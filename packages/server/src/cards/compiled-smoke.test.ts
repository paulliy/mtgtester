/**
 * The compiler's generated smoke games (`scripts/card-compiler/lib.ts`): what counts as a patch
 * having been exercised, and the baseline card a patched game is compared with.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '@mtg/engine';
import {
  baselineCard,
  compileTarget,
  pinnedPool,
  smokeExercised,
  smokeTest,
  type SmokeResult,
} from '../../../../scripts/card-compiler/lib';

const root = resolve(import.meta.dirname, '../../../..');
const patchOf = (slug: string) =>
  JSON.parse(
    readFileSync(resolve(root, `docs/reviews/card-compiler-trial-01/patches/${slug}.json`), 'utf8'),
  ) as { def: Parameters<typeof smokeTest>[1] };
const targetOf = (name: string) =>
  compileTarget(pinnedPool().find((row) => row.card.name === name)!)!;

const run = (over: Partial<SmokeResult>): SmokeResult => ({
  ok: true,
  scenario: 'test',
  exercised: false,
  abilityResolved: false,
  resolved: [],
  detail: '',
  decisions: 0,
  eventTypes: [],
  ...over,
});

describe('whether smoke exercised a patch', () => {
  it('counts a game that differed from its baseline', () => {
    expect(smokeExercised([run({ changedGame: false }), run({ changedGame: true })])).toBe(true);
  });

  it('does not count a resolved ability when the game matched its baseline', () => {
    // The ability that resolved belonged to a line the interpreter already read.
    expect(
      smokeExercised([run({ changedGame: false, exercised: true, abilityResolved: true })]),
    ).toBe(false);
  });

  it('falls back to the spell resolving when there is no baseline', () => {
    expect(smokeExercised([run({ exercised: true })])).toBe(true);
    expect(smokeExercised([run({})])).toBe(false);
    expect(smokeExercised([])).toBe(false);
  });
});

describe('the baseline card', () => {
  it('is the card without its unparsed line, modeled by the interpreter alone', () => {
    const target = targetOf('Yavimaya Hollow');
    const baseline = baselineCard(target)!;
    expect(baseline.oracleText).not.toContain('Regenerate target creature');
    expect(baseline.oracleText).toContain('{T}: Add {C}.');
    expect(baseline.oracleId).toBe(target.card.oracleId);
    expect(interpretCard(baseline).modeled).toBe(true);
  });

  it('does not exist for a spell whose only line is the unparsed one', () => {
    const target = targetOf('Damning Verdict');
    expect(target.card.oracleText!.split('\n')).toHaveLength(1);
    expect(baselineCard(target)).toBeNull();
  });
});

describe('smoke games for a patch', () => {
  it('pass, show the patch changed the game, and are reproducible', () => {
    const target = targetOf('Yavimaya Hollow');
    const { def } = patchOf('yavimaya-hollow');
    const runs = smokeTest(target, def);
    expect(runs.map((result) => result.scenario)).toEqual([
      'from-hand',
      'on-battlefield',
      'busy-board',
      'busy-own-turn',
    ]);
    expect(runs.every((result) => result.ok)).toBe(true);
    expect(runs.every((result) => result.changedGame !== undefined)).toBe(true);
    expect(smokeExercised(runs)).toBe(true);
    expect(runs.every((result) => !('digest' in result))).toBe(true);
    expect(smokeTest(target, def)).toEqual(runs);
  }, 60_000);

  it('still pass for a patch that means the wrong thing: smoke is a crash net', () => {
    // Trial 01's audit found this patch wrong (it targets the random graveyard card).
    const runs = smokeTest(targetOf('Charmbreaker Devils'), patchOf('charmbreaker-devils').def);
    expect(runs.every((result) => result.ok)).toBe(true);
  }, 60_000);
});

describe('what the back-translator is shown', () => {
  it('keeps schema names of any length and hides free text', async () => {
    const { stripDescriptions } = await import('../../../../scripts/card-compiler/lib');
    expect(
      stripDescriptions({
        kind: 'enchantedByAuraYouControlOrSomethingLonger',
        op: 'createTokenCopyOf',
        description: 'Whenever this creature attacks, draw a card.',
        name: 'A token name that is long enough to be a sentence of rules text',
        counter: '+1/+1',
        // A discriminant that is not a schema name is free text like any other.
        when: 'whenever you feel like it',
      }),
    ).toEqual({
      kind: 'enchantedByAuraYouControlOrSomethingLonger',
      op: 'createTokenCopyOf',
      name: '<text>',
      counter: '+1/+1',
      when: '<text>',
    });
  });

  it('keeps comparison operators, which decide what a condition means', async () => {
    const { stripDescriptions } = await import('../../../../scripts/card-compiler/lib');
    for (const cmp of ['>=', '<=', '==', '!=', '<', '>'])
      expect(stripDescriptions({ kind: 'countPermanents', cmp, n: 1 })).toEqual({
        kind: 'countPermanents',
        cmp,
        n: 1,
      });
    expect(stripDescriptions({ cmp: '>= or so' })).toEqual({ cmp: '<text>' });
  });
});

describe('smoke target choice', () => {
  it('never announces the same object for two target slots', async () => {
    // "Target creature you control fights another target creature": both slots offer the same
    // creatures, and a game that picked one twice threw "illegal target" (Ulvenwald Tracker in
    // chunk 003, Gleaming Splendor in chunk 002).
    const { firstTargets } = await import('../../../../scripts/card-compiler/lib');
    const { Prng } = await import('../../../engine/src/rng/prng');
    const options = ['a', 'b'];
    for (let seed = 0; seed < 50; seed++) {
      const choices = firstTargets(
        {
          targets: [
            { slot: 0, options, min: 1, max: 1 },
            { slot: 1, options, min: 1, max: 1 },
          ] as never,
        },
        new Prng(`seed-${seed}`),
      );
      expect(choices.map((choice) => choice.slot)).toEqual([0, 1]);
      expect(new Set(choices.map((choice) => choice.choice)).size).toBe(2);
    }
  });

  it('gives a slot with one option that option, before the wider slot chooses', async () => {
    const { firstTargets } = await import('../../../../scripts/card-compiler/lib');
    const { Prng } = await import('../../../engine/src/rng/prng');
    for (let seed = 0; seed < 20; seed++) {
      const choices = firstTargets(
        {
          targets: [
            { slot: 0, options: ['a', 'b'], min: 1, max: 1 },
            { slot: 1, options: ['a'], min: 1, max: 1 },
          ] as never,
        },
        new Prng(`seed-${seed}`),
      );
      expect(choices).toEqual([
        { slot: 0, choice: 'b' },
        { slot: 1, choice: 'a' },
      ]);
    }
  });
});

describe('what the judge is shown', () => {
  it('carries the reminder text that says what a token on the line under test does', async () => {
    // Chunk 006: two judges in a row passed a Voldaren Estate patch whose Blood token had no
    // ability, because the line under test was only "Create a Blood token".
    const { reminderTextFor, judgeSuffix } =
      await import('../../../../scripts/card-compiler/prompts');
    const target = targetOf('Voldaren Estate');
    expect(reminderTextFor(target)).toEqual([
      'It\'s an artifact with "{1}, {T}, Discard a card, Sacrifice this token: Draw a card."',
    ]);
    expect(judgeSuffix(target, 'B')).toContain('Reminder text on those lines');
  });

  it('matches a line that names the card, and leaves out reminders of other lines', async () => {
    const { reminderTextFor } = await import('../../../../scripts/card-compiler/prompts');
    const minas = reminderTextFor(targetOf('Minas Morgul, Dark Fortress'));
    expect(minas).toHaveLength(1);
    expect(minas[0]).toContain('shadow');
    expect(reminderTextFor(targetOf('Yavimaya Hollow'))).toEqual([]);
  });
});
