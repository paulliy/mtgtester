/**
 * SQLite schema (brief §9). Phase 1 populates `card_cache`, `decks`, and `deck_snapshots`; the
 * remaining tables are created now so the schema is settled, but they are written by later
 * phases (games/events/state — Phase 2; ai_calls — Phase 3; mana_metrics — Phase 2/5). Column
 * shapes follow §9's suggested schema. JSON columns hold arrays/objects serialized as text.
 */

/**
 * Columns added to a table that already exists in someone's on-disk database. `CREATE TABLE IF
 * NOT EXISTS` silently leaves an older table alone, so each of these runs separately and its
 * "duplicate column name" error is expected and ignored. Idempotent by construction.
 */
export const MIGRATIONS_SQL: readonly string[] = [
  `ALTER TABLE ai_calls ADD COLUMN source TEXT`,
  `ALTER TABLE ai_calls ADD COLUMN cost_usd REAL`,
  `ALTER TABLE mana_metrics ADD COLUMN cards_drawn_cumulative INTEGER`,
  `ALTER TABLE games ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'spectator'`,
  `ALTER TABLE game_players ADD COLUMN controller_kind TEXT NOT NULL DEFAULT 'ai'`,
  `ALTER TABLE ai_calls ADD COLUMN anchor_sequence INTEGER`,
  `ALTER TABLE ai_calls ADD COLUMN turn INTEGER`,
  // Existing rows all predate inference, so 'manual' is the right default: a `retag` backfill
  // must never overwrite a tag a person may have typed, and it cannot tell them apart later.
  `ALTER TABLE decks ADD COLUMN archetype_source TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE decks ADD COLUMN archetype_features_json TEXT`,
  `ALTER TABLE deck_snapshots ADD COLUMN companion_oracle_id TEXT`,
  `ALTER TABLE deck_snapshots ADD COLUMN commander_oracle_ids TEXT`,
  // Replay inputs (ADR 0031 decision 8). Null for every game recorded before these existed, and
  // for Card Test Lab games, which start from a prepared engine and store none.
  `ALTER TABLE games ADD COLUMN config_json TEXT`,
  `ALTER TABLE games ADD COLUMN build_commit TEXT`,
  `ALTER TABLE games ADD COLUMN build_dirty INTEGER`,
  // The bot's choice beside the model's on a model-answered decision (`BotComparison`).
  `ALTER TABLE ai_calls ADD COLUMN bot_json TEXT`,
];

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
  created_at    TEXT NOT NULL,
  -- Where the tag came from (ADR 0022 §6): 'manual' | 'default' | 'heuristic' | 'inferred'.
  -- A backfill may rewrite anything except 'manual'.
  archetype_source        TEXT NOT NULL DEFAULT 'manual',
  -- The measured decklist shape behind a computed tag, so the classifier can be retuned and old
  -- decks re-scored without re-resolving their lists (the §9.2 raw-inputs principle).
  archetype_features_json TEXT
);

