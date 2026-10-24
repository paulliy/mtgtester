import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { drawCards } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { moveObject } from '../src/state/objects';
import type { EngineCardObject, EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, declareAttacks, oracle, pump, spawn } from './fixtures';
import { battlefield, checkpoint, game, pinned, player, resolve } from './pr11-helpers';
import { runCombatPhase } from '../src/combat/combat';

const DUSKMAGE = pinned("Defacing Duskmage // Vandal's Edit");
const DYNASTORIAN = pinned('Eiganjo Dynastorian // Replenish');

const preparedCopies = (ctx: GameContext, name: string): EngineCardObject[] =>
  ctx.state.exile.filter((card) => card.name === name && card.isCardCopy === true);

function draw(ctx: GameContext, id: string): void {
  pump(drawCards(ctx, player(ctx, id), 1));
  checkpoint(ctx);
}

function castCopy(ctx: GameContext, copy: EngineCardObject): void {
  const option = computePriorityOptions(ctx, player(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === copy.id;
  });
  expect(option, `cast ${copy.name}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

/** P2 draws its first and second cards this turn; the second prepares Duskmage. */
function preparedDuskmage(seed: string): { ctx: GameContext; duskmage: EnginePermanent } {
  const ctx = game(seed);
  const duskmage = spawn(ctx, 'P1', DUSKMAGE);
  draw(ctx, 'P2');
  expect(ctx.state.stack).toHaveLength(0);
  draw(ctx, 'P2');
  expect(ctx.state.stack.at(-1)?.description).toContain('becomes prepared');
  resolve(ctx);
  return { ctx, duskmage };
}

function attackWith(ctx: GameContext, attackers: EnginePermanent[]): void {
  ctx.state.phase = 'combat';
  const ids = new Set(attackers.map((attacker) => attacker.id));
  const gen = runCombatPhase(ctx);
  let step = gen.next();
  while (!step.done) {
    if (step.value.decisionType === 'declareAttackers') {
      step = gen.next(declareAttacks(step.value, (id) => (ids.has(id) ? 'P2' : null)));
      continue;
    }
    if (ctx.state.stack.length > 0) return;
    step = gen.next({ index: 0, targets: new Map() });
  }
}

describe('prepare (CR 722)', () => {
  it('prepare-modeled — both preparation cards model under the Oracle and fixture ids', () => {
    for (const card of [DUSKMAGE, DYNASTORIAN]) {
      for (const oracleId of [card.oracleId, fixtureOracleId(card.name)]) {
        const def = interpretCard({ ...card, oracleId } as typeof card);
        expect(def.unmodeledReasons).toEqual([]);
        expect(def.prepareSpell?.spellAbility?.kind).toBe('spell');
      }
    }
  });

  it("duskmage-c01-positive — an opponent's second draw this turn prepares it and makes a castable copy", () => {
    const { ctx, duskmage } = preparedDuskmage('duskmage-second-draw');
    expect(duskmage.prepared).toBe(true);
    expect(preparedCopies(ctx, "Vandal's Edit")).toHaveLength(1);
    // The third draw is not their second.
    draw(ctx, 'P2');
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('duskmage-c01-negative — your own second draw does not prepare it', () => {
    const ctx = game('duskmage-own-draw');
    const duskmage = spawn(ctx, 'P1', DUSKMAGE);
    draw(ctx, 'P1');
    draw(ctx, 'P1');
    expect(ctx.state.stack).toHaveLength(0);
    expect(duskmage.prepared).toBeUndefined();
  });

  it('duskmage-c01-event — a third draw before the trigger resolves still prepares it', () => {
    const ctx = game('duskmage-third-before');
    const duskmage = spawn(ctx, 'P1', DUSKMAGE);
    draw(ctx, 'P2');
    draw(ctx, 'P2');
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    resolve(ctx);
    expect(duskmage.prepared).toBe(true);
  });

  it("duskmage-c02-positive — casting the copy of Vandal's Edit unprepares it; it draws two and each player loses 2", () => {
    const { ctx, duskmage } = preparedDuskmage('duskmage-cast');
    const [copy] = preparedCopies(ctx, "Vandal's Edit");
    addMana(player(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'B' }, { symbol: 'C' }]);
    const hand = player(ctx, 'P1').hand.length;
    const lives = ctx.state.players.map((p) => p.life);
    castCopy(ctx, copy!);
    expect(duskmage.prepared).toBeUndefined();
    resolve(ctx);
    expect(player(ctx, 'P1').hand.length).toBe(hand + 2);
    expect(ctx.state.players.map((p) => p.life)).toEqual(lives.map((life) => life - 2));
    checkpoint(ctx);
    // A copy of a card ceases to exist once it leaves the stack (CR 704.5e).
    expect(player(ctx, 'P1').graveyard.some((card) => card.name === "Vandal's Edit")).toBe(false);
    expect(preparedCopies(ctx, "Vandal's Edit")).toHaveLength(0);
  });

  it('duskmage-c02-once — an already prepared permanent does not become prepared again', () => {
    const { ctx } = preparedDuskmage('duskmage-twice');
    Object.assign(ctx.state, { turnNumber: ctx.state.turnNumber + 1 });
    for (const p of ctx.state.players) p.cardsDrawnThisTurn = 0;
    draw(ctx, 'P3');
    draw(ctx, 'P3');
    resolve(ctx);
    expect(preparedCopies(ctx, "Vandal's Edit")).toHaveLength(1);
  });

  it('duskmage-c02-leaves — the copy ceases to exist when the prepared permanent leaves', () => {
    const { ctx, duskmage } = preparedDuskmage('duskmage-leaves');
    pump(moveObject(ctx, duskmage, { zone: 'graveyard' }));
    checkpoint(ctx);
    expect(preparedCopies(ctx, "Vandal's Edit")).toHaveLength(0);
  });

  it('dynastorian-c01-positive — attacking with two creatures prepares it; with one it does not', () => {
    const ctx = game('dynastorian-attack');
    const dynastorian = spawn(ctx, 'P1', DYNASTORIAN);
    const partner = spawn(ctx, 'P1', bear());
    attackWith(ctx, [dynastorian]);
    expect(ctx.state.stack).toHaveLength(0);
    const ctx2 = game('dynastorian-attack-two');
    const second = spawn(ctx2, 'P1', DYNASTORIAN);
    attackWith(ctx2, [second, spawn(ctx2, 'P1', bear())]);
    resolve(ctx2);
    expect(second.prepared).toBe(true);
    expect(preparedCopies(ctx2, 'Replenish')).toHaveLength(1);
    void partner;
  });

  it('replenish-c02-positive — the Replenish copy is cast at sorcery speed and returns your enchantments', () => {
    const ctx = game('replenish');
    const dynastorian = spawn(ctx, 'P1', DYNASTORIAN);
    attackWith(ctx, [dynastorian, spawn(ctx, 'P1', bear())]);
    resolve(ctx);
    const [copy] = preparedCopies(ctx, 'Replenish');
    const enchantment = oracle({
      name: 'Test Charm',
      typeLine: 'Enchantment',
      manaCost: '{1}',
      oracleText: '',
    });
    conjure(ctx, 'P1', enchantment, 'graveyard');
    conjure(
      ctx,
      'P2',
      { ...enchantment, name: 'Test Foreign Charm' } as typeof enchantment,
      'graveyard',
    );
    addMana(player(ctx, 'P1'), [
      { symbol: 'W' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    // Still in combat: a sorcery copy is not castable.
    expect(
      computePriorityOptions(ctx, player(ctx, 'P1')).some(
        (entry) => (entry.payload as { objectId?: string }).objectId === copy!.id,
      ),
    ).toBe(false);
    Object.assign(ctx.state, { phase: 'postcombatMain', step: null, stack: [] });
    castCopy(ctx, copy!);
    resolve(ctx);
    expect(battlefield(ctx, 'Test Charm')).toHaveLength(1);
    expect(battlefield(ctx, 'Test Foreign Charm')).toHaveLength(0);
    expect(dynastorian.prepared).toBeUndefined();
  });
});
