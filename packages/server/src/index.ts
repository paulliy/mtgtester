import type { GameId } from '@mtg/shared';

/**
 * `@mtg/server` — the Bun server that orchestrates everything the engine cannot: deck
 * import + Scryfall resolution + SQLite (Phase 1), then the Gemini client, PlayerView
 * assembly, request queue, and WebSocket protocol (Phase 3). It holds the Gemini API key
 * and is the only package with I/O (brief §2, §7).
 *
 * This is a Phase 0 scaffold. Subsystems land under `src/` per §2.1:
 * ai/ cards/ decks/ db/ match/ ws/.
 */
export const SERVER_VERSION = '0.0.0-phase0';

/**
 * TODO(phase-1): deck pipeline (Moxfield/Archidekt import, Scryfall resolution, validation,
 *   snapshotting) + the SQLite schema.
 * TODO(phase-3): Gemini client, context assembly with caching, decision queue + backoff,
 *   invalid-response handling, and the WebSocket protocol.
 */
export type ServerBoot = (gameId: GameId) => void;
