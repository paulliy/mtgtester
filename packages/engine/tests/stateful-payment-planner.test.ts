/**
 * H7: the stateful mana planner proves an unpayable cast impossible from a capacity bound that
 * gated sources now join, and searches a tap-only board over tapped sets instead of copied games.
 * Both must leave every answer as it was: the same plan (so the same lands are tapped), the same
 * null, the same error. Each agreement test runs the search both ways on one board.
 */
import { describe, expect, it } from 'vitest';
import type { Condition } from '../src/cards/condition';
import { parseManaCost, type ParsedManaCost } from '../src/mana/cost';
import {
  characteristicsFixedDuringPayment,
  gateCannotOpenDuringPayment,
} from '../src/mana/payment-stability';
import { searchPayment, tapOnlySource } from '../src/mana/stateful-payment';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { allowanceFor, manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, island, oracle, plains, spawn } from './fixtures';

const artifact = (name: string, oracleText: string) =>
  oracle({ name, typeLine: 'Artifact', oracleText, manaCost: '{2}', power: null, toughness: null });
const land = (name: string, oracleText: string) =>
  oracle({
    name,
    typeLine: 'Land',
    oracleText,
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });

const orchard = () =>
  land(
    'Exotic Orchard',
    '{T}: Add one mana of any color that a land an opponent controls could produce.',
  );
const mox = () =>
  artifact('Gated Mox', '{T}: Add one mana of any color. Activate only if you control a Dragon.');
const dragon = () =>
  oracle({
    name: 'Test Dragon',
    typeLine: 'Creature — Dragon',
    manaCost: '{4}{R}',
    power: '4',
    toughness: '4',
  });
const painland = () =>
  land('Test Painland', '{T}: Add {G} or {U}. This land deals 1 damage to you.');
const treasure = () =>
  artifact('Test Treasure', '{T}, Sacrifice this artifact: Add one mana of any color.');
const dual = () => land('Test Dual', '{T}: Add {W} or {G}.');

function board(build: (ctx: GameContext) => void): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  spawn(ctx, 'P2', island());
  spawn(ctx, 'P2', plains());
  build(ctx);
  return ctx;
}

type Outcome = { plan: unknown } | { error: string };

