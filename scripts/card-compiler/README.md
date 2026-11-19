# Batch card compiler

Turns the rules lines our Oracle-text parser cannot read into card IR, using a cheap model, and checks
the result automatically. The output is data (a `Partial<CardDefinition>` patch merged like an
`extendCard` override), never code, so the engine's validator can reject anything malformed and the
model cannot invent primitives.

## Pipeline

1. **Select** (`select.ts`): unmodeled cards from the pinned EDHREC pool whose only blockers are
   unparsed rules lines, spread across rank.

   **Screen** (`packages/server/src/cards/compiler-screen.ts`, free): `prepare` declines a card
   with no model call when one of its lines names a primitive the IR is known to lack, and records
   it as `screened` with the rule and reason. A rule is a Comprehensive Rules keyword the engine
   does not implement (701 actions, 702 abilities) or a hand-written phrase (`PHRASE_RULES`). It
   screens only once a past compile refusal confirmed it (a refused line matches it and the
   model's reason names it), and it retires itself as soon as a modeled card or any validated
   patch uses the wording. Screened cards are not refusal evidence, so a rule can never confirm
   itself. On trial 02 it declines 31 of the 191 refused cards and none of the 109 that compiled;
   judged leave-one-out (each card by a screen built without it) it declines 11 and still loses
   none. `prepare --no-screen` turns it off. Every rule that has screened is listed in
   `packages/server/fixtures/compiler-screen-history.json` (a test fails until a new one is added;
   never remove one). When a listed rule retires, the replay counts its refusals as settled
   rather than caught, so the catch metric and floors hold when the engine gains a primitive.

2. **Compile** (`prompts.ts`, compile stage): the model gets a fixed prefix (rules plus the IR schema,
   extracted from the engine's own type declarations by `schema.ts`) and a per-card suffix (the card,
   what the parser already produced, and the six most similar modeled cards with their IR from
   `examples.ts`). It answers with a patch, or `inexpressible` when the schema cannot say the line
   exactly.
3. **Validate** (`lib.ts` `applyPatch`): the patch is registered as an override, the card is
   interpreted, and `validateCardDefinition` runs on the merged definition. Rejections go back to the
   model with the validator's messages, up to three rounds (round 2 and later use the stronger retry
   model when run through the API).
4. **Smoke** (`lib.ts` `smokeTest`): generated four-player games, played through combat, the end
   step and the next turn: the card in hand, the card on the battlefield (for permanents), and two
   busy boards where every seat plays what it can (a creature enters and one dies, spells are cast,
   life is gained, a token and a counter are made, a land is played), one of them through the
   controller's whole turn so upkeep, draw-step and end-step triggers fire. Two legendary black
   4/4s of whatever creature types the unparsed line names give tribal and "legendary" lines
   something to act on. A game passes when the engine never halts, throws or breaks a strict
   invariant within 600 decisions; reaching the cap is a failure, since that is what a looping card
   looks like.

   Each game is also played with the **baseline card**: the same card with its unparsed lines
   removed, which the interpreter models alone. The patch was **exercised** when the two games
   differ in an event, a legal action, a life total or any permanent's computed characteristics
   (`changedGame`). That is how a static, a replacement effect or a keyword shows it did something,
   and it does not credit an ability from a line the interpreter already read. A spell whose whole
   text is the patch has no baseline and counts as exercised when it resolves. The queue shows the
   result as `smokeExercised`; a patch with `smokeExercised: false` only showed that it does not
   crash the engine, and cannot be promoted. `run.ts resmoke <trial>` validates every patch again
   and replays its games after a change to the validator, the harness or the engine.

5. **Text check** (`render.ts`, free): a deterministic renderer turns the patch back into English
   and compares it with the Oracle lines after normalizing wording. A match settles the meaning
   check with no model call. Anything it cannot render, or renders differently, goes on to 6 and 7.
   On trial 01 it settled 9 of 20 valid patches, and both wrong patches fell through to the model.
   `bun run scripts/card-compiler/render.ts --mismatches` reports its coverage on modeled cards.
6. **Back-translate**: a second call sees only the patch (descriptions removed, card name hidden) and
   writes the rules text it implements.
7. **Judge**: a third call compares the real lines with the back-translation and lists any difference
   that would change a game. It never sees the IR.

A card that passes 3 to 7 is `compiled-checked`. The checks take a patch from any source, so a patch
translated from another engine goes through the same gate (`run.ts import`).

