import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { addMana } from '../src/mana/pool';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { moveObject, queueAttackDeclarationTriggers } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const card = pinned.cards.find((entry) => entry.card.name === 'Breena, the Demagogue')!.card;
function pod() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(12, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.players[1]!.life = 45;
  return ctx;
}
function attack(
  ctx: ReturnType<typeof pod>,
  owner: 'P1' | 'P2' | 'P3',
  defenders: ('P1' | 'P2' | 'P3' | 'P4')[],
) {
  const attackers = defenders.map((defender, i) => {
    const attacker = spawn(ctx, owner, oracle({ name: `Breena attack witness ${i}` }));
    attacker.attacking = defender;
    return attacker;
  });
  queueAttackDeclarationTriggers(ctx, attackers);
  return attackers;
}
describe('Breena faithful defending-opponent life comparison', () => {
  it('breena-normal-cast: cast with legal mana, then one trigger per attacked opponent', () => {
    const ctx = pod(),
      player = ctx.state.players[0]!;
    const inHand = conjure(ctx, 'P1', card, 'hand');
    addMana(player, [{ symbol: 'C' }, { symbol: 'W' }, { symbol: 'B' }]);
    const option = computePriorityOptions(ctx, player).find((o) =>
      o.description.includes('Breena'),
    );
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: inHand.id, fromCommand: false },
        { index: 0, targets: new Map() },
      ),
    );
    pump(resolveTopOfStack(ctx));
    const breena = ctx.state.battlefield.find((p) => p.name === card.name)!;
    expect(breena).toBeDefined();
    attack(ctx, 'P1', ['P2', 'P2']);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const before = player.hand.length;
    pump(runPrioritySequence(ctx));
    expect(player.hand.length).toBe(before + 1);
    expect(breena.counters['+1/+1']).toBe(2);
  });
  it('breena-another-opponent: attacker life is irrelevant, each distinct defender is checked', () => {
    const ctx = pod();
    spawn(ctx, 'P1', card);
    ctx.state.players[2]!.life = 44;
    ctx.state.players[3]!.life = 43;
    ctx.state.players[0]!.life = 100;
    attack(ctx, 'P1', ['P2', 'P3', 'P4']);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    expect(ctx.state.pendingTriggers.map((t) => t.scope!.eventPlayerId)).toEqual(['P1', 'P1']);
  });
  it('breena-negative-tie: equal opponent life never triggers despite low attacker life', () => {
    const ctx = pod();
    spawn(ctx, 'P1', card);
    ctx.state.players.forEach((p) => (p.life = p.id === 'P1' ? 1 : 40));
    attack(ctx, 'P1', ['P2']);
    expect(ctx.state.pendingTriggers).toEqual([]);
  });
  it('breena-negative-controller: attacking the controller does not qualify', () => {
    const ctx = pod();
    spawn(ctx, 'P1', card);
    ctx.state.players[0]!.life = 100;
    attack(ctx, 'P3', ['P1']);
    expect(ctx.state.pendingTriggers).toEqual([]);
  });
  it('breena-attacking-opponent-draws: a different attacker draws, controller receives counters', () => {
    const ctx = pod(),
      breena = spawn(ctx, 'P1', card);
    attack(ctx, 'P3', ['P2', 'P2']);
    const before = ctx.state.players.map((p) => p.hand.length);
    pump(runPrioritySequence(ctx));
    expect(ctx.state.players.map((p) => p.hand.length)).toEqual([
      before[0],
      before[1],
      before[2]! + 1,
      before[3],
    ]);
    expect(breena.counters['+1/+1']).toBe(2);
  });
  it('breena-resolution-recheck: changed opponent life prevents drawing and counters', () => {
    const ctx = pod(),
      breena = spawn(ctx, 'P1', card);
    attack(ctx, 'P1', ['P2']);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    ctx.state.players[1]!.life = 40;
    pump(resolveTopOfStack(ctx));
    expect(breena.counters['+1/+1'] ?? 0).toBe(0);
    expect(ctx.state.players[0]!.hand).toHaveLength(0);
  });
  it('breena-event-defender-survives-attacker-removal: removing attacking creature does not erase the attacked player', () => {
    const ctx = pod(),
      breena = spawn(ctx, 'P1', card);
    const [attacker] = attack(ctx, 'P3', ['P2']);
    pump(priorityCheckpoint(ctx));
    pump(moveObject(ctx, attacker!, { zone: 'exile' }));
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.players[2]!.hand).toHaveLength(1);
    expect(breena.counters['+1/+1']).toBe(2);
  });
  it('breena-counters-not-targeted: the counters are not targeted, so Breena leaving does not stop the draw', () => {
    // Oracle: "you put two +1/+1 counters on a creature you control" -- no target.
    const ctx = pod(),
      breena = spawn(ctx, 'P1', card);
    attack(ctx, 'P3', ['P2']);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack[0]!.targets).toEqual([]);
    pump(moveObject(ctx, breena, { zone: 'exile' }));
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.players[2]!.hand).toHaveLength(1);
  });
  it('breena-real-and-fixture-alias: every clause has legal authored IR', () => {
    for (const oracleId of [card.oracleId, fixtureOracleId(card.name)]) {
      const def = interpretCard({ ...card, oracleId });
      expect(def.unmodeledReasons).toEqual([]);
      expect(validateCardDefinition(def)).toEqual([]);
      expect(def.keywords).toContain('flying');
    }
  });
});
