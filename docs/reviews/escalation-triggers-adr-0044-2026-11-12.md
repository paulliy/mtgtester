# ADR 0044 escalation triggers: shadow census and positions (2026-11-12)

Evidence for [ADR 0044](../decisions/0044-tactician-escalation-triggers.md). The triggers, their
shadow logging and the tooling are built and measured offline. The paid steps (bench points per
call and games against `never`) have not been run and need a spend cap.

## What is built

- **Triggers** (`packages/server/src/ai/escalation.ts`), computed from the seat's `PlayerView`, the
  legal menu and the bot's ranking:
  - `scarce-answer`: at `priority`, the bot would cast a counterspell, a wipe or destroy/exile
    removal (`CardTraits.hardRemoval`), no other card in hand has that role, and no lethal is at
    stake on the public board. Lethal counts incoming attacks, opponents' power (plus team pumps
    they have on the stack), commander damage, poison, and the seat's own kill this turn.
  - `unknown-card`: at `priority` or `chooseTargets`, the spell or ability the bot would use, or the
    opponent's spell on top of the stack, comes from a noncreature, nonland card that is
    unclassified. `CardTraits.unclassified` is set when a leaf effect op matches no role pattern, no
    hostile or friendly pattern and no bookkeeping op (shuffle, scry, surveil, look at the top,
    attach, crew, transform), or when the engine does not model the card. Tokens and granted
    abilities are opaque: their inner ops describe the token, not the card.
  - `uncertain`: ADR 0039's close-call rule, unchanged.
  - `lethal` (shadow only): public lethal exists and the bot's line neither takes nor prevents it.
    In practice that means passing while a kill is available, an attack that sends no killable
    opponent its lethal, an attack that leaves the next swing lethal, and passing or blocking
    while the attack on the seat is lethal.
- **Configuration.** `AI_BOT_ESCALATION` takes `never` or a list of live triggers.
  `AI_BOT_ESCALATION_SHADOW` lists the triggers that only log. An unknown name throws, and `lethal`
  cannot be made live.
- **Attribution.** A call goes to the first live trigger in the order `scarce-answer`,
  `unknown-card`, `uncertain`. A shadow trigger is logged beside it and never claims the call.
- **Logging.** `engine.addDebug` gets an `escalation triggers` entry with the fired, shadow and
  escalating triggers. Each seat keeps per-trigger counters (`escalationStats()`), broken down by
  decision type and answer source. The shadow also covers answers from the plan, the cache and the
  local heuristics, ranked by the bot's pure scoring path (`HeuristicDecisionProvider.rank`), which
  draws nothing from its RNG. A test plays the same seeded game with every trigger in shadow and
  with none, and checks that the event logs are identical.
- **Jev.** `scarce-answer` and `unknown-card` escalations skip active Jev and go to the model.
- **Cache.** An escalated answer stores its trigger on the cached entry. A replay logs "replaying
  an answer escalated by <trigger>".
- **Tooling.** `ai-call-census` adds would-fire counts for every bot mode and one mode per live
  trigger. `ai-mode-duel` takes `--escalation`, `--shadow` and `--opponents bot-never`. bot-bench's
  `bot-led` kind accepts every live trigger and records `reasons` per decision.
- **Engine fix found first** (decision 6). The census's one halting game was an engine error, not
  an escalation one: Sunbird's Invocation revealed Delirium ("cast only during an opponent's
  turn") on its controller's turn, offered the free cast, then refused it. Free casts now skip a
  spell whose own cast restriction is not met (CR 601.3), with a regression test in
  `pr09-library-reveal.test.ts`.

## Shadow census

`bun run ai-call-census --games 6` (seeds `census-0` to `census-5`, turn cap 40, a stub client: no
money spent). Counts are per game turn summed over the four AI seats, which is the unit of ADR
0044's 1.0 call budget.

