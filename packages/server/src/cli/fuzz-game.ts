/**
 * One fuzz game (ADR 0034 decision 8), run in its own process by `fuzz.ts`.
 *
 * A game can spin inside one `Engine.advance()` call, and synchronous JavaScript cannot be stopped
 * from the same process, so the parent holds the wall clock and kills this process when a game
 * outlives it (`combat-sweep-game.ts` has the history). The clock decides only whether a game
 * failed, never what happened in it: every game replays from its request alone.
 *
 * The game runs with `strictInvariants` and the state-invariant checker installed, under the table
 * server's step and object limits. Whatever goes wrong is reported, not thrown: a thrown error or
 * invariant violation, a halted result, an exhausted decision budget, and the heuristic bot's
 * empty-veto fallback, which the parent fails in a heuristic-only game.
 *
 * Reads one JSON `FuzzRequest` from the file named in `argv[2]` and writes one JSON `FuzzReply` to
 * stdout. Not meant to be run by hand: `bun run fuzz --from <seed> --games 1` replays a game.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionResponse, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, RandomDecisionProvider, type DecisionProvider } from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { installStateInvariants } from '../../../engine/src/testing/invariants';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';

export type FuzzProvider = 'heuristic' | 'random';

export interface FuzzDeck {
  label: string;
  commanders: OracleCard[];
  cards: OracleCard[];
}

export interface FuzzRequest {
  seed: string;
  /** One per seat, in seat order. */
  providers: FuzzProvider[];
  decks: FuzzDeck[];
  turnCap: number;
  /** Decisions the providers may answer before the game fails as a runaway. */
  maxDecisions: number;
}

export interface FuzzReply {
  winner: PlayerId | null;
  turns: number;
  decisions: number;
  /**
   * Set when the game halted: the engine's reason, the site of an invariant halt, and whether it
   * was the turn cap.
   */
  halt: { reason: string; site?: string; turnCap: boolean } | null;
  /** A thrown error, an invariant violation among them, with the top of its stack. */
  error: string | null;
  budgetExhausted: boolean;
  /** Times the heuristic bot's veto excluded every candidate and it took the first action. */
  emptyVetoes: number;
  ms: number;
}

const EMPTY_VETO = 'veto excluded every candidate';

export function playFuzzGame(request: FuzzRequest): FuzzReply {
  const restore = installStateInvariants();
  const started = performance.now();
  const reply: FuzzReply = {
    winner: null,
    turns: 0,
    decisions: 0,
    halt: null,
    error: null,
    budgetExhausted: false,
    emptyVetoes: 0,
    ms: 0,
  };
  const engine = new Engine(
    {
      gameId: 'fuzz',
      seed: request.seed,
      turnCap: request.turnCap,
      strictInvariants: true,
      players: request.decks.map((deck, seat) => ({
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
        request.providers[index] === 'random'
          ? new RandomDecisionProvider(`${request.seed}-${seat}`)
          : new HeuristicDecisionProvider(`${request.seed}-${seat}`, () => engine.view(seat));
      providers.set(seat, provider);
    }
    return provider;
  };
  try {
    for (;;) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        reply.winner = step.result.winnerSeat;
        reply.turns = step.result.turnCount;
        if (step.result.halted)
          reply.halt = {
            reason: step.result.haltReason ?? 'halted',
            ...(step.result.haltSite !== undefined && { site: step.result.haltSite }),
            turnCap:
              step.result.turnCount >= request.turnCap &&
              (step.result.haltReason ?? '').startsWith('turn cap'),
          };
        break;
      }
      if (step.kind === 'continue') continue;
      if (reply.decisions === request.maxDecisions) {
        reply.budgetExhausted = true;
        reply.turns = engine.getState().turnNumber;
        break;
      }
      reply.decisions++;
      const response: DecisionResponse = providerFor(step.request.decidingPlayer).decide(
        step.request,
      );
      if (response.note?.includes(EMPTY_VETO) === true) reply.emptyVetoes++;
      engine.submit(response);
    }
  } catch (error) {
    reply.turns = engine.getState().turnNumber;
    reply.error =
      error instanceof Error
        ? (error.stack ?? `${error.name}: ${error.message}`).split('\n').slice(0, 6).join('\n')
        : String(error);
  } finally {
    restore();
  }
  reply.ms = Math.round(performance.now() - started);
  return reply;
}

function main(): void {
  const payloadPath = process.argv[2];
  if (payloadPath === undefined) throw new Error('usage: fuzz-game.ts <request.json>');
  const reply = playFuzzGame(JSON.parse(readFileSync(payloadPath, 'utf8')) as FuzzRequest);
  process.stdout.write(JSON.stringify(reply));
}

// Only as the entry point: the parent imports this module's types.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) main();
