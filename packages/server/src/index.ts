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
export { parseBannedList, type BannedList } from './decks/banned';
export { loadBannedList } from './decks/banned-file';
export { buildOracleIndex, type OracleIndex } from './cards/oracle-index';
export { loadOracleIndexFromFile } from './cards/oracle-index-file';
export { toOracleCard, type RawScryfallCard } from './cards/scryfall';
export { GameStore, type DeckRow } from './db';
export { StatsRepository } from './db/stats';
export { MANA_METRICS } from './config/mana-metrics';

// --- Phase 3: AI agent integration ---
export * from './ai';

// --- Phase 4: match orchestration, persistence, and the WebSocket server (brief §10, §11) ---
export {
  GameRecorder,
  finishingPositions,
  seatIndex,
  type GameStatus,
  type GameSeatRecord,
  type SqliteLike,
} from './db/games';
export {
  MatchRunner,
  ComputeHaltError,
  LOOKAHEAD_TURNS,
  ESCALATION_TIMEOUT_MS,
  type MatchStatus,
  type MatchRunnerOptions,
  type HaltInfo,
} from './match/runner';
export { MatchSession, type MatchSessionOptions } from './match/session';
export {
  setupSeats,
  unmodeledCardNames,
  type SeatSetup,
  type SeatSetupDeps,
  type SeatProblem,
  type SetupResult,
} from './match/setup';
export { GameServer, type GameServerDeps } from './ws/server';

export { BatchRepository } from './db/batches';

export {
  BatchManager,
  validateBatch,
  MAX_BATCH_GAMES,
  MAX_BATCH_SCENARIOS,
  type BatchManagerDeps,
} from './batch/manager';
