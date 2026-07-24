/**
 * The deck pipeline (brief §8): import → resolve → validate → (optionally) snapshot. This is the
 * single orchestration entry point the CLI and, later, the WebSocket import screen (Phase 4) call.
 * It never throws for expected failures (unresolved names, invalid decks, a private URL) — those
 * are returned as structured results so the caller can report them precisely.
 */

import { ALL_COLORS } from '@mtg/shared';
import type { Color, DeckSnapshot, DeckSourceType, ValidationIssue } from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { GameStore } from '../db';
import type { BannedList } from './banned';
import { importDeck } from './source';
import { DeckImportError } from './errors';
import { resolveDeck } from './resolve';
import { validateDeck } from './validate';

export type DeckPipelineStatus = 'valid' | 'invalid' | 'unresolved' | 'importError';

export interface DeckPipelineResult {
  input: string;
  sourceType: DeckSourceType | null;
  deckName: string | null;
  commanderNames: string[];
  colorIdentity: Color[];
  archetypeTag: string | null;
  /** Total cards counted toward the 100/101 rule (commanders + companion + main). */
  cardCount: number;
  status: DeckPipelineStatus;
  unresolvedNames: string[];
  issues: ValidationIssue[];
  snapshotId: string | null;
  /** Human-readable message for an import failure (private/blocked/unrecognized URL). */
  importError: string | null;
}

export interface PipelineDeps {
  index: OracleIndex;
  banned: BannedList;
  /** When provided and the deck is valid, the deck + snapshot are persisted. */
  store?: GameStore;
}

/** WUBRG-ordered color identity of the commanders, e.g. `["W","U","B"]`. */
function deckColorIdentity(commanders: { colorIdentity: Color[] }[]): Color[] {
  const present = new Set<Color>();
  for (const c of commanders) for (const color of c.colorIdentity) present.add(color);
  return ALL_COLORS.filter((c) => present.has(c));
}

/** Default archetype tag when the user leaves it blank (§8.4): `"<identity> — <commander>"`. */
function defaultArchetypeTag(identity: Color[], commanderNames: string[]): string {
  const colors = identity.length > 0 ? identity.join('') : 'C';
  const names = commanderNames.length > 0 ? commanderNames.join(' & ') : 'no commander';
  return `${colors} — ${names}`;
}

export async function runDeckPipeline(
  input: string,
  deps: PipelineDeps,
): Promise<DeckPipelineResult> {
  const base: DeckPipelineResult = {
    input,
    sourceType: null,
    deckName: null,
    commanderNames: [],
    colorIdentity: [],
    archetypeTag: null,
    cardCount: 0,
    status: 'importError',
    unresolvedNames: [],
    issues: [],
    snapshotId: null,
    importError: null,
  };

  // 1. Import.
  let parsed;
  try {
    parsed = await importDeck(input);
  } catch (err) {
    return {
      ...base,
      importError:
        err instanceof DeckImportError ? err.message : `Import failed: ${(err as Error).message}`,
      sourceType: err instanceof DeckImportError ? err.sourceType : null,
    };
  }

  const partial: DeckPipelineResult = {
    ...base,
    sourceType: parsed.sourceType,
    deckName: parsed.name,
    commanderNames: parsed.commanderNames,
  };

  // 2. Resolve.
  const { resolved, unresolvedNames } = resolveDeck(parsed, deps.index);
  if (!resolved) {
    return { ...partial, status: 'unresolved', unresolvedNames };
  }

  const identity = deckColorIdentity(resolved.commanders);
  const archetypeTag =
    resolved.archetypeTag ?? defaultArchetypeTag(identity, parsed.commanderNames);
  const cardCount =
    resolved.cards.reduce((sum, e) => sum + e.quantity, 0) +
    resolved.commanders.length +
    (resolved.companion ? 1 : 0);

  // 3. Validate.
  const validation = validateDeck(resolved, deps.banned);
  const withValidation: DeckPipelineResult = {
    ...partial,
    colorIdentity: identity,
    archetypeTag,
    cardCount,
    status: validation.valid ? 'valid' : 'invalid',
    issues: validation.issues,
  };

  if (!validation.valid) return withValidation;

  // 4. Snapshot (only valid decks; only when a store is supplied).
  if (deps.store) {
    const store = deps.store;
    const allCards = [
      ...resolved.commanders.map((card) => ({ card, quantity: 1 })),
      ...(resolved.companion ? [{ card: resolved.companion, quantity: 1 }] : []),
      ...resolved.cards,
    ];
    store.cacheCards(allCards.map((e) => e.card));

    const deck = store.insertDeck({
      name: resolved.name,
      sourceUrl: resolved.sourceUrl,
      sourceType: resolved.sourceType,
      archetypeTag,
    });
    const snapshot: Omit<DeckSnapshot, 'id' | 'importedAt'> = {
      deckId: deck.id,
      commanderOracleIds: resolved.commanders.map((c) => c.oracleId),
      commanderNames: resolved.commanders.map((c) => c.name),
      companionOracleId: resolved.companion?.oracleId ?? null,
      colorIdentity: identity,
      cards: allCards.map((e) => ({
        oracleId: e.card.oracleId,
        name: e.card.name,
        quantity: e.quantity,
      })),
    };
    const saved = store.insertSnapshot(snapshot);
    return { ...withValidation, snapshotId: saved.id };
  }

  return withValidation;
}
