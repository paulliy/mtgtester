/**
 * One game of the bot league (ADR 0039), run in its own process so a hung game is one data point
 * rather than a lost run (the same reasoning as `combat-sweep-game.ts`). Reads a JSON
 * `LeagueGameRequest` from the file named in `argv[2]` and writes a `LeagueGameReply` to stdout.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotSteering, DecisionRequest, OracleCard, PlayerId } from '@mtg/shared';
import { Engine, runToCompletion, type EnginePlayerConfig } from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { buildCardKnowledge } from '../ai/card-traits';

/** How one seat's bot is configured. */
export interface LeagueArm {
  name: string;
  /** The pre-ADR 0039 flat scoring. */
  legacy?: boolean;
  /** Card traits from the IR. */
  knowledge?: boolean;
  /** Fixed strategist knobs for the whole game. */
  steering?: BotSteering;
}

export interface LeagueGameRequest {
  seed: string;
  turnCap: number;
  /** Arm per seat, in seat order. */
  seats: LeagueArm[];
  decks: { commander: OracleCard; cards: OracleCard[] }[];
}

export interface LeagueGameReply {
  winner: PlayerId | null;
  /** Arm name of the winner, or null for a draw. */
  winnerArm: string | null;
  turns: number;
  halted: boolean;
  /** Life of each seat at the end, 0 for an eliminated seat. */
  life: Record<PlayerId, number>;
  ms: number;
}

export function playLeagueGame(request: LeagueGameRequest): LeagueGameReply {
  const started = performance.now();
  const players: EnginePlayerConfig[] = request.decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `league-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));
  const engine = new Engine({
    gameId: 'bot-league',
    seed: request.seed,
    players,
    turnCap: request.turnCap,
  });
  const knowledge = buildCardKnowledge(engine.cardDefinitions());
  const providers = new Map<PlayerId, HeuristicDecisionProvider>();
  const armOf = (seat: PlayerId): LeagueArm => request.seats[Number(seat.slice(1)) - 1]!;
  const providerFor = (
    seat: PlayerId,
  ): { decide: (r: DecisionRequest) => ReturnType<HeuristicDecisionProvider['decide']> } => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const arm = armOf(seat);
      provider = new HeuristicDecisionProvider(`${request.seed}-${seat}`, () => engine.view(seat), {
        ...(arm.legacy === true ? { legacy: true } : {}),
        ...(arm.knowledge === true ? { knowledge } : {}),
        ...(arm.steering === undefined ? {} : { steering: () => arm.steering }),
      });
      providers.set(seat, provider);
    }
    return provider;
  };
  const result = runToCompletion(engine, providerFor);
  const life: Record<PlayerId, number> = {};
  for (const player of engine.getState().players) {
    life[player.id] = player.hasLost === true ? 0 : player.life;
  }
  return {
    winner: result.winnerSeat,
    winnerArm: result.winnerSeat === null ? null : armOf(result.winnerSeat).name,
    turns: result.turnCount,
    halted: result.halted,
    life,
    ms: Math.round(performance.now() - started),
  };
}

function main(): void {
  const payloadPath = process.argv[2];
  if (payloadPath === undefined) throw new Error('usage: bot-league-game.ts <payload.json>');
  const reply = playLeagueGame(JSON.parse(readFileSync(payloadPath, 'utf8')) as LeagueGameRequest);
  process.stdout.write(JSON.stringify(reply));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main();
}