function search(
  ctx: GameContext,
  cost: ParsedManaCost,
  current: boolean,
  lifeReserved = 0,
): Outcome {
  const player = playerById(ctx, 'P1');
  const allows = allowanceFor(ctx, 'P1', {
    kind: 'castSpell',
    oracleId: 'none',
    isCommander: false,
  });
  try {
    return {
      plan: searchPayment(
        ctx,
        player,
        cost,
        allows,
        (context, payer) => manaSourcesFor(context, payer.id, true),
        new Set(),
        lifeReserved,
        0,
        current,
      ),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Both ways agree on `cost`; returns the shared outcome. */
function agree(ctx: GameContext, manaCost: string, lifeReserved = 0): Outcome {
  const cost = parseManaCost(manaCost).cost!;
  const before = JSON.stringify(ctx.state);
  const legacy = search(ctx, cost, false, lifeReserved);
  const current = search(ctx, cost, true, lifeReserved);
  expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
  expect(JSON.stringify(ctx.state)).toBe(before);
  return current;
}

const COSTS = [
  '{G}',
  '{W}',
  '{U}',
  '{1}{W}',
  '{W}{U}',
  '{2}{W}{W}',
  '{B}',
  '{3}{G}{U}',
  '{W/P}',
  '{9}',
];

describe('gate classifier', () => {
  const count = (selector: unknown, cmp: '>=' | '<=' = '>='): Condition =>
    ({ kind: 'countPermanents', selector, scope: 'you', cmp, n: 1 }) as Condition;

  it('stateful-planner-gate-stable — a "you control a Dragon" gate cannot open mid-payment', () => {
    expect(gateCannotOpenDuringPayment(count({ kind: 'subtype', value: 'Dragon' }))).toBe(true);
    expect(
      gateCannotOpenDuringPayment(
        count({
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'color', value: 'R' },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('stateful-planner-gate-unstable — fewer-than counts, tapped status and other kinds stay out', () => {
    expect(gateCannotOpenDuringPayment(count({ kind: 'subtype', value: 'Dragon' }, '<='))).toBe(
      false,
    );
    expect(gateCannotOpenDuringPayment(count({ kind: 'tapped' }))).toBe(false);
    expect(gateCannotOpenDuringPayment(count({ kind: 'not', of: { kind: 'tapped' } }))).toBe(false);
    expect(gateCannotOpenDuringPayment(count({ kind: 'isEnchanted' }))).toBe(false);
    expect(gateCannotOpenDuringPayment({ kind: 'giftPromised' })).toBe(false);
  });
});

describe('payment premise', () => {
  const holder = (staticEffects: unknown[], ruleStatics: unknown[] = []) => ({
    staticEffects,
    ruleStatics,
  });
  it('stateful-planner-premise — statics reading tapped status or life break it; board counts do not', () => {
    const lands = { kind: 'type', value: 'Land' };
    const op = { layer: 6, loseAllAbilities: true };
    expect(characteristicsFixedDuringPayment([holder([{ affects: lands, op }])])).toBe(true);
    expect(
      characteristicsFixedDuringPayment([
        holder([
          {
            affects: lands,
            op,
            condition: { kind: 'countPermanents', selector: lands, scope: 'you', cmp: '<=', n: 3 },
          },
        ]),
      ]),
    ).toBe(true);
    expect(
      characteristicsFixedDuringPayment([
        holder([{ affects: lands, op, condition: { kind: 'isUntapped' } }]),
      ]),
    ).toBe(false);
    expect(
      characteristicsFixedDuringPayment([
        holder([{ affects: { kind: 'allOf', of: [lands, { kind: 'tapped' }] }, op }]),
      ]),
    ).toBe(false);
    expect(
      characteristicsFixedDuringPayment([
        holder(
          [],
          [{ kind: 'cantActivateAbilities', condition: { kind: 'anyPlayerLifeAtMost', n: 10 } }],
        ),
      ]),
    ).toBe(false);
    // Death's Shadow: a damage rider lowers life and so raises power, which a gate can read.
    expect(
      characteristicsFixedDuringPayment([
        holder([
          {
            affects: { kind: 'self' },
            op: {
              layer: 7,
              sublayer: 'd',
              power: { kind: 'negate', of: { kind: 'lifeTotal' } },
              toughness: { kind: 'negate', of: { kind: 'lifeTotal' } },
            },
          },
        ]),
      ]),
    ).toBe(false);
    // Iymrith's "ward {4} as long as it's untapped" and a commander-gated cost reduction change
    // nothing a payment reads.
    expect(
      characteristicsFixedDuringPayment([
        holder(
          [
            {
              affects: { kind: 'self' },
              op: { layer: 6, addWard: {} },
              condition: { kind: 'isUntapped' },
            },
          ],
          [{ kind: 'costReduction', condition: { kind: 'controlsYourCommander' } }],
        ),
      ]),
    ).toBe(true);
  });
});

describe('tap-only source shapes', () => {
  it('stateful-planner-tap-only — a plain or dynamic {T} source is tap-only; riders and sacrifices are not', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', forest());
      spawn(c, 'P1', painland());
      spawn(c, 'P1', treasure());
    });
    const byName = (name: string) => {
      const perm = ctx.state.battlefield.find((p) => p.name === name)!;
      return manaSourcesFor(ctx, 'P1', true).filter((s) => s.cardId === perm.cardId);
    };
    expect(byName('Exotic Orchard').every(tapOnlySource)).toBe(true);
    expect(byName('Forest').every(tapOnlySource)).toBe(true);
    expect(byName('Test Painland').some(tapOnlySource)).toBe(false);
    expect(byName('Test Treasure').some(tapOnlySource)).toBe(false);
  });
});

describe('old and new planner agree', () => {
  it('stateful-planner-agree-orchard — Exotic Orchard with basics, every cost', () => {
    const ctx = board((c) => {
      for (let i = 0; i < 3; i++) spawn(c, 'P1', forest());
      spawn(c, 'P1', dual());
      spawn(c, 'P1', orchard());
    });
    for (const cost of COSTS) agree(ctx, cost);
    expect(agree(ctx, '{W}{W}{U}')).toEqual({ plan: null });
    expect(agree(ctx, '{W}')).not.toEqual({ plan: null });
  });

  it('stateful-planner-agree-gated — a shut and an open Dragon gate', () => {
    const shut = board((c) => {
      for (let i = 0; i < 4; i++) spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', mox());
    });
    for (const cost of COSTS) agree(shut, cost);
    expect(agree(shut, '{B}')).toEqual({ plan: null });

    const open = board((c) => {
      for (let i = 0; i < 4; i++) spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', mox());
      spawn(c, 'P1', dragon());
    });
    for (const cost of COSTS) agree(open, cost);
    expect(agree(open, '{B}')).not.toEqual({ plan: null });
  });

  it('stateful-planner-agree-riders — a painland and a Treasure go to the copying search', () => {
    const ctx = board((c) => {
      for (let i = 0; i < 2; i++) spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', painland());
      spawn(c, 'P1', treasure());
    });
    for (const cost of COSTS) agree(ctx, cost);
    for (const cost of COSTS) agree(ctx, cost, 5);
  });

  it('stateful-planner-agree-life — a life reservation and Phyrexian pips', () => {
    const ctx = board((c) => {
      for (let i = 0; i < 2; i++) spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
    });
    for (const cost of COSTS) agree(ctx, cost, 3);
    playerById(ctx, 'P1').life = 2;
    for (const cost of COSTS) agree(ctx, cost, 3);
  });

  it('stateful-planner-agree-pool — mana already floating', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
    });
    playerById(ctx, 'P1').manaEntries.push({ symbol: 'U' }, { symbol: 'C' });
    for (const cost of COSTS) agree(ctx, cost);
  });
});

describe('a tap that changes other sources', () => {
  /**
   * Found in review: artifact A taps for {G}, and while A is untapped lands P1 controls lose all
   * abilities. Tapping A for {G} gives the Island back its {U}, so {G}{U} is payable. A gated
   * source routes the payment through the stateful planner, and the bound must not count only
   * what is available before any tap.
   */
  function suppressorBoard(gated: boolean): GameContext {
    return board((c) => {
      spawn(c, 'P1', island());
      spawn(c, 'P1', plains());
      const suppressor = spawn(c, 'P1', artifact('Suppressor', '{T}: Add {G}.'));
      c.defs.set(suppressor.oracleId, {
        ...c.defs.get(suppressor.oracleId)!,
        staticEffects: [
          {
            affects: {
              kind: 'allOf',
              of: [
                { kind: 'type', value: 'Land' },
                { kind: 'controller', who: 'you' },
              ],
            },
            op: { layer: 6, loseAllAbilities: true },
            condition: { kind: 'isUntapped' },
          },
        ],
      });
      spawn(c, 'P1', gated ? mox() : orchard());
      if (!gated) return;
      const moxPerm = c.state.battlefield.find((p) => p.name === 'Gated Mox')!;
      const def = c.defs.get(moxPerm.oracleId)!;
      c.defs.set(moxPerm.oracleId, {
        ...def,
        manaAbilities: def.manaAbilities.map((ability) => ({
          ...ability,
          units: [],
          dynamic: 'opponentLandColors' as const,
        })),
      });
    });
  }

  for (const gated of [true, false])
    it(`stateful-planner-tap-restores-abilities${gated ? '-gated' : ''} — the payment taps A, then the Island`, () => {
      const ctx = suppressorBoard(gated);
      const outcome = search(ctx, parseManaCost('{G}{U}').cost!, true);
      expect('plan' in outcome && outcome.plan).toBeTruthy();
      const plan = (outcome as { plan: { tapCardIds: string[] } }).plan;
      const names = plan.tapCardIds.map(
        (cardId) => ctx.state.battlefield.find((p) => p.cardId === cardId)!.name,
      );
      expect(names).toEqual(['Suppressor', 'Island']);
    });
});

describe('a damage rider that opens a gate', () => {
  /**
   * Found in review: at 10 life, a 13/13 that gets -X/-X for its controller's life total is 3/3.
   * A land taps for {G} and deals 1 damage, making it 4/4, which opens a {U} source gated on a
   * creature with power 4 or more; Exotic Orchard makes the other {U}. {G}{U}{U} is payable only
   * through that order.
   */
  it('stateful-planner-life-opens-gate — the payment taps the painland, then the gated source', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', land('Pain Forest', '{T}: Add {G}. This land deals 1 damage to you.'));
      const shadow = spawn(
        c,
        'P1',
        oracle({
          name: 'Shadow',
          typeLine: 'Creature — Avatar',
          manaCost: '{B}',
          power: '13',
          toughness: '13',
        }),
      );
      c.defs.set(shadow.oracleId, {
        ...c.defs.get(shadow.oracleId)!,
        staticEffects: [
          {
            affects: { kind: 'self' },
            op: {
              layer: 7,
              sublayer: 'd',
              power: { kind: 'negate', of: { kind: 'lifeTotal' } },
              toughness: { kind: 'negate', of: { kind: 'lifeTotal' } },
            },
          },
        ],
      });
      const gate = spawn(c, 'P1', artifact('Power Gate', '{T}: Add {U}.'));
      c.defs.set(gate.oracleId, {
        ...c.defs.get(gate.oracleId)!,
        manaAbilities: [
          {
            units: [['U']],
            condition: {
              kind: 'countPermanents',
              selector: {
                kind: 'allOf',
                of: [
                  { kind: 'type', value: 'Creature' },
                  { kind: 'powerAtLeast', n: 4 },
                ],
              },
              scope: 'you',
              cmp: '>=',
              n: 1,
            },
          },
        ],
      });
    });
    playerById(ctx, 'P1').life = 10;
    const outcome = search(ctx, parseManaCost('{G}{U}{U}').cost!, true);
    expect(JSON.stringify(outcome)).toBe(
      JSON.stringify(search(ctx, parseManaCost('{G}{U}{U}').cost!, false)),
    );
    expect('plan' in outcome && outcome.plan).toBeTruthy();
  });
});