-- Immutable resolved snapshot; historical stats key on this and must never change (§8.2, §9).
CREATE TABLE IF NOT EXISTS deck_snapshots (
  id                TEXT PRIMARY KEY,
  deck_id           TEXT NOT NULL REFERENCES decks(id),
  commander_names   TEXT NOT NULL,   -- JSON array
  color_identity    TEXT NOT NULL,   -- JSON array of colors
  card_list_json    TEXT NOT NULL,   -- JSON array of { oracleId, name, quantity }
  companion_oracle_id TEXT,
  commander_oracle_ids TEXT,
  imported_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(deck_id);

-- Versioned deterministic strategic profiles. Historical rows are immutable; the separate
-- pointer selects a current profile without rewriting artifacts used by earlier experiments.
CREATE TABLE IF NOT EXISTS deck_strategy_profiles (
  deck_snapshot_id       TEXT NOT NULL REFERENCES deck_snapshots(id),
  profile_version        TEXT NOT NULL,
  source_definition_hash TEXT NOT NULL,
  profile_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  PRIMARY KEY (deck_snapshot_id, profile_version, source_definition_hash)
);
CREATE TABLE IF NOT EXISTS deck_strategy_profile_current (
  deck_snapshot_id       TEXT PRIMARY KEY REFERENCES deck_snapshots(id),
  profile_version        TEXT NOT NULL,
  source_definition_hash TEXT NOT NULL,
  FOREIGN KEY (deck_snapshot_id, profile_version, source_definition_hash)
    REFERENCES deck_strategy_profiles(deck_snapshot_id, profile_version, source_definition_hash)
);

-- ── Written in later phases (created now to settle the schema) ──────────────────────────────

-- TODO(phase-2): games are recorded as they play.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  seed        TEXT NOT NULL,
  started_at  TEXT,
  ended_at    TEXT,
  turn_count  INTEGER,
  winner_seat INTEGER,
  status      TEXT,
  game_mode   TEXT NOT NULL DEFAULT 'spectator',
  -- Replay inputs (ADR 0031 decision 8): the card-data hash, deck snapshot ids, manual mana, turn
  -- cap, RNG kind and key, and engine options as JSON, plus the build the game ran on. Null for
  -- Card Test Lab games and for games recorded before these columns existed.
  config_json  TEXT,
  build_commit TEXT,
  build_dirty  INTEGER
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
  controller_kind    TEXT NOT NULL DEFAULT 'ai',
  PRIMARY KEY (game_id, seat)
);

-- Who answered each request (ADR 0031 decision 8): 'human' | 'auto' | 'timeout' | 'fallback' |
-- 'bot'. For attribution and statistics; replay does not read it. Written for games with a human
-- seat only.
CREATE TABLE IF NOT EXISTS game_decision_sources (
  game_id    TEXT NOT NULL REFERENCES games(id),
  request_id TEXT NOT NULL,
  seat       INTEGER NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (game_id, request_id)
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
  cost_usd        REAL,
  -- How the decision was answered: 'primary' | 'retry' | 'fallback' | 'heuristic' | 'cache'.
  -- The last two cost no network call; counting them is how the RPM savings are measured.
  source          TEXT,
  -- The game_events.sequence this call's reasoning annotates (ADR 0022). Null for calls made
  -- before the column existed, and for any that never reached a submitted decision.
  anchor_sequence INTEGER,
  turn            INTEGER,
  -- The bot's ranking beside the model's answer (BotComparison in ai/logger.ts): escalated
  -- bot-led decisions and model-mode shadow. Null for local answers and older rows.
  bot_json        TEXT,
  PRIMARY KEY (game_id, sequence)
);

