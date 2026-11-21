import { describe, expect, it } from 'vitest';
import { enforceCardDefinition } from '../src/cards/authoring-validation';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { AbilityCost, ManaAbilitySpec } from '../src/cards/ability';
import { createGame } from '../src/state/game';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';
import { countPermanents } from '../src/cards/condition';
import { allOf, ofType, powerAtLeast } from '../src/cards/selector';
import { tapOther } from '../src/cards/templates';
import {
  characteristicsFixedDuringPayment,
  leavingPermanentsKeepProduction,
} from '../src/mana/payment-stability';
import { engineWork, engineWorkSince } from '../src/work-counters';
import { script } from './script';

function setup(manaCost: string, costs: AbilityCost[] = [], targeted = false) {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Stateful casting probe',
      typeLine: 'Sorcery',
      manaCost,
      oracleText: targeted ? 'Target creature gets +1/+1 until end of turn.' : 'You gain 1 life.',
    }),
    'hand',
  );
  ctx.defs.set(card.oracleId, { ...ctx.defs.get(card.oracleId)!, spellAdditionalCosts: costs });
  const source = (name: string, ability: ManaAbilitySpec) => {
    const permanent = spawn(ctx, player.id, oracle({ name, typeLine: 'Artifact' }));
    ctx.defs.set(permanent.oracleId, {
      ...ctx.defs.get(permanent.oracleId)!,
      manaAbilities: [ability],
    });
    return permanent;
  };
  const offered = () =>
    computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === card.id;
    });
  const cast = (targets = new Map<number, string>()) => {
    const option = offered();
    expect(option).toBeDefined();
    return pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets,
      }),
    );
  };
  return { ctx, player, card, source, offered, cast };
}