| Mode                         | Calls per turn | Tactician per turn | Calls credited to the live trigger |
| ---------------------------- | -------------- | ------------------ | ---------------------------------- |
| model (today)                | 6.83           | 5.67               |                                    |
| bot, replan on change        | 0.79           | 0                  |                                    |
| bot + escalate scarce-answer | 0.83           | 0.05               | 11                                 |
| bot + escalate unknown-card  | 1.17           | 0.38               | 90                                 |
| bot + escalate uncertain     | 1.06           | 0.29               | 69                                 |

How often each trigger would fire, in shadow, per game turn (234 turns): `unknown-card` 0.385,
`uncertain` 0.303, `lethal` 0.051, `scarce-answer` 0.047. Every `scarce-answer` and `unknown-card`
firing came from a decision the bot answered. The plan, cache and heuristics answered nothing that
fired, except two `uncertain` firings answered by the heuristics. `lethal` fired 12 times: 5 at
`priority`, 5 on attacks and 2 on blocks. Before the engine fix above, one model-mode game
(`census-3`) halted; in the rerun after it, all 36 games (six per mode) completed.

What this says before any paid run:

- `scarce-answer` is cheap: about one call per 20 game turns, inside the budget.
- `unknown-card` and `uncertain` each go over the provisional 1.0 calls per game turn (1.17 and
  1.06). The ADR's call-budget criterion would fail them as configured. The `unknown-card` count
  comes from 123 of the coverage fixture's 472 modeled noncreature, nonland cards being unclassified.
  Narrowing that set, or the uncertainty margin, is a lever to pull before paying for their bench
  runs.
- `lethal` is rare and stays in shadow. A bot-led run of the 30 original positions
  (`bot-bench run --models bot-led:never`) had it fire on none of them once correct defensive play
  counts as prevention; `escalation-triggers.test.ts` pins the case that used to fire
  (`keep-blockers-home`).

## Positions (decision 7)

Eight new one-decision positions, four per live trigger, under `bot-bench/cases/tactician/single/`.
The card-aware bot (bot-led `never`) and the trigger that fires on each:

| Position                       | Trigger         | Right answer         | Bot  |
| ------------------------------ | --------------- | -------------------- | ---- |
| `hold-the-swords-for-a-threat` | `scarce-answer` | develop, keep Swords | 30%  |
| `hold-negate-for-a-threat`     | `scarce-answer` | pass                 | 0%   |
| `negate-the-blasphemous-act`   | `scarce-answer` | cast (control)       | 100% |
| `wrath-the-crowded-table`      | `scarce-answer` | cast (control)       | 100% |
| `darkness-the-alpha-strike`    | `unknown-card`  | cast Darkness        | 100% |
| `crackling-doom-for-two-kills` | `unknown-card`  | cast Crackling Doom  | 100% |
| `angels-grace-at-three`        | `unknown-card`  | cast Angel's Grace   | 100% |
| `protect-from-feed-the-swarm`  | `unknown-card`  | protect in response  | 100% |

With `hold-the-counter` (scarce), `hold-the-wrath` and `counter-the-sweeper` (controls) and
`fog-the-lethal-swing` (unknown), each trigger now has at least four positions of its own.
`counter-the-finisher` no longer fires `scarce-answer`: the opponent's Overrun on the stack puts
lethal at stake. `bot-bench/src/escalation-triggers.test.ts` pins which trigger fires on each.

The bot already plays the four `unknown-card` positions correctly: their cards' effects happen to
score above passing. The positions measure whether a model asked about an unfamiliar card does at
least as well, which is the no-harm half of the gate.

## Not run (paid)

- **Bench points per call.** `bun run bot-bench run --lineup <bot-led entries, one trigger live
each> --trials 3` over the gate's eight seeds.
- **Games against `never`.** `bun run ai-mode-duel --escalation <trigger> --opponents bot-never
--max-usd <cap>`.
- The per-trigger thresholds and margins the ADR leaves to the shadow data are not set until those
  runs exist.
