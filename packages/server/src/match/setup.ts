/**
 * Turning four `SeatSource`s into four seated players.
 *
 * Two paths, for the reason ADR 0009 established and ADR 0012 §3 records: the engine halts on
 * any unmodeled card, so a real decklist is all-or-nothing and *usually* nothing. A setup
 * screen offering only URL import would produce a halt on turn one for essentially every deck
 * a user actually owns.
 *
 *   - `pool`  — generate a legal deck from the engine-supported pool. Always playable.
 *   - `url` / `plaintext` — the Phase 1 pipeline, then a **pre-flight** through `interpretCard`
 *     so unmodeled cards are reported as a list of names on the setup screen, before a game
 *     starts, rather than as a mid-game halt.
 *
 * The pre-flight is the important half: it turns the coverage constraint into a visible
 * property of the deck instead of a failure mode.
 */

import { interpretCard } from '@mtg/engine';
import type { EnginePlayerConfig } from '@mtg/engine';
import type {
  Color,
  OracleCard,
  PlayerId,
  SeatSource,
  SeatSummary,
  ValidationIssue,
} from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { GameStore } from '../db';
import type { BannedList } from '../decks/banned';
import { inferArchetype } from '../decks/archetype';
import { generateCommanderDeck } from '../decks/generate';
import { runDeckPipeline } from '../decks/pipeline';

export interface SeatSetupDeps {
  pool: SupportedPool;
  index: OracleIndex;
  banned: BannedList;
  store?: GameStore | undefined;
}

/** One seat failed to set up. Every failing seat is reported, never just the first (brief §8.3). */
export interface SeatProblem {
  seat: PlayerId;
  message: string;
  issues: ValidationIssue[];
  unresolvedNames: string[];
  /** Cards the engine cannot model — the ADR 0009 constraint, surfaced at setup. */
  unmodeledCards: string[];
}

export interface SeatSetup {
  seat: PlayerId;
  config: EnginePlayerConfig;
  summary: SeatSummary;
  /** Null for generated decks, which are not snapshotted (they are reproducible from the seed). */
  deckSnapshotId: string | null;
}

export type SetupResult =
  | { ok: true; seats: SeatSetup[] }
  | { ok: false; problems: SeatProblem[] };

/** Distinct names in `cards` that `interpretCard` cannot model (brief §6.3, ADR 0009). */
export function unmodeledCardNames(cards: readonly OracleCard[]): string[] {
  const names = new Set<string>();
  for (const card of cards) {
    if (!interpretCard(card).modeled) names.add(card.name);
  }
  return [...names].sort();
}

function identityString(identity: readonly Color[]): string {
  return identity.length > 0 ? [...identity].join('') : 'C';
}

/** Brief §8.4's default archetype tag: `"<color identity> — <commander name>"`. */
function defaultTag(identity: readonly Color[], commanderNames: readonly string[]): string {
  return `${identityString(identity)} — ${commanderNames.join(' & ') || 'no commander'}`;
}

function problem(seat: PlayerId, message: string, extra?: Partial<SeatProblem>): SeatProblem {
  return {
    seat,
    message,
    issues: extra?.issues ?? [],
    unresolvedNames: extra?.unresolvedNames ?? [],
    unmodeledCards: extra?.unmodeledCards ?? [],
  };
}

/**
 * Build one seat from the engine-supported pool (ADR 0009). Deterministic given the seed.
 *
 * Snapshotted like any other deck when a store is available: per-deck statistics key on
 * `deck_snapshots`, and `game_players.deck_snapshot_id` is a foreign key into it, so a
 * generated deck that skipped the table could not be recorded as having played at all.
 */
function setupPoolSeat(
  seat: PlayerId,
  deps: SeatSetupDeps,
  seed: string,
): SeatSetup | SeatProblem {
  let deck;
  try {
    deck = generateCommanderDeck(deps.pool, { seed });
  } catch (err) {
    return problem(
      seat,
      `Could not generate a deck from the supported pool: ${(err as Error).message}`,
    );
  }

  const identity = [...deck.commander.colorIdentity] as Color[];
  const commanderNames = [deck.commander.name];
  // Classify generated decks too (ADR 0022 §5). Pool mode is the default and always-playable
  // path, so it is where a strategist most needs to be told what its deck is built to do —
  // `defaultTag` would only hand it back the commander name it can already see.
  const archetype = inferArchetype({
    commanders: [deck.commander],
    cards: deck.cards.map((card) => ({ card, quantity: 1 })),
    colorIdentity: identity,
  });
  const archetypeTag = archetype.tag;
  const label = `${deck.commander.name} (generated)`;

  let deckSnapshotId: string | null = null;
  let deckId = `pool:${seed}`;
  if (deps.store !== undefined) {
    const store = deps.store;
    store.cacheCards([deck.commander, ...deck.cards]);
    const row = store.insertDeck({
      name: label,
      sourceUrl: null,
      sourceType: 'generated',
      archetypeTag,
      archetypeSource: 'heuristic',
      archetypeFeatures: archetype.features,
    });
    // Quantities are collapsed by oracle id: the generated list is already expanded, and a
    // snapshot is a card list, not a shuffled deck.
    const counts = new Map<string, { name: string; quantity: number }>();
    for (const card of [deck.commander, ...deck.cards]) {
      const entry = counts.get(card.oracleId);
      if (entry === undefined) counts.set(card.oracleId, { name: card.name, quantity: 1 });
      else entry.quantity++;
    }
    const snapshot = store.insertSnapshot({
      deckId: row.id,
      commanderOracleIds: [deck.commander.oracleId],
      commanderNames,
      companionOracleId: null,
      colorIdentity: identity,
      cards: [...counts].map(([oracleId, e]) => ({ oracleId, name: e.name, quantity: e.quantity })),
    });
    deckSnapshotId = snapshot.id;
    deckId = row.id;
  }

  return {
    seat,
    deckSnapshotId,
    config: { id: seat, deckId, commanders: [deck.commander], cards: deck.cards },
    summary: {
      seat,
      deckId,
      label: deck.commander.name,
      commanderNames,
      colorIdentity: identity,
      archetypeTag,
    },
  };
}