describe('actual changing-resource spell payment contracts', () => {
  it('rejects a payment made unaffordable by mana damage, without touching state or RNG', () => {
    const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
    state.player.life = 3;
    state.source('Damage payment source', {
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 1 }],
    });
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeUndefined();
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          { kind: 'castSpell', objectId: state.card.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.debugLog).toEqual(before.debugLog);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('uses mana life gain before paying additional spell life', () => {
    const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
    state.player.life = 1;
    const source = state.source('Life payment source', {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeDefined();
    expect(state.ctx.state).toEqual(before.state);
    state.cast();
    expect(source.tapped).toBe(true);
    expect(state.player.life).toBe(1);
    expect(state.ctx.state.stack).toHaveLength(1);
    expect(
      state.ctx.state.eventLog
        .filter((e) => ['lifeGain', 'lifeLoss'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['lifeGain', 'lifeLoss']);
  });

  it.each([1, -1])(
    'offers additional life X funded by actual mana life gain from starting life %s',
    (life) => {
      const state = setup('{G}', [{ kind: 'payLifeValue', amount: { kind: 'xValue' } }]);
      state.ctx.defs.set(state.card.oracleId, {
        ...state.ctx.defs.get(state.card.oracleId)!,
        announcesX: true,
      });
      state.player.life = life;
      const source = state.source('Additional-X life source', {
        units: [['G']],
        onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
      });
      const before = cloneContractContext(state.ctx);
      const options = computePriorityOptions(state.ctx, state.player).filter(
        (option) => (option.payload as PriorityActionPayload).kind === 'castSpell',
      );
      expect(options.map((option) => (option.payload as { x: number }).x)).toEqual(
        life === 1 ? [0, 1, 2, 3, 4] : [0, 1, 2],
      );
      expect(state.ctx.state).toEqual(before.state);
      const option = options.find((option) => (option.payload as { x: number }).x === life + 3)!;
      pump(
        applyPriorityAction(state.ctx, state.player, option.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      expect(source.tapped).toBe(true);
      expect(state.player.life).toBe(0);
      expect(state.ctx.state.stack[0]!.announcedX).toBe(life + 3);
      expect(
        state.ctx.state.eventLog
          .filter((event) => ['lifeGain', 'lifeLoss'].includes(event.type))
          .map((event) => event.type),
      ).toEqual(['lifeGain', 'lifeLoss']);
    },
  );

  it.each(['missing', 'fixed', 'otherValue', 'mixedValue'] as const)(
    'contains an additional-X announcement without a proven X cost: %s',
    (variant) => {
      const state = setup(
        '{G}',
        variant === 'missing'
          ? []
          : [
              {
                kind: 'payLifeValue',
                amount:
                  variant === 'fixed'
                    ? { kind: 'const', n: 1 }
                    : { kind: 'negate', of: { kind: 'xValue' } },
              },
            ],
      );
      if (variant === 'mixedValue')
        state.ctx.defs
          .get(state.card.oracleId)!
          .spellAdditionalCosts!.push({ kind: 'payLifeValue', amount: { kind: 'xValue' } });
      const malformed = { ...state.ctx.defs.get(state.card.oracleId)!, announcesX: true };
      expect(enforceCardDefinition(malformed).modeled).toBe(false);
      state.ctx.defs.set(state.card.oracleId, malformed);
      const before = cloneContractContext(state.ctx);
      expect(state.offered).toThrow('direct pay-X-life cost');
      expect(() =>
        pump(
          applyPriorityAction(
            state.ctx,
            state.player,
            { kind: 'castSpell', objectId: state.card.id, fromCommand: false, x: 1 },
            { index: 0, targets: new Map() },
          ),
        ),
      ).toThrow('direct pay-X-life cost');
      expect(state.ctx.state).toEqual(before.state);
      expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    },
  );

  it('reports an additional-X menu beyond its supported choice budget without mutation', () => {
    const state = setup('{G}', [{ kind: 'payLifeValue', amount: { kind: 'xValue' } }]);
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      announcesX: true,
    });
    state.player.life = 1024;
    state.source('Large-X fixed source', { units: [['G']] });
    const before = cloneContractContext(state.ctx);
    expect(state.offered).toThrow('additional life X choice budget exceeded');
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });

  it('finishes mana activations before paying a target life tax', () => {
    const state = setup('{G}', [], true);
    state.player.life = 1;
    state.source('Target-tax life source', {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    const target = spawn(state.ctx, 'P2', bear());
    state.ctx.defs.set(target.oracleId, {
      ...state.ctx.defs.get(target.oracleId)!,
      ruleStatics: [{ kind: 'targetLifeTax', amount: 3 }],
    });
    expect(state.offered()?.targets?.[0]?.options).toContain(target.id);
    state.cast(new Map([[0, target.id]]));
    expect(state.player.life).toBe(1);
    expect(
      state.ctx.state.eventLog
        .filter((e) => ['lifeGain', 'lifeLoss'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['lifeGain', 'lifeLoss']);
  });

  it('discovers a later activation that becomes affordable after earlier life gain', () => {
    const state = setup('{G}{R}', [{ kind: 'payLife', amount: 1 }]);
    state.player.life = 1;
    const later = state.source('Initially unaffordable source', {
      units: [['R']],
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 2 }],
    });
    const earlier = state.source('Unlocking life source', {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    state.cast();
    expect(earlier.tapped).toBe(true);
    expect(later.tapped).toBe(true);
    expect(state.player.life).toBe(1);
    expect(
      state.ctx.state.eventLog
        .filter((e) => ['lifeGain', 'lifeLoss'].includes(e.type))
        .map((e) => e.type),
    ).toEqual(['lifeGain', 'lifeLoss', 'lifeLoss']);
  });

  it('tries another source when the first arithmetic plan would leave unpaid spell life', () => {
    const state = setup('{G}{R}', [{ kind: 'payLife', amount: 1 }]);
    state.player.life = 4;
    const bad = state.source('Bad damage source', {
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 2 }],
    });
    const costly = state.source('Required life source', {
      units: [['R']],
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 2 }],
    });
    const good = state.source('Good ordinary source', { units: [['G']] });
    state.cast();
    expect(bad.tapped).toBe(false);
    expect(costly.tapped).toBe(true);
    expect(good.tapped).toBe(true);
    expect(state.player.life).toBe(1);
  });

  it('can pay Phyrexian life made available by producing the generic mana', () => {
    const state = setup('{1}{G/P}');
    state.player.life = 0;
    state.source('Phyrexian life source', {
      units: [['C']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 2 } }],
    });
    state.cast();
    expect(state.player.life).toBe(0);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.stack).toHaveLength(1);
  });

  it('recomputes a repeated source resource after its counter rider resolves', () => {
    const state = setup('{G}{G}');
    const source = state.source('Restoring-counter source', {
      units: [['G']],
      costs: [{ kind: 'removeCounters', counter: 'nest', count: 1 }],
      onActivate: [{ op: 'putCounters', target: 'source', counter: 'nest', count: 1 }],
    });
    source.counters['nest'] = 1;
    state.cast();
    expect(source.counters['nest']).toBe(1);
    expect(source.tapped).toBe(false);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.eventLog.filter((e) => e.type === 'tapForMana')).toHaveLength(0);
  });

  it('preserves a counter named __proto__ while probing a repeatable payment', () => {
    const state = setup('{G}{G}');
    const source = state.source('Special-name restoring-counter source', {
      units: [['G']],
      costs: [{ kind: 'removeCounters', counter: '__proto__', count: 1 }],
      onActivate: [{ op: 'putCounters', target: 'source', counter: '__proto__', count: 1 }],
    });
    source.counters = JSON.parse('{"__proto__":1}');
    expect(state.offered()).toBeDefined();
    expect(source.counters['__proto__']).toBe(1);
    expect(Object.getPrototypeOf(source.counters)).toBe(Object.prototype);
    state.cast();
    expect(source.counters['__proto__']).toBe(1);
    expect(Object.hasOwn(source.counters, '__proto__')).toBe(true);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.stack).toHaveLength(1);
  });

  it.each(['infect', 'lifelink'] as const)(
    'replays actual %s damage instead of treating damage as a life cost',
    (keyword) => {
      const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
      state.player.life = 3;
      const source = state.source('Damage trait source', {
        units: [['G']],
        onActivate: [{ op: 'damageController', amount: 2 }],
      });
      state.ctx.defs.set(source.oracleId, {
        ...state.ctx.defs.get(source.oracleId)!,
        keywords: [keyword],
      });
      state.cast();
      expect(state.player.life).toBe(0);
      expect(state.player.poisonCounters).toBe(keyword === 'infect' ? 2 : 0);
    },
  );

  it('finds an activation order that pays life first and may finish below zero before SBAs', () => {
    const state = setup('{G}{R}');
    state.player.life = 4;
    state.source('Deferred damage source', {
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 3 }],
    });
    state.source('Prior life payment source', {
      units: [['R']],
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 4 }],
    });
    state.cast();
    expect(state.player.life).toBe(-3);
    expect(state.ctx.state.stack).toHaveLength(1);
    expect(state.player.hasLost).toBe(false);
  });

  it('uses state-dependent production together with actual mana life gain', () => {
    const state = setup('{G}', [{ kind: 'payLife', amount: 3 }]);
    state.player.life = 1;
    state.source('Dynamic life source', {
      units: [['G']],
      amount: { kind: 'const', n: 1 },
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    expect(state.offered()).toBeDefined();
    expect(state.player.life).toBe(1);
    state.cast();
    expect(state.player.life).toBe(1);
    expect(state.ctx.state.stack).toHaveLength(1);
  });

  it.each([1, 2, 3])(
    'reads source counters after paying its counter cost for %s green pips',
    (pips) => {
      const state = setup('{G}'.repeat(pips));
      const source = state.source('Post-cost counters source', {
        units: [['G']],
        amount: { kind: 'countersOnSelf', counter: 'charge' },
        costs: [{ kind: 'tap' }, { kind: 'removeCounters', counter: 'charge', count: 1 }],
      });
      source.counters['charge'] = 3;
      const before = cloneContractContext(state.ctx);
      if (pips === 3) {
        expect(state.offered()).toBeUndefined();
        expect(() =>
          pump(
            applyPriorityAction(
              state.ctx,
              state.player,
              { kind: 'castSpell', objectId: state.card.id, fromCommand: false },
              { index: 0, targets: new Map() },
            ),
          ),
        ).toThrow();
        expect(state.ctx.state).toEqual(before.state);
        expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
      } else {
        state.cast();
        expect(source.counters['charge']).toBe(2);
        expect(source.tapped).toBe(true);
        expect(state.player.manaEntries.map((entry) => entry.symbol)).toEqual(
          pips === 1 ? ['G'] : [],
        );
      }
    },
  );

  it('recomputes each successive counter-dependent activation', () => {
    const state = setup('{G}{G}{G}');
    const source = state.source('Repeated post-cost source', {
      units: [['G']],
      amount: { kind: 'countersOnSelf', counter: 'charge' },
      costs: [{ kind: 'removeCounters', counter: 'charge', count: 1 }],
    });
    source.counters['charge'] = 3;
    state.cast();
    expect(source.counters['charge']).toBe(1);
    expect(source.tapped).toBe(false);
    expect(state.player.manaEntries).toEqual([]);
  });

  it.each([1, 2])('evaluates conditional production after tapping for %s green pips', (pips) => {
    const state = setup('{G}'.repeat(pips));
    const source = state.source('Conditional post-tap source', {
      units: [['G']],
      costs: [{ kind: 'tap' }],
      conditionalUnits: { condition: { kind: 'isUntapped' }, units: [['G'], ['G']] },
    });
    if (pips === 2) {
      const before = cloneContractContext(state.ctx);
      expect(state.offered()).toBeUndefined();
      expect(state.ctx.state).toEqual(before.state);
      expect(source.tapped).toBe(false);
    } else {
      state.cast();
      expect(source.tapped).toBe(true);
      expect(state.player.manaEntries).toEqual([]);
    }
  });

  it('can activate an initially empty source whose tap cost enables production', () => {
    const state = setup('{G}');
    const source = state.source('Post-tap enabled source', {
      units: [],
      costs: [{ kind: 'tap' }],
      conditionalUnits: {
        condition: { kind: 'not', of: { kind: 'isUntapped' } },
        units: [['G']],
      },
    });
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeDefined();
    expect(state.ctx.state).toEqual(before.state);
    state.cast();
    expect(source.tapped).toBe(true);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.stack).toHaveLength(1);
  });

  it.each(['{G}{G}', '{G}{R}'])(
    'uses the linked constraint that becomes active after tapping for %s',
    (cost) => {
      const state = setup(cost);
      const source = state.source('Post-tap linked source', {
        units: [
          ['G', 'R'],
          ['G', 'R'],
        ],
        costs: [{ kind: 'tap' }],
        conditionalUnits: {
          condition: { kind: 'not', of: { kind: 'isUntapped' } },
          units: [
            ['G', 'R'],
            ['G', 'R'],
          ],
          linked: true,
        },
      });
      const before = cloneContractContext(state.ctx);
      if (cost === '{G}{R}') {
        expect(state.offered()).toBeUndefined();
        expect(state.ctx.state).toEqual(before.state);
        expect(() =>
          pump(
            applyPriorityAction(
              state.ctx,
              state.player,
              { kind: 'castSpell', objectId: state.card.id, fromCommand: false },
              { index: 0, targets: new Map() },
            ),
          ),
        ).toThrow();
        expect(state.ctx.state).toEqual(before.state);
        expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
      } else {
        state.cast();
        expect(source.tapped).toBe(true);
        expect(state.player.manaEntries).toEqual([]);
        expect(state.ctx.state.stack).toHaveLength(1);
      }
    },
  );

  it('drops a pre-cost linked constraint when tapping selects independent units', () => {
    const state = setup('{G}{R}');
    const source = state.source('Post-tap independent source', {
      units: [
        ['G', 'R'],
        ['G', 'R'],
      ],
      costs: [{ kind: 'tap' }],
      conditionalUnits: {
        condition: { kind: 'isUntapped' },
        units: [
          ['G', 'R'],
          ['G', 'R'],
        ],
        linked: true,
      },
    });
    state.cast();
    expect(source.tapped).toBe(true);
    expect(state.player.manaEntries).toEqual([]);
    expect(state.ctx.state.stack).toHaveLength(1);
  });

  it.each(['G', 'R'] as const)(
    'reads dynamic colors after sacrificing its own colored source for %s',
    (symbol) => {
      const state = setup(`{${symbol}}`);
      const source = state.source('Sacrificed dynamic source', {
        units: [],
        dynamic: 'oneColorAmongPermanents',
        costs: [{ kind: 'sacrificeSelf' }],
      });
      state.ctx.defs.set(source.oracleId, {
        ...state.ctx.defs.get(source.oracleId)!,
        colors: ['G'],
      });
      spawn(
        state.ctx,
        'P1',
        oracle({ name: 'Remaining red permanent', typeLine: 'Artifact', colors: ['R'] }),
      );
      const before = cloneContractContext(state.ctx);
      if (symbol === 'G') {
        expect(state.offered()).toBeUndefined();
        expect(state.ctx.state).toEqual(before.state);
      } else {
        state.cast();
        expect(state.ctx.state.battlefield).not.toContain(source);
        expect(state.player.graveyard.some((card) => card.cardId === source.cardId)).toBe(true);
        expect(state.player.manaEntries).toEqual([]);
      }
    },
  );

  it('fails visibly when an unbounded activation loop exceeds the supported witness budget', () => {
    const state = setup('{40}{G}');
    state.player.life = 1;
    state.source('Unbounded life loop source', {
      units: [['G']],
      costs: [{ kind: 'payLife', amount: 1 }],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
    });
    expect(state.offered).toThrow('depth budget exceeded');
    expect(state.player.life).toBe(1);
    expect(state.player.manaEntries).toEqual([]);
  });
});

