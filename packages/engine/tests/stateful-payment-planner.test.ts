/**
 * H7: the stateful mana planner proves an unpayable cast impossible from a capacity bound that
 * gated sources now join, and solves a board of tap-only and self-sacrificing sources statically
 * (#46). The bound must leave every answer as it was: the same plan, the same null, the same error.
 * The static solve picks its own plan, so there the two must agree on whether the cost can be paid.
 * Each agreement test runs the search both ways on one board.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { Condition } from '../src/cards/condition';
import { parseManaCost, type ParsedManaCost } from '../src/mana/cost';
import {
  characteristicsFixedDuringPayment,
  gateCannotOpenDuringPayment,
  leavingPermanentsKeepProduction,
} from '../src/mana/payment-stability';
import {
  interchangeablePermanents,
  searchPayment,
  tapOnlySource,
} from '../src/mana/stateful-payment';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { allowanceFor, convokeSourcesFor, manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  bear,
  island,
  mountain,
  oracle,
  plains,
  pump,
  spawn,
  swamp,
} from './fixtures';

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
  trace?: { staticSolve?: boolean },
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
        trace,
      ),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Both ways agree on `cost` (exactly, unless the static solve answered); returns the current outcome. */
function agree(ctx: GameContext, manaCost: string, lifeReserved = 0): Outcome {
  const cost = parseManaCost(manaCost).cost!;
  const before = JSON.stringify(ctx.state);
  const trace: { staticSolve?: boolean } = {};
  const legacy = search(ctx, cost, false, lifeReserved);
  const current = search(ctx, cost, true, lifeReserved, trace);
  // The old search ran out of budget: it has no answer to compare.
  if ('error' in legacy && legacy.error.includes('budget exceeded') && !('error' in current))
    return current;
  if (trace.staticSolve) {
    // The static solve picks its own plan (as `planPayment` does on an ordinary board); what
    // must agree is whether the cost can be paid.
    const settled = (outcome: Outcome): string =>
      'error' in outcome ? outcome.error : outcome.plan === null ? 'unpayable' : 'payable';
    expect(settled(current)).toBe(settled(legacy));
  } else expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
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
    // Zurgo and Ojutai: "has hexproof as long as it entered this turn" (fuzz-26, fuzz-169). Turn,
    // step and entry facts cannot change during a payment; inside a combinator, each child counts.
    const fixed = (condition: unknown) =>
      characteristicsFixedDuringPayment([
        holder([
          { affects: { kind: 'self' }, op: { layer: 6, addKeyword: 'hexproof' }, condition },
        ]),
      ]);
    expect(fixed({ kind: 'enteredThisTurn' })).toBe(true);
    expect(fixed({ kind: 'allOf', of: [{ kind: 'yourTurn' }, { kind: 'enteredThisTurn' }] })).toBe(
      true,
    );
    expect(
      fixed({ kind: 'anyOf', of: [{ kind: 'yourTurn' }, { kind: 'anyPlayerLifeAtMost', n: 10 }] }),
    ).toBe(false);
    expect(fixed({ kind: 'not', of: { kind: 'isUntapped' } })).toBe(false);
    // What happened this turn may include the cast the payment belongs to.
    expect(fixed({ kind: 'castSpellThisTurn' })).toBe(false);
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

describe('shortest plan first', () => {
  /** The plan's activations, by name and symbol. */
  const steps = (ctx: GameContext, outcome: Outcome): string[] => {
    const plan = (outcome as { plan: { tapCardIds: string[]; produced: { symbol: string }[] } })
      .plan;
    return plan.tapCardIds.map(
      (cardId, i) =>
        `${ctx.state.battlefield.find((p) => p.cardId === cardId)!.name}:${plan.produced[i]!.symbol}`,
    );
  };

  it('stateful-planner-shortest — {B} from an Orchard and four Treasures sacrifices one Treasure', () => {
    // A depth-first search to full depth made U, W, W, W and then B: four Treasures for {B}.
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      for (let i = 0; i < 4; i++) spawn(c, 'P1', treasure());
    });
    expect(steps(ctx, agree(ctx, '{B}'))).toEqual(['Test Treasure:B']);
    expect(steps(ctx, agree(ctx, '{1}{B}'))).toEqual(['Exotic Orchard:U', 'Test Treasure:B']);
  });

  it('stateful-planner-deep-board — 36 Treasures pay {U} with one, where the search once went 32 deep and halted (fuzz-26)', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      for (let i = 0; i < 36; i++) spawn(c, 'P1', treasure());
    });
    expect(steps(ctx, agree(ctx, '{U}'))).toEqual(['Exotic Orchard:U']);
    expect(steps(ctx, agree(ctx, '{B}'))).toEqual(['Test Treasure:B']);
  });
});