/**
 * Build one seat from an imported decklist. Runs the full Phase 1 pipeline — every §8.3 problem
 * is reported, not just the first — and then the pre-flight.
 */
async function setupImportedSeat(
  seat: PlayerId,
  source: Extract<SeatSource, { kind: 'url' } | { kind: 'plaintext' }>,
  deps: SeatSetupDeps,
): Promise<SeatSetup | SeatProblem> {
  const input = source.kind === 'url' ? source.url : source.text;
  const result = await runDeckPipeline(input, {
    index: deps.index,
    banned: deps.banned,
    ...(deps.store !== undefined && { store: deps.store }),
  });

  if (result.status === 'importError') {
    return problem(seat, result.importError ?? 'Import failed.');
  }
  if (result.status === 'unresolved') {
    return problem(seat, 'Some card names could not be resolved against Scryfall oracle data.', {
      unresolvedNames: result.unresolvedNames,
    });
  }
  if (result.status === 'invalid') {
    return problem(seat, 'Deck is not a legal Commander deck.', { issues: result.issues });
  }

  // Re-resolve the card objects: the pipeline reports names and a snapshot id, but the engine
  // needs the `OracleCard`s themselves.
  const cards: OracleCard[] = [];
  const commanders: OracleCard[] = [];
  const missing: string[] = [];
  for (const name of result.commanderNames) {
    const card = deps.index.resolve(name);
    if (card === null) missing.push(name);
    else commanders.push(card);
  }
  if (missing.length > 0) {
    return problem(seat, 'Commander could not be resolved.', { unresolvedNames: missing });
  }

  const snapshotCards = result.snapshotId === null ? null : deps.store?.snapshotCards(result.snapshotId);
  if (snapshotCards === null || snapshotCards === undefined) {
    return problem(
      seat,
      'Deck validated but its cards could not be loaded — imported decks need a database (run the server with a data directory).',
    );
  }
  const commanderNameSet = new Set(result.commanderNames);
  for (const entry of snapshotCards) {
    if (commanderNameSet.has(entry.name)) continue;
    const card = deps.index.getByOracleId(entry.oracleId) ?? deps.index.resolve(entry.name);
    if (card === null) {
      missing.push(entry.name);
      continue;
    }
    for (let i = 0; i < entry.quantity; i++) cards.push(card);
  }
  if (missing.length > 0) {
    return problem(seat, 'Some cards could not be loaded from the snapshot.', {
      unresolvedNames: missing,
    });
  }

  // Pre-flight (ADR 0009 / ADR 0012 §3). A deck with even one unmodeled card cannot be played,
  // so it is rejected here with the full list rather than halting mid-game.
  const unmodeled = unmodeledCardNames([...commanders, ...cards]);
  if (unmodeled.length > 0) {
    return problem(
      seat,
      `The engine cannot yet model ${unmodeled.length} card${unmodeled.length === 1 ? '' : 's'} in this deck. ` +
        `A deck must be fully modeled to be simulated — see ADR 0009.`,
      { unmodeledCards: unmodeled },
    );
  }

  const identity = result.colorIdentity;
  const archetypeTag =
    source.archetypeTag?.trim() ||
    result.archetypeTag ||
    defaultTag(identity, result.commanderNames);

  const deckId = result.snapshotId ?? `import:${seat}`;
  return {
    seat,
    deckSnapshotId: result.snapshotId,
    config: { id: seat, deckId, commanders, cards },
    summary: {
      seat,
      deckId,
      label: result.deckName ?? result.commanderNames.join(' & '),
      commanderNames: result.commanderNames,
      colorIdentity: identity,
      archetypeTag,
    },
  };
}

function isProblem(value: SeatSetup | SeatProblem): value is SeatProblem {
  return 'message' in value;
}

/**
 * Set up every seat, reporting *all* failures rather than stopping at the first — the same rule
 * §8.3 applies to deck validation, for the same reason: fixing four problems one round-trip at
 * a time is miserable.
 */
export async function setupSeats(
  sources: readonly SeatSource[],
  deps: SeatSetupDeps,
  gameSeed: string,
): Promise<SetupResult> {
  const results: Array<SeatSetup | SeatProblem> = [];

  for (const [index, source] of sources.entries()) {
    const seat: PlayerId = `P${index + 1}`;
    if (source.kind === 'pool') {
      results.push(setupPoolSeat(seat, deps, source.seed ?? `${gameSeed}-seat${index + 1}`));
    } else {
      results.push(await setupImportedSeat(seat, source, deps));
    }
  }

  const problems = results.filter(isProblem);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, seats: results as SeatSetup[] };
}