**Calibration.** Steps 6 and 7 are model calls, and a worker that calls every patch "same" would
produce a trial that looks excellent. So `prepare` mixes ten calibration cases into each trial
(`calibration.ts`, `calibration.json`): patches a person already judged, entered at step 6 under
their card's name with an ordinary prompt file. Twenty-eight are audited-correct patches, two are
the patches the trial 01 audit found wrong, and twenty-five are broken variants of the correct ones
made with the IR mutation operators. `report` scores them, and `queue` refuses a trial whose check
called a known-wrong case "same": run `recheck`, have fresh workers answer, and `check` again.
`run.ts calibrate <trial>` adds the cases to a trial that was not prepared here. The first run is in
`docs/reviews/card-compiler-trial-calibration-01`. A trial keys its cards by name, so `prepare` and
`import` refuse a real card that is already one of the trial's calibration cases, before writing
anything; put that card in a new trial.

**`compiled-checked` means "ready for review", not "in the game".** Every checked card goes to the
review queue (`docs/reviews/compiled-card-queue.json`). It enters the card pool only through
`run.ts promote`, after its queue entry is accepted (below), as an `implemented-unreviewed` card
([ADR 0047](../../docs/decisions/0047-compiled-cards-as-unreviewed-overrides.md)).

**Provisional play is opt-in** ([ADR 0050](../../docs/decisions/0050-provisional-card-tier.md),
proposed). With `--provisional`, `serve`, `play-decks` and `fuzz` admit `compiled-checked` entries
whose patch bytes still match as provisional cards: marked in the UI and log, listed on the game
result, and never used by benchmarks or fingerprints. Without the switch nothing changes.
`run.ts audit --seed S [--count 10]` samples them for review and `run.ts audit-verdict` records a verdict;
a `rejected` verdict takes the card out of provisional play.

## Running

```bash
bun run scripts/card-compiler/select.ts --out <trial> --count 50 [--xmage rows.json]
bun run scripts/card-compiler/run.ts prepare <trial>
bun run scripts/card-compiler/run.ts exec <trial> compile   # needs ANTHROPIC_API_KEY, or --executor (below)
bun run scripts/card-compiler/run.ts check <trial>          # validate, smoke, write next prompts
bun run scripts/card-compiler/run.ts exec <trial> compile   # retry rounds, if any
bun run scripts/card-compiler/run.ts exec <trial> back
bun run scripts/card-compiler/run.ts check <trial>
bun run scripts/card-compiler/run.ts exec <trial> judge
bun run scripts/card-compiler/run.ts check <trial>
bun run scripts/card-compiler/run.ts report <trial>
```

Prompts and answers are files under `<trial>/work/` (answers: `.json` for compile and judge, `.txt` for
back; `check` warns about any other file), so any executor can answer them (the `exec`
command, a batch job, or an agent). `exec` records token usage and cost per call in
`<trial>/work/usage.jsonl`. Settings: `CARD_COMPILER_MODEL` (default `claude-haiku-5-5`),
`CARD_COMPILER_RETRY_MODEL` (default `claude-sonnet-5-5`), `CARD_COMPILER_CONCURRENCY` (default 4).

Valid patches are written to `<trial>/patches/`.

Refusals feed the primitive backlog. `report` appends each `inexpressible` card that
`packages/server/fixtures/primitive-backlog-groups.json` does not list yet to its `ungrouped`
list (only for trials under `docs/reviews/`, run from the repo root) and regenerates the
backlog. Move each one into a feature group, or into `oneOff`, by hand, then run `bun run primitive-backlog` to re-rank the missing
features by deck slots (`docs/plans/primitive-backlog.md`).

### Answering with worker agents

Without an API key, Haiku worker agents answer the prompt files instead of `exec`; cost is then
estimated from text size in `report`.

```bash
bun run scripts/card-compiler/run.ts batches <trial> compile   # also back, judge; --size 25
```

writes `<trial>/work/batches/<stage>-NN.txt`, one `prompt<TAB>answer` pair per line, from the
prompts still unanswered. Give each worker one batch list and the stage's prefix file
(`<trial>/work/prompts/<stage>-prefix.md`). The workers are defined in `.claude/agents/`:
`card-compile-worker` for `compile`, `card-judge-worker` for `back` and `judge`. Use a fresh worker
for each stage and never continue one into another: a judge that has seen the card data, or a
back-translator that has seen the Oracle text, is not independent. A validator retry round goes to
a Sonnet `implementer`.

### Answering through a coding-agent CLI

`exec` can run each prompt through a coding-agent CLI on your own login instead of the API:

```bash
bun run scripts/card-compiler/run.ts exec <trial> compile --executor claude       # Claude Code: claude -p
bun run scripts/card-compiler/run.ts exec <trial> compile --executor codex        # Codex: codex exec
bun run scripts/card-compiler/run.ts exec <trial> compile --executor antigravity  # Antigravity: agy -p
```

`--executor api` (the default) is the Claude API path above; `CARD_COMPILER_EXECUTOR` sets the
default. Each prompt is one headless run, started in a fresh temporary directory so no project
instructions (CLAUDE.md, AGENTS.md) reach it. Claude Code runs with every tool off and the stage
prefix as its system prompt. Codex runs `--ephemeral` in a read-only sandbox, and Antigravity in
print mode, with the prefix placed before the card's prompt. Failures, timeouts and empty answers
leave the prompt pending, as on the API path, so `exec` can be run again.

