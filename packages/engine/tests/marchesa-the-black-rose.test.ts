/**
 * Regression test for the "Delayed Trigger … used 'triggerObject' with no trigger object"
 * crash: Marchesa's dies trigger calls `registerDelayedTrigger` with `target: 'triggerObject'`,
 * but by the time a 'dies' ability resolves, its trigger object has already left the
 * battlefield — that's the entire premise of "dies". The generic `ref()` helper restricts
 * `'triggerObject'` to the battlefield (correct for most of its other call sites), so it
 * always returned null here, `registerDelayedTrigger` silently dropped the referent, and the
 * delayed ability halted the engine when it fired at end step with nothing to return.
 * See `effects/resolve.ts`'s `registerDelayedTrigger` case.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

const marchesaOracle = () =>
  oracle({
    name: 'Marchesa, the Black Rose',
    manaCost: '{1}{U}{B}{R}',
    typeLine: 'Legendary Creature — Human Warrior',
    types: ['Creature'],
    subtypes: ['Human', 'Warrior'],
    supertypes: ['Legendary'],
    power: '3',
    toughness: '3',
    oracleText:
      'Dethrone (Whenever this creature attacks, if defending player has more life than you, put a +1/+1 counter on it.)\nOther creatures you control have dethrone.\nWhenever a creature you control with a +1/+1 counter on it dies, return that card to the battlefield under your control at the beginning of the next end step.',
  });

describe('Marchesa, the Black Rose', () => {
  it('returns a countered creature that died, at the next end step, instead of halting the engine', () => {
    const ctx = pod('marchesa-black-rose');
    spawn(ctx, 'P1', marchesaOracle());
    const victim = spawn(ctx, 'P1', bear());
    victim.counters['+1/+1'] = 1;

    // The creature dies — this queues Marchesa's "dies" trigger with `victim` as the trigger
    // object, which by resolution is already in the graveyard.
    pump(moveObject(ctx, victim, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));

    // The fix under test: `registerDelayedTrigger` must still capture a referent for a
    // graveyard trigger object, not silently drop it.
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]!.targetId).toBe(victim.cardId);

    // Advance to the next end step and let the delayed trigger fire — this used to throw
    // "engine bug: Delayed Trigger used 'triggerObject' with no trigger object".
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));

    expect(ctx.state.battlefield.some((p) => p.cardId === victim.cardId)).toBe(true);
    expect(ctx.state.players.find((p) => p.id === 'P1')!.graveyard.some((c) => c.cardId === victim.cardId)).toBe(false);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });
});
