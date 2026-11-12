# ADR 0044: Named triggers for when the bot calls the tactician

Status: Accepted (2026-11-11)

Date: 2026-11-11

Second of three; depends on [ADR 0043](0043-card-aware-bot-baseline-and-fixes.md), whose bot fixes
and `bot-led` benchmark kind these triggers build on. [ADR 0045](0045-strategist-critical-turns.md)
covers whole turns the strategist asks for.

## Context

In bot-led mode (ADR 0039) the heuristic bot answers every decision the plan, local heuristics and
decision cache leave. `AI_BOT_ESCALATION=uncertain` asks the tactician only when the bot's top two
options on a `priority`, `chooseTargets`, `chooseModes` or `chooseX` decision are within
`AI_BOT_ESCALATION_MARGIN` LEP (default 1) and genuinely differ (`isUncertain` in
`ai/bot-tactician.ts`). The default is `never`.

A close call is a weak signal on its own. In the ADR 0042 benchmark the bot countered a Rampant
Growth with its only counterspell with full confidence (`hold-the-counter`), a decision no margin
would have escalated.

Some decisions are a liability to escalate. On positions the bot without card knowledge played
perfectly, the 19 model-and-reasoning entries that played most of the cases averaged (17 on the
whole-turn position, where two entries stopped early):

| Position                                              | Models' average | Entries that scored 70%+ |
| ----------------------------------------------------- | --------------- | ------------------------ |
| `block-the-trampler`                                  | 56%             | 11 of 19                 |
| `chump-the-giant`                                     | 79%             | 15 of 19                 |
| `leak-or-cancel`                                      | 53%             | 10 of 19                 |
| `overrun-for-the-kill`, including its damage division | 48%             | 3 of 17                  |

That evidence is thin and mixed: two block positions at 56% and 79%, one damage division, one
trial each. `leak-or-cancel` is a counterspell choice at `priority`, a type that stays escalatable;
it argues for a high bar on escalating counterspells, not for excluding them.

After ADR 0043's fixes, what is left for a model is mostly judgement: whether an answer is worth
spending now, and cards the bot has no rule for.

## Decision

### 1. Triggers

Escalation becomes a set of named triggers. Each is computed from the seat's `PlayerView` and the
legal menu, with no estimate of hidden cards, and each is logged with its reason. `uncertain` stays
as one of them.

