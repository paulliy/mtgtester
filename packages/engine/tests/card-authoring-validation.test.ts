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

  it('rejects a mana amount that a mana ability has no scope to evaluate', () => {
    // Viridian Joiner, "{T}: Add an amount of {G} equal to this creature's power", compiled as a
    // mana ability with `powerOfSource`. It validated, then threw as the engine listed mana
    // sources: a mana ability is not a resolving ability, so nothing answers that value.
    const withAmount = (amount: unknown): CardOverride =>
      ({
        oracleId: 'oracle-mana-amount-probe',
        name: 'Mana Amount Probe',
        handledLines: [],
        def: { manaAbilities: [{ units: [['G']], amount }] },
      }) as unknown as CardOverride;
    const issue = {
      path: 'override.def.manaAbilities[0].amount',
      message: 'mana amount a mana ability cannot evaluate',
    };
    for (const amount of [
      { kind: 'powerOfSource' },
      { kind: 'xValue' },
      { kind: 'plus', of: { kind: 'powerOfSource' }, n: 1 },
      { kind: 'lifeTotal', scope: 'eventPlayer' },
    ])
      expect(validateOverrideDefinition(withAmount(amount)), JSON.stringify(amount)).toContainEqual(
        issue,
      );
    // The amounts modeled cards use: Gaea's Cradle, Nykthos, Everflowing Chalice.
    for (const amount of [
      { kind: 'countPermanents', selector: { kind: 'creature' }, scope: 'you' },
      { kind: 'devotionTo', color: 'G' },
      { kind: 'countersOnSelf', counter: 'charge' },
      { kind: 'times', of: { kind: 'countersOnSelf', counter: 'charge' }, n: 2 },
    ])
      expect(
        validateOverrideDefinition(withAmount(amount)),
        JSON.stringify(amount),
      ).not.toContainEqual(issue);
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

    const FIXED =
      'this token power and toughness are read with no ability scope (a token spec outside an effect, or an op that changes the game before it creates); only a fixed value fits here';
    const CHOSEN =
      'an entering permanent settles its counters and enters-tapped condition before its as-enters choice; a chosen option cannot be read here';

    it('takes a scoped token power only where a resolving effect creates the token first', () => {
      // Warden of the Grove: an X/X token where X is the counters on the creature. It validated,
      // then threw "source counters need a layer evaluation scope" when the token was made. An
      // effect's spec is now read with the resolving ability's scope (compiled-patch-findings
      // test), so it stays valid there.
      const scoped = { kind: 'countersOnSelf', counter: '+1/+1' };
      expect(messages(tokenOn(spirit(scoped)))).toEqual([]);
      // An op that destroys first would read the game before the destroy: fixed values only.
      const destroyFirst = (power: unknown) => ({
        spellAbility: {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [
            {
              op: 'destroyAndCreateTokenForController',
              target: 0,
              spec: spirit(power),
              count: { kind: 'const', n: 1 },
            },
          ],
          description: 'Destroy target creature. Its controller creates a token.',
        },
      });
      expect(messages(destroyFirst(scoped))).toEqual([
        `override.def.spellAbility.effects[0].spec.power: ${FIXED}`,
        `override.def.spellAbility.effects[0].spec.toughness: ${FIXED}`,
      ]);
      expect(messages(destroyFirst(3))).toEqual([]);
      // A token spec outside an effect is read with no scope at all.
      expect(messages({ tokenCreationReplacement: spirit(scoped) })).toEqual([
        `override.def.tokenCreationReplacement.power: ${FIXED}`,
        `override.def.tokenCreationReplacement.toughness: ${FIXED}`,
      ]);
      for (const power of [1, { kind: 'cardTypesInAllGraveyards' }])
        expect(
          messages({ tokenCreationReplacement: spirit(power) }),
          JSON.stringify(power),
        ).toEqual([]);
      // A layer-only value throws when a resolving ability reads it.
      expect(messages(tokenOn(spirit({ kind: 'timesAttackedThisTurn' })))).toEqual([
        'override.def.spellAbility.effects[0].spec.power: a token power and toughness cannot read a value that exists only in a layer',
        'override.def.spellAbility.effects[0].spec.toughness: a token power and toughness cannot read a value that exists only in a layer',
      ]);
    });

    it('rejects an entry choice read before it is made (Banner of Kinship)', () => {
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
      ).toEqual([`override.def.entersWithCounters.fellowship: ${CHOSEN}`]);
      expect(messages(banner({ kind: 'type', value: 'Creature' }))).toEqual([]);
      // Enters-tapped is settled even earlier.
      expect(
        messages({
          entersChoosingOption: {
            prompt: 'choose a color',
            domain: 'options',
            options: [{ key: 'red', label: 'Red' }],
          },
          entersTappedUnless: { kind: 'chosenOptionIs', value: 'red' },
        }),
      ).toEqual([`override.def.entersTappedUnless: ${CHOSEN}`]);
    });

    it('checks the scope of a mass graveyard return', () => {
      const back = (scope: unknown) => ({
        spellAbility: {
          kind: 'spell',
          targets: [],
          effects: [
            {
              op: 'graveyardToBattlefieldEach',
              filter: { kind: 'type', value: 'Creature' },
              scope,
            },
          ],
          description: 'Return all creature cards.',
        },
      });
      expect(messages(back('all'))).toEqual([]);
      expect(messages(back('you'))).toEqual([]);
      expect(messages(back('opponents'))).toEqual([
        'override.def.spellAbility.effects[0].scope: expected you | all',
      ]);
    });

    it('accepts distinct targets on any ability (Gleaming Splendor)', () => {
      // "{2}{W}: Two target players each draw a card." The engine now offers activated abilities
      // and triggers one target menu per legal assignment, as it did spells (compiled-patch-
      // findings test), so the shape that once threw "illegal target" is valid everywhere.
      const draw = (target: number) => ({
        op: 'drawTarget',
        target,
        count: { kind: 'const', n: 1 },
      });
      const pair = (kind: 'activated' | 'triggered' | 'spell') => ({
        kind,
        ...(kind === 'triggered'
          ? { trigger: { when: 'upkeep', player: 'you' }, optional: false }
          : {}),
        targets: [{ kind: 'player' }, { kind: 'player', differentFromSlots: [0] }],
        effects: [draw(0), draw(1)],
        description: 'Two target players each draw a card.',
      });
      expect(
        messages({
          activatedAbilities: [
            { costs: [{ kind: 'mana', cost: mana }], timing: 'any', ability: pair('activated') },
          ],
        }),
      ).toEqual([]);
      expect(messages({ spellAbility: pair('spell') })).toEqual([]);
      expect(messages({ triggers: [pair('triggered')] })).toEqual([]);
      // `differentPlayerTargetSlots` stays a modal-trigger field, reported once.
      expect(
        messages({
          spellAbility: {
            ...pair('spell'),
            targets: [
              { kind: 'player', differentPlayerTargetSlots: [1] },
              { kind: 'player', differentPlayerTargetSlots: [0] },
            ],
          },
        }),
      ).toEqual([
        'override.def.spellAbility: distinct player target slots require nonrepeatable triggered modes',
      ]);
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
