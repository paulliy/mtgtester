/**
 * One game of the ADR 0024 sub-phase 7c sweep, run in its own process.
 *
 * ## Why this is a separate process at all
 *
 * The parent (`combat-sweep.ts`) needs to survive a game that never ends, and it cannot do that
 * in-process. The engine's own runaway guards — the turn cap (`flow/game.ts`) and
 * `runToCompletion`'s `maxDecisions` — both assume the game keeps *reaching* them, and a game can
 * spin inside a single `Engine.advance()` call without surfacing a decision or advancing a turn.
 * When that happens the loop is synchronous JavaScript: no timer fires, no callback runs, and
 * nothing in the same process can interrupt it.
 *
 * Three such games turned up in the first sweep attempts, all pre-existing and none caused by the
 * search: a `{0}` activated ability the bot re-activated until the stack held 1,270 copies of it
 * (fixed — see `WEIGHTS.repeatActivationPenalty`), a targeted spell whose alternative-cost option
 * carried no target slots (fixed — see `legal.ts`'s `nonMana` branch), and a Twilight Diviner
 * whose "a creature enters from a graveyard" trigger fires on the token copy it just made, which
 * is a card-modelling loop belonging to the coverage stream, not to this ADR.
 *
 * A measurement harness that dies on the third one is not a harness. So each game runs here, under
 * a wall-clock kill from the parent, and a game that hangs becomes one recorded data point instead
 * of a lost run of hundreds.
 *
 * Note the wall clock lives in the PARENT, never in the engine: a timeout that could halt a game
 * would make outcomes depend on machine speed, and every game is supposed to be reproducible from
 * its seed alone (brief §4, §5.9). Here it only ever decides whether a result is reported, never
 * what the result is.
 *
 * The decks cross the process boundary as JSON. That round-trip has to be game-identical or the
 * whole measurement is measuring the serializer: checked by playing eight seeds twice, once with
 * the request object as built and once with `JSON.parse(JSON.stringify(request))`, and comparing
 * winner, turn count and search-engagement counts. Worth re-running if `OracleCard` ever grows a
 * field that does not survive JSON (a Set, a Map, a `undefined` that means something).
 *
 * Reads one JSON `GameRequest` from the file named in `argv[2]` and writes one JSON `GameReply`
 * to stdout. A file rather than stdin because `bun run` does not reliably forward stdin to the
 * script on Windows, and the payload (four decks of `OracleCard`) is far too big for argv. Not
 * meant to be run by hand.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletion, type EnginePlayerConfig } from '@mtg/engine';
import { HeuristicDecisionProvider, type CombatSearchOptions } from '@mtg/bot';

/** Per-arm tallies for one game. Summed by the parent across the whole configuration. */
export interface ArmCounters {
  wins: number;
  combatDecisionMs: number;
  combatDecisions: number;
  totalMs: number;
  totalDecisions: number;
  blockSearched: number;
  blockDeclined: number;
  splitSearched: number;
  splitDeclined: number;
}

export interface GameRequest {
  seed: string;
  turnCap: number;
  /** Seats running the search arm; every other seat runs the Phase 4 heuristic. */
  searchSeats: PlayerId[];
  /** Bound overrides for the search arm. Never carries `onSearch` — functions don't serialize. */
  options: CombatSearchOptions;
  decks: { commander: OracleCard; cards: OracleCard[] }[];
}

export interface GameReply {
  winner: PlayerId | null;
  turns: number;
  halted: boolean;
  search: ArmCounters;
  control: ArmCounters;
}

const emptyCounters = (): ArmCounters => ({
  wins: 0,
  combatDecisionMs: 0,
  combatDecisions: 0,
  totalMs: 0,
  totalDecisions: 0,
  blockSearched: 0,
  blockDeclined: 0,
  splitSearched: 0,
  splitDeclined: 0,
});

const COMBAT_DECISIONS = new Set(['declareBlockers', 'assignCombatDamage', 'declareAttackers']);

export function playOneGame(request: GameRequest): GameReply {
  const players: EnginePlayerConfig[] = request.decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `sweep-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));

  const engine = new Engine({
    gameId: 'combat-sweep',
    seed: request.seed,
    players,
    turnCap: request.turnCap,
  });

  const searchSeats = new Set(request.searchSeats);
  const search = emptyCounters();
  const control = emptyCounters();
  const armOf = (seat: PlayerId): ArmCounters => (searchSeats.has(seat) ? search : control);

  const providers = new Map<PlayerId, HeuristicDecisionProvider>();
  const providerFor = (seat: PlayerId): HeuristicDecisionProvider => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const arm = armOf(seat);
      const combatSearch: CombatSearchOptions = searchSeats.has(seat)
        ? {
            ...request.options,
            onSearch: (kind, searched) => {
              if (kind === 'block' && searched) arm.blockSearched++;
              else if (kind === 'block') arm.blockDeclined++;
              else if (searched) arm.splitSearched++;
              else arm.splitDeclined++;
            },
          }
        : { enabled: false };
      provider = new HeuristicDecisionProvider(`${request.seed}-${seat}`, () => engine.view(seat), {
        combatSearch,
      });
      providers.set(seat, provider);
    }
    return provider;
  };

  // Timing wraps `decide` rather than sitting in `onDecision`, which fires after the fact.
  const timed = (
    seat: PlayerId,
  ): { decide: (r: DecisionRequest) => ReturnType<HeuristicDecisionProvider['decide']> } => {
    const provider = providerFor(seat);
    const arm = armOf(seat);
    return {
      decide: (decisionRequest) => {
        const started = performance.now();
        const response = provider.decide(decisionRequest);
        const elapsed = performance.now() - started;
        arm.totalMs += elapsed;
        arm.totalDecisions++;
        if (COMBAT_DECISIONS.has(decisionRequest.decisionType)) {
          arm.combatDecisionMs += elapsed;
          arm.combatDecisions++;
        }
        return response;
      },
    };
  };

  const result = runToCompletion(engine, timed);
  if (result.winnerSeat !== null) armOf(result.winnerSeat).wins++;
  return {
    winner: result.winnerSeat,
    turns: result.turnCount,
    halted: result.halted,
    search,
    control,
  };
}

function main(): void {
  const payloadPath = process.argv[2];
  if (payloadPath === undefined) throw new Error('usage: combat-sweep-game.ts <payload.json>');
  const reply = playOneGame(JSON.parse(readFileSync(payloadPath, 'utf8')) as GameRequest);
  process.stdout.write(JSON.stringify(reply));
}

// Only when run as the entry point. Without this guard, importing anything from this module runs a
// game in the importing process with the importing process argv, which is exactly what happened
// the first time the parent imported these types by value.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main();
}
