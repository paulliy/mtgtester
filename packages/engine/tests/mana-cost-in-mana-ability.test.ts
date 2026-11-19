/**
 * A mana ability may charge MANA as part of its own cost — filter lands, signets, Cabal Coffers,
 * Nykthos.
 *
 * CR 605.1a constrains what a mana ability *does* (adds mana, no target, not a loyalty ability);
 * it says nothing about what the ability may cost. The engine refused the whole family anyway,
 * because `planPayment` had no way to pay for its own sources: `ManaSource.costs` was ignored and
 * `payAbilityCosts` had `case 'mana': break`. Authored overrides that bypassed the parser were
 * therefore producing free mana — Desolate Mire's `{1}, {T}: Add {W}{B}` tapped for two mana out
 * of nothing, every turn — and `manaSourcesFor` fixed that by dropping such abilities entirely.
 *
 * This file covers the real implementation that replaced both:
 *
 * - `ManaSource.manaCost` carries the cost where the solver can see it.
 * - `planPayment` runs its ordinary solve first, unchanged, and only reaches for a mana-costing
 *   source when that fails — so no existing payment changed its tap choices.
 * - The plan comes back in an order that can be EXECUTED. A bag argument ("total production
 *   covers the cost plus every activation cost") says nothing about timing, and a filter land
 *   cannot pay for itself.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import type { ManaAbilitySpec } from '../src/cards/definition';
import { listOverrides } from '../src/cards/overrides';
import { canPay, parseManaCost, planPayment } from '../src/mana/cost';
import { payManaCost } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import {
  copies,
  forest,
  gameConfig,
  oracle,
  plains,
  pump,
  spawn,
  swamp,
  editableDef,
} from './fixtures';

const desolateMire = () =>
  oracle({
    name: 'Test Mire',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{1}, {T}: Add {W}{B}.',
  });

const fetidHeath = () =>
  oracle({
    name: 'Test Heath',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}.\n{W/B}, {T}: Add {W}{W}, {W}{B}, or {B}{B}.',
  });

const cabalCoffers = () =>
  oracle({
    name: 'Test Coffers',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}.\n{2}, {T}: Add {B} for each Swamp you control.',
  });

const nykthos = () =>
  oracle({
    name: 'Test Shrine',
    typeLine: 'Legendary Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      '{T}: Add {C}.\n{2}, {T}: Choose a color. Add an amount of mana of that color equal to your devotion to that color.',
  });

const threeTreeCity = () =>
  oracle({
    name: 'Test City',
    typeLine: 'Legendary Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      'As this land enters, choose a creature type.\n{T}: Add {C}.\n{2}, {T}: Choose a color. Add an amount of mana of that color equal to the number of creatures you control of the chosen type.',
  });

const typedCreature = (subtype: string, name: string) =>
  oracle({
    name,
    typeLine: `Creature — ${subtype}`,
    manaCost: '{1}',
    subtypes: [subtype],
    power: '1',
    toughness: '1',
    oracleText: '',
  });

/** A permanent whose printed cost supplies devotion pips. */
const devotee = (manaCost: string, name: string) =>
  oracle({
    name,
    typeLine: 'Creature — Human',
    manaCost,
    power: '1',
    toughness: '1',
    oracleText: '',
  });

