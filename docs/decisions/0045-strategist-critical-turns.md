# ADR 0045: Find the turns where the strategist should hand the tactician the turn

Status: Accepted (2026-11-11)

Date: 2026-11-11

Third of three. [ADR 0043](0043-card-aware-bot-baseline-and-fixes.md) fixes the bot;
[ADR 0044](0044-tactician-escalation-triggers.md) lets the bot ask the tactician about single
decisions. This one is about whole turns the strategist judges critical.

## Context

In bot-led mode (ADR 0039) the strategist steers the bot with knobs (`BotSteering`: aggression,
target order, cards to prioritize or hold, mana to hold up, avoiding overextension). Knobs are soft
weights in the bot's policy, persist across turns per seat, and are reused while the table is quiet
(`AI_STRATEGIST_REPLAN=onChange`). The strategist reasons over the seat's `PlayerView` across turns,
plus its threat order and the seat's deals (ADR 0035); the bot sees one decision at a time.

Some turns may need that wider reasoning in a way no knob can carry. Which turns those are is
unknown, and none of the 30 benchmark positions was built to find them.

In model mode the tactician already receives the strategy, recent decisions, deals and public
memory (`guidanceFor` in `ai/strategy-coordinator.ts`). In bot mode the strategist returns knobs
only (`BOT_STRATEGIST_PRIMER`), so there is no context to hand over until its output grows.

The tools do not yet support the study:

- ADR 0028's counterfactual evaluation (`benchmark/counterfactual.ts`) forks at one pending
  decision, compares exactly two responses, rolls out with deterministic policies, and stops at the
  end of the active turn at the latest. Its default evaluator scores board and life averaged over
  opponents, so it penalises holding back and cannot value sparing one player.
- No bot-led game writes a replayable transcript. `captureReplayTranscript` runs only inside
  `ai-bench replay`; `bot-league` returns winner, turns and final life and has no strategist;
  `ai-mode-duel` logs calls, not a transcript.
- A bot-bench case is one position and one decision or one turn, with no field for strategy, deals
  or earlier turns, and no commanders.

## Decision

This ADR decides an investigation, not a feature. The strategist escalates for real only for
situations the investigation confirms, and only once those situations are catalogued.

### 1. Build first

1. **Capture games.** Bot-led games run through `StrategyCoordinator` with a real, paid strategist,
   `AI_STRATEGIST_REPLAN=everyTurn` and diplomacy on, writing a `ReplayTranscript` plus each seat's
   knobs in force at every turn. A spend cap applies to the whole study. Decks are chosen so that
   combos and deals can occur; randomly generated decks rarely hold combos. Capture speed is
   unmeasured. The only paid figure, a 98-minute `ai-mode-duel` game, had two model-mode seats that
   hit a rate limit, and the per-turn call counts in ADR 0039 come from a stubbed census; a four-seat
   bot-led game is probably faster. The first capture game is timed and the study plan sized from it.
2. **A turn-level counterfactual.** It forks at the first decision of a seat's turn and takes N arms,
   each a policy for that seat: the steered bot under one knob setting, the tactician, or a scripted
   reference line (below). A bot arm keeps its knob setting until the horizon, since `hold`, mana
   held up and avoiding overextension act across turns. The tactician and reference arms play the
   forked turn only, then the seat plays the card-aware bot with its recorded knobs. The other three
   seats play the card-aware bot with the knobs recorded for them, frozen; no strategist runs inside
   a rollout. It runs to a multi-turn horizon: until the seat's next turn ends.
3. **Variation, within what the engine can do.** The engine has no way to re-deal hidden zones or
   reseed mid-game; `reconstructAtDecision` rebuilds a game from its config and checks state hashes.
   The study therefore varies the rollout policies' seeds only, so every trial of a turn plays the
   same deal. To keep one lucky deal from confirming a situation, a situation enters the catalogue
   only when it is confirmed on marked turns from several different games; the number is in the
   study plan. Seed variation counts as too narrow when the bot arms reach identical final state
   hashes across seeds on most marked turns. Then re-sampling hidden zones consistent with the
   seat's view is built: separate engine work, seeded and reproducible, that re-pins the benchmark
   fixtures.
4. **The tactician arm is live and non-deterministic.** Its answers are recorded, each turn is run K
   times, and a decision the fallback bot made is never credited to the model, as bot-bench already
   does.
5. **A scripted reference arm.** For each marked turn a reviewer writes the good line, as bot-bench's
   `lines` are written. It is what "knob ignored" and "bot rule missing" are measured against. The
   line is written from the seat's `PlayerView` at the fork, before any arm is run, so it carries no
   hindsight of hidden cards or the outcome.
6. **An evaluator per situation class**, named before any run. Cross-turn and political classes are
   judged at the multi-turn horizon or by game result, not by the end-of-turn board score.