it.each(['commanderIdentity', 'chosenColor'] as const)(
  'keeps invariant %s mana sources on the fixed solver for impossible and funded casts',
  (dynamic) => {
    const state = setup('{99}');
    const commander = conjure(
      state.ctx,
      'P1',
      oracle({
        name: 'Invariant commander',
        typeLine: 'Legendary Creature',
        colorIdentity: ['W', 'U', 'B', 'R', 'G'],
      }),
      'command',
      { isCommander: true },
    );
    state.player.commanderCardIds.push(commander.cardId);
    const sources = Array.from({ length: 8 }, (_, i) =>
      state.source(`Invariant source ${i}`, { units: [], dynamic }),
    );
    for (const source of sources) source.chosenOption = 'G';
    const before = cloneContractContext(state.ctx);
    expect(state.offered()).toBeUndefined();
    expect(state.ctx.state).toEqual(before.state);
    expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      manaCost: { generic: 1, colored: { W: 0, U: 0, B: 0, R: 0, G: 1 }, colorless: 0 },
    });
    state.cast();
    expect(sources.filter((source) => source.tapped)).toHaveLength(2);
    expect(state.ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(2);
  },
);

it('prunes an impossible fixed-production replay before the activation state budget', () => {
  const state = setup('{99}', [{ kind: 'payLife', amount: 1 }]);
  for (let i = 0; i < 12; i++)
    state.source(`Life capacity source ${i}`, {
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
    });
  const before = cloneContractContext(state.ctx);
  expect(state.offered()).toBeUndefined();
  expect(state.ctx.state).toEqual(before.state);
  expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
});

