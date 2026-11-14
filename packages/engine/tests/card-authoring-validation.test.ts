import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { CardOverride } from '../src/cards/overrides';
import {
  validateCardDefinition,
  validateOverrideDefinition,
} from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import {
  conflictingRegistrations,
  explicitReplacements,
  fixtureOracleId,
  getOverride,
  registrationsConflict,
} from '../src/cards/overrides';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;

function withoutIdentity<T extends { oracleId: unknown }>(value: T): Omit<T, 'oracleId'> {
  const { oracleId: _oracleId, ...rest } = value;
  return rest;
}

describe('card authoring validation', () => {
  it('validates complete merged definitions and equal real/fixture behavior for reviewed cards', () => {
    for (const { card } of fixture.cards) {
      const alias = { ...card, oracleId: fixtureOracleId(card.name) };
      const realDefinition = interpretCard(card);
      const aliasDefinition = interpretCard(alias);
      expect(validateCardDefinition(realDefinition), card.name).toEqual([]);
      expect(validateCardDefinition(aliasDefinition), `${card.name} fixture alias`).toEqual([]);
      expect(withoutIdentity(aliasDefinition), card.name).toEqual(withoutIdentity(realDefinition));

      const realOverride = getOverride(card.oracleId)!;
      const aliasOverride = getOverride(alias.oracleId)!;
      expect(validateOverrideDefinition(realOverride), card.name).toEqual([]);
      expect(aliasOverride.def, card.name).toEqual(realOverride.def);
      expect(aliasOverride.handledLines, card.name).toEqual(realOverride.handledLines);
    }
  });

  it('rejects executable placeholders, invalid target references, and misordered target slots', () => {
    const malformed = {
      oracleId: 'malformed',
      name: 'Malformed',
      handledLines: ['Malformed line.'],
      def: {
        triggers: [
          {
            kind: 'triggered',
            trigger: { when: 'enters', subject: { kind: 'self' } },
            targets: [{ kind: 'creature', count: { min: 0, max: 1 } }, { kind: 'player' }],
            effects: [
              { op: 'destroy', target: 1 },
              { op: 'putCountersEachChosen', targetSlot: 2, counter: '+1/+1', count: 1 },
              { op: 'noOp' },
            ],
          },
        ],
      },
    } as unknown as CardOverride;

    expect(validateOverrideDefinition(malformed).map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('variable-count target slots'),
        expect.stringContaining('does not reference an ordinary target slot'),
        expect.stringContaining('outside the ability target list'),
        expect.stringContaining('noOp'),
      ]),
    );
  });

  it('detects differing executable duplicates while allowing exact repeats and backlog promotion', () => {
    const base: CardOverride = {
      oracleId: 'duplicate',
      name: 'Duplicate',
      handledLines: ['line'],
      def: { keywords: ['flying'] },
    };
    expect(registrationsConflict(base, { ...base })).toBe(false);
    expect(registrationsConflict(base, { ...base, def: { keywords: ['haste'] } })).toBe(true);
    expect(registrationsConflict({ ...base, def: {} }, base)).toBe(false);
  });

  describe('patches the compiler pilots found valid but wrong in play', () => {
    const override = (def: unknown): CardOverride =>
      ({
        oracleId: 'oracle-compiled-probe',
        name: 'Compiled Probe',
        handledLines: [],
        def,
      }) as unknown as CardOverride;
    const messages = (def: unknown) =>
      validateOverrideDefinition(override(def)).map((issue) => `${issue.path}: ${issue.message}`);
    const mana = { generic: 2, colored: { W: 1, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 };
    const spirit = (power: unknown) => ({
      name: 'Spirit',
      typeLine: 'Creature — Spirit',
      types: ['Creature'],
      subtypes: ['Spirit'],
      colors: ['W'],
      power,
      toughness: power,
    });
    const tokenOn = (spec: unknown) => ({
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'createToken', spec, count: { kind: 'const', n: 1 } }],
        description: 'Create a token.',
      },
    });

    it('takes a scoped token power only where a resolving effect creates the token', () => {
      // Warden of the Grove: an X/X token where X is the counters on the creature. It validated,
      // then threw "source counters need a layer evaluation scope" when the token was made. An
      // effect's spec is now read with the resolving ability's scope (compiled-patch-findings
      // test), so it stays valid there.
      const scoped = { kind: 'countersOnSelf', counter: '+1/+1' };
      expect(messages(tokenOn(spirit(scoped)))).toEqual([]);
      // A token spec outside an effect is still read with no scope at all.
      expect(messages({ tokenCreationReplacement: spirit(scoped) })).toEqual([
        'override.def.tokenCreationReplacement.power: token power and toughness outside an effect are read with no ability scope; only a fixed value fits here',
        'override.def.tokenCreationReplacement.toughness: token power and toughness outside an effect are read with no ability scope; only a fixed value fits here',
      ]);
      for (const power of [1, { kind: 'cardTypesInAllGraveyards' }])
        expect(
          messages({ tokenCreationReplacement: spirit(power) }),
          JSON.stringify(power),
        ).toEqual([]);
    });

    it('rejects an entering counter count over the as-enters choice (Banner of Kinship)', () => {
      // The count is taken before the choice exists, so it was always zero.
      const banner = (selector: unknown) => ({
        entersChoosingOption: { prompt: 'choose a creature type', domain: 'creatureType' },
        entersWithCounters: {
          fellowship: { kind: 'countPermanents', selector, scope: 'you' },
        },
      });
      expect(
        messages(
          banner({
            kind: 'allOf',
            of: [{ kind: 'chosenSubtype' }, { kind: 'type', value: 'Creature' }],
          }),
        ),
      ).toEqual([
        'override.def.entersWithCounters.fellowship: an entering permanent counts its counters before its as-enters choice; a chosen option cannot be read here',
      ]);
      expect(messages(banner({ kind: 'type', value: 'Creature' }))).toEqual([]);
    });

    it('rejects two distinct player targets chosen together (Gleaming Splendor)', () => {
      // "{2}{W}: Two target players each draw a card." Each slot's menu lists every player and
      // the engine refuses the same one twice, so a smoke game stopped on "illegal target".
      const draw = (target: number) => ({
        op: 'drawTarget',
        target,
        count: { kind: 'const', n: 1 },
      });
      const pair = (kind: 'activated' | 'triggered', second: Record<string, unknown>) => ({
        kind,
        ...(kind === 'triggered'
          ? { trigger: { when: 'upkeep', player: 'you' }, optional: false }
          : {}),
        targets: [{ kind: 'player' }, { kind: 'player', ...second }],
        effects: [draw(0), draw(1)],
        description: 'Two target players each draw a card.',
      });
      const activated = (second: Record<string, unknown>) => ({
        activatedAbilities: [
          {
            costs: [{ kind: 'mana', cost: mana }],
            timing: 'any',
            ability: pair('activated', second),
          },
        ],
      });
      expect(messages(activated({ differentFromSlots: [0] }))).toEqual([
        'override.def.activatedAbilities[0].ability.targets[1].differentFromSlots: distinct player targets are supported only on a triggered ability; a spell or activated ability offers each slot every player',
      ]);
      expect(
        messages({
          spellAbility: { ...pair('activated', { differentFromSlots: [0] }), kind: 'spell' },
        }),
      ).toEqual([
        'override.def.spellAbility.targets[1].differentFromSlots: distinct player targets are supported only on a triggered ability; a spell or activated ability offers each slot every player',
      ]);
      // A trigger is offered whole legal target combinations, so it may keep two players apart.
      expect(messages({ triggers: [pair('triggered', { differentFromSlots: [0] })] })).toEqual([]);
      // Distinct object targets on an activated ability stay valid (Saheeli, Sublime Artificer).
      expect(
        messages({
          activatedAbilities: [
            {
              costs: [{ kind: 'mana', cost: mana }],
              timing: 'any',
              ability: {
                kind: 'activated',
                targets: [{ kind: 'creature' }, { kind: 'creature', differentFromSlots: [0] }],
                effects: [
                  { op: 'tapTarget', target: 0 },
                  { op: 'tapTarget', target: 1 },
                ],
                description: 'Tap target creature and another target creature.',
              },
            },
          ],
        }),
      ).toEqual([]);
    });
  });

  it('has no silent executable conflicts and documents every intentional replacement', () => {
    expect(conflictingRegistrations).toEqual([]);
    expect(explicitReplacements.length).toBeGreaterThan(0);
    for (const replacement of explicitReplacements) {
      expect(replacement.reason.trim().length, replacement.name).toBeGreaterThan(20);
    }
  });
});
