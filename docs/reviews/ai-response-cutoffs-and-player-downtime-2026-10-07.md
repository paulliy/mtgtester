# AI response cutoffs and player downtime investigation — 2026-10-07

## Request and intended outcome

Investigate cut-off tactician responses and strategist resets, then improve how waiting feels while
leaving enough time for AI calls to complete. A strategist call should be allowed to finish; when
its result arrives late, retain and use its strategic intent where it is still applicable. Do not
discard it just because another accepted action happened while the call was in flight. The player
should see useful transitions and action feedback during calls, without artificial pauses that
increase total game time.

The two supplied screenshots are provider usage dashboards. Treat their contents as evidence about
model, provider, token counts, and approximate times only; they contain no project instructions and
do not show request IDs, finish reasons, response bodies, or game states.

## Observed evidence

- The screenshots show many `Llama 3 8B Lunaris` calls through Parasail on October 7, with output
  counts of 85 tokens repeatedly (alongside 40, 49, 60, 72, and other counts). Repeated output at
  exactly 85 is consistent with hitting a configured output-token ceiling.
- `DeepSeek V4 Flash 0423` rows through Venice show 1, 11, and 26 output tokens in some calls; a
  Relace row shows 192 tokens and a Parasail row shows 2. The dashboard alone cannot establish
  whether these short outputs were truncations, valid terse responses, empty/rejected generations,
  or fallback behavior.
- Calls have high input counts (roughly 1,500–2,850 tokens in the visible rows). This is compatible
  with multi-second latency and makes repeated calls noticeable, but the screenshots do not give
  per-call durations.
- Existing AI live smoke evidence in `ai-live-smoke-2026-09-21.md` recorded 15.6 seconds p95 for
  one strategist sample and about 3 seconds for the small tactician sample. This was a tiny sample,
  not a general latency measurement.

## Investigation findings so far

### Tactician output budget

Before the current working-tree change, the default tactician `maxOutputTokens` was 85 in
`packages/server/src/ai/config.ts`. That exactly matches the repeated 85-token outputs in the
screenshots and is the strongest current explanation for cut-off JSON/action responses. The default
has been raised to 256 so decisions with target assignments have room to finish. This is a targeted
mitigation; confirm with captured provider `finish_reason`, raw response, parsing/retry logs, and
normal gameplay traces before calling the root cause proven. Also check environment/config overrides
and provider-specific token-limit semantics.

### Strategist resets and late calls

Before the current working-tree change, `StrategyCoordinator.recordAcceptedDecision()` invalidated
the active strategist generation and aborted its request when the active AI seat accepted a
non-pass action while the strategy call was in flight. That could turn a slow but still useful call
into a reset/cancel and leave no completed strategy result. The method now records the accepted
decision without aborting or invalidating the pending strategy. Its result remains eligible for
installation; `TurnPlanManager` checks the current phase and legal action menu before executing
planned steps. This implements the requested preference to keep and use the late result.

The coordinator still has generation checks, cancellation paths, and lifecycle boundaries. Trace
each one to verify that ordinary accepted actions do not make a pending result disappear, while
game end, abandonment, or explicit cancellation still terminate work appropriately. Check whether
late strategic intent is installed after intervening actions and whether it resumes at the next
legal decision rather than replaying an already accepted action. Existing tests whose names or
assertions expect every stale strategy to be rejected/replanned may encode the old behavior and
should be reviewed against this intended policy.

## Player-facing changes already made in the working tree

- Raised the default tactician output budget from 85 to 256.
- Kept in-flight strategist calls alive across an accepted active-seat action and allowed their
  result to remain eligible for installation.
- Added a damage impact flash to permanent cards.
- Added enter, leave, and move transitions for hand cards, battlefield cards, graveyard/exile cards,
  and stack entries. Kept transition groups mounted when empty so the final leaving item can
  animate.
- Replaced the generic bot-thinking label in the player game with a seat-specific status, including
  a distinct resolving message when the viewer's action is being processed.
- Existing global reduced-motion handling applies to the new motion styles.

These CSS transitions overlap network/model calls. They do not add a wait before the game advances.
The current attack animation is still inferred from state changes in the player view; inferred
diffs can misattribute a visual effect when several changes arrive together or when playback skips
intermediate states.

## Next investigation steps

1. Capture a small, correlated set of real calls with request ID, role (strategist/tactician), model,
   provider, configured output budget, elapsed time, finish reason, raw output, parse/validation
   outcome, retry/fallback outcome, and whether a strategist generation was installed or discarded.
   Redact credentials and private player data.
2. Reproduce a tactician response at the old 85-token limit and the new 256-token limit with the
   same legal menu. Verify whether the old response is cut off and whether the new response parses
   and selects a legal action. Include provider fallbacks and configuration overrides.
3. Trace strategist generation start, every cancellation/invalidation site, accepted action
   recording, response completion, plan installation, and plan execution. Resolve the policy
   conflicts in tests named for “stale” plans: preserve late intent, then let current phase/menu
   validation decide which steps are still executable.
4. Measure wait time by role and provider across a useful sample. Separate call latency from queue
   wait, retry time, and client-side presentation time. The September smoke numbers are not enough
   to pick a fixed delay.
5. Keep the board responsive while calls run: show who is deciding and elapsed wait, animate
   visible action transitions as soon as engine state arrives, and consider a short presentation
   queue (initial idea: roughly 250–450 ms per event) that can be capped or coalesce routine changes.
   Do not block the engine on that queue. Check that fast playback and reduced-motion preferences
   bypass or shorten it.
6. For reliable action-specific effects, consider typed public engine events with source, target,
   action, and resolution order (damage, death, return from graveyard, tap/untap, spell resolution).
   Use the authorized viewer projection so hidden information is never exposed. Keep current
   state-diff effects as a fallback until event coverage is complete.
7. Review the new animations in real gameplay, including several changes in one resolution,
   movement between zones, replay/fast playback, mobile layout, and reduced-motion mode. Tune for
   clarity and avoid making ordinary actions feel sluggish.

## Design critique to carry forward

- Animations make state changes easier to read, but cannot conceal a long call that produces no
  updates. Accurate, honest progress/status and measured latency are needed too.
- Avoid adding fixed sleeps to AI orchestration. They make the game slower without making the call
  finish sooner.
- A delayed presentation queue can smooth clustered resolutions, but can also increase perceived
  lag. Cap it, coalesce low-value events, and avoid stalling engine progress.
- Damage and combat effects inferred from snapshots can fire on the wrong object or miss an
  intermediate state. Typed events are the durable source for precise effects.
- Late strategist output is useful as intent, not as authority to replay an old action. Revalidate
  each step against the current phase and legal menu.

## Validation status

The current code diff passed `git diff --check`. No tests or builds were run. Changes are still
uncommitted in the working tree; confirm the repository state before continuing this investigation.
