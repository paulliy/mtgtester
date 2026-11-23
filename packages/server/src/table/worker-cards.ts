/**
 * The card data a table worker gets from the main thread (plan M3 task 3): the supported pool
 * and the cards the approved human decklists resolve to. A table game can reach nothing else,
 * so the worker never reads the bulk file, and every worker sees exactly the cards the claim-time
 * check resolved against.
 */

import type { OracleCard } from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { BannedList } from '../decks/banned';
import { parsePlaintextDeck } from '../decks/plaintext';
import type { TableSessionConfig } from './session-port';
import type { TableWorkerCards } from './worker-protocol';

export interface WorkerCardDeps {
  index: OracleIndex;
  pool: SupportedPool;
  banned: BannedList;
}

/** A function from an attempt's configuration to its worker's cards. */
export function workerCardsFor(
  deps: WorkerCardDeps,
): (config: TableSessionConfig) => TableWorkerCards {
  const pool = deps.pool.cards;
  const bannedNames = [...deps.banned.names];
  return (config) => {
    const deckCards = new Map<string, OracleCard>();
    for (const seat of config.seats) {
      if (seat.controller !== 'human') continue;
      const parsed = parsePlaintextDeck(seat.decklist);
      const names = [
        ...parsed.commanderNames,
        ...(parsed.companionName === null ? [] : [parsed.companionName]),
        ...parsed.cards.map((entry) => entry.name),
      ];
      for (const name of names) {
        const card = deps.index.resolve(name);
        if (card !== null) deckCards.set(card.oracleId, card);
      }
    }
    return { pool, deckCards: [...deckCards.values()], bannedNames };
  };
}
