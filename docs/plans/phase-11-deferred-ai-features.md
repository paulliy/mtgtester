# Phase 11 — The three deferred features from brief §15

## Purpose

Brief §15 cut three features from v1:

- **Post-game AI self-reflection commentary.** Cut from v1.
- **Automatic archetype tagging.** Manual field only; leave the schema ready for inference later.
- **AI reasoning in the spectator log.** Reasoning notes go to the debug log only.

All three deferrals were cost/scope calls, not design objections, and each one was explicitly
left "ready for later" in the schema and the type surface. This phase builds them.

Because §15 is a *deferral list*, not a prohibition, overturning it needs a numbered ADR —
`docs/decisions/0022-deferred-ai-features.md`, written as the first task of this phase — per
CLAUDE.md's "where this file or the brief conflicts with a numbered ADR, the ADR wins."

Phase 11 is independent of Phase 10 (deck testing lab). The three workstreams are also
independent of each other and are ordered cheapest-and-lowest-risk first:

| # | Workstream | New API calls | Main risk |
|---|---|---|---|
| 11.1 | AI reasoning in the spectator log | none | leaking hidden info into a single-player game |
| 11.2 | Automatic archetype tagging | none by default | retagging shifts historical stats grouping |
| 11.3 | Post-game AI self-reflection | ≤1 per seat per game | cost; must never touch engine state |

## Invariants that hold across all three

1. **The engine stays AI-unaware.** `formatSpectatorLog` in
   [packages/engine/src/view/spectator.ts](packages/engine/src/view/spectator.ts) formats
   `GameEvent`s and nothing else. No AI text is ever baked into `SpectatorLogLine.text`;
   annotations ride a parallel channel keyed by `sequence`.
2. **Determinism is untouched.** Nothing in this phase feeds back into a decision. Same seed +
   same scripted decisions still ⇒ byte-identical event log (brief §12). Reflection runs strictly
   after `Engine.getResult()`; archetype inference runs at import, never during a game.
3. **No hidden state to the model, no rules text to the provider.** Reflection prompts are built
   from that seat's own `PlayerView` plus the public log. The Comprehensive Rules are never sent
   (brief §7.4).
4. **Everything opt-in and off by default.** Each feature lands behind a flag; the default game
   costs exactly what it costs today.
5. **Every new model call is logged.** New calls go through `AiCallLogger.log` with a new
   `DecisionSource`, so `/api/games/:id/debug` and the cost counters stay the single source of
   truth for spend.

---

## 11.1 — AI reasoning in the spectator log

### What exists today