describe('Treasure boards', () => {
  it('stateful-planner-treasure-bound — seven Treasures cannot pay nine pips, and say so without a halt (fuzz-173)', () => {
    // A Treasure sacrifices only itself, so under the leaving premise it keeps the capacity bound.
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      for (let i = 0; i < 7; i++) spawn(c, 'P1', treasure());
    });
    expect(agree(ctx, '{4}{W}{U}{B}{R}{G}')).toEqual({ plan: null });
  });

  /** The plan's sources by name, and whether the static solve answered. */
  function solve(ctx: GameContext, manaCost: string) {
    const trace: { staticSolve?: boolean } = {};
    const outcome = search(ctx, parseManaCost(manaCost).cost!, true, 0, trace);
    const plan = 'plan' in outcome ? (outcome.plan as { tapCardIds: string[] } | null) : null;
    return {
      outcome,
      static: trace.staticSolve === true,
      names: plan?.tapCardIds.map((id) => ctx.state.battlefield.find((p) => p.cardId === id)!.name),
    };
  }

  it('stateful-planner-treasure-static — ten Treasures pay {4}{W}{U}{B}{R}{G} in one solve, where the search halted (fuzz-173)', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', forest());
      for (let i = 0; i < 10; i++) spawn(c, 'P1', treasure());
    });
    const { static: wasStatic, names } = solve(ctx, '{4}{W}{U}{B}{R}{G}');
    expect(wasStatic).toBe(true);
    // Both lands, then the seven Treasures the other seven pips need: no Treasure to spare.
    expect(names!.filter((name) => name !== 'Test Treasure').sort()).toEqual([
      'Exotic Orchard',
      'Forest',
    ]);
    expect(names!.filter((name) => name === 'Test Treasure')).toHaveLength(7);
  });

  it('stateful-planner-treasure-many — 33 Treasures and an Orchard pay five colors and four more (fuzz-218)', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      for (let i = 0; i < 33; i++) spawn(c, 'P1', treasure());
    });
    const { static: wasStatic, names } = solve(ctx, '{4}{W}{U}{B}{R}{G}');
    expect(wasStatic).toBe(true);
    expect(names).toHaveLength(9);
    expect(names).toContain('Exotic Orchard');
  });

  it('stateful-planner-treasure-keeps — a cast the lands can pay sacrifices no Treasure', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', forest());
      for (let i = 0; i < 3; i++) spawn(c, 'P1', treasure());
    });
    expect(solve(ctx, '{G}').names).toEqual(['Forest']);
    expect(solve(ctx, '{U}').names).toEqual(['Exotic Orchard']);
    expect(solve(ctx, '{1}{G}').names!.sort()).toEqual(['Exotic Orchard', 'Forest']);
  });

  it('stateful-planner-treasure-hand-back — a source that reads the payer’s own board keeps the search', () => {
    // Reflecting Pool reads P1's own lands. A Treasure leaving cannot change that, but the static
    // solve only trusts kinds that read nothing of the payer's board once a source sacrifices.
    const pool = () =>
      land('Test Pool', '{T}: Add one mana of any type that a land you control could produce.');
    const withTreasure = board((c) => {
      spawn(c, 'P1', forest());
      spawn(c, 'P1', pool());
      spawn(c, 'P1', treasure());
    });
    const tapOnly = board((c) => {
      spawn(c, 'P1', forest());
      spawn(c, 'P1', pool());
    });
    expect(solve(withTreasure, '{G}{G}').static).toBe(false);
    expect(solve(tapOnly, '{G}{G}').static).toBe(true);
    expect(solve(tapOnly, '{G}{G}').names!.sort()).toEqual(['Forest', 'Test Pool']);
  });

  it('stateful-planner-treasure-cast — a real cast pays from the static plan and sacrifices only what it used', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', forest());
      for (let i = 0; i < 4; i++) spawn(c, 'P1', treasure());
    });
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Rainbow',
        typeLine: 'Creature — Shapeshifter',
        manaCost: '{W}{U}{B}{G}',
        power: '2',
        toughness: '2',
      }),
      'hand',
    );
    const player = playerById(ctx, 'P1');
    const cast = computePriorityOptions(ctx, player).find(
      (action) => action.type === 'castSpell' && action.description.includes(spell.name),
    );
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      () => undefined,
      { strict: true },
    );
    expect(ctx.state.stack.some((entry) => entry.description.includes(spell.name))).toBe(true);
    // Forest makes G, the Orchard U or W, and two Treasures the rest.
    expect(ctx.state.battlefield.filter((p) => p.name === 'Test Treasure')).toHaveLength(2);
    expect(
      ctx.state.battlefield
        .filter((p) => p.name !== 'Test Treasure' && p.controllerId === 'P1')
        .every((p) => p.tapped),
    ).toBe(true);
    expect(player.manaEntries).toEqual([]);
  });

  it('stateful-planner-filter-static — a filter land joins the static solve (fuzz-131, fuzz-144)', () => {
    const cairns = () =>
      land('Test Cairns', '{T}: Add {C}.\n{B/R}, {T}: Add {B}{B}, {B}{R}, or {R}{R}.');
    const lands = (c: GameContext) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', plains());
      spawn(c, 'P1', swamp());
      spawn(c, 'P1', mountain());
      spawn(c, 'P1', cairns());
    };
    // Only the filter makes the second R: it is paid for and used.
    const ctx = board(lands);
    const { static: wasStatic, names } = solve(ctx, '{W}{B}{R}{R}');
    expect(wasStatic).toBe(true);
    expect(names).toContain('Test Cairns');
    expect(agree(ctx, '{W}{B}{R}{R}')).not.toEqual({ plan: null });
    // With Treasures too it stays one static solve, payable or not.
    const withTreasures = board((c) => {
      lands(c);
      for (let i = 0; i < 3; i++) spawn(c, 'P1', treasure());
    });
    expect(solve(withTreasures, '{1}{W}{B}{R}{R}{G}').static).toBe(true);
    expect(agree(withTreasures, '{1}{W}{B}{R}{R}{G}')).not.toEqual({ plan: null });
    expect(agree(withTreasures, '{5}{W}{B}{R}{R}{G}')).toEqual({ plan: null });
  });
});

