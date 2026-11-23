/**
 * The part of `GameStore` that deck setup reads and writes: card cache, deck and snapshot rows,
 * strategy profiles. Setup, the deck pipeline and the setup preview take a `DeckStore`, so the
 * browser (ADR 0053), which has no database, can seat an imported deck from memory.
 *
 * `MemoryDeckStore` keeps those rows for the life of the page and nothing else: no game is
 * recorded, and saved decks across visits are the web app's job, not this store's.
 */

import type { DeckCardEntry, DeckSnapshot, OracleCard } from '@mtg/shared';
import type { StrategyProfile } from '../decks/strategy-profile';
import type { DeckRow, GameStore } from './index';

export type DeckStore = Pick<
  GameStore,
  | 'cacheCards'
  | 'insertDeck'
  | 'insertSnapshot'
  | 'snapshotCards'
  | 'savedSnapshot'
  | 'insertStrategyProfile'
>;

type SavedSnapshot = NonNullable<ReturnType<GameStore['savedSnapshot']>>;

export class MemoryDeckStore implements DeckStore {
  private readonly cards = new Map<string, OracleCard>();
  private readonly decks = new Map<string, DeckRow>();
  private readonly snapshots = new Map<string, DeckSnapshot>();
  private readonly profiles = new Map<string, StrategyProfile>();

  cacheCards(cards: OracleCard[]): void {
    for (const card of cards) this.cards.set(card.oracleId, card);
  }

  insertDeck(deck: Parameters<GameStore['insertDeck']>[0]): DeckRow {
    const row: DeckRow = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name: deck.name,
      sourceUrl: deck.sourceUrl,
      sourceType: deck.sourceType,
      archetypeTag: deck.archetypeTag,
      archetypeSource: deck.archetypeSource ?? 'manual',
    };
    this.decks.set(row.id, row);
    return row;
  }

  insertSnapshot(snapshot: Omit<DeckSnapshot, 'id' | 'importedAt'>): DeckSnapshot {
    const saved: DeckSnapshot = {
      ...snapshot,
      id: crypto.randomUUID() as DeckSnapshot['id'],
      importedAt: new Date().toISOString(),
    };
    this.snapshots.set(saved.id, saved);
    return saved;
  }

  snapshotCards(snapshotId: string): DeckCardEntry[] | null {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot === undefined ? null : snapshot.cards.map((entry) => ({ ...entry }));
  }

  /** A snapshot of an imported deck, as `GameStore` gives it: never a generated one. */
  savedSnapshot(snapshotId: string): SavedSnapshot | null {
    const snapshot = this.snapshots.get(snapshotId);
    const deck = snapshot === undefined ? undefined : this.decks.get(snapshot.deckId);
    if (snapshot === undefined || deck === undefined || deck.sourceType === 'generated') {
      return null;
    }
    return {
      snapshotId: snapshot.id,
      name: deck.name ?? snapshot.commanderNames.join(' & '),
      commanderNames: [...snapshot.commanderNames],
      colorIdentity: [...snapshot.colorIdentity],
      archetypeTag: deck.archetypeTag,
      cards: snapshot.cards.map((entry) => ({ ...entry })),
      companionOracleId: snapshot.companionOracleId,
      commanderOracleIds: [...snapshot.commanderOracleIds],
    };
  }

  insertStrategyProfile(snapshotId: string, profile: StrategyProfile): void {
    this.profiles.set(snapshotId, profile);
  }
}