- `DecisionResponse.note` ([packages/shared/src/engine.ts:207](packages/shared/src/engine.ts#L207))
  already carries the model's one-line reasoning, and the full response lands in
  `ai_calls.response_json` ([packages/server/src/ai/logger.ts:116](packages/server/src/ai/logger.ts#L116)).
- `TurnStrategy.intent` / `manaPlan` are the richest reasoning the system produces, and today they
  only reach `engine.addDebug('decision', …)` in
  [packages/server/src/ai/strategy-coordinator.ts:236](packages/server/src/ai/strategy-coordinator.ts#L236).
- `SpectatorLogLine` is documented as "**never** carries AI reasoning"
  ([packages/shared/src/spectator.ts:148](packages/shared/src/spectator.ts#L148)), and
  [apps/web/src/components/ActionLog.vue](apps/web/src/components/ActionLog.vue) repeats it.
- `DebugFlags.showAIResponses` exists ([packages/shared/src/protocol.ts:177](packages/shared/src/protocol.ts#L177))
  but only gates the debug panel.

So the data is all there; what is missing is a delivery channel and a UI.

### Design

Add a **separate annotation stream** rather than changing the log line shape. This keeps the
engine pure, keeps `game_events` replayable without AI data, and lets the annotation be dropped
entirely when the flag is off.

**Shared types** (`packages/shared/src/spectator.ts`):

```ts
/**
 * An AI reasoning annotation for the spectator log (§15 / ADR 0022). Deliberately NOT part of
 * `SpectatorLogLine`: the engine emits log lines and knows nothing about the AI, and a replay
 * built from `game_events` alone must still be complete.
 */
export interface AiAnnotation {
  /** The first `GameEvent.sequence` this decision produced — the line it attaches under. */
  sequence: number;
  turn: number;
  seat: PlayerId;
  kind: 'decision' | 'strategy';
  /** `DecisionResponse.note`, or the strategist's `intent`. */
  text: string;
  /** `DecisionSource` — 'primary' | 'retry' | 'fallback' | 'heuristic' | 'cache' | 'plan' | 'strategist'. */
  source: string;
  model?: string;
}
```

**Sequence anchoring.** `Runner.loop()` calls `onDecision` after `engine.submit(response)` and
*before* `flushEvents()` ([packages/server/src/match/runner.ts:348-353](packages/server/src/match/runner.ts#L348-L353)),
so `this.eventCursor` at that instant is exactly the sequence of the first event the decision will
produce. Pass it through:

```ts
onDecision?(request: DecisionRequest, response: DecisionResponse, anchorSequence: number): void;
```

For the strategist, `StrategyCoordinator.runStrategist` gets an `onStrategy` callback fired when a
plan installs; the session anchors it to the current frontier's first sequence of that turn.

**Server plumbing** ([packages/server/src/match/session.ts](packages/server/src/match/session.ts)):

- Collect annotations in `onDecision` only when `debugFlags.showAIResponses` is on and
  `response.note` is non-empty.
- Attach them to the **same release path as log lines**. Live mode buffers lines through
  `pendingLines`/`releaseLines`; annotations must ride that buffer or they will describe a turn the
  board has not reached — the exact desync the existing comment at `onEvents` warns about. Extend
  `EventBatchPayload` with `annotations?: AiAnnotation[]`.
- Add a `/api/games/:id/annotations` route in [packages/server/src/ws/server.ts](packages/server/src/ws/server.ts)
  that reconstructs annotations from `ai_calls.response_json` for a finished game, so scrubbing
  backward after a reload still shows them. No new table needed — `ai_calls` already stores the
  responses; add `anchor_sequence INTEGER` to it via `MIGRATIONS_SQL` so the join is exact rather
  than reconstructed by guesswork.

**Hidden-information gate (the real risk).** In `singlePlayer` mode, showing opponent reasoning
mid-game is a cheat: the human would read "I'm holding a counterspell for your commander" before
deciding. Enforce, in `session.ts`:

- `gameMode === 'singlePlayer'` ⇒ annotations for seats other than `humanSeat` are withheld until
  `publishGameOver` fires, then delivered with the existing `replayUnlocked` message (extend
  `ReplayUnlockedPayload` with `annotations`).
- `gameMode === 'spectator'` ⇒ delivered live with the batch. The spectator already sees every
  hand (brief §10.2), so there is nothing left to protect.

This is a hard gate in the server, not a UI checkbox — the client never receives what it must
not show.

**UI** ([apps/web/src/components/ActionLog.vue](apps/web/src/components/ActionLog.vue)):

- New prop `annotations: AiAnnotation[]`, indexed by sequence.
- Render as a dimmed, italic sub-line beneath its log line, prefixed by source
  (`strategist` / `fallback` / …), with fallback annotations keeping the existing `warning`
  emphasis colour so brief §13's "prominent, unmissable" fallback markers survive.
- A local `Show AI reasoning` toggle in the log header that maps to `showAIResponses` via
  `game.setDebugFlags`, so the debug panel and the log agree on one flag rather than two.
- Update the header comments in both `ActionLog.vue` and `spectator.ts` — they currently assert
  the opposite and would become lies.

### Tests

- Unit: annotation anchoring — a scripted decision producing 3 events attaches to the first.
- Unit: `singlePlayer` withholding — a mocked AI seat's note is absent from every `eventBatch`
  and present in `replayUnlocked`.
- Unit: flag off ⇒ `eventBatch.annotations` is undefined (no payload growth by default).
- Existing determinism test must still pass unchanged (annotations are not events).

---

## 11.2 — Automatic archetype tagging

### What exists today

The schema is already "ready for inference" exactly as §8.4 promised:

- `decks.archetype_tag TEXT NOT NULL` ([packages/server/src/db/schema.ts:38](packages/server/src/db/schema.ts#L38)).
- `defaultArchetypeTag()` fills `"<identity> — <commander>"` when blank
  ([packages/server/src/decks/pipeline.ts:51-56](packages/server/src/decks/pipeline.ts#L51-L56)).
- `DeckPipelineResult.archetypeTag` and `ParsedDeck.archetypeTag` thread a user-supplied value
  through import; every importer (`moxfield`, `archidekt`, `plaintext`, `generate`) currently
  hardcodes `null`.
- `stats.ts` groups the "who beats me" view by `archetype_tag`
  ([packages/server/src/db/stats.ts:104-113](packages/server/src/db/stats.ts#L104-L113)).
- The import screen **does** already collect a per-seat archetype tag
  ([SetupView.vue](apps/web/src/views/SetupView.vue), the `tags` ref), carried by `SeatSource` and
  applied in [setup.ts:243](packages/server/src/match/setup.ts#L243) as
  `source.archetypeTag || result.archetypeTag || defaultTag(...)`. An earlier draft of this plan
  claimed the field was never built; that was wrong. The inferred tag becomes the **middle** term
  of that expression, so it fills a blank and can never replace a typed entry. What the UI lacks
  is any display of what was inferred — that is the real 11.2 UI gap.

### Design

Two stages, deterministic first. The heuristic is the product; the AI pass is an optional polish.

**Stage 1 — heuristic classifier (new `packages/server/src/decks/archetype.ts`).**
Pure function over the resolved `OracleCard[]` + commanders + color identity. Zero cost, offline,
deterministic, unit-testable, and it works for pool-generated decks too.

Extract a feature vector:

- counts by type line (creature / instant / sorcery / artifact / enchantment / planeswalker / land),
- mana curve and average MV of nonlands,
- functional counts by oracle-text matching: ramp, targeted removal, board wipes, card draw,
  tutors, counterspells, recursion, sacrifice outlets,
- theme signals by oracle-text frequency: `+1/+1 counter`, `token`, `graveyard`, `landfall`,
  `lifelink`/`gain life`, `artifact`, `sacrifice`, `mill`, `equip`/`aura`, and creature-subtype
  concentration for tribal,
- the commander's own oracle text, weighted heaviest — in Commander the general *is* the thesis.

Map to two axes and render one free-text tag:

- **strategy** ∈ {aggro, midrange, control, combo, ramp, stax} — from curve, interaction density,
  and creature count;
- **theme** — the top-scoring signal above a threshold, else omitted;
- **identity name** — WUBRG → guild/shard/wedge name table (`Azorius`, `Gruul`, `Mardu`, `Jeskai`,
  … `Colorless`), which is what a Commander player actually says.

Result: `"Gruul tokens aggro"`, `"Azorius control"`, `"Rakdos sacrifice combo"` — the same shape as
the brief's own examples. Falls back to `defaultArchetypeTag()` when nothing clears the threshold.

**Stage 2 — optional AI refinement (new `packages/server/src/ai/archetype.ts`).**
One call per import, behind `AI_ARCHETYPE_INFERENCE=true` (default off). It receives the *feature
vector and card names only* — never full oracle text, never the rules — and returns
`{ tag, confidence }`. Reuses `OpenAiCompatibleClient` with a new `configForRole(config, 'archetype')`
profile (cheap model, reasoning off, tiny output budget). On timeout, invalid JSON, low confidence,
or any error, keep the Stage 1 tag. Validate and clamp with a `validateArchetype()` mirroring
[packages/server/src/ai/validate.ts](packages/server/src/ai/validate.ts).

**Precedence — never overwrite a human.** In `runDeckPipeline`:

```
user-supplied tag  >  inferred tag  >  heuristic tag  >  defaultArchetypeTag()
```

`resolved.archetypeTag !== null` short-circuits inference entirely. This preserves §8.4's contract
that the field is the user's.

**Provenance.** Add via `MIGRATIONS_SQL` (the established additive-migration pattern at
[schema.ts:13-19](packages/server/src/db/schema.ts#L13-L19)):

```sql
ALTER TABLE decks ADD COLUMN archetype_source TEXT NOT NULL DEFAULT 'manual'
ALTER TABLE decks ADD COLUMN archetype_features_json TEXT
```

`archetype_source` ∈ `'manual' | 'default' | 'heuristic' | 'inferred'`. Storing the feature vector
means the classifier can be retuned and old decks re-scored without re-resolving decklists — the
same reasoning §9.2 gives for logging raw mana inputs rather than booleans.

**Backfill CLI** — `bun run retag [--dry-run] [--force] [--ai]`
(new `packages/server/src/cli/retag.ts`, registered in root `package.json`):

- rebuilds each deck's card list from its latest `deck_snapshots` row via `card_cache` (no network),
- by default only rewrites rows whose `archetype_source` is `'default'`; `--force` extends to
  `'heuristic'`, and **never** to `'manual'`,
- `--dry-run` prints old → new for every row and writes nothing.

⚠️ **Call out to the user before running it:** `stats.ts` groups `lossesTo` by `archetype_tag`, so
retagging *changes how historical results aggregate*. Nothing is lost (the underlying game rows are
untouched), but the "what type of deck do I lose to" table will regroup. `--dry-run` is the default
recommendation.

**UI** ([apps/web/src/views/SetupView.vue](apps/web/src/views/SetupView.vue)):
add the missing per-deck archetype field from brief §10.2. Show the inferred tag as a pre-filled,
editable suggestion with a small `auto` chip; the moment the user types, `archetype_source` becomes
`'manual'`. Surface the tag on `/api/known-decks` so the setup screen can label saved decks.

### Tests

- Golden tests over the committed deck fixtures (`packages/server/src/cards/*.test.ts` already load
  them): each fixture asserts a stable expected tag. These double as regression guards when the
  classifier is retuned.
- Precedence: a user tag survives inference; a blank tag gets one; a nothing-clears-threshold deck
  gets `defaultArchetypeTag()`.
- Determinism: same decklist ⇒ same tag, run twice, no ordering dependence.
- `retag --dry-run` writes nothing; `retag` without `--force` leaves `'manual'` rows alone.
- AI refinement mocked; provider failure ⇒ heuristic tag retained (never `null`, never a throw).

---

## 11.3 — Post-game AI self-reflection commentary

### Design

One optional call per AI seat, fired after the game ends. At most 4 calls per game, off the
critical path by construction — the game is over, nothing is waiting.

**Trigger.** `MatchSession.publishGameOver()`
([session.ts:628](packages/server/src/match/session.ts#L628)) already runs at exactly the right
moment and already computes `standings()`. Fire reflection there, `await`-free: the existing
`gameOver` message ships immediately as it does today, and reflections arrive later on their own
message. A slow model must never delay the results screen.

**Inputs per seat** (assembled in a new `assembleReflectionPrompt()` in
[packages/server/src/ai/context.ts](packages/server/src/ai/context.ts)):

- final standings: this seat's finishing position, `lossReason`, `eliminatedOnTurn`, turn count;
- that seat's **own** `PlayerView` at end of game plus its own commander/tax/life history;
- the public spectator log, condensed to that seat's actions and to eliminations;
- its own decision history. `StrategyCoordinator.recentBySeat` is capped at
  `strategyRecentDecisionLimit` and is too short — add a per-seat full digest
  (`turn, phase, action description`) accumulated in `recordDecision`, sampled down to a token
  budget (keep every turn's first main-phase action and every combat decision; drop passes).

Keeping the prompt to what the seat actually saw is deliberate: a reflection built from omniscient
data produces "I should have known about the counterspell", which is not a lesson.

**Response schema**, validated by a new `validateReflection()` alongside
[validate.ts](packages/server/src/ai/validate.ts), with every string length-clamped the way
`cleanPlan()` clamps `intent` to 500 chars:

```jsonc
{
  "summary": "…",                    // ≤600 chars, what this deck was trying to do and why it ended how it did
  "keyMistakes": [{ "turn": 7, "what": "…", "better": "…" }],  // ≤5
  "keyPlays":    [{ "turn": 4, "what": "…" }],                 // ≤3
  "threatRead":  "…"                 // ≤300 chars, which opponent it should have respected sooner
}
```

**Config** ([packages/server/src/ai/config.ts](packages/server/src/ai/config.ts)):
`AI_REFLECTION_ENABLED` (default `false`), plus a `reflection: AiModelProfile` tier following the
established `strategist`/`tactician` pattern — cheap model, reasoning off, modest output budget,
short timeout. Reuse the **strategist queue** (`aiStrategistQueue`): concurrency is already
separated from the tactician lane and no tactical decision can exist any more.

**Turned on per game, from the new-game screen** (ADR 0022 §10 — added after this plan was
written). `SetupView.vue` carries a `Post-game commentary` checkbox next to the AI-bots choice,
and `startGame.reflectionEnabled` overrides `AI_REFLECTION_ENABLED` for that game. This is the one
feature here that spends budget the user cannot see coming — it fires after the game they were
watching has already ended — so the decision belongs next to the decision to use AI bots at all.
The provider kind remains the real gate: a random bot has nothing to review and is never asked.

**Persistence.** New table in `SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS game_reflections (
  game_id     TEXT NOT NULL REFERENCES games(id),
  seat        INTEGER NOT NULL,
  model       TEXT,
  summary     TEXT,
  detail_json TEXT,            -- keyMistakes / keyPlays / threatRead
  created_at  TEXT NOT NULL,
  PRIMARY KEY (game_id, seat)
);
```

Also log each call through `AiCallLogger.log(..., 'reflection')` with a new `DecisionSource`
member, so spend stays visible in one place. Two care points in
[logger.ts](packages/server/src/ai/logger.ts): `'reflection'` must **not** join `SKIPPED_SOURCES`
(it is a real billed call), and it is already excluded from `avgTacticianLatencyMs` because that
average filters explicitly to `primary`/`retry`/`fallback` — but `avgLatencyMs` would absorb it,
so exclude `'reflection'` there too or the average stops meaning "time a decision took".

**Protocol.** Reflections land after `gameOver`, so they need their own message rather than a field
on `GameOverPayload`:

- `ServerToClientMessage`: `| { type: 'gameReflections'; payload: GameReflectionsPayload }`, added
  to `SERVER_TO_CLIENT_TYPES`;
- `GET /api/games/:id/reflections` in [ws/server.ts](packages/server/src/ws/server.ts) for a
  reloaded page or a historical game.

**UI.**

- Spectator ([apps/web/src/views/GameView.vue](apps/web/src/views/GameView.vue)) and single-player
  ([apps/web/src/views/PlayerGameView.vue](apps/web/src/views/PlayerGameView.vue)): a
  `Post-game commentary` section on the results screen, one collapsible card per AI seat, with a
  `waiting…` placeholder while the calls are in flight and a clean "not available" state when the
  feature is off or a call failed.
- Each `keyMistakes[].turn` is a jump link into the timeline scrubber — the commentary is only
  useful if you can go look at the turn it names.
- In single-player, this is the most valuable surface in the app: three opponents explaining what
  they were doing and where they think they went wrong.

### Tests

- Mocked AI: 4 seats ⇒ 4 rows in `game_reflections`, 4 `ai_calls` rows with `source='reflection'`.
- Feature off ⇒ zero calls, zero rows, `gameOver` unchanged.
- Provider failure / invalid JSON / timeout for one seat ⇒ the other three still persist; no throw
  escapes into the session; the results screen still renders.
- `gameOver` is sent before any reflection resolves (assert ordering — this is the whole point).
  **As built, this one is not covered by an automated test.** Reaching a real `gameOver` requires
  running a whole game, and a game with `providerKind: 'ai'` makes live provider calls for every
  decision — there is no seam to stub the *decision* provider, only the reflection client. The
  ordering is instead enforced by construction (`publishGameOver` sends, then assigns
  `this.reflectionRun` without awaiting) and the surrounding behaviour — incremental publishing,
  one-seat failure isolation, terminal `complete` — is tested directly via `publishReflections`.
- Visibility test extension: a reflection prompt for seat P1 contains no other seat's hand and no
  library ordering, mirroring the existing brief §12 visibility test.
- Determinism test unchanged: reflections run after `getResult()` and touch no engine state.

---

## Suggested sequencing

1. **ADR 0022** — record that §15's three deferrals are being overturned, and why. Everything else
   depends on this existing.
2. **11.1** — pure plumbing, no new spend, immediately useful for debugging the AI you already run.
3. **11.2 Stage 1** — heuristic tagging + provenance columns + setup-screen field. Still no spend.
4. **11.2 Stage 2 + `retag`** — optional AI refinement and the backfill CLI (dry-run first).
5. **11.3** — the only workstream that adds recurring API cost; ship it last, default off.

Each numbered step is a working, shippable state. Per CLAUDE.md and brief §14.1, stop at each for
approval before starting the next.

## Resolved decisions

Confirmed 2026-08-03; these are settled, not assumptions.

- **11.1 — reasoning is a toggle, default off.** Even in spectator mode, where nothing is hidden
  from the viewer, annotations require the explicit `Show AI reasoning` toggle. The log stays as
  minimal as brief §10.2 specified until the user asks otherwise, and `eventBatch.annotations`
  stays absent from the payload by default.
- **11.2 — inferred tags auto-fill and stay editable.** The heuristic tag pre-fills the setup
  screen's archetype field with an `auto` chip; typing over it flips `archetype_source` to
  `'manual'`. `defaultArchetypeTag()` survives as the fallback when no signal clears the
  threshold, so the field is never empty and never `null`.
- **11.3 — every AI seat reflects.** Four calls in spectator mode, three in single-player (the
  human seat has no model to reflect with). No winner-only or human-adjacent narrowing — the
  point is reading all three opponents' accounts of the same game. The feature still defaults to
  off, so this is a cost the user opts into per configuration, not per game.
