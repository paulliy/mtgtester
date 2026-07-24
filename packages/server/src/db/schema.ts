/**
 * SQLite schema (brief §9). Phase 1 populates `card_cache`, `decks`, and `deck_snapshots`; the
 * remaining tables are created now so the schema is settled, but they are written by later
 * phases (games/events/state — Phase 2; ai_calls — Phase 3; mana_metrics — Phase 2/5). Column
 * shapes follow §9's suggested schema. JSON columns hold arrays/objects serialized as text.
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Resolved Scryfall cards, persisted per import so games never read the bulk file (§3).
CREATE TABLE IF NOT EXISTS card_cache (
  oracle_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL          -- full OracleCard as JSON
);

-- A user-managed deck identity (§8.4, §9).
CREATE TABLE IF NOT EXISTS decks (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  source_url    TEXT,
  source_type   TEXT NOT NULL,       -- 'moxfield' | 'archidekt' | 'plaintext'
  archetype_tag TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Immutable resolved snapshot; historical stats key on this and must never change (§8.2, §9).
CREATE TABLE IF NOT EXISTS deck_snapshots (
  id                TEXT PRIMARY KEY,
  deck_id           TEXT NOT NULL REFERENCES decks(id),
  commander_names   TEXT NOT NULL,   -- JSON array
  color_identity    TEXT NOT NULL,   -- JSON array of colors
  card_list_json    TEXT NOT NULL,   -- JSON array of { oracleId, name, quantity }
  imported_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(deck_id);

-- ── Written in later phases (created now to settle the schema) ──────────────────────────────

-- TODO(phase-2): games are recorded as they play.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  seed        TEXT NOT NULL,
  started_at  TEXT,
  ended_at    TEXT,
  turn_count  INTEGER,
  winner_seat INTEGER,
  status      TEXT
);

-- TODO(phase-2): per-seat outcome of each game.
CREATE TABLE IF NOT EXISTS game_players (
  game_id            TEXT NOT NULL REFERENCES games(id),
  seat               INTEGER NOT NULL,
  deck_snapshot_id   TEXT NOT NULL REFERENCES deck_snapshots(id),
  finished_position  INTEGER,
  eliminated_on_turn INTEGER,
  loss_reason        TEXT,
  eliminated_by_seat INTEGER,
  mulligans_taken    INTEGER,
  opening_hand_size  INTEGER,
  PRIMARY KEY (game_id, seat)
);

-- TODO(phase-2): the full replayable action log.
CREATE TABLE IF NOT EXISTS game_events (
  game_id      TEXT NOT NULL REFERENCES games(id),
  sequence     INTEGER NOT NULL,
  turn         INTEGER,
  phase        TEXT,
  step         TEXT,
  actor_seat   INTEGER,
  event_type   TEXT,
  payload_json TEXT,
  PRIMARY KEY (game_id, sequence)
);

-- TODO(phase-2): one state snapshot per turn, for the timeline scrubber (§4, Phase 4).
CREATE TABLE IF NOT EXISTS game_state_snapshots (
  game_id    TEXT NOT NULL REFERENCES games(id),
  turn       INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (game_id, turn)
);

-- TODO(phase-3): every Gemini call, for the debug panel and cost accounting.
CREATE TABLE IF NOT EXISTS ai_calls (
  game_id         TEXT NOT NULL REFERENCES games(id),
  sequence        INTEGER NOT NULL,
  seat            INTEGER,
  model           TEXT,
  prompt_tokens   INTEGER,
  response_tokens INTEGER,
  request_json    TEXT,
  response_json   TEXT,
  was_retry       INTEGER,
  was_fallback    INTEGER,
  latency_ms      INTEGER,
  PRIMARY KEY (game_id, sequence)
);

-- TODO(phase-2/5): per-turn mana efficiency metrics.
CREATE TABLE IF NOT EXISTS mana_metrics (
  game_id                 TEXT NOT NULL REFERENCES games(id),
  seat                    INTEGER NOT NULL,
  turn                    INTEGER NOT NULL,
  lands_in_hand           INTEGER,
  lands_drawn_cumulative  INTEGER,
  spells_castable         INTEGER,
  unspent_mana            INTEGER,
  on_curve                INTEGER,
  PRIMARY KEY (game_id, seat, turn)
);
`;