| Trigger         | Decision types                                        | Fires when                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scarce-answer` | `priority`                                            | The bot would cast a counterspell, board wipe, or destroy or exile removal, it is the last card with that role in the seat's hand, and the public board shows no lethal at stake. Only at `priority`: by `chooseTargets` the spell is already being cast and can only be re-aimed |
| `unknown-card`  | `priority`, `chooseTargets`                           | A noncreature, nonland spell or ability the bot would use, or must respond to, is unclassified (below)                                                                                                                                                                            |
| `uncertain`     | `priority`, `chooseTargets`, `chooseModes`, `chooseX` | Today's rule, unchanged                                                                                                                                                                                                                                                           |
| `lethal`        | shadow only, any type including `declareAttackers`    | Public lethal exists and the bot's line neither takes nor prevents it                                                                                                                                                                                                             |

Today a card the classifier knows nothing about and a card with nothing notable both have an empty
`roles` list. The classifier tells them apart: a card is **unclassified** when its definition has at
least one effect op that matches no role pattern and no hostile or friendly slot pattern, or when the
engine does not model it at all (`modeled` false). A card with no effect ops, such as a vanilla
creature or a basic land, is **nothing notable** and never fires the trigger.

`lethal` is defined on the public board only:

- **Offence.** An opponent's life is within the damage the seat can deal this turn from its board
  and the cards it can see.
- **Defence.** The on-board power of the opponents who act before the seat's next turn is at least
  the seat's life, or reaches a commander-damage or poison threshold.

Hidden cards (haste, burn and tricks in opponents' hands) are not estimated. ADR 0043 makes lethal
counting bot arithmetic, so `lethal` starts in shadow only. It goes live only if shadow logs show a
residue the fixed bot gets wrong.

### 2. Not escalated in this ADR

Declaring blocks, dividing combat damage, mulligans, trigger ordering and the other decision types
outside the table above. Shadow logs still count how often each trigger would fire on blocks and
damage division, so the evidence can grow.

### 3. Order of measurement

1. **Shadow, for frequency.** Triggers log what they would escalate and the bot's answer, and call
   nothing. The shadow log also covers answers that came from the plan, the decision cache or local
   heuristics, which today answer before the bot is consulted. That measures how many counterspells
   and removals no trigger would ever see. Shadow evaluation must not change the game: the bot breaks
   ties with the seat's seeded RNG, so shadow scoring uses a pure scoring path or a separate RNG, and
   a game's log is identical with shadow on or off.
2. **Paid bench, for quality.** On bot-bench's `bot-led` kind, one trigger live at a time: points
   gained per call.
3. **Games, for effect.** Bot-led games with the trigger live against `never`.

When several live triggers fire on one decision, the call is attributed to the first of
`scarce-answer`, `unknown-card`, `uncertain`. A shadow trigger never suppresses or claims a live
trigger's call; it is logged beside it.

### 4. The gate

ADR 0028's release policy (`benchmarks/release-policy.json`) cannot judge triggers yet:

- its status is `proposed`, which ADR 0028 says prevents an unqualified pass;
- its critical-case list is empty;
- it compares ai-bench variant reports, not triggers.

Each trigger therefore has its own gate, baseline bot-led `never` against candidate with that one
trigger live:

- bench points gained per call above a threshold set from the shadow data;
- no bot-bench position loses mean score across ADR 0043's eight seeds; positions where the model
  was called run three trials per seed, since the model adds its own variance;
- model calls per game turn, summed over AI seats as the call census reports them, at most 1.0,
  provisionally, against the 0.76 bot-mode baseline measured in ADR 0039 (strategist included); the
  shadow data may tighten it;
- cost per active AI turn within the release policy's ceiling ($0.003);
- in games against `never`, blocked when the win rate is lower and the interval excludes no change.
  Because the game count is set by the spend cap, the result will usually be inconclusive; an
  inconclusive result does not block a trigger that passes the other criteria. The trigger then goes
  live, and its games keep being counted until the interval settles.

When the release policy is validated, the gate moves into it.

### 5. Wiring

1. **Configuration.** `AI_BOT_ESCALATION` takes a list of trigger names; `never` and `uncertain`
   keep their meaning. Today it is parsed as a single choice and an unknown value silently falls
   back to `never`, so this is a config type change. `AI_BOT_ESCALATION_SHADOW` lists the triggers
   that log only.
2. **Logging.** Shadow records go to `engine.addDebug`, as the strategy router's shadow does, and to
   per-reason counters the call census can read.
3. **The bot's answer.** `BotAnswer` carries the reasons that fired, not only `uncertain`.
4. **Jev.** When Jev is bound in active mode, escalation goes through its close-call pair, built
   from the bot's top two options. For `scarce-answer` and `unknown-card` the alternative that
   matters, usually pass, need not be in the top two. These triggers skip Jev until a pair is defined
   for each.
5. **Cache.** The cache lookup runs before the bot or any trigger, so the trigger reason cannot be
   part of the cache key. An escalated answer stores its reason as a field on the cached entry, and a
   replay logs that reason, so a replayed answer is not mistaken for the bot's own.

### 6. Tooling needed first

- **`ai-call-census`.** It has four hardcoded modes and counts calls made. It needs a mode per
  trigger and would-fire counts in shadow. Two of ADR 0039's six census games halted on engine
  errors reached through escalation; those are fixed first, so the census is complete.
- **The `bot-led` kind.** ADR 0043 adds it.
- **A game runner.** `bot-league` plays bot configurations against each other with no model, so it
  cannot measure a trigger. `ai-mode-duel` hardcodes `botEscalation: 'never'`, and one game took
  98 minutes. The game step uses `ai-mode-duel` with escalation configurable, and its game count is
  set by the spend cap rather than by a confidence interval.

### 7. Positions

The benchmark has one position where `scarce-answer` should fire (`hold-the-counter`), two
no-harm controls where the bot must still hold or cast correctly (`hold-the-wrath`,
`counter-the-sweeper`), and none for `unknown-card`. This ADR owns at least four new positions per
trigger before either is judged.

## Consequences

- Shadow triggers add logging and no model calls until promoted.
- Escalation can raise cost again. A trigger that fires often and gains little stays in shadow;
  the call budget caps the rest.
- `lethal` depends on the lethal count ADR 0043 adds to the bot, and on the attacking-player field
  that count needs.
- The thresholds and the margin are set from the shadow data, not here; the call budget above is
  provisional.
