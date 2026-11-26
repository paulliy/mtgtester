/**
 * The table's post-game view (ADR 0031 decision 7, plan M3 task 3): results, every decklist, the
 * game's key, and a turn-by-turn replay from the committed snapshots. The main thread reads it
 * from the table database, and the hub calls it only after the attempt's worker has stopped and
 * its end is committed, so a failed health probe can never expose a game that is still running.
 *
 * Nothing here claims more than was saved. An interrupted game lists the turns its committed
 * snapshots cover and the log its committed events hold; a game that never created its row has
 * the approved decklists and the key, and no replay.
 */

import { formatSpectatorLog, PLAYER_HALT_TEXT } from '@mtg/engine';
import type {
  GameResult,
  PlayerId,
  ReplayUnlockedPayload,
  SpectatorState,
  TableEnding,
  TableResultsDeck,
  TableResultsPayload,
} from '@mtg/shared';
import type { GameRecorder } from '../db/games';
import type { TableAttemptManifest, TableGameDeck, TableRepository } from '../db/tables';
import { parsePlaintextDeck } from '../decks/plaintext';
import { playerFacingEvents } from '../match/presentation';
import type { PostGameReader } from './table-ws';

/** The two database views the reader needs; `GameStore` provides both. */
export interface PostGameStore {
  tables(): Pick<TableRepository, 'attempt' | 'gameExists' | 'gameDecks'>;
  recorderFor(
    gameId: string,
  ): Pick<GameRecorder, 'snapshotTurns' | 'loadTurnSnapshot' | 'loadEvents'>;
}

export function createPostGameReader(store: PostGameStore): PostGameReader {
  const manifestOf = (attemptId: string): TableAttemptManifest | null =>
    store.tables().attempt(attemptId)?.manifest ?? null;

  return {
    results(query) {
      const manifest = manifestOf(query.attemptId);
      if (manifest === null || manifest.tableId !== query.tableId) {
        return Promise.resolve({
          results: emptyResults(query.ending, query.result),
          unlock: null,
        });
      }
      const tables = store.tables();
      const hasGame = tables.gameExists(manifest.gameId);
      const stored = hasGame ? tables.gameDecks(manifest.gameId) : [];
      const recorder = hasGame ? store.recorderFor(manifest.gameId) : null;
      const replayTurns = recorder?.snapshotTurns() ?? [];

      const results: TableResultsPayload = {
        ending: query.ending,
        result: query.result,
        rngKey: manifest.rngKey,
        decks: decksOf(manifest, stored),
        replayTurns,
      };
      return Promise.resolve({ results, unlock: unlockOf(recorder, replayTurns) });
    },

    turn(query) {
      const manifest = manifestOf(query.attemptId);
      if (manifest === null || manifest.tableId !== query.tableId) return Promise.resolve(null);
      if (!store.tables().gameExists(manifest.gameId)) return Promise.resolve(null);
      const state: SpectatorState | null = store
        .recorderFor(manifest.gameId)
        .loadTurnSnapshot(query.turn);
      return Promise.resolve(state);
    },
  };
}

function emptyResults(ending: TableEnding, result: GameResult | null): TableResultsPayload {
  return { ending, result, rngKey: null, decks: [], replayTurns: [] };
}

/** Every seat's deck: the stored snapshot when the game has one, else the approved decklist. */
function decksOf(
  manifest: TableAttemptManifest,
  stored: readonly TableGameDeck[],
): TableResultsDeck[] {
  const bySeat = new Map<PlayerId, TableGameDeck>(stored.map((deck) => [deck.seat, deck]));
  return manifest.seats.map((seat) => {
    const deck = bySeat.get(seat.seat);
    if (seat.controller !== 'human') {
      return {
        seat: seat.seat,
        controller: seat.controller,
        displayName: null,
        commanderNames: deck?.commanderNames ?? [],
        cards: deck?.cards ?? [],
      };
    }
    if (deck !== undefined) {
      return {
        seat: seat.seat,
        controller: 'human',
        displayName: seat.displayName,
        commanderNames: deck.commanderNames,
        cards: deck.cards,
      };
    }
    const parsed = parsePlaintextDeck(seat.decklist);
    return {
      seat: seat.seat,
      controller: 'human',
      displayName: seat.displayName,
      commanderNames: parsed.commanderNames,
      cards: parsed.cards.map((entry) => ({ name: entry.name, quantity: entry.quantity })),
    };
  });
}

/**
 * The replay's unlock frame, from the last committed snapshot and the committed log. The last
 * snapshot is the final board for a game that ended by the rules (the runner re-snapshots the
 * final turn), and the start of the interrupted turn for one that did not.
 */
function unlockOf(
  recorder: Pick<GameRecorder, 'loadTurnSnapshot' | 'loadEvents'> | null,
  replayTurns: readonly number[],
): ReplayUnlockedPayload | null {
  const lastTurn = replayTurns[replayTurns.length - 1];
  if (recorder === null || lastTurn === undefined) return null;
  const state = recorder.loadTurnSnapshot(lastTurn);
  if (state === null) return null;
  return {
    state,
    lines: formatSpectatorLog(
      playerFacingEvents(recorder.loadEvents()).map((event) =>
        // The raw halt reason names engine internals; players read the fixed text, after the
        // game as during it.
        event.type === 'engineHalt' ? { ...event, payload: { reason: PLAYER_HALT_TEXT } } : event,
      ),
    ),
    snapshotTurns: [...replayTurns],
    frontierTurn: lastTurn,
  };
}
