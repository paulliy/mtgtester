/**
 * `@mtg/server` — the Bun server that orchestrates everything the engine cannot: deck import +
 * Scryfall resolution + SQLite (Phase 1), then the Gemini client, PlayerView assembly, request
 * queue, and WebSocket protocol (Phase 3). It holds the Gemini API key and is the only package
 * with I/O (brief §2, §7).
 */
export const SERVER_VERSION = '0.1.0-phase1';

// --- Phase 1: deck pipeline (import → resolve → validate → snapshot) ---
export { runDeckPipeline, type DeckPipelineResult, type PipelineDeps } from './decks/pipeline';
export { importDeck, detectSource, DeckImportError } from './decks/source';
export { resolveDeck } from './decks/resolve';
export { validateDeck, isLegalSoloCommander } from './decks/validate';
export { parsePlaintextDeck } from './decks/plaintext';
export { parseBannedList, loadBannedList, type BannedList } from './decks/banned';
export { buildOracleIndex, loadOracleIndexFromFile, type OracleIndex } from './cards/oracle-index';
export { toOracleCard, type RawScryfallCard } from './cards/scryfall';
export { GameStore, type DeckRow } from './db';

/**
 * TODO(phase-3): Gemini client, context assembly with caching, decision queue + backoff,
 *   invalid-response handling, and the WebSocket protocol.
 */
