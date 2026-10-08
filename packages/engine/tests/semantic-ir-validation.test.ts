import { describe, expect, it } from 'vitest';
import type { Ability, AbilityCost, Effect, TargetSpec, TokenSpec } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { defineCard } from '../src/cards/overrides';
import { ofType } from '../src/cards/selector';
import { createGame } from '../src/state/game';
import { createToken } from '../src/state/objects';
import { computePriorityOptions } from '../src/actions/legal';
import { executeAbility } from '../src/effects/resolve';
import { copies, forest, gameConfig, oracle, pump } from './fixtures';

const base = () =>
  interpretCard(
    oracle({
      name: 'Semantic probe',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
  );
function issues(targets: TargetSpec[], effects: Effect[], extra: Partial<Ability> = {}) {
  return validateCardDefinition({
    ...base(),
    spellAbility: { kind: 'spell', targets, effects, ...extra },
  });
}
const destroy: Effect = { op: 'destroy', target: 0 };

describe('semantic IR contracts', () => {
  it.each([
    { targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'unknown' }] },
    { targets: [{ kind: 'creature', controller: 'unknown' }] },
    { targets: [{ kind: 'creature', filter: null }] },
    { targets: [{ kind: 'cardInGraveyard', controller: 'opponent' }] },
    { targets: [{ kind: 'creature', count: { min: Number.MAX_SAFE_INTEGER + 1, max: Infinity } }] },
    { modes: null },
    { modes: { minChoices: 1, maxChoices: 1, options: [null] } },
    { modes: { minChoices: 1, maxChoices: 1, options: [{ effects: [], targetSlots: {} }] } },
  ])('contains malformed target/mode schemas without a validator crash: %j', (patch) => {
    expect(issues([], [], patch as Partial<Ability>)).not.toEqual([]);
  });

  it.each([
    { spellAdditionalCosts: 'free' },
    { triggers: undefined },
    { manaAbilities: [{ units: [['Q']], costs: [] }] },
    { manaAbilities: [{ units: [['G']], costs: null }] },
    {
      activatedAbilities: [
        { timing: 'any', ability: { kind: 'activated', targets: [], effects: [] } },
      ],
    },
    { spellAbility: { kind: 'futureAbility', targets: [], effects: [] } },
    {
      staticEffects: [
        { affects: { kind: 'powerAtLeast', n: 3 }, op: { layer: 6, addKeyword: 'flying' } },
      ],
    },
    {
      staticEffects: [
        {
          affects: { kind: 'self' },
          op: {
            layer: 7,
            sublayer: 'a',
            power: { kind: 'unknownValue' },
            toughness: { kind: 'const', n: 1 },
          },
        },
      ],
    },
  ])('contains malformed executable containers and continuous expressions: %j', (patch) => {
    expect(
      validateCardDefinition({ ...base(), ...patch } as unknown as ReturnType<typeof base>),
    ).not.toEqual([]);
  });

  it.each([
    { op: 'draw', count: { kind: 'unknownValue' } },
    { op: 'draw', count: { kind: 'plus', n: 1 } },
    { op: 'draw', count: { kind: 'const', n: NaN } },
    { op: 'destroyEach', selector: { kind: 'allOf', of: [{ kind: 'unknownSelector' }] } },
    { op: 'destroyEach', selector: { kind: 'controller', who: 'anyone' } },
    { op: 'conditionalEffect', condition: { kind: 'unknownCondition' }, then: [] },
    {
      op: 'conditionalEffect',
      condition: { kind: 'cardsInYourGraveyard', cmp: '>', n: 1 },
      then: [],
    },
  ])('rejects malformed nested expression operands: %j', (effect) => {
    expect(issues([], [effect as Effect])).not.toEqual([]);
  });

  it.each([
    { hybrid: [['W']] },
    { hybrid: [['W', 'P']] },
    { phyrexian: ['C'] },
    { generic: Infinity },
  ])('rejects malformed mana symbols: %j', (patch) => {
    const def = base();
    expect(
      validateCardDefinition({
        ...def,
        manaCost: { ...def.manaCost!, ...patch } as typeof def.manaCost,
      }),
    ).not.toEqual([]);
  });

  it('rejects choice predicates at trigger and activation checks but permits entry choices', () => {
    const condition = { kind: 'mayPayLife', n: 2 } as const;
    expect(
      issues([], [], {
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'self' }, condition },
      }),
    ).not.toEqual([]);
    expect(validateCardDefinition({ ...base(), entersTappedUnless: condition })).toEqual([]);
  });

  it.each([
    ['battlefield destruction', { kind: 'cardInGraveyard' }, destroy],
    ['reanimation', { kind: 'player' }, { op: 'graveyardToBattlefield', target: 0 }],
    ['spell countering', { kind: 'permanent' }, { op: 'counter', target: 0 }],
    ['ordinary reference', { kind: 'creature', count: { min: 0, max: 1 } }, destroy],
    ['counted reference', { kind: 'creature' }, { op: 'destroyEachChosen', targetSlot: 0 }],
  ] as [string, TargetSpec, Effect][])(
    'rejects an incompatible %s contract',
    (_label, target, effect) => {
      expect(issues([target], [effect])).not.toEqual([]);
    },
  );

  it.each([-1, 1, 0.5, NaN, Infinity])('rejects the malformed ordinary reference %s', (target) => {
    expect(issues([{ kind: 'creature' }], [{ op: 'destroy', target }])).not.toEqual([]);
  });

  it('requires explicit reference fields and rejects unknown operations', () => {
    expect(issues([{ kind: 'creature' }], [{ op: 'destroy' } as Effect])).not.toEqual([]);
    expect(issues([], [{ op: 'futureOperation' } as unknown as Effect])).not.toEqual([]);
    expect(issues([], [{} as Effect])).not.toEqual([]);
  });

  it('checks nested abilities in their own target scope', () => {
    const granted: Ability = {
      kind: 'triggered',
      trigger: { when: 'upkeep', player: 'you' },
      targets: [{ kind: 'player' }],
      effects: [destroy],
    };
    expect(
      issues([{ kind: 'creature' }], [{ op: 'grantAbilityUntilEot', target: 0, ability: granted }]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('incompatible') }),
      ]),
    );
  });

  it('checks nested target values independently of the outer effect domain', () => {
    expect(
      issues(
        [{ kind: 'creature' }],
        [
          {
            op: 'putCounters',
            target: 0,
            counter: '+1/+1',
            count: { kind: 'cardsInTargetHand', target: 0 },
          },
        ],
      ),
    ).not.toEqual([]);
  });

  it('checks mode ownership rather than allowing another mode’s slot', () => {
    expect(
      issues([{ kind: 'creature' }, { kind: 'creature' }], [], {
        modes: {
          minChoices: 1,
          maxChoices: 1,
          options: [
            { targetSlots: [1], effects: [destroy] },
            { targetSlots: [0], effects: [] },
          ],
        },
      }),
    ).not.toEqual([]);
  });

  it.each([
    [{ kind: 'cardInGraveyard', graveyardOwnerSlot: 1 }, { kind: 'player' }],
    [{ kind: 'creature' }, { kind: 'cardInGraveyard', graveyardOwnerSlot: 0 }],
    [
      { kind: 'player', count: { min: 0, max: 1 } },
      { kind: 'cardInGraveyard', graveyardOwnerSlot: 0 },
    ],
    [
      { kind: 'player' },
      { kind: 'cardInGraveyard', graveyardOwnerSlot: 0, graveyardOwnerScope: 'any' },
    ],
  ] as TargetSpec[][])('rejects invalid graveyard owner dependencies %s', (...targets) => {
    expect(issues(targets, [])).not.toEqual([]);
  });

  it.each([
    { min: -1, max: 1 },
    { min: 2, max: 1 },
    { min: 0, max: 0.5 },
  ])('rejects malformed count bounds %s', (count) => {
    expect(issues([{ kind: 'creature', count }], [])).not.toEqual([]);
  });

  it('does not broaden unimplemented mixed-domain filters', () => {
    expect(issues([{ kind: 'anyTarget', filter: ofType('Creature') }], [])).not.toEqual([]);
  });

  it('supports a correctly guarded permanent instruction in a mixed target domain', () => {
    const effect: Effect = {
      op: 'conditionalEffect',
      checkTarget: 0,
      condition: { kind: 'triggerObjectMatches', selector: ofType('Creature') },
      then: [{ op: 'pumpUntilEot', target: 0, power: 4, toughness: 4 }],
      else: [],
    };
    expect(issues([{ kind: 'anyTarget' }], [effect])).toEqual([]);
    expect(
      issues([{ kind: 'anyTarget' }], [{ ...effect, then: [], else: effect.then }]),
    ).not.toEqual([]);
    expect(
      issues(
        [{ kind: 'anyTarget' }, { kind: 'anyTarget' }],
        [{ ...effect, then: [{ op: 'pumpUntilEot', target: 1, power: 4, toughness: 4 }] }],
      ),
    ).not.toEqual([]);
  });

  it('rejects malformed additional costs', () => {
    expect(
      validateCardDefinition({
        ...base(),
        spellAdditionalCosts: [{ kind: 'payLife', amount: -1 }],
      }),
    ).not.toEqual([]);
    expect(
      validateCardDefinition({
        ...base(),
        spellAdditionalCosts: [{ kind: 'unknown' } as unknown as AbilityCost],
      }),
    ).not.toEqual([]);
  });
});