describe('a counted amount', () => {
  const brigid = () =>
    oracle({
      name: 'Test Brigid',
      typeLine: 'Legendary Creature — Kithkin Druid',
      manaCost: '{1}{G}{W}',
      power: '2',
      toughness: '3',
      oracleText: '{T}: Add X {G} or X {W}, where X is the number of other creatures you control.',
    });
  /** Fuzz-200's board: Brigid, Fellwar Stones that make every color, three Plains. */
  function brigidBoard(tapped: boolean) {
    return board((c) => {
      for (const make of [swamp, mountain, forest]) spawn(c, 'P2', make());
      spawn(c, 'P1', brigid()).tapped = tapped;
      for (let i = 0; i < 2; i++) spawn(c, 'P1', bear());
      // Distinct names, so no two are interchangeable and the search must try each.
      for (let i = 0; i < 7; i++)
        spawn(
          c,
          'P1',
          artifact(
            `Test Stone ${i}`,
            '{T}: Add one mana of any color that a land an opponent controls could produce.',
          ),
        );
      for (let i = 0; i < 3; i++) spawn(c, 'P1', plains());
    });
  }

  it('stateful-planner-counted-bound — "X is the number of other creatures" keeps the bound, and an unpayable cast says so (fuzz-200)', () => {
    const ctx = brigidBoard(true);
    const legacy = search(ctx, parseManaCost('{9}{W}{G}{G}').cost!, false);
    expect('error' in legacy && legacy.error).toContain('budget exceeded');
    expect(search(ctx, parseManaCost('{9}{W}{G}{G}').cost!, true)).toEqual({ plan: null });
  }, 30_000);

  it('stateful-planner-counted-pays — untapped, Brigid adds her two and the cast is paid', () => {
    const ctx = brigidBoard(false);
    const outcome = agree(ctx, '{9}{W}{G}{G}');
    expect(outcome).not.toEqual({ plan: null });
    expect('error' in outcome).toBe(false);
  });
});

