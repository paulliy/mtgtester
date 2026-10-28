/**
 * One seeded heuristic-bot game with table diplomacy (ADR 0035) on for some seats.
 *
 * `diplomacy-sweep` runs this file as a child process per game (payload path in argv, JSON reply
 * on stdout), so a slow game can be killed without losing the run, the same arrangement as
 * `combat-sweep-game.ts`. Importing it runs nothing; tests call `playDiplomacyGame` directly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OracleCard, PlayerId, TableMessage } from '@mtg/shared';
import { Engine, runToCompletion, type EnginePlayerConfig } from '@mtg/engine';
import {
  DiplomacyTable,
  HeuristicDecisionProvider,
  withDiplomacy,
  type DiplomacyStats,
} from '@mtg/bot';

export interface DiplomacyGameRequest {
  seed: string;
  turnCap: number;
  /** Seats that negotiate and play deal-aware. The rest are the plain heuristic bot. */
  diplomacySeats: readonly PlayerId[];
  /**
   * False keeps the diplomacy seats' threat-aware attack targets but makes no deals, so a sweep
   * can tell what deals add from what the targeting alone does.
   */
  negotiate?: boolean;
  decks: readonly { commander: OracleCard; cards: OracleCard[] }[];
}

export interface DiplomacyGameResult {
  winner: PlayerId | null;
  turns: number;
  halted: boolean;
  haltReason?: string;
  /** Each seat's life when the game ended. */
  finalLife: Record<PlayerId, number>;
  stats: DiplomacyStats;
  messages: TableMessage[];
}

export function playDiplomacyGame(request: DiplomacyGameRequest): DiplomacyGameResult {
  const players: EnginePlayerConfig[] = request.decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `diplomacy-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));
  const engine = new Engine({
    gameId: 'diplomacy-sweep',
    seed: request.seed,
    players,
    turnCap: request.turnCap,
  });

  const diplomats = new Set(request.diplomacySeats);
  const table = new DiplomacyTable({
    seed: request.seed,
    seats: players.map((p) => p.id),
    viewOf: (seat) => engine.view(seat),
    negotiates: (seat) => request.negotiate !== false && diplomats.has(seat),
    repairedAttacks: () =>
      engine.getState().eventLog.filter((e) => e.type === 'attackDeclarationRepaired').length,
  });

  // Every seat goes through the table, so the window opens on whoever decides first in a turn
  // and every decision is judged. Plain seats never hold a deal, so judging them is a no-op.
  const providers = new Map<PlayerId, ReturnType<typeof withDiplomacy>>();
  const providerFor = (seat: PlayerId) => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const bot = new HeuristicDecisionProvider(
        `${request.seed}-${seat}`,
        () => engine.view(seat),
        diplomats.has(seat) ? { diplomacy: table.playFor(seat) } : {},
      );
      provider = withDiplomacy(table, bot);
      providers.set(seat, provider);
    }
    return provider;
  };

  const result = runToCompletion(engine, providerFor);
  table.flush();
  return {
    winner: result.winnerSeat,
    turns: result.turnCount,
    halted: result.halted,
    ...(typeof result.haltReason === 'string' ? { haltReason: result.haltReason } : {}),
    finalLife: Object.fromEntries(engine.getState().players.map((p) => [p.id, p.life])),
    stats: { ...table.stats },
    messages: [...table.messages()],
  };
}

function main(): void {
  const payloadPath = process.argv[2];
  if (payloadPath === undefined) throw new Error('usage: diplomacy-game.ts <payload.json>');
  const request = JSON.parse(readFileSync(payloadPath, 'utf8')) as DiplomacyGameRequest;
  process.stdout.write(JSON.stringify(playDiplomacyGame(request)));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main();
}
