import { describe, expect, it, vi } from 'vitest';
import { enforceCardDefinition } from '../src/cards/authoring-validation';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { AbilityCost, ManaAbilitySpec } from '../src/cards/ability';
import { createGame } from '../src/state/game';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { countPermanents } from '../src/cards/condition';
import { OTHER, YOURS, allOf, ofType, powerAtLeast } from '../src/cards/selector';
import { tapOther } from '../src/cards/templates';
import { needsStatefulManaPayment } from '../src/mana/stateful-payment';
import { parseManaCost } from '../src/mana/cost';
import { engineWork, engineWorkSince } from '../src/work-counters';
import { cloneContractContext } from './helpers/contract-harness';
import { leavingPermanentsKeepProduction } from '../src/mana/payment-stability';

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

function parsedCost(cost: string) {
  const parsed = parseManaCost(cost as never);
  if (parsed.cost === null) throw new Error(`bad cost ${cost}`);
  return parsed.cost;
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

const ANY_COLOR = ['W', 'U', 'B', 'R', 'G'] as const;
const treasure: ManaAbilitySpec = {
  units: [[...ANY_COLOR]],
  costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }],
};
const countedRock: ManaAbilitySpec = { units: [['C']], amount: { kind: 'const', n: 1 } };

describe('stateful payment search limits', () => {
  it('offers a {U} cast with 33 Treasures instead of throwing at the first deep dead end', () => {
    const state = setup('{U}');
    // A counted amount makes the payment stateful; the Treasures are tried before it.
    for (let i = 0; i < 33; i++) state.source(`Treasure ${i}`, treasure);
    state.source('Counting rock', countedRock);
    expect(state.offered()).toBeDefined();
    state.cast();
    expect(state.ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(1);
    // One pip costs one Treasure, not the 32 a search that piles up {W} first would sacrifice.
    expect(state.ctx.state.battlefield.filter((p) => p.name.startsWith('Treasure '))).toHaveLength(
      32,
    );
  });

  it('still throws the depth error when the cost needs more than 32 replayed activations', () => {
    const state = setup('{33}');
    state.player.life = 100;
    // One repeatable source: the plan needs 33 activations, one more than the search replays.
    state.source('Repeatable source', {
      units: [['G']],
      costs: [{ kind: 'payLife', amount: 1 }],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
    });
    expect(state.offered).toThrow('depth budget exceeded');
  });

  const conditionalRock: ManaAbilitySpec = {
    units: [[...ANY_COLOR]],
    conditionalUnits: {
      condition: countPermanents(allOf(ofType('Creature'), powerAtLeast(4)), 'you', '>=', 1),
      units: [[...ANY_COLOR], [...ANY_COLOR]],
      linked: true,
    },
  };
  const board = (state: ReturnType<typeof setup>) => {
    state.source('Conditional rock', conditionalRock);
    for (let i = 0; i < 9; i++) state.source(`Plain rock ${i}`, { units: [[...ANY_COLOR]] });
  };

  it('proves a cost one mana above conditional capacity impossible without a search or error', () => {
    const state = setup('{12}');
    board(state);
    const before = engineWork();
    expect(state.offered()).toBeUndefined();
    const work = engineWorkSince(before);
    // The unbounded search walks its whole 2048-state budget before giving up.
    expect(work.manaPlannerStates).toBeLessThan(100);
  });

  it('still pays a cost exactly at capacity once the conditional source makes two', () => {
    const state = setup('{11}');
    board(state);
    spawn(
      state.ctx,
      state.player.id,
      oracle({ name: 'Big Bear', typeLine: 'Creature — Bear', power: '4', toughness: '4' }),
    );
    state.cast();
    expect(state.ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(11);
  });
});

describe('identical sources in the stateful payment search', () => {
  // `MTG_VERIFY_MANA_PLAN=1` runs every search twice, so the work counters double.
  const runs = process.env['MTG_VERIFY_MANA_PLAN'] === '1' ? 2 : 1;
  const orchard: ManaAbilitySpec = { units: [], dynamic: 'opponentLandColors' };
  /**
   * The state-dependent source that makes the stateful search run (Exotic Orchard), untapped and
   * with no opposing land, so it makes no mana itself. A tapped one no longer does (bug 12).
   */
  function withOrchard(state: ReturnType<typeof setup>) {
    return state.source('Exotic Orchard', orchard);
  }
  const treasures = (state: ReturnType<typeof setup>) =>
    state.ctx.state.battlefield.filter((p) => p.name === 'Treasure');

  it('casts a nine-pip cost from 48 Treasures in few states', () => {
    const state = setup('{4}{W}{U}{B}{R}{G}');
    withOrchard(state);
    for (let i = 0; i < 48; i++) state.source('Treasure', treasure);
    const before = engineWork();
    expect(state.offered()).toBeDefined();
    const work = engineWorkSince(before);
    expect(work.manaPlannerStates).toBeLessThan(500 * runs);
    state.cast();
    expect(treasures(state)).toHaveLength(39);
    expect(state.ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(9);
  }, 60_000);

  it('does not offer an eight-mana cast from seven Treasures, and does not throw', () => {
    const state = setup('{8}');
    withOrchard(state);
    for (let i = 0; i < 7; i++) state.source('Treasure', treasure);
    const before = engineWork();
    expect(state.offered()).toBeUndefined();
    // The capacity bound proves 7 < 8 at the root: no search at all.
    // The root of the {8} search is pruned; the rest is the probe spell's own {1}{G} search.
    expect(engineWorkSince(before).manaPlannerStates).toBeLessThan(40 * runs);
  });

  it('keeps the capacity bound off when an own dynamic source reads the permanents sacrificed', () => {
    const state = setup('{9}');
    state.source('Color reader', { units: [], dynamic: 'oneColorAmongPermanents' });
    for (let i = 0; i < 7; i++) state.source('Treasure', treasure);
    const before = engineWork();
    // Not pruned at the root: a sacrifice can change what that source makes.
    expect(state.offered()).toBeUndefined();
    expect(engineWorkSince(before).manaPlannerStates).toBeGreaterThan(300 * runs);
  });

  describe('what keeps two Treasures apart', () => {
    /**
     * Seven Treasures make one mana less than {9}; the counted rock turns the capacity bound off,
     * so the search must walk every branch it cannot merge. Identical Treasures are one branch per
     * level and the search ends inside its budget; a Treasure that differs is a branch of its own
     * and brings the search past the budget (the planner halts rather than guess).
     */
    function impossibleBoard(mark: (state: ReturnType<typeof setup>) => void) {
      const state = setup('{9}');
      state.source('Counting rock', countedRock);
      for (let i = 0; i < 7; i++) state.source('Treasure', treasure);
      mark(state);
      return state;
    }

    it('searches identical Treasures as one branch per level', () => {
      const state = impossibleBoard(() => undefined);
      const before = engineWork();
      expect(state.offered()).toBeUndefined();
      expect(engineWorkSince(before).manaPlannerStates).toBeLessThan(2048 * 3 * runs);
    });

    it('does not merge a Treasure that has a counter', () => {
      const state = impossibleBoard((board) => {
        treasures(board)[0]!.counters['+1/+1'] = 1;
      });
      expect(state.offered).toThrow('state budget exceeded');
    });

    it('does not merge a Treasure that something is attached to', () => {
      const state = impossibleBoard((board) => {
        const aura = spawn(
          board.ctx,
          board.player.id,
          oracle({ name: 'Aura probe', typeLine: 'Enchantment — Aura' }),
        );
        aura.attachedTo = treasures(board)[0]!.id;
      });
      expect(state.offered).toThrow('state budget exceeded');
    });
  });
});

describe('a pay-life mana source keeps the capacity bound on', () => {
  // `MTG_VERIFY_MANA_PLAN=1` also runs the old search, so the state counts differ.
  const runs = process.env['MTG_VERIFY_MANA_PLAN'] === '1' ? 2 : 1;
  const ANY: ManaAbilitySpec['units'] = [[...ANY_COLOR]];
  /** "{T}, Pay 1 life: Add one mana of any color. Activate only if you control an artifact." */
  const spireOfIndustry: ManaAbilitySpec = {
    units: ANY,
    costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 1 }],
    condition: countPermanents(ofType('Artifact'), 'you', '>=', 1),
  };
  const painland: ManaAbilitySpec = {
    units: [['R'], ['G']],
    onActivate: [{ op: 'damageController', amount: 1 }],
  };

  /** A board shaped like fuzz-77: no blue source but the Spire, every other source a land. */
  function fuzz77Board(manaCost: string, withArtifact: boolean) {
    const state = setup(manaCost);
    const land = (name: string, abilities: ManaAbilitySpec[]) => {
      const permanent = spawn(state.ctx, state.player.id, oracle({ name, typeLine: 'Land' }));
      state.ctx.defs.set(permanent.oracleId, {
        ...state.ctx.defs.get(permanent.oracleId)!,
        manaAbilities: abilities,
      });
      return permanent;
    };
    land('Spire of Industry', [spireOfIndustry]);
    for (let i = 0; i < 2; i++) land(`Forest ${i}`, [{ units: [['G']] }]);
    for (let i = 0; i < 2; i++) land(`Mountain ${i}`, [{ units: [['R']] }]);
    land('Sheltered Thicket', [{ units: [['R'], ['G']] }]);
    for (let i = 0; i < 2; i++) land(`Karplusan Forest ${i}`, [{ units: [['C']] }, painland]);
    if (withArtifact)
      spawn(state.ctx, state.player.id, oracle({ name: 'Trinket', typeLine: 'Artifact' }));
    return state;
  }

  it('proves {1}{U} impossible while the Spire gate is shut, in a handful of states', () => {
    const state = fuzz77Board('{1}{U}', false);
    const before = engineWork();
    expect(state.offered()).toBeUndefined();
    const work = engineWorkSince(before);
    // Unbounded, the search tries every subset of the seven other lands (1031 states before the
    // fix). The verify run also runs the old search, which keeps the gated source unbounded.
    if (runs === 1) {
      expect(work.manaPlannerStates).toBeLessThan(20);
      expect(work.stateCopies).toBeLessThan(20);
    }
  });

  it('pays {1}{U} with the Spire, losing 1 life, once an artifact opens its gate', () => {
    const state = fuzz77Board('{1}{U}', true);
    const life = state.player.life;
    state.cast();
    expect(state.player.life).toBe(life - 1);
    expect(state.ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(2);
  });

  it('follows the engine rule that a life payment may take the payer to 0', () => {
    const state = fuzz77Board('{1}{U}', true);
    state.player.life = 1;
    state.cast();
    expect(state.player.life).toBe(0);
  });

  it('does not offer the {U} when the payer has no life to pay', () => {
    const state = fuzz77Board('{1}{U}', true);
    state.player.life = 0;
    expect(state.offered()).toBeUndefined();
  });
});

describe('the capacity bound on small boards (bug 09)', () => {
  // `MTG_VERIFY_MANA_PLAN=1` runs every search twice, so the work counters double.
  const runs = process.env['MTG_VERIFY_MANA_PLAN'] === '1' ? 2 : 1;
  // The verify run walks the old search's whole state budget on each impossible board here.
  vi.setConfig({ testTimeout: 30_000 });
  const ANY: ManaAbilitySpec['units'] = [[...ANY_COLOR]];
  type Board = ReturnType<typeof setup>;

  /** An untapped Exotic Orchard with no opposing land: stateful, and it offers no mana itself. */
  function inertOrchard(state: Board) {
    state.source('Exotic Orchard', { units: [], dynamic: 'opponentLandColors' });
  }
  /** Distinct plain rocks: no two merge, so an unbounded search walks their subsets. */
  function rocks(state: Board, count: number) {
    for (let i = 0; i < count; i++) state.source(`Plain rock ${i}`, { units: ANY });
  }
  const manaSpent = (state: Board) => state.ctx.state.stack[0]?.triggerScope?.manaSpent;
  /** The impossible cost is not offered, with no throw and next to no search. */
  function provesImpossible(state: Board) {
    const before = engineWork();
    expect(state.offered()).toBeUndefined();
    // The verify run also runs the old search, which has no bound for the counted, conditional
    // and self-sacrifice sources here and halts on its budget; the answer must not change.
    if (runs === 1) expect(engineWorkSince(before).manaPlannerStates).toBeLessThan(100);
  }

  const caryatid: ManaAbilitySpec = {
    units: ANY,
    conditionalUnits: {
      condition: countPermanents(allOf(ofType('Creature'), powerAtLeast(4)), 'you', '>=', 1),
      units: [ANY[0]!, ANY[0]!],
      linked: true,
    },
  };

  it('counts a conditional source at its base units while its gate cannot open (Ilysian Caryatid)', () => {
    const state = setup('{11}');
    state.source('Caryatid', caryatid);
    rocks(state, 9);
    // Ten units, with no creature of power 4 to make the Caryatid's second one.
    provesImpossible(state);
  });

  it('still pays a cost exactly at the conditional source base units', () => {
    const state = setup('{10}');
    state.source('Caryatid', caryatid);
    rocks(state, 9);
    state.cast();
    expect(manaSpent(state)).toBe(10);
  });

  /** Brigid, Doun's Mind: "Add X mana in any combination of {G} and/or {W}, X = other creatures". */
  const brigid: ManaAbilitySpec = {
    units: [['G', 'W']],
    amount: {
      kind: 'countPermanents',
      selector: allOf(ofType('Creature'), YOURS, OTHER),
      scope: 'all',
    },
    linked: true,
  };
  const withBrigid = (manaCost: string) => {
    const state = setup(manaCost);
    state.source('Brigid', brigid);
    for (let i = 0; i < 2; i++)
      spawn(
        state.ctx,
        state.player.id,
        oracle({ name: `Friend ${i}`, typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      );
    rocks(state, 8);
    return state;
  };

  it('counts a counted amount at its value now: Brigid makes two, so ten units pay at most {10}', () => {
    provesImpossible(withBrigid('{11}'));
  });

  /** Shanna, Sisay's Legacy: power and toughness equal to the creatures you control. */
  function withShanna(manaCost: string) {
    const state = withBrigid(manaCost);
    const count = {
      kind: 'countPermanents',
      selector: allOf(YOURS, ofType('Creature')),
      scope: 'you',
    };
    const shanna = spawn(
      state.ctx,
      state.player.id,
      oracle({
        name: 'Shanna',
        typeLine: 'Legendary Creature — Human',
        power: '0',
        toughness: '0',
      }),
    );
    state.ctx.defs.set(shanna.oracleId, {
      ...state.ctx.defs.get(shanna.oracleId)!,
      staticEffects: [
        {
          affects: { kind: 'self' },
          op: {
            layer: 7,
            sublayer: 'd',
            power: { kind: 'times', of: count, n: 1 },
            toughness: { kind: 'times', of: count, n: 1 },
          },
        },
      ] as never,
      ruleStatics: [{ kind: 'cantBeTargetedByOpponentAbilities' }] as never,
    });
    return state;
  }

  it('keeps the count at its value now beside a creature whose power is the creature count (Shanna)', () => {
    // Brigid counts three other creatures now: eleven units, so {12} is impossible, {11} payable.
    provesImpossible(withShanna('{12}'));
  });

  it('still pays exactly at the counted amount beside Shanna', () => {
    const state = withShanna('{11}');
    state.cast();
    expect(manaSpent(state)).toBe(11);
  });

  it('still pays a cost exactly at the counted amount', () => {
    const state = withBrigid('{10}');
    state.cast();
    expect(manaSpent(state)).toBe(10);
  });

  const barbarian: ManaAbilitySpec = { units: [['R'], ['R']], costs: [{ kind: 'sacrificeSelf' }] };

  it('counts a source that sacrifices itself with no {T} once (Reckless Barbarian)', () => {
    const state = setup('{11}');
    inertOrchard(state);
    state.source('Reckless Barbarian', barbarian);
    rocks(state, 8);
    provesImpossible(state);
  });

  it('still pays a cost exactly at a self-sacrifice source and the rocks', () => {
    const state = setup('{10}');
    inertOrchard(state);
    state.source('Reckless Barbarian', barbarian);
    rocks(state, 8);
    state.cast();
    expect(manaSpent(state)).toBe(10);
    expect(state.ctx.state.battlefield.some((p) => p.name === 'Reckless Barbarian')).toBe(false);
  });

  /** Solar Transformer: "{T}: Add {C}." and "{T}, Pay {E}: Add one mana of any color." */
  function withTransformer(manaCost: string) {
    const state = setup(manaCost);
    state.player.energy = 3;
    inertOrchard(state);
    const permanent = spawn(
      state.ctx,
      state.player.id,
      oracle({ name: 'Solar Transformer', typeLine: 'Artifact' }),
    );
    state.ctx.defs.set(permanent.oracleId, {
      ...state.ctx.defs.get(permanent.oracleId)!,
      manaAbilities: [
        { units: [['C']] },
        { units: ANY, costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] },
      ],
    });
    rocks(state, 9);
    return state;
  }

  it('counts a card with two mana abilities, one of them paying energy, as one activation', () => {
    // The Transformer is one `{T}`: ten units, not eleven.
    provesImpossible(withTransformer('{11}'));
  });

  it('still pays a cost exactly at capacity with the energy ability', () => {
    const state = withTransformer('{10}');
    state.cast();
    expect(manaSpent(state)).toBe(10);
  });

  /** Statics that read the turn, the commander or devotion, never what a payment changes. */
  const premiseStatics = {
    'enteredThisTurn (Zurgo and Ojutai)': {
      affects: { kind: 'self' },
      op: { layer: 6, addKeyword: 'hexproof' },
      condition: { kind: 'enteredThisTurn' },
    },
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
    const holder = spawn(
      state.ctx,
      state.player.id,
      oracle({ name: 'Static holder', typeLine: 'Creature — God', power: '3', toughness: '3' }),
    );
    state.ctx.defs.set(holder.oracleId, {
      ...state.ctx.defs.get(holder.oracleId)!,
      staticEffects: [rule] as never,
    });
    rocks(state, 12);
    return state;
  }

  it.each(Object.entries(premiseStatics))(
    'keeps the premise, so the bound runs, with a %s static in play',
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

  it('keeps the sacrifice bounds off for a static that a permanent leaving can start', () => {
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
    expect(leavingPermanentsKeepProduction(holder(count('>=')), false)).toBe(true);
    expect(leavingPermanentsKeepProduction(holder({ kind: 'enteredThisTurn' }), false)).toBe(true);
  });

  describe('a tapped dynamic source (bug 12, fuzz-392)', () => {
    const orchard: ManaAbilitySpec = { units: [], dynamic: 'opponentLandColors' };
    function opposingForest(state: Board) {
      spawn(
        state.ctx,
        state.ctx.state.players[1]!.id,
        oracle({ name: 'Opposing Forest', typeLine: 'Basic Land — Forest', manaCost: null }),
      );
    }
    function board(orchardAbility: ManaAbilitySpec, tapped: boolean) {
      const state = setup('{32}{R}');
      opposingForest(state);
      state.source('Exotic Orchard', orchardAbility).tapped = tapped;
      for (let i = 0; i < 36; i++) state.source('Treasure', treasure);
      return state;
    }

    it('offers and casts {32}{R} from 36 Treasures beside a tapped Exotic Orchard', () => {
      const state = board(orchard, true);
      expect(state.offered()).toBeDefined();
      state.cast();
      expect(manaSpent(state)).toBe(33);
      expect(state.ctx.state.battlefield.filter((p) => p.name === 'Treasure')).toHaveLength(3);
    });

    it('still takes the stateful path for an untapped Exotic Orchard (33 activations are over the depth limit)', () => {
      const state = board(orchard, false);
      expect(state.offered).toThrow('budget exceeded');
    });

    it('keeps the stateful path when a mana ability could untap the Orchard', () => {
      // The pool has no mana ability that untaps (a rider is damage, life or counters), and the
      // engine refuses to list one, so ask the predicate directly with an inline ability.
      const needs = (extra?: ManaAbilitySpec) => {
        const state = setup('{2}');
        opposingForest(state);
        state.source('Exotic Orchard', orchard).tapped = true;
        if (extra) state.source('Untapper', extra);
        return needsStatefulManaPayment(state.ctx, state.player, parsedCost('{2}'), 0);
      };
      const untapper = {
        units: [[...ANY_COLOR]],
        onActivate: [{ op: 'untapEach', selector: ofType('Land') }],
      } as unknown as ManaAbilitySpec;
      expect(needs()).toBe(false);
      expect(needs(untapper)).toBe(true);
    });
  });
});

describe('an unpayable cost is not offered instead of halting (bug 14)', () => {
  // `MTG_VERIFY_MANA_PLAN=1` also runs the old search, so the state counts differ.
  const runs = process.env['MTG_VERIFY_MANA_PLAN'] === '1' ? 2 : 1;
  const ANY: ManaAbilitySpec['units'] = [[...ANY_COLOR]];
  type Board = ReturnType<typeof setup>;
  const tapACreature: AbilityCost[] = [{ kind: 'tap' }, tapOther(ofType('Creature'))];
  /** A permanent with these mana abilities; `typeLine` makes it a creature when it should be one. */
  const permanent = (
    state: Board,
    name: string,
    typeLine: string,
    abilities: ManaAbilitySpec[],
  ) => {
    const spawned = spawn(state.ctx, state.player.id, oracle({ name, typeLine }));
    state.ctx.defs.set(spawned.oracleId, {
      ...state.ctx.defs.get(spawned.oracleId)!,
      manaAbilities: abilities,
    });
  };
  /** Jaspera Sentinel: "{T}, Tap an untapped creature you control: Add one mana of any color." */
  const sentinel = (state: Board) =>
    permanent(state, 'Sentinel', 'Artifact', [{ units: ANY, costs: tapACreature }]);
  /** The stateful search runs for a dynamic source; an untapped Orchard with no opposing land. */
  const creature = (state: Board) => {
    state.source('Exotic Orchard', { units: [], dynamic: 'opponentLandColors' });
    return spawn(state.ctx, state.player.id, bear());
  };
  const holdout = (state: Board) =>
    permanent(state, 'Holdout', 'Land', [
      { units: [['G']] },
      { units: [['G']], costs: tapACreature },
    ]);
  const restInPeace = (state: Board) => {
    const spawned = spawn(
      state.ctx,
      state.player.id,
      oracle({ name: 'Rest in Peace', typeLine: 'Enchantment' }),
    );
    state.ctx.defs.set(spawned.oracleId, {
      ...state.ctx.defs.get(spawned.oracleId)!,
      ruleStatics: [
        { kind: 'graveyardToExile', scope: 'all', basis: 'owner', includeTokens: true },
      ],
    });
  };

  it('fuzz-410 shape: a lone tap-a-creature source cannot pay two pips', () => {
    const state = setup('{G/W}{G/W}');
    sentinel(state);
    creature(state);
    expect(state.offered()).toBeUndefined();
  });

  it('fuzz-515 shape: one unit per card makes six against seven', () => {
    const state = setup('{4}{G}{G}{G}');
    state.source('Forest', { units: [['G']] });
    holdout(state);
    state.source('Sol Ring', { units: [['C'], ['C']] });
    creature(state);
    expect(state.offered()).toBeUndefined();
  });

  it('keeps offering a cost the board pays without the tap-a-creature ability', () => {
    // The test's other castable card costs {1}{G}; two Forests pay it too, so only this cast matters.
    const state = setup('{G}');
    sentinel(state);
    for (let i = 0; i < 2; i++) state.source(`Forest ${i}`, { units: [['G']] });
    creature(state);
    expect(state.offered()).toBeDefined();
  });

  it('still halts, as before, where the cost needs the tap-a-creature ability', () => {
    const state = setup('{G}{G}');
    sentinel(state);
    state.source('Forest', { units: [['G']] });
    creature(state);
    expect(state.offered).toThrow('outside the proven scope');
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

  it('fuzz-490 shape: eight units against nine pips, beside Rest in Peace', () => {
    const state = setup('{4}{W}{U}{B}{R}{G}');
    for (let i = 0; i < 7; i++) state.source(`Land ${i}`, { units: ANY });
    state.source('Fellwar Stone', { units: [], dynamic: 'opponentLandColors' });
    state.source('Treasure', treasure);
    restInPeace(state);
    const before = engineWork();
    expect(state.offered()).toBeUndefined();
    expect(engineWorkSince(before).manaPlannerStates).toBeLessThan(100 * runs);
  });

  it('fuzz-490 shape still pays nine pips from nine units beside Rest in Peace', () => {
    const state = setup('{4}{W}{U}{B}{R}{G}');
    for (let i = 0; i < 8; i++) state.source(`Land ${i}`, { units: ANY });
    state.source('Fellwar Stone', { units: [], dynamic: 'opponentLandColors' });
    state.source('Treasure', treasure);
    restInPeace(state);
    expect(state.offered()).toBeDefined();
  });
});