7. **The strategist context**, built by hand for the study before any primer change: the
   strategist's intent and threat order, the flag's reason, and the seat's deals, through the existing
   `TacticalGuidance`. The tactician arm runs with and without it.

### 2. Which turns to examine

- **The acting seat's own turns before a swing.** A swing is an elimination or a large change in life
  or board. The swing usually lands on another player's turn, after the decision that caused it, so
  the seat's preceding one or two turns are marked rather than the swing turn.
- **Turns where the bot arms disagree,** sampled regardless of swing at a fixed rate. A missed kill or
  a missed hold produces no swing at all. Disagreement is a different final state hash, or an
  evaluator gap above the margin, among bot arms only; the paid tactician arm runs only on turns
  that pass that filter.

### 3. The knob grid

Every knob combination is intractable: target order and the card-name lists alone run to thousands
of settings. The arms per marked turn are:

- the strategist's own knobs;
- the bot's defaults;
- one knob changed at a time from the strategist's knobs:
  - aggression 0, 0.5 or 1;
  - each opponent first in the target order;
  - mana held up 0, 2 or all;
  - avoid overextending on or off;
  - one card at a time added to `hold` or `prioritize`.

A one-at-a-time grid misses knob interactions, such as aggression 1 with a changed target order.
Before a turn gets a "knob missing" or "needs the tactician" verdict, a small pairwise follow-up on
that turn tries the pairs of the knobs that moved the evaluator; it costs bot arms only.

The budget, marked turns × arms × trials, is fixed before the study and kept within the spend cap.

### 4. Verdicts

Each marked turn gets one of six verdicts:

| Verdict             | Meaning                                                                                            | Fix                               |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| Knob ignored        | A grid arm sets the knob that names the reference line, and the bot's actions do not change        | A weight change in `packages/bot` |
| Bot rule missing    | The reference line beats every grid arm, and a deterministic rule could find it whatever the knobs | A bot rule, under ADR 0043's gate |
| Knob missing        | No arm in the grid reaches the reference line, the tactician does, and a new knob could express it | A new knob                        |
| Needs the tactician | No arm in the grid reaches it, the tactician does, and no knob or rule could                       | Strategist escalation             |
| No gap              | A grid arm reaches the reference line                                                              | None; catalogued                  |
| Nobody finds it     | The reference line beats every arm, the tactician fails too, and no rule could find it             | None; catalogued                  |

The tactician "does" reach it only when its arm beats the best grid arm by more than a set margin,
and comes within that margin of the reference arm, in at least a set share of its K trials. Choosing between "knob missing" and "needs the tactician",
and whether a rule "could" find a line, are reviewed judgements made on the main thread and recorded
with their reason.

### 5. The strategist's flag, in shadow

1. **A typed field.** `TurnStrategy` gets an optional typed field asking for the tactician on this
   turn, with a short reason. A typed field rather than one read untyped, as `dealProposal` is read
   today. It is parsed and logged independently of the knobs, since an answer whose knobs are all
   invalid stores no steering.
2. **The reason stays private.** It goes to the debug log only, like `DecisionResponse.note`. It is
   length-capped, since it can name cards in the seat's hand. The context later passed to the
   tactician is derived from the same seat's view.
3. **Shadow only.** During the study the flag is logged, not acted on, and compared with the turns
   from section 2. Each flag records which change would have woken the strategist under `onChange`,
   since reused turns make no strategist call in production.
4. **Overlap with ADR 0044.** `lethal` is shadow-only too, so in shadow both are logged when they
   fire on the same turn. A merge rule is decided only if both go live.
5. **Check the primer change.** Adding the field changes the strategist's prompt and answer. Knob
   quality is compared with and without it.

### 6. Turning results into benchmark positions

Confirmed situations become bot-bench positions where the format can hold them. That needs:

- a context block carrying the strategist's view;
- deals;
- a scope longer than one turn.

Classes the format cannot hold, including commander damage until the scenario format can arrange
commanders, are judged by game result only.

### 7. Exit

- **Size.** The study stops after a fixed number of captured games and marked turns, or at the spend
  cap.
- **Output.** A catalogue of situations, each with its frequency per game, its verdict, and the
  tactician's lift with and without strategist context. For each, the cheapest fix that works wins.
- **If nothing is confirmed,** strategist escalation is not built, and whole-turn judgement positions
  are written by hand instead.
- **Numbers on record first.** A study plan under `docs/reviews/`, committed before the first paid
  run, holds the game count, marked turns, K, the margin and share, the sample rate and the spend
  cap.

## Consequences

- No production tactician calls are added until a situation is confirmed. The study itself is paid
  (strategist games, tactician arms, bot-bench runs) and runs under its spend cap.
- The turn-level counterfactual, transcript capture from strategist games and the bot-bench format
  extensions are new work, and come before any measurement.
- Situations that pass become the positions that keep measuring what a model is worth once ADR
  0043's fixes have closed the arithmetic gaps.
- The field name, the margin, the trial counts and the budget are set in the study plan, not here.
