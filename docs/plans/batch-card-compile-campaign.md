# Plan: batch-compiling the remaining EDHREC cards with Haiku workers

Status: in progress (2026-11-15). Baseline: `fae4d11`. Stage 0 steps 1 to 6 are built and
measured (see [Stage 0 status](#stage-0-status)). Ten chunks are done:
[001](../reviews/card-compiler-trial-chunk-001/README.md),
[002](../reviews/card-compiler-trial-chunk-002/README.md),
[003](../reviews/card-compiler-trial-chunk-003/README.md),
[004](../reviews/card-compiler-trial-chunk-004/README.md),
[005](../reviews/card-compiler-trial-chunk-005/README.md),
[006](../reviews/card-compiler-trial-chunk-006/README.md),
[007](../reviews/card-compiler-trial-chunk-007/README.md),
[008](../reviews/card-compiler-trial-chunk-008/README.md),
[009](../reviews/card-compiler-trial-chunk-009/README.md) and
[010](../reviews/card-compiler-trial-chunk-010/README.md). With four cards retired after review or
fuzzing, 790 are promoted and the pool models 4,508 of 8,972. The audits found 20 wrong patches
among the 754 that every automatic check passed (about 2.7%), so the audit stays at every card (decided
2026-11-14): the ADR 0047 rule that lets audits drop to a sample is suspended until validator
rules close the engine gaps behind those escapes. Chunk 004 tripped the calibration stop rule
twice on one case, Urza's Power Plant; the owner decided to drop that case, since it tests Magic
knowledge the judge is not given (chunk 004's README). Chunk 006 tripped it again; the owner chose to fix the judge prompt (it now carries the reminder text of the lines under test), and the one case still missed after that, Voldaren Estate, was dropped (chunk 006's README). Still to do: chunks 011 onward, a time limit for the smoke games (chunk 008's README), Stage 0
step 7 (optional), and the validator rules for the engine findings in the chunk READMEs.

Scope: the 5,254 cards in the pinned EDHREC pool that do not model today. The plan runs them
through the existing [batch card compiler](../../scripts/card-compiler/README.md) in chunks of 300,
with Haiku subagents answering the compile, back-translation and judge prompts, and lands the cards
that pass every check as data overrides.

Related: [EDHREC coverage modelling](edhrec-coverage-modelling.md) (this plan is its Phase 6 done by
batch), [card coverage workflow](../guides/card-coverage-workflow.md), trial reports
[01](../reviews/card-compiler-trial-01/README.md) and
[02](../reviews/card-compiler-trial-02/README.md), the
[XMage pilot](../reviews/xmage-pilot-01/README.md), ADR
[0033](../decisions/0033-forge-informed-card-authoring.md),
[0034](../decisions/0034-fail-loud-execution-and-strict-tests.md),
[0036](../decisions/0036-ci-minutes-budget.md) and
[0038](../decisions/0038-phrase-level-card-grammar.md).

## Summary

- **The batch system exists and has been measured.** Two trials took 350 cards through it. What it
  lacks is everything after the review queue: 208 patches are queued, none is reviewed, and no
  command registers a patch with the engine.
- **Haiku alone will not finish the pool.** At the trial 02 rates, the compiler produces a checked
  patch for 28% of cards and a flagged one for 8%. It declines 64% because the IR cannot say the
  line. Over the 4,758 cards no trial has seen, that is about 1,350 checked cards and 370 flagged
  ones. The other 3,100 need engine features first, and those are a long tail.
- **So the plan has two tracks.** Track A is the Haiku batch loop, which lands what the IR can
  already say. Track B turns the refusals into a ranked primitive backlog that the main thread and
  Sonnet work under the full completion standard, then sends the unblocked cards back through
  Track A.
- **Stage 0 comes first.** Seven improvements close the gaps the trials found, and the campaign
  does not start until they pass on cards whose answers are already known.
- **The main regression guard is separation.** A promotion pull request contains only generated
  data and may only add cards. Engine, grammar and validator changes go in their own pull requests
  between chunks.

## Where things stand

Measured at the baseline with `interpretCard` over
`packages/server/fixtures/edhrec-pinned-oracle.json`:

| Pinned EDHREC pool                          | Cards |
| ------------------------------------------- | ----: |
| Pinned                                      | 8,972 |
| Modeled (the `edhrec-modeled.json` ratchet) | 3,718 |
| Unmodeled                                   | 5,254 |
| Of those: one unparsed line, normal layout  | 5,176 |
| Of those: adventure, modal DFC, transform   |    77 |
| Already through a trial (see the ledger)    |   419 |
| Not yet seen by any trial                   | 4,758 |

Every unmodeled pinned card is blocked by exactly one line, because that is how the pool was
chosen. By rank, the one-line normal-layout cards are 539 in ranks 1 to 2,000, 813 in 2,001 to
4,000, 1,685 in 4,001 to 8,000 and 2,139 past 8,000.

The wider Scryfall bank is out of scope. Its baseline (`bulk-population.json`) is 35,460 cards with
7,987 modeled, and most of the rest have several unparsed lines. They need the bank to pin, and the
bank is not in a cloud container. `select.ts --max-lines` already supports them once this campaign
has proved the loop.

### What the existing system does

| Piece                                                    | What it gives the campaign                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `scripts/card-compiler/` (`select`, `prepare`, `check`…) | Prompts and answers as files, so a subagent can answer them; resumable by design  |
| `applyPatch` and `validateCardDefinition`                | A patch is data merged like an override; the model cannot invent a primitive      |
| Generated smoke game                                     | Four-player game under strict invariants; catches crashes and loops               |
| Renderer, back-translation, judge                        | Three meaning checks; the back-translator never sees Oracle text, the judge no IR |
| `run.ts queue --cross`                                   | Compares a patch with an independent one (XMage) for the same card                |
| `handledLines` drift guard                               | A patch whose line changes or becomes parsed turns the card unmodeled, loudly     |
| `coverage:pin --check`                                   | Fails offline when a modeled pinned card stops modeling                           |
| `snapshots:check` (4 seconds locally)                    | Definitions of 1,031 pinned cards, 866 overrides and 5,917 corpus line outcomes   |
| Card gate, ratchets, IR mutation, fuzz, weekly bulk run  | The pull-request and weekly nets every card change already passes                 |

### Gaps the trials found

1. **No promotion path.** `compiled-checked` means "ready for review". Nothing reads the queue.
2. **Smoke proves little.** In 61 of 100 checked cards the card's own ability never resolved.
3. **The validator has holes.** Viridian Joiner's mana ability passed validation and threw in play.
4. **The free text check settles 4 of 109 patches**, so nearly every card costs two model calls.
5. **Nothing measures the judge.** A worker that waves everything through looks like a good chunk.
6. **The modeled ratchet records names, not behavior.** The definition snapshot covers 1,031 of the
   8,972 pinned cards. A parser change can alter a modeled card's definition without failing
   anything.
7. **Worker agents are not defined.** `CLAUDE.md` names `explorer`, `implementer` and `reviewer`,
   but the repository has no `.claude/agents/` directory, and trial 02's batch lists were made by
   hand.

## Decisions

Decided 2026-11-13: the owner asked for best judgement, so each recommendation below stands. The
first changes what "modeled" promises and is recorded as
[ADR 0047](../decisions/0047-compiled-cards-as-unreviewed-overrides.md).

- **D1. What bar makes a compiled card playable?** Today the compiler README says a person or the
  main thread reviews each card, override rule 3 asks for a behavioral test per override, and the
  coverage plan gives a bespoke override the full completion standard. At the pilot's 25 minutes a
  card, 1,700 cards is about 700 agent-hours, which is not a batch.
  **Recommended:** a compiled card enters the pool as `implemented-unreviewed`, the same state
  the coverage plan's D1 gives a card the interpreter models from tested productions. It gets
  there only by passing every automatic check in the ladder below plus the main-thread audit rule
  in D2. It is never reported as reviewed, and the manifest shows its source as compiled.
- **D2. How much does the main thread audit?** **Recommended:** every card in the first two
  chunks; after that every card ranked 1 to 2,000 (11% of the cards, 45% of the deck slots) and a
  random 20 from the rest of each chunk. One wrong patch in a sample means the whole chunk is
  audited.
- **D3. What happens to `meaning-differs` cards?** Most flags in both trials were false alarms.
  **Recommended:** a Sonnet `reviewer` checks each against a written checklist and recommends
  accept, recompile or reject, and the main thread decides. No flagged card is promoted on the
  reviewer's word alone.
- **D4. Executor.** **Recommended:** Haiku subagents answering prompt files, as asked. The
  `run.ts exec` API and CLI paths stay interchangeable, because the pipeline only reads answer
  files.
- **D5. Order.** **Recommended:** rank order, so the most-played cards land first and the audit
  effort goes where the deck slots are.

## Stage 0 status

Built on 2026-11-13, each with tests:

| Step | Result                                                                                                                                                                                                                                                                                                                                      |
| ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `edhrec-modeled.json` holds a definition fingerprint for each of the 3,718 modeled cards. `coverage:pin --check` fails on a changed one, and `coverage:pin --dump` shows the change.                                                                                                                                                        |
|    2 | `run.ts review`, `promote`, `retire` and `verify`. Promoting and retiring six audited trial 01 patches left the tree as it was, and the generated module typechecks against `CardDefinition`. `fuzz` reads a promoted card from its EDHREC pin.                                                                                             |
|    3 | `calibration.json`: 28 audited-correct patches, the 2 known-wrong ones and 25 broken variants. In [calibration run 01](../reviews/card-compiler-trial-calibration-01/README.md) Haiku workers caught all 27 wrong cases and passed the 3 correct ones. `prepare` adds ten cases to every trial and `queue` refuses a trial that misses one. |
|    4 | Smoke compares each game with the same card minus its patched lines, on two added busy boards. 177 of the 207 valid queued patches are exercised (86%), up from 72 of 208 under a looser rule, and every game still passes.                                                                                                                 |
|    5 | The validator rejects a mana amount a mana ability cannot evaluate. Viridian Joiner's patch is now `invalid`. The wider sweep of every value and condition kind against every ability context is not done.                                                                                                                                  |
|    6 | `.claude/agents/` defines the two compiler workers and `explorer`, `implementer`, `reviewer`. `run.ts batches` and `ledger`, and `select.ts --order rank --exclude-ledger`.                                                                                                                                                                 |
|    7 | Not started.                                                                                                                                                                                                                                                                                                                                |

Found on the way and fixed: the old smoke rule credited abilities from lines the interpreter had
already read; the back-translator was shown long schema names as hidden text, a cause of false
alarms; and the free text check threw on an ability with no effects.

Not done yet:

- The two pilot chunks with a full main-thread audit, which gate sampling under D2.
- The value-and-condition sweep in step 5.
- Step 7, renderer coverage.
- The 208 queued patches have no review verdicts, so none is promoted.
- CI has not run on this branch: every recent run in the repository fails before its first step
  (see the pull request). The checks listed there were run locally.

## Stage 0: improvements before the campaign

Each step is its own pull request with tests, in this order. Steps 1 to 3 are the safeguards and
cannot be skipped. The main thread designs each; Sonnet implements from the written design.

1. **Behavior fingerprints in the modeled ratchet.** Record a hash of each modeled pinned card's
   canonical behavior beside its name (`canonicalBehavior` in `run.ts` already ignores descriptions
   and list order). `coverage:pin --check` then fails when any modeled card's behavior changes, not
   only when it stops modeling. Re-recording prints the per-card diff.
   Exit: a deliberately changed production fails the check and names the affected cards.
2. **The promotion path.** `run.ts promote <batch>` writes the accepted queue entries as a batch
   into one generated TypeScript data module, `packages/engine/src/cards/overrides/compiled/index.ts`,
   registered from `overrides/index.ts`. A `.ts` module keeps the engine free of I/O and inside the
   benchmark source hash, and one module rather than one per chunk keeps a promotion from touching
   the evidence generators' source lists. Each entry carries its source, trial and patch SHA-256. The command
   refuses a card that has an authored override, a card the interpreter now models alone, and a
   patch whose bytes differ from the reviewed ones. `run.ts retire <name>` removes one card, and
   reports whether the interpreter's own reading now matches the patch when a grammar change
   strands it. `promote --verify` is the additive-only check in the ladder below. `fuzz --changed`
   reads changed cards from the pin store today, so it also learns to read a promoted card from the
   EDHREC pins.
   Exit: promoting and then retiring the trial 01 audited patches leaves the tree byte-identical.
3. **A judge that is itself tested.** Build a calibration set of patches with known answers: the 28
   hand-audited correct patches, the two known-wrong ones (Charmbreaker Devils, Thran Turbine) and
   about 30 wrong variants made from correct patches with the IR mutation operators
   (`scripts/mutate-cards.ts`): a dropped "you may", a loosened target filter, a changed duration.
   Every chunk's back-translation and judge batches carry 10 of them, unmarked.
   Exit: on the 208 queued patches plus the set, the meaning check flags every known-wrong patch.
4. **Directed smoke.** Derive the stimulus from the patch: a trigger's event picks the scripted
   setup (a death, an attack, a cast, a step), an activated ability is given its cost and
   activated, and a static is checked by comparing computed characteristics with and without the
   patch. Promotion requires `smokeExercised: true`.
   Exit: at least 85% of the 208 queued patches are exercised, up from 35%, and both known-wrong
   patches still pass smoke (it is a crash net, not a meaning check).
5. **Validator gaps.** Reject a value a mana ability cannot read (Viridian Joiner) and sweep every
   `Value` and `Condition` kind against each ability context for the same class of hole. From then
   on a smoke failure on a validated patch is a validator bug, fixed with a regression test before
   the next chunk.
6. **Worker definitions and batch tooling.** Add `.claude/agents/`:
   - `card-compile-worker` (Haiku): reads the prompt files on its list and writes one answer file
     for each. No Bash, no Edit, no project instructions.
   - `card-judge-worker` (Haiku): the same shape for back-translation and judge batches.
   - `explorer`, `implementer` and `reviewer`, which `CLAUDE.md` already names.

   Add `run.ts batches <trial> <stage> --size 25` for the lists trial 02 made by hand, and
   `run.ts ledger`, which derives one row per card from the trial directories. Extend `select.ts`
   with `--order rank --exclude-ledger`. Update `CLAUDE.md`: Haiku may answer compiler prompt
   files, which is data and not code.

7. **Renderer coverage** (saves calls, not a safeguard). Extend `render.ts` to static effects,
   token specs, conditions and loyalty abilities, measured with `render.ts --mismatches`.

Stage 0 exit: the pipeline reruns the 208 queued patches with every new check, and two pilot
chunks (600 cards, rank order) go through the full loop with a main-thread audit of every checked
card. Sampling under D2 starts only if that audit finds at most one wrong card among those the
checks passed. Otherwise the miss becomes a calibration case, the check is fixed, and the pilot
repeats on the next 300.

## Track A: the chunk loop

One chunk is 300 cards, one trial directory and one pull request. The 4,758 unseen cards are 16
chunks; cards that Track B unblocks come back as later chunks.

| Step | Who                | What                                                                                                            |
| ---: | ------------------ | --------------------------------------------------------------------------------------------------------------- |
|    1 | Main thread        | Clean tree on current main; `snapshots:check` and the card gate green; `select` the next 300 by rank; `prepare` |
|    2 | Haiku, 12 workers  | Compile, 25 prompt files each, at most four at a time                                                           |
|    3 | Script             | `check`: validator, then directed smoke                                                                         |
|    4 | Sonnet, 1 worker   | Retry round for patches the validator rejected, with its messages                                               |
|    5 | Script, then Haiku | Renderer text check; back-translation and judge for the rest, with the calibration patches mixed in             |
|    6 | Script             | `check` and `report`: outcomes, calibration result, rates beside the trailing average                           |
|    7 | Sonnet `reviewer`  | Checklist review of each `meaning-differs` card (D3)                                                            |
|    8 | Main thread        | Audit under D2; verdicts recorded in the queue with the patch SHA                                               |
|    9 | Script             | `promote`, regenerate snapshots, ratchet, modelled-cards list and benchmark seal; `promote --verify`            |
|   10 | Main thread        | Local ladder, pull request, `ci:engine` and `ci:fuzz` labels, merge                                             |
|   11 | Sonnet, 1 worker   | Group the chunk's refusals by missing feature into the Track B backlog                                          |

Worker rules:

- One stage per worker, and a worker is never continued into another stage. A judge that has seen
  the IR, or a back-translator that has seen the Oracle text, is not independent.
- A worker's output is only its answer files. `check` warns about any other file, and anything
  that is not valid JSON or text for the stage stays pending and is asked again.
- Only patches the main thread has audited become worked examples for later compiles
  (`examples.ts`), so one wrong patch cannot teach the next chunk its mistake.

### Running for a long time

- **State is files.** Commit and push the trial directory after each of steps 2, 3, 5, 6 and 8. A
  reclaimed container then loses one stage at most, and `exec` and `check` already skip what is
  answered.
- **Resuming.** A new session reads `run.ts ledger`, finds the first chunk that is not merged, and
  continues from its last committed stage.
- **Repository growth.** Trial 02 is 3.2 MB for 300 cards. Sixteen chunks would add about 50 MB
  of prompts and answers, so the campaign commits patches, results and state, and keeps raw
  answers only for the pilot chunks and for any chunk that trips a stop rule.
- **Pace.** A chunk is about 23 subagent runs. One chunk per session is the unit, and Track B
  work fits between chunks without blocking them.

## Safeguards

### The ladder a card climbs

| Level | Check                                                                                                      | Catches                                          |
| ----: | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
|     0 | Validator; identity fields banned; `handledLines` byte-exact                                               | Invented primitives, bad references, errata      |
|     1 | Directed smoke under strict invariants, ability exercised                                                  | Crashes, loops, executor paths validation missed |
|     2 | Renderer match, or back-translation and judge by separate workers                                          | A patch that means something else                |
|     3 | Agreement with an XMage patch where one exists (`queue --cross`); every op used has a primitive contract   | Shared misreadings; untested primitives          |
|     4 | Main-thread audit (D2)                                                                                     | What the automatic checks miss                   |
|     5 | Pull request: additive-only diff, `snapshots:check`, fingerprints, no new facet mismatch, card gate, suite | Any effect on a card outside the chunk           |
|     6 | Fuzz pods holding each promoted card at least twice (`fuzz --changed`)                                     | Interactions in real games                       |
|     7 | Weekly bulk smoke, fuzz and full Card Test Lab (existing)                                                  | Slow drift                                       |

### Additive-only promotion

`promote --verify` fails the pull request unless all of these hold:

- the only engine source file changed is the generated module;
- the override snapshot, the fingerprints and the modeled ratchet gain entries for exactly the
  promoted names and change no existing entry;
- the interpretation snapshots and the one-line corpus outcomes are unchanged.

A promotion therefore cannot change how any existing card behaves. A grammar, validator or engine
change is a separate pull request, checked by the fingerprints from Stage 0 step 1.

### Stop rules

The loop halts and the main thread investigates when any of these happens:

- the meaning check misses a known-wrong calibration patch (the chunk's verdicts are void and it
  is rejudged by fresh workers; a second miss stops the campaign);
- an audit sample finds a wrong patch (audit the whole chunk; two chunks in a row return the
  campaign to auditing every card);
- the checked, flagged or declined rate moves more than 10 points from the trailing average;
- more than 5% of a chunk is still invalid after three rounds;
- smoke fails on a validated patch (a validator bug);
- any check at level 5 reports a card outside the chunk.

### When a promoted card turns out wrong

1. `run.ts retire` it first. The card goes back to unmodeled and the engine halts loudly on it,
   which is the project's rule over playing it wrong.
2. Add the wrong patch to the calibration set.
3. Use the ledger to list every promoted card with the same op or shape, and audit those.
4. A whole chunk is one batch in the generated module, so reverting its pull request removes it
   cleanly.

### When grammar work strands a compiled card

A new production that parses a line a compiled patch claims turns that card unmodeled through the
drift guard, and the ratchet fails. `run.ts retire` removes the patch and compares the two
readings. If they agree, the interpreter takes over. If they differ, one of them is wrong and the
main thread decides which before the grammar change merges.

## Track B: the refusal backlog

A refusal names the missing piece in one sentence, so each chunk also ranks what to build. In trial
02, 17 feature groups of four or more cards held 120 of the 191 refusals, and no single feature
held more than seven: characteristic-setting effects with durations, new trigger events, dynamic
mana-value comparisons, turn-history conditions, per-player scope, alternative-cost keywords, and
so on down the trial's table.

- After every third chunk, regroup all refusals so far and rank the groups by cards and deck slots.
- The main thread picks and designs the top features. Each is a feature under the coverage plan's
  D1, so it brings executor tests, a primitive contract and the full standard for its first card.
  Sonnet implements from the written design.
- Each feature lands in its own pull request, guarded by the fingerprints.
- `select --requeue <group>` sends the cards that feature blocked back through Track A.

Expect each top feature to unlock 70 to 120 cards across the pool. The 77 cards with other layouts
and the one-off mechanics stay with the hand workflow.

## Roles

| Role                 | Work                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Main thread          | Stage 0 designs, every rules judgement, the D2 audits, flagged-card decisions, promotion, Track B picks |
| Sonnet `implementer` | Stage 0 code from written designs, validator retries, Track B features, refusal grouping                |
| Sonnet `reviewer`    | Checklist review of flagged cards and of each promotion diff                                            |
| Haiku workers        | Compile, back-translation and judge answers, as data files only                                         |
| Haiku `explorer`     | Reading test and fuzz output into the scratchpad, locating a refusal's gap in the engine source         |

No subagent edits `packages/engine` except a Sonnet `implementer` working from a main-thread
design, and no Haiku worker edits the repository at all.

## Expected yield

Estimates from the trial 02 rates, to be replaced by each chunk's measured numbers:

| Source                                           |            Cards |
| ------------------------------------------------ | ---------------: |
| The 208 patches already queued, once reviewed    |        about 170 |
| Track A over 4,758 unseen cards, checked         |      about 1,350 |
| Track A, flagged cards that survive adjudication | about 200 to 300 |
| Track B, per top feature                         |        70 to 120 |

That takes the pool from 3,718 modeled to roughly 5,400 to 5,500 of 8,972 before Track B. The
campaign's API-price cost is small (trial 02 estimated $0.37 for 300 cards); the real cost is the
main thread's audit time.

## Risks

| Risk                                               | Mitigation                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A wrong card passes every check                    | Calibration set, D2 audits, fail-closed retirement, same-shape re-audit                          |
| The judge degrades or a worker rubber-stamps       | Calibration patches in every batch; rate drift stop rule; one stage per worker                   |
| The pilot's zero-error audits were luck (25 cards) | Two fully audited pilot chunks before any sampling                                               |
| Promotion disturbs existing cards                  | Additive-only verification; promotion separated from engine changes                              |
| Grammar work silently changes modeled cards        | Behavior fingerprints (Stage 0 step 1)                                                           |
| Hundreds of stranded patches after a grammar batch | `retire` compares readings; the ratchet names each stranded card                                 |
| CI minutes (ADR 0036)                              | One pull request per chunk, labels added once after the local ladder passes                      |
| Benchmark re-seals on every chunk                  | One re-seal per promotion pull request, generated by `promote`                                   |
| The session ends mid-chunk                         | Stage-by-stage commits; the ledger names where to resume                                         |
| Refusals are a long tail and Track B stalls        | Rank by deck slots; stop Track B when a feature unlocks fewer cards than the hand workflow would |
