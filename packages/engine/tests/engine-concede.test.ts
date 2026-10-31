/**
 * `Engine.concede` (ADR 0031 decision 10, plan M4 task 2): a game ended by agreement is a draw for
 * the players still in it, recorded as `conceded` then `gameOver`, and a concession that lands
 * while a spell is being cast keeps its event after the cast's checkpoint rewinds.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, GameEvent, OracleCard } from '@mtg/shared';
import { Engine } from '../src/engine';
import { EngineUsageError } from '../src/errors';
import { commanderFor, copies, forestsPod, gameConfig, plains } from './fixtures';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };
/** Dawn's Truce: casting it asks, mid-cast, whether to promise an opponent a gift. */
const truce = (): OracleCard => pins.cards.find(({ card }) => card.name === "Dawn's Truce")!.card;

/** Answer with a sensible default: keep hands, play lands, cast the Truce when offered. */
function choose(request: DecisionRequest): number {
  const by = (type: string) => request.legalActions.find((action) => action.type === type);
  const truceCast = request.legalActions.find(
    (action) => action.type === 'castSpell' && action.description.includes("Dawn's Truce"),
  );
  return (truceCast ?? by('keep') ?? by('playLand') ?? request.legalActions[0])!.id;
}

function firstDecision(engine: Engine): DecisionRequest {
  const step = engine.advance();
  if (step.kind !== 'decision') throw new Error('expected a decision');
  return step.request;
}

const tail = (engine: Engine, n: number): string[] =>
  engine
    .eventsSince(0)
    .slice(-n)
    .map((event: GameEvent) => event.type);

describe('Engine.concede', () => {
  it('ends the game as a draw for everyone still in it, with the reason', () => {
    const engine = new Engine(gameConfig(forestsPod(), { seed: 'concede-1' }));
    firstDecision(engine);
    expect(engine.concede(['P1', 'P2', 'P3', 'P4'], 'timeLimit')).toBe(true);
    const result = engine.getResult();
    expect(result).toMatchObject({
      winnerSeat: null,
      halted: false,
      haltReason: null,
      endReason: 'timeLimit',
    });
    expect(tail(engine, 2)).toEqual(['conceded', 'gameOver']);
    const conceded = engine.eventsSince(0).find((event) => event.type === 'conceded');
    expect(conceded?.payload).toEqual({ players: ['P1', 'P2', 'P3', 'P4'], reason: 'timeLimit' });
    expect(engine.advance()).toEqual({ kind: 'gameOver', result });
    // Once over, a second concession changes nothing.
    expect(engine.concede(['P1'], 'allAway')).toBe(false);
  });

  it('withdraws the waiting decision, which can no longer be answered', () => {
    const engine = new Engine(gameConfig(forestsPod(), { seed: 'concede-2' }));
    const request = firstDecision(engine);
    engine.concede(['P1', 'P2', 'P3', 'P4'], 'allAway');
    expect(() => engine.submit({ requestId: request.requestId, actionId: 0 })).toThrow(
      EngineUsageError,
    );
  });

  it('is not charged to the work budget the last step left behind', () => {
    const engine = new Engine(gameConfig(forestsPod(), { seed: 'concede-budget' }), {
      maxStepWork: 50_000,
    });
    firstDecision(engine);
    // The step that surfaced the decision spent the whole budget.
    const budget = (engine as unknown as { ctx: { budget: { stepWork: { count: number } } } }).ctx
      .budget;
    budget.stepWork.count = 50_000;
    expect(engine.concede(['P1', 'P2', 'P3', 'P4'], 'allAway')).toBe(true);
    expect(engine.getResult()?.endReason).toBe('allAway');
    expect(tail(engine, 2)).toEqual(['conceded', 'gameOver']);
  });

  it('refuses before the game has surfaced a decision', () => {
    const engine = new Engine(gameConfig(forestsPod(), { seed: 'concede-3' }));
    expect(() => engine.concede(['P1'], 'timeLimit')).toThrow(EngineUsageError);
  });

  it('keeps the conceded event when the concession lands mid-cast', () => {
    const seats = [0, 1, 2, 3].map(() => ({
      commander: commanderFor('W', 'Test White General'),
      cards: [...copies(20, plains), ...copies(20, truce)],
    }));
    const engine = new Engine(gameConfig(seats, { seed: 'concede-mid-cast', turnCap: 30 }));
    let midCast: DecisionRequest | null = null;
    for (let i = 0; i < 3000 && midCast === null; i++) {
      const step = engine.advance();
      if (step.kind !== 'decision') break;
      if (step.request.legalActions.some((action) => action.type === 'promiseGift')) {
        midCast = step.request;
        break;
      }
      engine.submit({ requestId: step.request.requestId, actionId: choose(step.request) });
    }
    expect(midCast).not.toBeNull();
    const caster = midCast!.decidingPlayer;
    // The spell is on the stack while its cast is in progress.
    expect(engine.getState().stack).toHaveLength(1);
    const lastBefore = engine.eventsSince(0).at(-1)!.sequence;
    engine.concede(['P1', 'P2', 'P3', 'P4'], 'timeLimit');
    expect(tail(engine, 2)).toEqual(['conceded', 'gameOver']);
    expect(engine.getResult()?.endReason).toBe('timeLimit');
    // The rewind took back the cast's events, but the concession is numbered after every event
    // emitted before it, which a server may already have recorded.
    const conceded = engine.eventsSince(0).find((event) => event.type === 'conceded')!;
    expect(conceded.sequence).toBeGreaterThan(lastBefore);
    // The cast rewound: the stack is empty and the Truce is back in its caster's hand.
    expect(engine.getState().stack).toEqual([]);
    expect(engine.view(caster).hand.map((card) => card.name)).toContain("Dawn's Truce");
  });
});
