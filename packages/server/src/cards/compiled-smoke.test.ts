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
});