describe('the static solve, widened (#46)', () => {
  function staticOf(
    ctx: GameContext,
    manaCost: string,
    lifeReserved = 0,
    sourcesFor = (context: GameContext, payer: { id: string }) =>
      manaSourcesFor(context, payer.id as 'P1', true),
  ) {
    const trace: { staticSolve?: boolean } = {};
    const player = playerById(ctx, 'P1');
    const plan = searchPayment(
      ctx,
      player,
      parseManaCost(manaCost).cost!,
      allowanceFor(ctx, 'P1', { kind: 'castSpell', oracleId: 'none', isCommander: false }),
      sourcesFor,
      new Set(),
      lifeReserved,
      0,
      true,
      trace,
    );
    return { plan, static: trace.staticSolve === true };
  }

  it('stateful-planner-static-pain — a painland rides along when no life is reserved, and keeps the search when it is (fuzz-131, fuzz-144)', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', painland());
      for (let i = 0; i < 3; i++) spawn(c, 'P1', treasure());
    });
    const free = staticOf(ctx, '{G}{U}');
    expect(free.static).toBe(true);
    expect(free.plan).not.toBeNull();
    expect(staticOf(ctx, '{G}{U}', 5).static).toBe(false);
    expect(staticOf(ctx, '{G}{W/P}').static).toBe(false);
  });

  it('stateful-planner-static-convoke — convoke creatures join the static solve (fuzz-200)', () => {
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', forest());
      for (let i = 0; i < 2; i++) spawn(c, 'P1', bear());
    });
    const withConvoke = (context: GameContext, payer: { id: string }) => [
      ...manaSourcesFor(context, payer.id as 'P1', true),
      ...convokeSourcesFor(context, payer.id as 'P1'),
    ];
    // The fixture bears are colorless: each convokes for one generic.
    const paid = staticOf(ctx, '{2}{G}{U}', 0, withConvoke);
    expect(paid.static).toBe(true);
    expect(paid.plan).not.toBeNull();
    expect(staticOf(ctx, '{3}{G}{U}', 0, withConvoke).plan).toBeNull();
    expect(staticOf(ctx, '{1}{G}{G}', 0, withConvoke).plan).toBeNull();
  });

  it('stateful-planner-static-conditional — "two mana instead if you control a 4-power creature" keeps the bound (fuzz-169, fuzz-173, fuzz-185)', () => {
    const caryatid = () =>
      oracle({
        name: 'Test Caryatid',
        typeLine: 'Creature — Plant',
        manaCost: '{1}{G}',
        power: '0',
        toughness: '2',
        oracleText:
          '{T}: Add one mana of any color. If you control a creature with power 4 or greater, add two mana of any one color instead.',
      });
    const giant = () =>
      oracle({
        name: 'Test Giant',
        typeLine: 'Creature — Giant',
        manaCost: '{4}',
        power: '4',
        toughness: '4',
      });
    const ctx = board((c) => {
      for (const make of [swamp, mountain, forest]) spawn(c, 'P2', make());
      spawn(c, 'P1', caryatid()).tapped = true;
      spawn(c, 'P1', giant());
      for (let i = 0; i < 7; i++)
        spawn(
          c,
          'P1',
          artifact(
            `Test Stone ${i}`,
            '{T}: Add one mana of any color that a land an opponent controls could produce.',
          ),
        );
      for (let i = 0; i < 3; i++) spawn(c, 'P1', plains());
    });
    const legacy = search(ctx, parseManaCost('{9}{W}{G}{G}').cost!, false);
    expect('error' in legacy && legacy.error).toContain('budget exceeded');
    expect(staticOf(ctx, '{9}{W}{G}{G}').plan).toBeNull();
    // Untapped, she makes two of one color: the bound counts her at that.
    const untapped = board((c) => {
      spawn(c, 'P1', caryatid());
      spawn(c, 'P1', giant());
      spawn(c, 'P1', orchard());
    });
    expect(staticOf(untapped, '{G}{G}{U}').plan).not.toBeNull();
    expect(staticOf(untapped, '{G}{G}{G}{U}').plan).toBeNull();
  }, 30_000);
});

