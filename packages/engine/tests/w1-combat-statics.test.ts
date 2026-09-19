import { queueStepTriggers } from '../src/turn/turn';
import { queueTriggersForEvent } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { bear, copies, forest, gameConfig, pump, spawn } from './fixtures';
const cards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
function real(name: string): OracleCard {
  const card = cards.find((c) => c.name === name);
  if (!card) throw Error(name);
  return card;
}
function pod() {
  return createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'w1-combat-statics' },
    ),
  );
}
describe('W1 combat statics from frozen Oracle text', () => {
  it.each(['Ohran Frostfang', 'Crescendo of War'])('fully interprets %s', (name) => {
    const def = interpretCard(real(name));
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.modeled).toBe(true);
  });
  it('grants deathtouch only to your attackers and refreshes on combat and control changes', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real('Ohran Frostfang'));
    const yours = spawn(ctx, 'P1', bear()),
      opponent = spawn(ctx, 'P2', bear());
    const keywords = () => computeCharacteristics(ctx, yours).keywords;
    expect(keywords()).not.toContain('deathtouch');
    yours.attacking = 'P2';
    opponent.attacking = 'P1';
    expect(keywords()).toContain('deathtouch');
    expect(computeCharacteristics(ctx, opponent).keywords).not.toContain('deathtouch');
    yours.attacking = null;
    yours.blocking = opponent.id;
    expect(keywords()).not.toContain('deathtouch');
    yours.blocking = null;
    yours.attacking = 'P2';
    expect(keywords()).toContain('deathtouch');
    yours.controllerId = 'P2';
    expect(keywords()).not.toContain('deathtouch');
  });
  it('counts strife counters dynamically for every attacker but only your blockers', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', real('Crescendo of War'));
    const yours = spawn(ctx, 'P1', bear()),
      opponent = spawn(ctx, 'P2', bear());
    source.counters['strife'] = 2;
    expect(computeCharacteristics(ctx, yours).power).toBe(2);
    yours.attacking = 'P2';
    opponent.attacking = 'P1';
    expect(computeCharacteristics(ctx, yours).power).toBe(4);
    expect(computeCharacteristics(ctx, opponent).power).toBe(4);
    source.counters['strife'] = 3;
    expect(computeCharacteristics(ctx, yours).power).toBe(5);
    yours.attacking = null;
    yours.blocking = opponent.id;
    opponent.attacking = null;
    opponent.blocking = yours.id;
    expect(computeCharacteristics(ctx, yours).power).toBe(5);
    expect(computeCharacteristics(ctx, opponent).power).toBe(2);
    yours.blocking = null;
    expect(computeCharacteristics(ctx, yours).power).toBe(2);
  });
});

it('Crescendo gains a strife counter on each player upkeep', () => {
  const ctx = pod();
  const source = spawn(ctx, 'P1', real('Crescendo of War'));
  for (const [i, player] of ctx.state.players.entries()) {
    ctx.state.currentTurnPlayer = player.id;
    ctx.state.activePlayerIndex = i;
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(source.counters['strife']).toBe(i + 1);
  }
});
it('Frostfang draws once per friendly creature dealing combat damage, not per damage point', () => {
  const ctx = pod();
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  const source = spawn(ctx, 'P1', real('Ohran Frostfang'));
  const other = spawn(ctx, 'P1', bear()),
    opponent = spawn(ctx, 'P2', bear());
  const player = ctx.state.players.find((p) => p.id === 'P1')!;
  const before = player.hand.length;
  queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [
    { permanent: source, amount: 3, playerId: 'P2' },
    { permanent: other, amount: 2, playerId: 'P2' },
    { permanent: opponent, amount: 2, playerId: 'P1' },
  ]);
  expect(ctx.state.pendingTriggers).toHaveLength(2);
  pump(runPrioritySequence(ctx));
  expect(player.hand.length).toBe(before + 2);
});
