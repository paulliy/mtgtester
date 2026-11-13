# ADR 0047: Compiled cards enter the pool as unreviewed overrides

Status: Accepted (2026-11-13)

Date: 2026-11-13

Builds on [ADR 0004](0004-card-dsl.md) (authored overrides and the drift guard),
[ADR 0033](0033-forge-informed-card-authoring.md) and
[ADR 0034](0034-fail-loud-execution-and-strict-tests.md). Plan:
[batch card compile campaign](../plans/batch-card-compile-campaign.md).

## Context

The batch card compiler (`scripts/card-compiler/`) turns an unparsed rules line into a card IR patch
with a cheap model and checks the result. Its two trials produced 208 checked patches, and none could
be played: the compiler's README said a person or the main thread reviews each card, the override
registry's rule 3 asks for a behavioral test for every override, and the coverage plan gives a
bespoke override the full completion standard. The authoring pilot measured that standard at about
25 minutes a card. The compiler is expected to produce about 1,700 valid patches from the pinned
EDHREC pool, which is about 700 agent-hours at that rate.

The coverage plan's decision D1 already lets a card in without tests of its own when it only
composes grammar and primitives that are under test: it is pinned, snapshotted and
`implemented-unreviewed`. A compiled patch is the same kind of thing reached another way. It is data
in the IR, so it can only compose existing primitives, and the validator rejects anything else.
What it lacks is a tested grammar production standing behind it: its meaning rests on the checks
that were run on that one patch.

## Decision

1. **A compiled card may enter the card pool as `implemented-unreviewed`.** It is registered as an
   `'append'` override from the generated module
   `packages/engine/src/cards/overrides/compiled/index.ts`, with its batch, source, trial and
   reviewed patch hash. It is one module, not one per batch, because the viewer-evidence
   generators list every engine source they depend on.
   It is never reported as reviewed or as meeting the completion standard, and nothing in this ADR
   changes what `implemented-reviewed` requires.
2. **It gets there only through `run.ts promote`**, which takes a patch only when all of these
   hold:
   - the validator accepts the merged definition against the engine as it is now;
   - the generated smoke games all pass, and in at least one the patch visibly changed the game
     against the same card without its patched lines;
   - the meaning check passed (the free text check, or back-translation and judge by separate
     workers), in a trial whose calibration cases caught every known-wrong patch;
   - the queue entry is accepted, by the audit in decision 3, for the exact patch bytes promoted;
   - no authored override and no other accepted patch claims the card, and the interpreter does
     not already model it.
3. **The main thread audits by rule, not every card.** Every card of the first two campaign
   chunks is audited against Oracle text. After that, every card ranked 1 to 2,000 and a random 20
   of the rest of each chunk. One wrong patch in a sample means the whole chunk is audited, and
   two such chunks in a row return the campaign to auditing every card.
4. **A patch the meaning check flagged is never promoted on a subagent's word.** A Sonnet
   `reviewer` recommends, and the main thread accepts or rejects.
5. **A promotion changes nothing but the promoted cards.** `run.ts verify` fails a promotion that
   changes engine source outside the generated module, any existing snapshot entry or definition
   fingerprint, or the set of modeled cards beyond the promoted ones. Engine, grammar and validator
   changes go in their own pull requests.
6. **A wrong compiled card is retired first.** `run.ts retire` returns it to unmodeled, where the
   engine halts on it, before anything else is done. The wrong patch joins the calibration set, and
   every promoted card with the same op or shape is audited.
7. **Override rule 3 does not apply to a compiled card.** It has no behavioral test of its own.
   The checks in decision 2 and the audit in decision 3 stand in for it, and the registry comment
   says so.

## Consequences

- "Modeled" now covers three kinds of unreviewed card: read by the grammar, authored by hand
  without review, and compiled. The first has tested productions behind it and the third has
  per-patch checks; neither has clause-level tests of its own. Reports that count modeled cards
  should say how many are compiled (`compiledCards()` lists them).
- A wrong card can still pass. The trials' audits found the checks caught both wrong patches among
  20, and found no wrong patch among the 25 checked patches audited. That is a small sample, which
  is why the first two chunks are audited in full before sampling starts.
- A grammar change that starts parsing a line a compiled patch claims turns the card unmodeled
  through the drift guard, and the modeled ratchet fails until the patch is retired. `retire`
  reports whether the interpreter's reading matches the patch.
- The benchmark source hash covers the generated module, so each promotion re-seals the
  benchmark pins once.

## Alternatives considered

- **The full completion standard for every compiled card.** It is the safest and it is not a batch:
  about 700 agent-hours, most of it on cards past rank 4,000.
- **Promote on the automatic checks alone.** The meaning check is two cheap model calls. Without
  the calibration cases and the audits, a worker that approves everything is indistinguishable
  from a good chunk.
- **Keep compiled cards out of the engine and load them only in a separate mode.** It would keep
  the modeled set pure, and it would mean two card pools to test, with the compiled one never
  played by the fuzz and league runs that find interaction bugs.