describe('interchangeable permanents', () => {
  /** P1's Treasures on a fresh board, and the classes the planner puts them in. */
  function classes(edit?: (ctx: GameContext, treasures: string[]) => void) {
    const ctx = board((c) => {
      for (let i = 0; i < 3; i++) spawn(c, 'P1', treasure());
    });
    const ids = ctx.state.battlefield
      .filter((p) => p.name === 'Test Treasure')
      .map((p) => p.cardId);
    edit?.(ctx, ids);
    const byCard = interchangeablePermanents(ctx, ids);
    return ids.map((id) => byCard.get(id) ?? null);
  }

  it('stateful-planner-interchangeable — identical, unreferenced Treasures share a class', () => {
    const [a, b, c] = classes();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('stateful-planner-not-interchangeable — a counter or a reference keeps a Treasure apart', () => {
    const withCounter = classes((ctx, ids) => {
      ctx.state.battlefield.find((p) => p.cardId === ids[1])!.counters['charge'] = 1;
    });
    expect(withCounter[1]).not.toBe(withCounter[0]);
    expect(withCounter[2]).toBe(withCounter[0]);

    // An effect that names the third Treasure: anything could read that one in particular.
    const referenced = classes((ctx, ids) => {
      ctx.state.effects.push({
        id: 'eff-test',
        sourceId: 'test',
        description: 'names one Treasure',
        targetCardIds: [ids[2]!],
        kind: 'grantKeyword',
        keyword: 'hexproof',
        timestamp: ctx.state.nextTimestamp++,
      } as never);
    });
    expect(referenced[2]).toBeNull();
    expect(referenced[1]).toBe(referenced[0]);
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

describe('sacrifice mana sources', () => {
  /**
   * Found in the bot league (seeds league-0, -7, -15, -17): a player with a source whose symbols
   * depend on the board (Exotic Orchard, Fellwar Stone, Mox Amber) and a "sacrifice a creature: add
   * mana" source (Ashnod's Altar, Phyrexian Altar) made the planner skip the Altar, fail to find a
   * payment, and halt the whole game with an unmodeled-mana-payment error. That happened for a
   * cast that no creature could pay for just as for one only a sacrifice could.
   */
  const altar = () => artifact("Ashnod's Altar", 'Sacrifice a creature: Add {C}{C}.');
  const fodder = (name: string) =>
    oracle({ name, typeLine: 'Creature — Human', manaCost: '{1}', power: '1', toughness: '1' });
  const names = (ctx: GameContext, outcome: Outcome): string[] =>
    (outcome as { plan: { tapCardIds: string[] } }).plan.tapCardIds.map(
      (cardId) => ctx.state.battlefield.find((p) => p.cardId === cardId)!.name,
    );

  function altarBoard(creatures: number, extra?: (c: GameContext) => void): GameContext {
    return board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', altar());
      for (let i = 0; i < creatures; i++) spawn(c, 'P1', fodder(`Fodder ${i + 1}`));
      extra?.(c);
    });
  }

  it('stateful-planner-sacrifice-unpayable — a cast no sacrifice can pay for is unpayable, not a halt', () => {
    // One creature gives the Altar one activation: {C}{C} and the Orchard's one mana make three.
    const ctx = altarBoard(1);
    expect(agree(ctx, '{W}{4}')).toEqual({ plan: null });
    // Enough mana, wrong colors: the Altar and the Orchard make no {B}.
    expect(agree(ctx, '{B}')).toEqual({ plan: null });
    // Each creature is one more activation, so the same cost becomes payable.
    expect(agree(altarBoard(2), '{W}{4}')).not.toEqual({ plan: null });
    // The Orchard makes one mana, not both of {W}{U}, however many creatures the Altar has.
    expect(agree(altarBoard(5), '{W}{U}')).toEqual({ plan: null });
  });

  it('stateful-planner-mana-only-repeats — an ability paid only with mana can fire again and again', () => {
    // Review finding: counting a mana-only cost as fixed capacity let the bound see one activation
    // of a source that can be activated twice from floating mana, and rule out a legal payment.
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', artifact('Test Converter', '{1}: Add {W}.'));
    });
    const player = playerById(ctx, 'P1');
    for (let i = 0; i < 4; i++) player.manaEntries.push({ symbol: 'C' });
    // {W}{W}{W}: the Orchard makes one W, so the Converter must fire twice. The plan is exactly
    // those three activations (the shortest), where a depth-first order once also tapped the
    // Orchard for a U nothing spent.
    const outcome = agree(ctx, '{W}{W}{W}');
    expect(outcome).not.toEqual({ plan: null });
    const tapped = (outcome as { plan: { tapCardIds: string[] } }).plan.tapCardIds.map(
      (cardId) => ctx.state.battlefield.find((p) => p.cardId === cardId)!.name,
    );
    expect(tapped).toEqual(['Exotic Orchard', 'Test Converter', 'Test Converter']);
  });

  it('stateful-planner-sacrifice-payable — a cast only a sacrifice can pay for is found, victim unpinned', () => {
    const ctx = altarBoard(3);
    const outcome = agree(ctx, '{W}{2}');
    expect(outcome).not.toEqual({ plan: null });
    expect(names(ctx, outcome)).toEqual(['Exotic Orchard', "Ashnod's Altar"]);
    const plan = (
      outcome as {
        plan: {
          tapSources: { costs: { kind: string; onlyCardId?: string }[]; sacrifices?: string[][] }[];
        };
      }
    ).plan;
    const altarSource = plan.tapSources.find((source) =>
      source.costs.some((cost) => cost.kind === 'sacrificeOther'),
    )!;
    // Who is sacrificed is the player's choice: the plan names no victim and offers all three.
    expect(altarSource.costs.some((cost) => cost.onlyCardId !== undefined)).toBe(false);
    expect(altarSource.sacrifices?.map((group) => group.length)).toEqual([3]);
  });

  it('stateful-planner-sacrifice-last-resort — a cast the lands can pay never sacrifices anything', () => {
    const withAltar = board((c) => {
      spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
      spawn(c, 'P1', altar());
      spawn(c, 'P1', fodder('Fodder 1'));
    });
    const without = board((c) => {
      spawn(c, 'P1', forest());
      spawn(c, 'P1', orchard());
    });
    const [a, b] = [agree(withAltar, '{G}'), agree(without, '{G}')];
    expect(names(withAltar, a)).not.toContain("Ashnod's Altar");
    // The Altar and its creature change nothing about how this cast was already paid.
    expect(names(withAltar, a)).toEqual(names(without, b));
  });

  it('stateful-planner-sacrifice-suppressor — with a static that could give production back, it still halts', () => {
    // Blood Moon-style: while the Suppressor is in play, P1's lands lose their abilities. Sacrificing
    // it would give the Orchard back; the bound cannot assume sacrifices only take things away.
    const ctx = altarBoard(1, (c) => {
      const suppressor = spawn(c, 'P1', artifact('Suppressor', 'Flying'));
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
          },
        ],
      });
    });
    const outcome = agree(ctx, '{B}');
    expect(outcome).toHaveProperty('error');
    expect((outcome as { error: string }).error).toMatch(/Unmodeled card "mana payment"/);
  });

  it('stateful-planner-sacrifice-same-permanent — a tap ability and a sacrifice ability of one permanent never share an activation', () => {
    // Phyrexian Tower's shape. Its {T} ability and its sacrifice ability share one {T}, so a
    // plan uses one of them; the planner must not hand back two activations with one identity.
    const ctx = board((c) => {
      spawn(c, 'P1', orchard());
      spawn(
        c,
        'P1',
        land('Two Way Tower', '{T}: Add {C}.\n{T}, Sacrifice a creature: Add {B}{B}.'),
      );
      spawn(c, 'P1', fodder('Fodder 1'));
      spawn(c, 'P1', fodder('Fodder 2'));
    });
    const tower = ctx.state.battlefield.find((p) => p.name === 'Two Way Tower')!;
    // Both abilities are listed, or this test would prove nothing.
    expect(manaSourcesFor(ctx, 'P1', true).filter((s) => s.cardId === tower.cardId).length).toBe(2);
    // {B}{B} can only come from the Tower's sacrifice ability, {W} only from the Orchard.
    const outcome = agree(ctx, '{B}{B}{W}');
    expect(names(ctx, outcome)).toEqual(['Exotic Orchard', 'Two Way Tower']);
    const identities = (
      outcome as { plan: { tapSources: { cardId: string; activation?: number }[] } }
    ).plan.tapSources.map((source) => `${source.cardId}/${source.activation ?? '-'}`);
    expect(new Set(identities).size).toBe(identities.length);
    // One {T} cannot pay for both of the Tower's abilities.
    expect(agree(ctx, '{B}{B}{W}{C}')).toEqual({ plan: null });
  });

  describe('the guard behind the bound', () => {
    const holder = (
      staticEffects: unknown[],
      ruleStatics: unknown[] = [],
    ): Parameters<typeof leavingPermanentsKeepProduction>[0][number] => ({
      staticEffects,
      ruleStatics,
    });
    const effect = (op: Record<string, unknown>) => ({ affects: { kind: 'self' }, op });

    it('stateful-planner-leaving-guard — what a permanent leaving could give back', () => {
      const keeps = (definition: ReturnType<typeof holder>, powerGated = false) =>
        leavingPermanentsKeepProduction([definition], powerGated);
      expect(keeps(holder([]))).toBe(true);
      // Adding never gives anything back when it ends.
      expect(keeps(holder([effect({ layer: 6, addKeyword: 'flying' })]))).toBe(true);
      expect(keeps(holder([effect({ layer: 4, addTypes: ['Creature'] })]))).toBe(true);
      // Stripping, setting and denying do.
      for (const op of [
        { layer: 6, loseAllAbilities: true },
        { layer: 6, denyKeywords: ['flying'] },
        { layer: 6, removeKeywords: ['flying'] },
        { layer: 5, setColors: ['W'] },
        { layer: 4, setLandSubtype: 'Mountain' },
        { layer: 4, setTypes: ['Artifact'] },
        { layer: 4, removeCreatureType: true },
        { layer: 4, loseAbilities: true },
      ])
        expect(keeps(holder([effect(op)])), JSON.stringify(op)).toBe(false);
      // Power and toughness matter only when a mana ability is gated on them.
      const pumped = (power: unknown) =>
        holder([effect({ layer: 7, sublayer: 'd', power, toughness: 1 })]);
      expect(keeps(pumped(1), true)).toBe(true);
      expect(keeps(pumped(-1), true)).toBe(false);
      expect(keeps(pumped({ kind: 'negate', of: { kind: 'lifeTotal' } }), true)).toBe(false);
      expect(keeps(pumped({ kind: 'negate', of: { kind: 'lifeTotal' } }), false)).toBe(true);
      // Rule statics are listed as irrelevant or they count against it.
      expect(keeps(holder([], [{ kind: 'attackTax' }]))).toBe(true);
      expect(keeps(holder([], [{ kind: 'triggerAdditionalTime' }]))).toBe(true);
      // Damage modifiers change only damage (Neriv, Heart of the Storm on a Treasure board, fuzz-26).
      for (const kind of [
        'damageDoubled',
        'damageDoubledToOpponents',
        'damageHalvedToYou',
        'preventCombatDamageToSelf',
        // Terror of the Peaks (fuzz-26) and other rules no source's production reads.
        'targetLifeTax',
        'graveyardToExile',
        'tokenCountMultiplier',
        'untapDuringOthersUntapSteps',
      ])
        expect(keeps(holder([], [{ kind }])), kind).toBe(true);
      expect(keeps(holder([], [{ kind: 'cantActivateAbilities' }]))).toBe(false);
      expect(keeps(holder([], [{ kind: 'lifeGainReplacement' }]))).toBe(false);
      expect(keeps(holder([], [{ kind: 'aKindThatDoesNotExistYet' }]))).toBe(false);
    });
  });

  it('stateful-planner-sacrifice-cast — a real cast asks who to sacrifice and sacrifices only that one', () => {
    const ctx = altarBoard(3);
    const hulk = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Test Hulk',
        typeLine: 'Creature — Hulk',
        manaCost: '{2}{W}',
        power: '2',
        toughness: '2',
      }),
      'hand',
    );
    const player = playerById(ctx, 'P1');
    const cast = computePriorityOptions(ctx, player).find(
      (action) => action.type === 'castSpell' && action.description.includes(hulk.name),
    );
    // Before the fix the game halted here, while working out what could be cast.
    expect(cast).toBeDefined();
    const { decisions } = pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      (decision) => {
        const choice = decision.options.findIndex((option) =>
          option.description.includes('Sacrifice Fodder 2'),
        );
        return choice < 0 ? undefined : { index: choice, targets: new Map() };
      },
      { strict: true },
    );
    const asked = decisions.filter((decision) =>
      decision.options.some((option) => option.description.includes('Sacrifice Fodder')),
    );
    expect(asked).toHaveLength(1);
    expect(
      asked[0]!.options.filter((o) => o.description.includes('Sacrifice Fodder')),
    ).toHaveLength(3);
    expect(player.graveyard.map((card) => card.name)).toEqual(['Fodder 2']);
    expect(
      ctx.state.battlefield.filter((p) => p.name.startsWith('Fodder')).map((p) => p.name),
    ).toEqual(['Fodder 1', 'Fodder 3']);
    expect(ctx.state.stack.some((entry) => entry.description.includes(hulk.name))).toBe(true);
    expect(player.manaEntries).toEqual([]);
  });
});
