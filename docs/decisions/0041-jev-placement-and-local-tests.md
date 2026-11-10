# ADR 0041: Where Jev sits, and how it is tested locally

Status: Accepted (2026-11-10)

Date: 2026-11-10

## Context

The Jev integration (`docs/plans/jev-tactician-remake.md`) was built for model-mode tactics: Jev
answers first and the chat tactician answers whatever Jev cannot. ADR 0039 then made the bot the
planned default tactician. Under bot-led tactics the chat tactician is asked only on the bot's
close calls, and Jev had no place of its own:

- Shadow mode only ran where the chat tactician ran, so a bot-led seat never asked Jev at all.
- A Jev fallthrough always went to the chat tactician, even when the bot already had a free answer.
- Shadow answers were logged, but never compared with the answer actually played.
- Any target choice with more than one legal object bypassed Jev for the whole menu. In offline
  games this was 23% of priority decisions in model mode and 23% of the bot's close calls.
- The parser rejected answers without `confidence` or `probabilities`, which the OpenRouter SDK
  types (`@openrouter/sdk` 1.3.16, `DecisionsChoiceAnswer`) mark optional.

Jev's play quality has never been measured. The tactician benchmark has one Jev case.

## Decision

1. **Placement settings.**
   - `AI_JEV_FALLBACK=model|bot` (default `model`): what answers a decision Jev was asked but did
     not settle. `bot` costs nothing.
   - In bot mode, shadow Jev now runs beside the bot (`AI_JEV_SHADOW_SCOPE=all|uncertain`, default
     `all`). It is fire-and-forget, so play is unchanged; a test plays the same seed with and
     without shadow and requires an identical event log.
   - In bot mode with `AI_BOT_ESCALATION=uncertain`, active Jev answers the bot's close calls, and
     `AI_JEV_FALLBACK=bot` keeps the bot's answer when Jev cannot.
2. **Agreement records.** Whenever Jev answers beside another answerer (shadow, or a fallthrough
   that another answerer settled), a `JevComparison` records the played answer, who played it,
   whether the bot called it close, Jev's answer, its confidence and margin, and whether they
   agree (same action and same targets). `AiCallLogger.capturedJevComparisons()` holds them.
3. **Target expansion** (`AI_JEV_EXPAND_TARGETS`, default on). A targeted action with exactly one
   undecided slot is offered once per legal object, with the object's public name and controller.
   The choice maps back to a complete response, which still passes `validateResponse` and the
   engine. Two undecided slots, or an undecided slot that could repeat a forced slot's object
   (which may need distinct targets), still bypass Jev, as does exceeding `AI_JEV_MAX_ACTIONS`.
   In offline games this raises the share of non-local decisions Jev can answer from 69% to 83%
   in model mode, and from 77% to 100% of the bot's close calls.
4. **Optional scores.** A missing `confidence` falls back to the chosen option's probability; a
   missing distribution leaves confidence and margin unknown. Unknown never passes a nonzero
   threshold, so authoritative Jev with thresholds still fails closed. Probabilities may cover
   only some options, but every key must be a real option and the choice must be the top one.
5. **`bun run jev-duel`.** Four seats, each a preset: `bot`, `bot-shadow`, `bot-jev`, `model`,
   `jev` (Jev with the bot as fallback) and `jev-model`. The lineup rotates a seat per game. One
   spend cap covers chat and Jev calls. `--offline` plays the same games with no network: the
   chat tactician is the bot and Jev is a deterministic stub, which checks the wiring and counts
   calls for free. `--out` writes the report, Jev traces and comparisons.

The default configuration is unchanged: Jev stays off, and the registry entry stays `unmeasured`.

## Consequences

- Paid evidence can be collected cheaply from bot-led games. In an offline two-game run at a
  30-turn cap, a `bot-shadow` seat asked Jev about 0.7 times per game turn and a `bot-jev` seat
  about 0.25 times. At the earlier estimate of about $0.00006 per Jev call, that is well under a
  cent per game.
- Agreement with the bot is not quality. It tells us where Jev and the bot differ; the games
  where Jev decides (`bot-jev`, `jev`) are what show whether the difference wins.
- Target expansion lets Jev pick removal targets, which is new judgement for it. The duel and
  comparison records should be read for target choices before any default changes.