-- Physical provider attempts. Unlike ai_calls, this retains rejected, timed-out, cancelled and
-- model-fallback requests even when a later attempt or local recovery answers the decision.
CREATE TABLE IF NOT EXISTS ai_attempts (
  game_id            TEXT NOT NULL REFERENCES games(id),
  sequence           INTEGER NOT NULL,
  logical_request_id TEXT NOT NULL,
  client_attempt     INTEGER NOT NULL,
  requested_model    TEXT NOT NULL,
  response_model     TEXT,
  backend             TEXT,
  provider_request_id TEXT,
  status              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT NOT NULL,
  duration_ms         INTEGER NOT NULL,
  attempt_json        TEXT NOT NULL,
  cost_usd            REAL,
  PRIMARY KEY (game_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_ai_attempts_request
  ON ai_attempts(game_id, logical_request_id, client_attempt);

-- Policy-level Jev outcomes. This complements ai_attempts: an accepted HTTP response may still
-- fall through because its shape, probability contract, or calibrated confidence was unsuitable.
CREATE TABLE IF NOT EXISTS jev_decision_traces (
  game_id             TEXT NOT NULL REFERENCES games(id),
  logical_request_id  TEXT NOT NULL,
  recorded_at         TEXT NOT NULL,
  mode                TEXT NOT NULL,
  outcome             TEXT NOT NULL,
  fallback_reason     TEXT,
  engine_acceptance   TEXT NOT NULL,
  trace_json          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jev_decision_traces_request
  ON jev_decision_traces(game_id, logical_request_id);

-- One AI seat's post-game review of the game it played (ADR 0022 §7). Keyed by (game, seat)
-- because a seat reviews once; a re-run replaces rather than accumulates. Separate from
-- ai_calls, which records that the call happened and what it cost — this records the artifact.
CREATE TABLE IF NOT EXISTS game_reflections (
  game_id     TEXT NOT NULL REFERENCES games(id),
  seat        INTEGER NOT NULL,
  model       TEXT,
  position    INTEGER,
  summary     TEXT NOT NULL,
  detail_json TEXT,               -- { keyMistakes, keyPlays, threatRead }
  created_at  TEXT NOT NULL,
  PRIMARY KEY (game_id, seat)
);

-- Table talk and deals (ADR 0035): one row per line, in the order the table said it, anchored to
-- the game_events.sequence it sits under. Public by design, so stored and served like the log.
CREATE TABLE IF NOT EXISTS game_table_talk (
  game_id      TEXT NOT NULL REFERENCES games(id),
  position     INTEGER NOT NULL,
  sequence     INTEGER NOT NULL,
  turn         INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  text         TEXT NOT NULL,
  PRIMARY KEY (game_id, position)
);

-- TODO(phase-2/5): per-turn mana efficiency metrics.
CREATE TABLE IF NOT EXISTS mana_metrics (
  game_id                 TEXT NOT NULL REFERENCES games(id),
  seat                    INTEGER NOT NULL,
  turn                    INTEGER NOT NULL,
  lands_in_hand           INTEGER,
  lands_drawn_cumulative  INTEGER,
  cards_drawn_cumulative  INTEGER,
  spells_castable         INTEGER,
  unspent_mana            INTEGER,
  on_curve                INTEGER,
  PRIMARY KEY (game_id, seat, turn)
);

-- Phase 5: engine-internal diagnostics. Kept separate from the spectator action log because
-- legal-action menus and AI diagnostics are not spectator-timeline content.
CREATE TABLE IF NOT EXISTS game_debug_events (
  game_id    TEXT NOT NULL REFERENCES games(id),
  sequence   INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  category   TEXT NOT NULL,
  message    TEXT NOT NULL,
  data_json  TEXT,
  PRIMARY KEY (game_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_game_debug_events_filters
  ON game_debug_events(game_id, turn, category);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, seed TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, failure_json TEXT
);
CREATE TABLE IF NOT EXISTS batch_scenarios (
  batch_id TEXT NOT NULL REFERENCES batches(id), scenario_id TEXT NOT NULL,
  scenario_index INTEGER NOT NULL, name TEXT NOT NULL, games INTEGER NOT NULL,
  spec_json TEXT NOT NULL, PRIMARY KEY (batch_id, scenario_id)
);
CREATE TABLE IF NOT EXISTS batch_games (
  batch_id TEXT NOT NULL REFERENCES batches(id), scenario_id TEXT NOT NULL,
  game_index INTEGER NOT NULL, game_id TEXT NOT NULL UNIQUE,
  seed TEXT NOT NULL, status TEXT NOT NULL, failure_reason TEXT,
  started_at TEXT, ended_at TEXT, PRIMARY KEY (batch_id, scenario_id, game_index),
  FOREIGN KEY (batch_id, scenario_id) REFERENCES batch_scenarios(batch_id, scenario_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_games_batch ON batch_games(batch_id, scenario_id, game_index);

-- Decks the table host approved, under table-scoped ids (ADR 0031 decision 6).
CREATE TABLE IF NOT EXISTS table_decks (
  id           TEXT PRIMARY KEY,
  table_id     TEXT NOT NULL,
  seat         INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  decklist     TEXT NOT NULL,
  approved_at  TEXT NOT NULL
);

-- One private manifest per table start attempt, written before its worker starts.
CREATE TABLE IF NOT EXISTS table_attempts (
  attempt_id    TEXT PRIMARY KEY,
  table_id      TEXT NOT NULL,
  game_id       TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  ended_at      TEXT
)`;