Settings (`agent-cli.ts`): `CARD_COMPILER_MODEL` and `CARD_COMPILER_RETRY_MODEL` (Claude Code keeps
the Haiku and Sonnet defaults; Codex and Antigravity use the CLI's own default unless set),
`CARD_COMPILER_CONCURRENCY`, `CARD_COMPILER_AGENT_BIN` (the CLI's path when it is not `claude`,
`codex` or `agy` on PATH) and `CARD_COMPILER_AGENT_TIMEOUT_MS` (default 10 minutes per prompt).
Claude Code reports its cost, so those runs are priced in `usage.jsonl`. Codex and Antigravity runs
are logged unpriced, and `report` shows its size-based estimate beside them.

Keep the judge independent. Running `judge` on a different executor or model from `compile` gives a
second opinion, not the same model checking its own work.

### Patches from other sources

```bash
bun run scripts/card-compiler/run.ts import <trial> <patch-dir>   # e.g. XMage translations
bun run scripts/card-compiler/run.ts check <trial>                # validate, smoke, text check
bun run scripts/card-compiler/run.ts queue <trial> [<trial>...]   # rebuild the review queue
```

A patch file is one JSON per card: `{ name, oracleId, handledLines, compose: "append", def, source }`,
where `source` names its origin, e.g. `xmage@31ede542` or `compiler@claude-haiku-5-5`. An imported
patch that fails validation is `invalid` with no retry, since the compile prompt did not produce it.
`queue` keeps a reviewer's verdict on an entry only while the patch file's SHA-256 is unchanged.

`queue <trials...> --cross <patch-dir>` cross-checks each queued patch against an independent
patch for the same card (for example the XMage pilot's `patches/`). It records `identical` when the
two merged definitions have the same behavior, ignoring descriptions and the order inside
allOf/anyOf, and `differs` otherwise. On the first 9 overlapping cards, 8 were identical. The one
difference was Koma's token name, which the XMage adapter leaves generic.

## From the queue into the engine

```bash
bun run scripts/card-compiler/run.ts review "<name>" --verdict accepted --by <who> [--source <tag>]
bun run scripts/card-compiler/run.ts promote <batch-id> [--trial <dir>] [--dry-run]
bun run snapshots:write && bun run coverage:pin --ratchet && bun run modelled-cards
bun run ai-bench refresh --suite core-fast --write
bun run scripts/card-compiler/run.ts verify [--base <sha>]
bun run scripts/card-compiler/run.ts retire "<name>" --reason "<why>"
```

- `review` records a verdict against the exact patch bytes. `queue` drops it if the patch changes.
- `promote` (`promote.ts`) writes the accepted entries as a batch of their own into the generated
  module `packages/engine/src/cards/overrides/compiled/index.ts`, which registers them as `'append'`
  overrides with their source, trial and patch hash. It says why it leaves a card out: its checks
  failed, no smoke game exercised it, the patch changed after review, the exact patch was retired,
  its trial's calibration is unfinished or missed a case, an authored override or a second accepted
  patch claims the card, the interpreter already models it, or the patch no longer validates. The
  generated module is never edited by hand.
- `queue` refuses a trial whose calibration cases are not all answered, as it does one that missed
  a case.
- `verify` is the regression guard. It fails unless the working tree only adds the promoted cards
  to the base commit: no engine source outside the generated module, no changed entry in the
  override or interpretation snapshots, no changed definition fingerprint, and no newly modeled
  card that was not promoted. Engine, grammar and validator changes therefore go in their own
  pull requests.
- `retire` takes one card back out, so the engine halts on it again. It records the patch hash and
  the reason in `docs/reviews/compiled-card-retired.json` and turns the queue review to rejected,
  so `promote` never puts those bytes back. When a grammar change starts
  parsing a line a compiled patch claims, the drift guard turns the card unmodeled and the modeled
  ratchet fails; `retire` then reports whether the interpreter's own reading has the same behavior
  as the patch. If it differs, one of the two is wrong.

## Running a campaign in chunks

```bash
bun run scripts/card-compiler/run.ts ledger            # every card any trial has taken
bun run scripts/card-compiler/select.ts --out docs/reviews/card-compiler-trial-chunk-001 \
  --count 300 --order rank --exclude-ledger
```

`ledger` derives `docs/reviews/compiled-card-ledger.json` from the trial directories, one card per
line. `select.ts --order rank --exclude-ledger` takes the highest-ranked cards no trial has seen.
The loop, its safeguards and its stop rules are in the
[batch card compile campaign](../../docs/plans/batch-card-compile-campaign.md).