describe('the mana planner on the stops main still had (bug 16)', () => {
  type Board = ReturnType<typeof setup>;
  const ANY_COLOR = ['W', 'U', 'B', 'R', 'G'] as const;
  const ANY: ManaAbilitySpec['units'] = [[...ANY_COLOR]];
  const treasure: ManaAbilitySpec = {
    units: ANY,
    costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }],
  };
  const manaSpent = (state: Board) => state.ctx.state.stack[0]?.triggerScope?.manaSpent;
  /** An untapped Exotic Orchard with no opposing land: it makes no mana, but the search runs. */
  const inertOrchard = (state: Board) =>
    state.source('Exotic Orchard', { units: [], dynamic: 'opponentLandColors' });
  /** Distinct plain rocks: no two merge, so an unbounded search walks their subsets. */
  const rocks = (state: Board, count: number) => {
    for (let i = 0; i < count; i++) state.source(`Plain rock ${i}`, { units: ANY });
  };
  // `MTG_VERIFY_MANA_PLAN=1` runs every search twice, so the work counters differ.
  const verifying = process.env['MTG_VERIFY_MANA_PLAN'] === '1';
  /** The impossible cost is not offered, with no throw and next to no search. */
  const provesImpossible = (state: Board) => {
    const before = engineWork();
    expect(state.offered()).toBeUndefined();
    if (!verifying) expect(engineWorkSince(before).manaPlannerStates).toBeLessThan(100);
  };
  const withDefinition = (state: Board, name: string, typeLine: string, patch: object) => {
    const spawned = spawn(state.ctx, state.player.id, oracle({ name, typeLine }));
    state.ctx.defs.set(spawned.oracleId, { ...state.ctx.defs.get(spawned.oracleId)!, ...patch });
    return spawned;
  };
  /** Casts the offered spell, answering each unforced decision from the script. */
  const castWith = (state: Board, steps: Parameters<typeof script>[0] = []) => {
    const option = state.offered();
    expect(option).toBeDefined();
    return pump(
      applyPriorityAction(state.ctx, state.player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      script(steps),
    );
  };

  describe('a pay-life or pay-energy source keeps the capacity bound (fuzz-284, fuzz-307)', () => {
    /** "{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact." */
    const spire: ManaAbilitySpec = {
      units: ANY,
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 1 }],
      condition: countPermanents(ofType('Artifact'), 'you', '>=', 1),
    };
    const painland: ManaAbilitySpec = {
      units: [['R'], ['G']],
      onActivate: [{ op: 'damageController', amount: 1 }],
    };
    function spireBoard(manaCost: string, withArtifact: boolean) {
      const state = setup(manaCost);
      const land = (name: string, abilities: ManaAbilitySpec[]) =>
        withDefinition(state, name, 'Land', { manaAbilities: abilities });
      land('Spire of Industry', [spire]);
      for (let i = 0; i < 2; i++) land(`Forest ${i}`, [{ units: [['G']] }]);
      for (let i = 0; i < 2; i++) land(`Mountain ${i}`, [{ units: [['R']] }]);
      land('Sheltered Thicket', [{ units: [['R'], ['G']] }]);
      for (let i = 0; i < 2; i++) land(`Karplusan Forest ${i}`, [{ units: [['C']] }, painland]);
      if (withArtifact)
        spawn(state.ctx, state.player.id, oracle({ name: 'Trinket', typeLine: 'Artifact' }));
      return state;
    }

    it('proves {1}{U} impossible while the Spire gate is shut, in a handful of states', () => {
      provesImpossible(spireBoard('{1}{U}', false));
    });

    it('pays {1}{U} with the Spire, losing 1 life, once an artifact opens its gate', () => {
      const state = spireBoard('{1}{U}', true);
      const life = state.player.life;
      state.cast();
      expect(state.player.life).toBe(life - 1);
      expect(manaSpent(state)).toBe(2);
    });

    it('does not offer the {U} when the payer has no life to pay', () => {
      const state = spireBoard('{1}{U}', true);
      state.player.life = 0;
      expect(state.offered()).toBeUndefined();
    });

    /** Solar Transformer: "{T}: Add {C}." and "{T}, Pay {E}: Add one mana of any color." */
    function transformerBoard(manaCost: string, energy: number) {
      const state = setup(manaCost);
      state.player.energy = energy;
      inertOrchard(state);
      withDefinition(state, 'Solar Transformer', 'Artifact', {
        manaAbilities: [
          { units: [['C']] },
          { units: ANY, costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] },
        ],
      });
      rocks(state, 9);
      return state;
    }

    it('counts a card with two abilities, one paying energy, as one activation', () => {
      provesImpossible(transformerBoard('{11}', 3));
    });

    it('still pays exactly at capacity with the energy ability, spending the energy', () => {
      const state = transformerBoard('{10}', 3);
      state.cast();
      expect(manaSpent(state)).toBe(10);
    });

    // Ten colored pips: the Transformer's `{C}` pays none of them, so its energy ability is needed.
    const tenColored = '{W}{W}{U}{U}{B}{B}{R}{R}{G}{G}';

    it('pays a cost that needs the energy ability while the payer has energy', () => {
      const state = transformerBoard(tenColored, 1);
      state.cast();
      expect(manaSpent(state)).toBe(10);
      expect(state.player.energy).toBe(0);
    });

    it('does not offer a cost that needs the energy ability when the payer has no energy', () => {
      expect(transformerBoard(tenColored, 0).offered()).toBeUndefined();
    });
  });

  describe('statics that read only what a payment cannot change (fuzz-179, fuzz-276)', () => {
    const premiseStatics = {
      'controlsYourCommander (Thunderfoot Baloth)': {
        affects: { kind: 'self' },
        op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 },
        condition: { kind: 'controlsYourCommander' },
      },
      'devotion (Xenagos, God of Revels)': {
        affects: { kind: 'self' },
        op: { layer: 4, removeCreatureType: true },
        condition: {
          kind: 'compareValues',
          left: { kind: 'devotionTo', color: 'R', and: 'G' },
          cmp: '<=',
          right: { kind: 'const', n: 6 },
        },
      },
    } as const;
    function withStatic(manaCost: string, rule: unknown) {
      const state = setup(manaCost);
      inertOrchard(state);
      withDefinition(state, 'Static holder', 'Creature — God', { staticEffects: [rule] });
      rocks(state, 12);
      return state;
    }

    it.each(Object.entries(premiseStatics))('%s keeps the premise', (_name, rule) => {
      expect(characteristicsFixedDuringPayment([{ staticEffects: [rule], ruleStatics: [] }])).toBe(
        true,
      );
    });

    it.each(Object.entries(premiseStatics))(
      'proves one pip above capacity impossible with a %s static in play',
      (_name, rule) => {
        provesImpossible(withStatic('{13}', rule));
      },
    );

    it.each(Object.entries(premiseStatics))(
      'still pays exactly at capacity with a %s static in play',
      (_name, rule) => {
        const state = withStatic('{12}', rule);
        state.cast();
        expect(manaSpent(state)).toBe(12);
      },
    );

    it('a static a permanent leaving can start keeps the sacrifice bounds off', () => {
      const holder = (condition: unknown) => [
        {
          staticEffects: [
            { affects: { kind: 'self' }, op: { layer: 6, addKeyword: 'flying' }, condition },
          ],
          ruleStatics: [],
        },
      ];
      const count = (cmp: string) => ({
        kind: 'countPermanents',
        selector: ofType('Dragon'),
        scope: 'you',
        cmp,
        n: 1,
      });
      const devotion = {
        kind: 'compareValues',
        left: { kind: 'devotionTo', color: 'R' },
        cmp: '<=',
        right: { kind: 'const', n: 2 },
      };
      expect(leavingPermanentsKeepProduction(holder(devotion), false)).toBe(false);
      expect(leavingPermanentsKeepProduction(holder(count('<=')), false)).toBe(false);
      expect(leavingPermanentsKeepProduction(holder({ kind: 'not', of: count('>=') }), false)).toBe(
        false,
      );
      expect(leavingPermanentsKeepProduction(holder(count('>=')), false)).toBe(true);
      expect(leavingPermanentsKeepProduction(holder({ kind: 'enteredThisTurn' }), false)).toBe(
        true,
      );
      expect(
        leavingPermanentsKeepProduction(holder({ kind: 'controlsYourCommander' }), false),
      ).toBe(true);
      expect(leavingPermanentsKeepProduction(holder({ kind: 'yourTurn' }), false)).toBe(true);
    });

    it('a damage replacement and a life tax give no production back when they end (fuzz-552)', () => {
      const rule = (ruleStatic: object) =>
        [{ staticEffects: [], ruleStatics: [ruleStatic] }] as never;
      expect(
        leavingPermanentsKeepProduction(
          rule({
            kind: 'damageReplacement',
            sourceFilter: { kind: 'controller', who: 'you' },
            recipient: 'opponents',
            factor: 2,
          }),
          false,
        ),
      ).toBe(true);
      expect(
        leavingPermanentsKeepProduction(rule({ kind: 'targetLifeTax', amount: 3 }), false),
      ).toBe(true);
      // A rule that can matter to production still keeps the bound off.
      expect(leavingPermanentsKeepProduction(rule({ kind: 'cantActivateAbilities' }), false)).toBe(
        false,
      );
    });
  });

  describe('a conditional source beside a self-sacrificing one (fuzz-123)', () => {
    const caryatid: ManaAbilitySpec = {
      units: ANY,
      conditionalUnits: {
        condition: countPermanents(allOf(ofType('Creature'), powerAtLeast(4)), 'you', '>=', 1),
        units: [ANY[0]!, ANY[0]!],
        linked: true,
      },
    };
    function board(manaCost: string) {
      const state = setup(manaCost);
      state.source('Caryatid', caryatid);
      state.source('Treasure', treasure);
      rocks(state, 8);
      return state;
    }

    it('counts the Caryatid at the most it can make, and proves one pip above impossible', () => {
      // Ten cards, the Caryatid at two: eleven units. The Treasure leaves, so the gate is not fixed.
      provesImpossible(board('{12}'));
    });

    it('still pays exactly at the most the Caryatid can make', () => {
      const state = board('{11}');
      spawn(
        state.ctx,
        state.player.id,
        oracle({ name: 'Big Bear', typeLine: 'Creature — Bear', power: '4', toughness: '4' }),
      );
      state.cast();
      expect(manaSpent(state)).toBe(11);
    });
  });

  describe('a tap-a-creature source (fuzz-282, fuzz-407, fuzz-410, fuzz-515)', () => {
    const tapACreature: AbilityCost[] = [{ kind: 'tap' }, tapOther(ofType('Creature'))];
    const sentinel = (state: Board) =>
      withDefinition(state, 'Sentinel', 'Artifact', {
        manaAbilities: [{ units: ANY, costs: tapACreature }],
      });
    const holdout = (state: Board) =>
      withDefinition(state, 'Holdout', 'Land', {
        manaAbilities: [{ units: [['G']] }, { units: [['G']], costs: tapACreature }],
      });
    /** A creature with "{T}: Add {G}", and one that makes no mana. */
    const elf = (state: Board, name: string) =>
      withDefinition(state, name, 'Creature', { manaAbilities: [{ units: [['G']] }] });
    const bystander = (state: Board, name: string) =>
      withDefinition(state, name, 'Creature', { manaAbilities: [] });
    const creature = (state: Board) => {
      inertOrchard(state);
      return spawn(state.ctx, state.player.id, bear());
    };
    const tappedNames = (state: Board) =>
      state.ctx.state.battlefield
        .filter(
          (p) => p.tapped && p.controllerId === state.player.id && p.name !== 'Exotic Orchard',
        )
        .map((p) => p.name)
        .sort();

    it('fuzz-410 shape: a lone tap-a-creature source cannot pay two pips, and nothing halts', () => {
      const state = setup('{G/W}{G/W}');
      sentinel(state);
      creature(state);
      expect(state.offered()).toBeUndefined();
    });

    it('fuzz-515 shape: one unit per card makes six against seven, and nothing halts', () => {
      const state = setup('{4}{G}{G}{G}');
      state.source('Forest', { units: [['G']] });
      holdout(state);
      state.source('Sol Ring', { units: [['C'], ['C']] });
      creature(state);
      expect(state.offered()).toBeUndefined();
    });

    it('keeps offering a cost the board pays without the tap-a-creature ability', () => {
      const state = setup('{G}');
      sentinel(state);
      for (let i = 0; i < 2; i++) state.source(`Forest ${i}`, { units: [['G']] });
      creature(state);
      expect(state.offered()).toBeDefined();
    });

    it('does not prove a board with a sacrifice-another source impossible', () => {
      // Forest 1 + two creatures sacrificed to the Altar, 2 each = 5, though one card each gives 4.
      const state = setup('{5}');
      sentinel(state);
      state.source('Forest', { units: [['G']] });
      state.source("Ashnod's Altar", {
        units: [['C'], ['C']],
        costs: [{ kind: 'sacrificeOther', selector: ofType('Creature') }],
      });
      creature(state);
      creature(state);
      expect(state.offered()).toBeDefined();
    });

    it('pays where the cost needs the tap-a-creature ability (Sentinel taps a third creature)', () => {
      const state = setup('{2}{G}');
      inertOrchard(state);
      sentinel(state);
      elf(state, 'Elf 0');
      elf(state, 'Elf 1');
      bystander(state, 'Bystander');
      castWith(state);
      expect(tappedNames(state)).toEqual(['Bystander', 'Elf 0', 'Elf 1', 'Sentinel']);
    });

    it('does not offer a cost that needs one creature twice, and does not halt', () => {
      const state = setup('{2}{G}');
      inertOrchard(state);
      sentinel(state);
      elf(state, 'Elf 0');
      elf(state, 'Elf 1');
      // The Sentinel must tap an elf, which then cannot make its own mana: two mana, not three.
      expect(state.offered()).toBeUndefined();
    });

    it('fuzz-407 shape: Holdout is the only white, and the player picks which creature to tap', () => {
      const state = setup('{3}{W}');
      inertOrchard(state);
      withDefinition(state, 'Holdout', 'Land', {
        manaAbilities: [{ units: [['C']] }, { units: ANY, costs: tapACreature }],
      });
      for (let i = 0; i < 3; i++) elf(state, `Elf ${i}`);
      bystander(state, 'Bystander');
      bystander(state, 'Bystander 2');
      castWith(state, [
        { prompt: 'choose a permanent to tap as an activation cost', choose: /^Tap Bystander 2$/ },
      ]);
      expect(tappedNames(state)).toEqual(['Bystander 2', 'Elf 0', 'Elf 1', 'Elf 2', 'Holdout']);
    });

    it('keeps halting where a tap for the cost would raise another source', () => {
      // Tapping the Bystander for the Sentinel's cost first makes the other source add {G}{G}:
      // payable, but only in that order, which the final payment does not explore.
      const state = setup('{G}{G}{G}');
      inertOrchard(state);
      withDefinition(state, 'Green Sentinel', 'Artifact', {
        manaAbilities: [{ units: [['G']], costs: tapACreature }],
      });
      bystander(state, 'Bystander');
      state.source('Tapped-creature source', {
        units: [['G']],
        conditionalUnits: {
          condition: countPermanents(allOf(ofType('Creature'), { kind: 'tapped' }), 'you', '>=', 1),
          units: [['G'], ['G']],
        },
      });
      expect(state.offered).toThrow('outside the proven scope');
    });

    it('keeps halting where the creature to tap could also be sacrificed for mana', () => {
      // Sentinel taps Wild Cantor for its cost, then the tapped Cantor is sacrificed for {G}:
      // payable, but only in that order, which the final payment does not explore. A halt, not
      // a "not payable".
      const state = setup('{G}{G}');
      inertOrchard(state);
      sentinel(state);
      withDefinition(state, 'Wild Cantor', 'Creature', {
        manaAbilities: [{ units: ANY, costs: [{ kind: 'sacrificeSelf' }] }],
      });
      expect(state.offered).toThrow('outside the proven scope');
    });

    it('keeps halting for a tap-a-creature source with a rider', () => {
      const state = setup('{G}{G}');
      inertOrchard(state);
      withDefinition(state, 'Rider Sentinel', 'Artifact', {
        manaAbilities: [
          {
            units: ANY,
            costs: tapACreature,
            onActivate: [{ op: 'damageController', amount: 1 }],
          },
        ],
      });
      state.source('Forest', { units: [['G']] });
      bystander(state, 'Bystander');
      expect(state.offered).toThrow('outside the proven scope');
    });

    it('keeps halting for a source that taps several creatures', () => {
      const state = setup('{G}{G}');
      inertOrchard(state);
      withDefinition(state, 'Two-tap source', 'Artifact', {
        manaAbilities: [
          {
            units: ANY,
            costs: [{ kind: 'tap' }, { kind: 'tapOthers', count: 2, selector: ofType('Creature') }],
          },
        ],
      });
      state.source('Forest', { units: [['G']] });
      bystander(state, 'Bystander');
      bystander(state, 'Bystander 2');
      expect(state.offered).toThrow('outside the proven scope');
    });
  });

  describe('a sacrifice source after a first search that spends its budget (fuzz-495, fuzz-552)', () => {
    const altar = (state: Board) =>
      state.source("Ashnod's Altar", {
        units: [['C'], ['C']],
        costs: [{ kind: 'sacrificeOther', selector: ofType('Creature') }],
      });
    const lands = (state: Board, count: number, symbols: readonly ('U' | 'B' | 'R' | 'C')[]) => {
      for (let i = 0; i < count; i++)
        state.source(`Land ${i}`, { units: [[symbols[i % symbols.length]!]] });
    };
    const bystander = (state: Board, name: string) =>
      withDefinition(state, name, 'Creature', { manaAbilities: [] });

    it(
      'fuzz-495 shape: ten lands and an Altar are offered fourteen, though the first search spends its states',
      // The first search runs out of its 2048 states, each a copy of the game: slow by design.
      { timeout: 120_000 },
      () => {
        const state = setup('{11}{U}{B}{R}');
        inertOrchard(state);
        for (let i = 0; i < 10; i++) state.source(`Land ${i}`, { units: [['U', 'B', 'R']] });
        altar(state);
        bystander(state, 'Victim 0');
        bystander(state, 'Victim 1');
        expect(state.offered()).toBeDefined();
      },
    );

    it('fuzz-495 shape: with one creature the cost is not offered, and nothing halts', () => {
      const state = setup('{11}{U}{B}{R}');
      inertOrchard(state);
      lands(state, 10, ['U', 'B', 'R', 'C']);
      altar(state);
      bystander(state, 'Victim 0');
      expect(state.offered()).toBeUndefined();
    });

    // `MTG_VERIFY_MANA_PLAN=1` also runs the old search, which spends its whole state budget here.
    it(
      'fuzz-552 shape: with a damage doubler in play one sacrifice pays eight',
      { timeout: 120_000 },
      () => {
        const state = setup('{5}{U}{B}{R}');
        inertOrchard(state);
        lands(state, 7, ['U', 'B', 'R', 'C']);
        altar(state);
        bystander(state, 'Victim 0');
        const doubler = spawn(
          state.ctx,
          state.ctx.state.players[1]!.id,
          oracle({ name: 'Doubler' }),
        );
        state.ctx.defs.set(doubler.oracleId, {
          ...state.ctx.defs.get(doubler.oracleId)!,
          ruleStatics: [
            {
              kind: 'damageReplacement',
              sourceFilter: { kind: 'controller', who: 'you' },
              recipient: 'opponents',
              factor: 2,
            },
          ],
        });
        castWith(state, []);
        expect(state.ctx.state.stack).toHaveLength(1);
        expect(state.ctx.state.battlefield.some((p) => p.name === 'Victim 0')).toBe(false);
      },
    );
  });
});