function pod(seed = 'mana-cost-in-mana-ability'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 5;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

const cost = (text: string) => parseManaCost(text as never).cost!;

describe('the parse', () => {
  it('reads a mana-costed line as a mana ability, not as a stack ability', () => {
    const def = interpretCard(desolateMire());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    // Not `activatedAbilities`: a real filter land does not use the stack and cannot be
    // responded to between the payment and the mana.
    expect(def.activatedAbilities).toEqual([]);
    expect(def.manaAbilities[0]?.costs?.map((c) => c.kind)).toEqual(['mana', 'tap']);
  });

  it('reads a filter land three printed outputs as two either-symbol units', () => {
    const def = interpretCard(fetidHeath());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    const filter = def.manaAbilities.find((a) => a.units.length === 2);
    // {W}{W} / {W}{B} / {B}{B} are exactly the three multisets you can draw twice from {W,B},
    // so two independent either-symbol units express the clause without losing or adding a case.
    expect(filter?.units).toEqual([
      ['W', 'B'],
      ['W', 'B'],
    ]);
  });

  it('expands the Nykthos colour choice into five alternative abilities', () => {
    const def = interpretCard(nykthos());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    // The colour and the AMOUNT are one decision — devotion is per colour — and no single spec
    // can express that, so the choice becomes alternatives of one permanent (the Haven of the
    // Spirit Dragon shape), alongside the printed {C} ability.
    const counted = def.manaAbilities.filter((a) => a.amount !== undefined);
    expect(counted.map((a) => a.units)).toEqual([[['W']], [['U']], [['B']], [['R']], [['G']]]);
    expect(counted[0]?.amount).toEqual({ kind: 'devotionTo', color: 'W' });
  });
});

describe('planning a payment that has to pay for its own source', () => {
  it('offers a filter land only when something else can pay its cost', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', desolateMire());

    // Alone, the Mire is mana-negative: it cannot pay its own {1}. This is the exact bug the
    // old fail-closed filter existed to prevent, now decided by arithmetic instead.
    expect(canPay(cost('{W}'), [], manaSourcesFor(ctx, player.id))).toBe(false);

    spawn(ctx, 'P1', forest());
    expect(canPay(cost('{W}{B}'), [], manaSourcesFor(ctx, player.id))).toBe(true);
    // Two mana in, three pips out is still beyond it.
    expect(canPay(cost('{W}{B}{G}'), [], manaSourcesFor(ctx, player.id))).toBe(false);
  });

  it('puts the payer before the payee in the plan', () => {
    const ctx = pod();
    const player = p1(ctx);
    // The Mire is spawned FIRST, so battlefield order is the wrong activation order and the
    // plan has to reorder rather than merely balance the books.
    const mire = spawn(ctx, 'P1', desolateMire());
    const tree = spawn(ctx, 'P1', forest());

    const plan = planPayment(cost('{W}{B}'), [], manaSourcesFor(ctx, player.id));
    expect(plan).not.toBeNull();
    expect(plan?.tapCardIds).toEqual([tree.cardId, mire.cardId]);
  });

  it('leaves a payment that never needed one exactly as it was', () => {
    const ctx = pod();
    const player = p1(ctx);
    const a = spawn(ctx, 'P1', forest());
    const b = spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', desolateMire());

    // Two Forests can pay this on their own, so the first pass answers and the Mire is never
    // considered — the guarantee that keeps this change from perturbing existing cards.
    const plan = planPayment(cost('{G}{G}'), [], manaSourcesFor(ctx, player.id));
    expect(plan?.tapCardIds).toEqual([a.cardId, b.cardId]);
  });

  it('pays a hybrid activation cost from a source that can make either half', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', fetidHeath());
    spawn(ctx, 'P1', plains());

    // Fetid Heath's own cost is {W/B}; the Plains covers it, and the Heath turns one white mana
    // into two. Two white pips from two lands, one of which makes no white, is the card.
    expect(canPay(cost('{W}{W}'), [], manaSourcesFor(ctx, player.id))).toBe(true);
    // But it is still only +1 net: a Plains and a Heath are not three white.
    expect(canPay(cost('{W}{W}{W}'), [], manaSourcesFor(ctx, player.id))).toBe(false);
  });
});

