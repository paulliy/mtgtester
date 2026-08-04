/**
 * The deck pipeline (brief §8): import → resolve → validate → (optionally) snapshot. This is the
 * single orchestration entry point the CLI and, later, the WebSocket import screen (Phase 4) call.
 * It never throws for expected failures (unresolved names, invalid decks, a private URL) — those
 * are returned as structured results so the caller can report them precisely.
 */

import { ALL_COLORS } from '@mtg/shared';
import type {
  Color,
  DeckSnapshot,
  DeckSourceType,
  ResolvedDeck,
  ValidationIssue,
} from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { ArchetypeSource, GameStore } from '../db';
import { inferArchetype, type ArchetypeResult } from './archetype';
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
  /** Where `archetypeTag` came from (ADR 0022 §6) — the UI shows an `auto` chip for computed ones. */
  archetypeSource: ArchetypeSource;
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
  /**
   * Optional AI polish for a heuristic tag (ADR 0022 §5, Stage 2). Returning `null` — which it
   * does whenever it is disabled or anything goes wrong — leaves the heuristic tag standing, so
   * a deck import never depends on it.
   */
  refineArchetype?: (result: ArchetypeResult, deck: ResolvedDeck) => Promise<string | null>;
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
    archetypeSource: 'default',
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
  // §8.4's contract is that the field is the user's: an explicit tag short-circuits inference
  // entirely rather than being "improved". Precedence is user > heuristic > default.
  const inferred =
    resolved.archetypeTag === null
      ? inferArchetype({
          commanders: resolved.commanders,
          companion: resolved.companion,
          cards: resolved.cards.map((entry) => ({ card: entry.card, quantity: entry.quantity })),
          colorIdentity: identity,
        })
      : null;
  // Stage 2 polish, when configured. It can only replace a computed tag, never a typed one:
  // `inferred` is null the moment the user supplied their own.
  const refined =
    inferred !== null && deps.refineArchetype !== undefined
      ? await deps.refineArchetype(inferred, resolved)
      : null;
  const archetypeTag =
    resolved.archetypeTag ??
    refined ??
    inferred?.tag ??
    defaultArchetypeTag(identity, parsed.commanderNames);
  const archetypeSource: ArchetypeSource =
    resolved.archetypeTag !== null
      ? 'manual'
      : refined !== null
        ? 'inferred'
        : inferred !== null
          ? 'heuristic'
          : 'default';
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
    archetypeSource,
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
      archetypeSource,
      ...(inferred !== null ? { archetypeFeatures: inferred.features } : {}),
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
