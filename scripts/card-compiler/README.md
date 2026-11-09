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
   halts, throws or breaks a strict invariant, and records whether the card's abilities resolved.
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

**Compiled cards are not playable.** `compiled-checked` means "ready for review", not "in the
game". Nothing here registers a patch with the engine; every checked card goes to the review queue
(`docs/reviews/compiled-card-queue.json`) and enters the card pool only after a person (or the main
thread, under the card coverage workflow) reviews it.

## Running

```bash
bun run scripts/card-compiler/select.ts --out <trial> --count 50 [--xmage rows.json]
bun run scripts/card-compiler/run.ts prepare <trial>
bun run scripts/card-compiler/run.ts exec <trial> compile   # needs ANTHROPIC_API_KEY
bun run scripts/card-compiler/run.ts check <trial>          # validate, smoke, write next prompts
bun run scripts/card-compiler/run.ts exec <trial> compile   # retry rounds, if any
bun run scripts/card-compiler/run.ts exec <trial> back
bun run scripts/card-compiler/run.ts check <trial>
bun run scripts/card-compiler/run.ts exec <trial> judge
bun run scripts/card-compiler/run.ts check <trial>
bun run scripts/card-compiler/run.ts report <trial>
```

Prompts and answers are files under `<trial>/work/`, so any executor can answer them (the `exec`
command, a batch job, or an agent). `exec` records token usage and cost per call in
`<trial>/work/usage.jsonl`. Settings: `CARD_COMPILER_MODEL` (default `claude-haiku-5-5`),
`CARD_COMPILER_RETRY_MODEL` (default `claude-sonnet-5-5`), `CARD_COMPILER_CONCURRENCY` (default 4).

Accepted patches are written to `<trial>/patches/`. Nothing here registers them with the engine.

Without an API key, Haiku and Sonnet worker agents answer the prompt files instead of `exec`; cost
is then estimated from text size in `report`.

### Patches from other sources

```bash
bun run scripts/card-compiler/run.ts import <trial> <patch-dir>   # e.g. XMage translations
bun run scripts/card-compiler/run.ts check <trial>                # validate, smoke, text check
bun run scripts/card-compiler/run.ts queue <trial> [<trial>...]   # rebuild the review queue
```

A patch file is one JSON per card: `{ name, oracleId, handledLines, compose: "append", def, source }`,
where `source` names its origin, e.g. `xmage@31ede542` or `compiler@claude-haiku-5-5`. An imported
patch that fails validation is `invalid` with no retry, since the compile prompt did not produce it.
`queue` keeps a reviewer's verdict on an entry as long as the patch is unchanged.