describe('applying the payment', () => {
  it('charges the {1} and adds both mana, leaving the pool empty', () => {
    const ctx = pod();
    const player = p1(ctx);
    const mire = spawn(ctx, 'P1', desolateMire());
    const tree = spawn(ctx, 'P1', forest());

    pump(payManaCost(ctx, player, cost('{W}{B}')));

    // Both lands tapped, and nothing floating: the Forest's {G} went into the Mire's cost, not
    // into the pool.
    expect(mire.tapped).toBe(true);
    expect(tree.tapped).toBe(true);
    expect(player.manaEntries).toEqual([]);
  });

  it('makes Cabal Coffers net mana only when the swamps outnumber its cost', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', cabalCoffers());
    const swamps = [0, 1, 2].map(() => spawn(ctx, 'P1', swamp()));

    // Three Swamps make three black; Coffers turns two of them into three more. Four is
    // reachable, five is not.
    expect(canPay(cost('{B}{B}{B}{B}'), [], manaSourcesFor(ctx, player.id))).toBe(true);
    expect(canPay(cost('{B}{B}{B}{B}{B}'), [], manaSourcesFor(ctx, player.id))).toBe(false);

    pump(payManaCost(ctx, player, cost('{B}{B}{B}{B}')));
    expect(swamps.every((s) => s.tapped)).toBe(true);
    expect(player.manaEntries).toHaveLength(0);
  });

  it('declines Cabal Coffers when it would cost more than it makes', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', cabalCoffers());
    const one = spawn(ctx, 'P1', swamp());

    // One Swamp: Coffers would charge {2} to add {B}. The solver must decline it and answer
    // with the Swamp alone.
    const plan = planPayment(cost('{B}'), [], manaSourcesFor(ctx, player.id));
    expect(plan?.tapCardIds).toEqual([one.cardId]);
  });

  it('pays Nykthos out of devotion to the colour it chose', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', nykthos());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    // Devotion to green 3, devotion to white 1 — so the green alternative is the one that pays.
    spawn(ctx, 'P1', devotee('{G}{G}', 'Test Green Devotee'));
    spawn(ctx, 'P1', devotee('{G}{W}', 'Test Gold Devotee'));

    // Two Forests pay the {2}; Nykthos then makes three green.
    expect(canPay(cost('{G}{G}{G}'), [], manaSourcesFor(ctx, player.id))).toBe(true);
    // White devotion is only 1, so no colour choice reaches three white.
    expect(canPay(cost('{W}{W}{W}'), [], manaSourcesFor(ctx, player.id))).toBe(false);

    pump(payManaCost(ctx, player, cost('{G}{G}{G}')));
    expect(player.manaEntries).toEqual([]);
  });

  it('counts only creatures of the type Three Tree City chose', () => {
    const def = interpretCard(threeTreeCity());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    // Same five-alternative shape as Nykthos, with a different amount — and the amount reads a
    // SECOND choice, the creature type named as the land entered.
    expect(def.entersChoosingOption).toEqual({
      prompt: 'choose a creature type',
      domain: 'creatureType',
    });

    const ctx = pod();
    const player = p1(ctx);
    const city = spawn(ctx, 'P1', threeTreeCity());
    city.chosenOption = 'Elf';
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', typedCreature('Elf', 'Test Elf A'));
    spawn(ctx, 'P1', typedCreature('Elf', 'Test Elf B'));
    spawn(ctx, 'P1', typedCreature('Goblin', 'Test Goblin'));

    // Two Elves, so the City makes two mana for its {2} — a wash, and the Goblin is not counted.
    // Two Forests plus a break-even City is two mana, not three.
    expect(canPay(cost('{G}{G}'), [], manaSourcesFor(ctx, player.id))).toBe(true);
    expect(canPay(cost('{G}{G}{G}'), [], manaSourcesFor(ctx, player.id))).toBe(false);

    // A third Elf makes it mana-positive.
    spawn(ctx, 'P1', typedCreature('Elf', 'Test Elf C'));
    expect(canPay(cost('{G}{G}{G}'), [], manaSourcesFor(ctx, player.id))).toBe(true);
  });
});

describe('what still fails closed', () => {
  it('refuses an {X} in a mana ability cost', () => {
    const ctx = pod();
    const player = p1(ctx);
    const perm = spawn(ctx, 'P1', forest());
    const def = editableDef(ctx, perm.oracleId);
    (def.manaAbilities as ManaAbilitySpec[]).push({
      costs: [{ kind: 'mana', cost: { ...cost('{0}'), x: 1 } }, { kind: 'tap' }],
      units: [['G'], ['G']],
    });

    // Nobody announces X for an ability the payment solver activates on its own, so the cost
    // has no value and would go uncharged. The printed {G} ability survives.
    const sources = manaSourcesFor(ctx, player.id).filter((s) => s.cardId === perm.cardId);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.units).toEqual([['G']]);
  });

  it('has no shipped override authoring an {X} mana ability cost', () => {
    const offenders: string[] = [];
    for (const override of listOverrides()) {
      for (const ability of override.def.manaAbilities ?? []) {
        for (const c of ability.costs ?? []) {
          if (c.kind === 'mana' && (c.cost.x ?? 0) > 0) offenders.push(override.name);
        }
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      'These overrides author a mana ability whose cost includes {X}. `manaSourcesFor` drops ' +
        'such abilities, so the card silently loses them — author the card without the {X}.',
    ).toEqual([]);
  });

  it('has no interpreted card authoring an {X} mana ability cost', () => {
    // The override guard cannot see cards the interpreter builds; `interpret-defs.json` is the
    // committed snapshot of those, and the CI-safe stand-in for the bulk cache.
    const snapshot = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'interpret-defs.json'), 'utf8'),
    ) as {
      name: string;
      manaAbilities?: { costs?: { kind: string; cost?: { x?: number } }[] }[];
    }[];
    const offenders = snapshot
      .filter((def) =>
        (def.manaAbilities ?? []).some((a) =>
          (a.costs ?? []).some((c) => c.kind === 'mana' && (c.cost?.x ?? 0) > 0),
        ),
      )
      .map((def) => def.name);
    expect(offenders, 'See the sibling override guard for what to do about these.').toEqual([]);
  });
});
