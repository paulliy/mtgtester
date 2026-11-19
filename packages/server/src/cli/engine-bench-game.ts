/**
 * One seeded four-player benchmark game: engine time apart from the providers, and a fingerprint
 * over everything the engine surfaced. `engine-bench` and `hill-climb` both play these.
 */
import { createHash } from 'node:crypto';
import type { DecisionResponse, PlayerId } from '@mtg/shared';
import { Engine, RandomDecisionProvider, type DecisionProvider } from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import type { FuzzDeck, FuzzProvider } from './fuzz-game';

export interface GameRun {
  seed: number;
  turns: number;
  decisions: number;
  engineMs: number;
  providerMs: number;
  outcome: string;
  fingerprint: string;
}

/**
 * Plays seed `seed`'s pod to the end. The fingerprint is a SHA-256 over every decision request
 * (with its full option menu), every response, the final event log and the outcome.
 */
export function playGame(
  seed: number,
  decks: FuzzDeck[],
  providerKinds: FuzzProvider[],
  turnCap: number,
): GameRun {
  const seedText = `fuzz-${seed}`;
  const engine = new Engine(
    {
      gameId: 'bench',
      seed: seedText,
      turnCap,
      players: decks.map((deck, seat) => ({
        id: `P${seat + 1}`,
        deckId: deck.label,
        commanders: deck.commanders,
        cards: deck.cards,
      })),
    },
    TABLE_ENGINE_LIMITS,
  );
  const providers = new Map<PlayerId, DecisionProvider>();
  const providerFor = (seat: PlayerId): DecisionProvider => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const index = Number(seat.slice(1)) - 1;
      provider =
        providerKinds[index] === 'random'
          ? new RandomDecisionProvider(`${seedText}-${seat}`)
          : new HeuristicDecisionProvider(`${seedText}-${seat}`, () => engine.view(seat));
      providers.set(seat, provider);
    }
    return provider;
  };
  const hash = createHash('sha256');
  let engineMs = 0;
  let providerMs = 0;
  let decisions = 0;
  let outcome = 'running';
  try {
    for (;;) {
      let t = performance.now();
      const step = engine.advance();
      engineMs += performance.now() - t;
      if (step.kind === 'gameOver') {
        outcome = step.result.halted
          ? `halted: ${step.result.haltReason ?? ''}`
          : `winner ${step.result.winnerSeat ?? 'none'}`;
        break;
      }
      if (step.kind === 'continue') continue;
      decisions++;
      hash.update(JSON.stringify(step.request));
      t = performance.now();
      const response: DecisionResponse = providerFor(step.request.decidingPlayer).decide(
        step.request,
      );
      providerMs += performance.now() - t;
      hash.update(JSON.stringify(response));
      t = performance.now();
      engine.submit(response);
      engineMs += performance.now() - t;
    }
  } catch (error) {
    outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  hash.update(JSON.stringify(engine.eventsSince(0)));
  hash.update(outcome);
  return {
    seed,
    turns: engine.getState().turnNumber,
    decisions,
    engineMs: Math.round(engineMs),
    providerMs: Math.round(providerMs),
    outcome,
    fingerprint: hash.digest('hex').slice(0, 16),
  };
}
