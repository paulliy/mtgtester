# Batch card compiler

Turns the rules lines our Oracle-text parser cannot read into card IR, using a cheap model, and checks
the result automatically. The output is data (a `Partial<CardDefinition>` patch merged like an
`extendCard` override), never code, so the engine's validator can reject anything malformed and the
model cannot invent primitives.

## Pipeline

1. **Select** (`select.ts`): unmodeled cards from the pinned EDHREC pool whose only blockers are
   unparsed rules lines, spread across rank.
2. **Compile** (`prompts.ts`, compile stage): the model gets a fixed prefix (rules plus the IR schema,
   extracted from the engine's own type declarations by `schema.ts`) and a per-card suffix (the card,
   what the parser already produced, and the six most similar modeled cards with their IR from
   `examples.ts`). It answers with a patch, or `inexpressible` when the schema cannot say the line
   exactly.
3. **Validate** (`lib.ts` `applyPatch`): the patch is registered as an override, the card is
   interpreted, and `validateCardDefinition` runs on the merged definition. Rejections go back to the
   model with the validator's messages, up to three rounds (round 2 and later use the stronger retry
   model when run through the API).
4. **Smoke** (`lib.ts` `smokeTest`): a generated four-player game with the card in hand and, for
   permanents, on the battlefield, played through combat, end step and the next turn. Player 1 uses
   every action the card offers; other decisions are seeded random. It passes when the engine never
   halts, throws or breaks a strict invariant within 600 decisions; reaching the cap is a failure,
   since that is what a looping card looks like. It records whether the card's own abilities or
   spell resolved, and the queue shows that as `smokeExercised`. A card with `smokeExercised: false`
   only showed that it does not crash the engine.
5. **Text check** (`render.ts`, free): a deterministic renderer turns the patch back into English
   and compares it with the Oracle lines after normalizing wording. A match settles the meaning
   check with no model call. Anything it cannot render, or renders differently, goes on to 6 and 7.
   It settles 45 of the 129 committed trial patches (35%; it was 10 before the November 2026
   widening), and both patches the trial 01 audit found wrong still fall through to the model.
   `bun run scripts/card-compiler/settle.ts` lists what settles and why the rest do not;
   `bun run scripts/card-compiler/render.ts --mismatches` reports coverage on modeled pool cards.
   Where Oracle words one IR several ways ("gain 1 life for each Elf", "gain X life, where X is
   the number of Elves"), the renderer writes all of them as an alternative group and a printed
   line may match any; each wording must mean exactly the IR.

   **Soundness guard.** A wrong patch that settles would reach review marked as checked, so
   `packages/server/src/hill-climb/text-check.test.ts` checks two things. Every settled trial
   patch must have a hand audit entry in `settle-audit.json` saying it is correct, so a renderer
   change that settles a new patch fails until someone audits it. And every single-step mutant of
   a settled patch or a matching pool card (`settle-mutants.ts`: numbers, flags, enum swaps,
   dropped or reordered list items, deleted keys, and keys added from other nodes of the same
   shape) that still validates and means something else must fail to settle. When that test names
   a survivor, either the renderer ignores a field (make it read the field, or refuse the node)
   or the two definitions really are equivalent (add the rule to `canonicalDefinition`, with the
   engine fact that makes it true).

6. **Back-translate**: a second call sees only the patch (descriptions removed, card name hidden) and
   writes the rules text it implements.
7. **Judge**: a third call compares the real lines with the back-translation and lists any difference
   that would change a game. It never sees the IR.

A card that passes 3 to 7 is `compiled-checked`. The checks take a patch from any source, so a patch
translated from another engine goes through the same gate (`run.ts import`).

**Compiled cards are not playable.** `compiled-checked` means "ready for review", not "in the
game". Nothing here registers a patch with the engine; every checked card goes to the review queue
(`docs/reviews/compiled-card-queue.json`) and enters the card pool only after a person (or the main
thread, under the card coverage workflow) reviews it.

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

Accepted patches are written to `<trial>/patches/`. Nothing here registers them with the engine.

Without an API key, Haiku and Sonnet worker agents answer the prompt files instead of `exec`; cost
is then estimated from text size in `report`.

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