describe('enforced final definition routes', () => {
  it('contains invalid merged override output, including fixture aliases', () => {
    const name = 'Invalid merged probe';
    const id = 'invalid-merged-probe';
    defineCard(id, name, [], {
      spellAbility: { kind: 'spell', targets: [{ kind: 'cardInGraveyard' }], effects: [destroy] },
    });
    for (const oracleId of [id, 'oracle-invalid-merged-probe']) {
      const def = interpretCard(
        oracle({ oracleId, name, typeLine: 'Sorcery', oracleText: 'You gain 1 life.' }),
      );
      expect(def.modeled).toBe(false);
      expect(def.unmodeledReasons.join('; ')).toContain('incompatible');
    }
  });

  it('rejects a malformed custom definition before constructing a game', () => {
    const config = gameConfig([0, 1].map(() => ({ cards: copies(3, forest) })));
    expect(() =>
      createGame({
        ...config,
        customDefinitions: [
          {
            ...base(),
            spellAbility: {
              kind: 'spell',
              targets: [{ kind: 'player' }],
              effects: [destroy],
            },
          },
        ],
      }),
    ).toThrow('Invalid card definition');
  });

  it('rejects a malformed shared token ability before creating its permanent', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(3, forest) }))));
    const token: TokenSpec = {
      name: 'Invalid token probe',
      typeLine: 'Creature — Probe',
      types: ['Creature'],
      subtypes: ['Probe'],
      colors: [],
      power: 1,
      toughness: 1,
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [destroy],
        },
      ],
    };
    expect(() => createToken(ctx, token, 'P1')).toThrow('Invalid card definition');
    expect(ctx.state.battlefield).toHaveLength(0);
  });

  it('rejects direct execution of placeholders', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(3, forest) }))));
    expect(() =>
      pump(
        executeAbility(
          ctx,
          { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
          { kind: 'spell', targets: [], effects: [{ op: 'noOp' }] },
          [],
        ),
      ),
    ).toThrow('noOp');
  });

  it('does not offer an invalid custom spell through normal priority actions', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(3, forest) }))));
    const raw = oracle({
      name: 'Contained card',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    });
    defineCard(raw.oracleId, raw.name, [], {
      spellAbility: { kind: 'spell', targets: [{ kind: 'player' }], effects: [destroy] },
    });
    const def = interpretCard(raw);
    ctx.defs.set(def.oracleId, def);
    ctx.state.players[0]!.hand.push({
      id: 'probe',
      cardId: 'probe-card',
      oracleId: raw.oracleId,
      name: raw.name,
      ownerId: 'P1',
      zone: 'hand',
      typeLine: raw.typeLine,
      oracleText: raw.oracleText,
      manaCost: raw.manaCost,
      isToken: false,
      isCommander: false,
    });
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.phase = 'precombatMain';
    expect(() => computePriorityOptions(ctx, ctx.state.players[0]!)).toThrow('Unmodeled card');
  });
});

it.each([null, { kind: 'unknownTarget' }])(
  'reports malformed delayed-trigger targets without throwing: %j',
  (target) => {
    const definition = {
      ...base(),
      spellAbility: {
        kind: 'spell',
        targets: [target, { kind: 'creature' }],
        effects: [
          { op: 'destroy', target: 1 },
          {
            op: 'registerDelayedTrigger',
            target: 0,
            ability: {
              kind: 'triggered',
              trigger: { when: 'endStep' },
              targets: [],
              effects: [],
            },
          },
        ],
      },
    } as unknown as ReturnType<typeof base>;
    expect(validateCardDefinition(definition)).not.toEqual([]);
  },
);
