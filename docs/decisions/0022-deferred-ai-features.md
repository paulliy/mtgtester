# 0022 — Building brief §15's three deferred AI-transparency features

Date: 2026-08-03

Status: Accepted

## Context

Brief §15 deferred three features out of v1:

- **Post-game AI self-reflection commentary** — cut outright.
- **Automatic archetype tagging** — manual field only, with the instruction to "leave the schema
  ready for inference later."
- **AI reasoning in the spectator log** — reasoning notes confined to the debug log.

Each was a scope and cost call at a point when the engine's rules fidelity was the only thing worth
spending effort on. None was a design objection, and none is load-bearing for any later decision:
ADRs 0016–0021 neither depend on the deferrals nor contradict them.

The deferrals were also honoured properly rather than merely postponed, which is why building them
now is mostly plumbing:

- `DecisionResponse.note` already carries the model's reasoning on every tactical response, and
  `TurnStrategy.intent`/`manaPlan` carry a richer per-turn version. Both already reach
  `ai_calls.response_json` and `Engine.addDebug`. What is missing is a delivery channel, not data.
- `decks.archetype_tag` exists, is `NOT NULL`, is defaulted by `defaultArchetypeTag()`, and every
  importer already threads a user-supplied `archetypeTag` through as `null`. §8.4's "structure the
  field so an inference pass can populate it later without a schema change" holds exactly.
- `DebugFlags.showAIResponses` already exists as the intended gate.

What has changed since the brief is that single-player mode (ADR 0018) now exists. That makes AI
reasoning a hidden-information problem it was not in a four-bot spectator game, and it makes
post-game commentary considerably more valuable — three opponents explaining what they were doing
is the single most useful post-game artifact the system can produce for a human player.

## Decision

1. Build all three features. This ADR supersedes brief §15 for these three items only; the rest of
   §15 stands.
2. **Reasoning reaches the spectator log on a parallel annotation stream, never inside
   `SpectatorLogLine`.** The engine formats `GameEvent`s and stays AI-unaware, and a replay rebuilt
   from `game_events` alone stays complete. Annotations anchor to a `GameEvent.sequence`.
3. **In `singlePlayer`, annotations for seats other than the human's are withheld by the server
   until the game ends**, then delivered with `replayUnlocked`. This is a server-side gate, not a
   UI preference: a client must never receive reasoning it must not show. Spectator mode delivers
   live, since that viewer already sees every hand (§10.2).
4. **Reasoning display is opt-in and off by default**, gated by the existing `showAIResponses`
   flag. With it off, the payload does not grow and the log is byte-identical to today's.
5. **Archetype inference is deterministic first.** A pure heuristic over the resolved decklist —
   type counts, curve, functional and thematic oracle-text signals, weighted toward the commander's
   own text — produces the tag at zero cost, offline and reproducibly. An optional AI refinement
   pass sits behind its own default-off flag and receives only the computed feature vector and card
   names; on any failure the heuristic tag stands.
6. **An explicit user tag always wins.** Precedence is user > inferred > heuristic > default. A
   new `archetype_source` column records which applied, and a stored feature vector allows the
   classifier to be retuned and old decks re-scored without re-resolving decklists — the same
   reasoning §9.2 gives for logging raw mana inputs rather than booleans.
7. **Post-game reflection runs after `Engine.getResult()`, once per AI seat, and never blocks the
   results screen.** `gameOver` ships as it does today; reflections arrive later on their own
   message. Prompts are built from that seat's own `PlayerView` and the public log — not from
   omniscient end-state data, which produces "I should have known about the counterspell" rather
   than a lesson.
8. **Every new model call is logged through `AiCallLogger` with its own `DecisionSource`**, so the
   debug panel and cost counters remain the single source of truth for spend. Reflection calls are
   billed calls and are never counted among the locally-answered sources.
9. **All three features default to off.** The default configuration costs exactly what it costs
   today.
10. **Reflection is turned on per game, from the new-game screen**, not only by an environment
    variable. It is the one feature here that spends budget the user cannot see coming — it fires
    after the game they were watching has already ended — so the decision belongs next to the
    decision to use AI bots at all, rather than in a server setting somebody left on three weeks
    ago. `startGame.reflectionEnabled` carries the choice and overrides `AI_REFLECTION_ENABLED`,
    which remains the default for callers that do not send one (CLIs, tests). The provider kind is
    still the real gate: a random bot has no reasoning to review, so it is never asked.
11. **A reflection is not given the decision primer.** `RULES_PRIMER` exists to make a model pick
    an `actionId` from a legal menu and answer in a decision-shaped JSON; both instructions
    directly contradict a retrospective. A review gets a short review brief instead, which also
    saves the primer's tokens on every seat of every game.

## Consequences

- Determinism is unaffected. Nothing here feeds back into a decision: reflection runs strictly
  after the game ends, and archetype inference runs at import. The brief §12 determinism test must
  pass unchanged, and annotations are not events.
- The hidden-information boundary gains a second required test surface alongside ADR 0018's: a
  reflection prompt for one seat must contain no other seat's hand and no library ordering.
- Retagging existing decks changes how historical results aggregate, because `stats.ts` groups the
  "who beats me" view by `archetype_tag`. No game data is lost, but the backfill CLI defaults to a
  dry run and never rewrites a manually-entered tag.
- The spectator action log's "minimal, no AI reasoning" contract becomes conditional rather than
  absolute. Its header comments, and the matching one on `SpectatorLogLine`, are updated to say so.
- Reflection adds at most one call per AI seat per game — four in spectator, three in
  single-player — and only when explicitly enabled.
- `gameReflections` is a new server→client message rather than a field on `GameOverPayload`. ADR
  0012's rule is to ride on an existing payload instead of widening the message set; this is the
  case that rule cannot cover, because the whole point is that commentary arrives _after_ the
  result. `gameOver` carries only `reflectingSeats`, so the screen knows what is coming.
- `ai_calls.source = 'reflection'` is counted as a billed call but excluded from `avgLatencyMs`. A
  20-second retrospective is real spend and must show up as such, but it is not a decision, and
  letting it into that average would stop it meaning "how long a decision took".
