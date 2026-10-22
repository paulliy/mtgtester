# PR09: library access and casting during resolution

Branch: `cards/pr09-library-casting`. Draft: [PR #27](https://github.com/paulliy/mtgtester/pull/27).
PR08 ([PR #26](https://github.com/paulliy/mtgtester/pull/26)) has merged. PR09 targets `main`
and includes the current base, `89f6605f8b7dfa82d5b9c13a48b2a8adb5684c7a`.
Evidence is regenerated against the final committed tree.

## Current implementation

All 31 assigned cards now have authored implementations. Their exact definitions, including
Etali's back face, are pinned in
[coverage-pr09-oracle.json](../../packages/engine/tests/fixtures/coverage-pr09-oracle.json).
All 31 implementations have been reviewed against those pins and the independent bounded
compositions. The manifest and ledger now record `implemented-reviewed`. Generated engine,
primitive and viewer evidence remains separate from that review label; current receipts are
required for completion and merge readiness.

The implementation covers public reveal versus private look, optional Aura/Equipment placement,
real exile and mill transitions, discover, explore, cascade/rebound, paid and free casting,
Hideaway 5, recruit, Sneak, random target announcement, exact-object delayed casts, and Paradigm.
Casting continues through normal spell announcement, target selection, payment and stack resolution.
Permissions distinguish casting spells from playing lands and expire at their specified boundary.

Review fixes include:

- Forge's private top-card view and casting permission use the selected spell face's full
  characteristics, including its colors. An eligible front face cannot authorize an ineligible
  Adventure face, and an eligible Adventure is offered independently of its front face.
- Szarekh chooses only eligible cards actually milled by that resolution, with their new graveyard
  object identities. Earlier graveyard cards and replacement destinations do not qualify.
- Celebrate expands optional targets for opponents, resolves every still-legal slot, and remembers
  the actual exiled objects for return when its source leaves.
- Power Pack chooses its random target when its trigger goes on the stack. Its one-shot delayed
  permission tracks the exact exile object and replaces only a stack-to-graveyard destination.
- Paradigm keeps a frozen copy template and a permanent delayed trigger after the first same-name
  resolution for its controller. Declined copies cease at state-based actions; the original card
  can leave exile without ending the schedule.
- Grenzo's permission preserves actual mana entries and their restrictions. Colored Convoke
  remains tied to the convoking creature's colors; any-color mana spending does not turn Convoke
  into an unrestricted colored payment. A full stolen Hour of Reckoning cast tests this boundary.
- Failed Aura placement stays in the appropriate remainder: library-look cards go to the bottom,
  and Genesis cards return to hand. An Aura cannot enchant a permanent entering alongside it.
- Etali's transform payment, sorcery timing, indestructible back face, and combat poison trigger
  have separate engine cases. The poison trigger accompanies ordinary damage; it is not infect.

## Validation and final evidence

The manifest maps all 58 printed clauses to engine cases and 75 real Card Test Lab scenarios,
including Etali's back face and separate activated abilities. Binding the catalog to the manifest
reports 31 cards, 75 scenarios, no orphan scenarios and no missing clauses.

The four real frontend/backend browser batches passed 13, 18, 21 and 23 scenarios respectively.
The final receipt reruns all 75 against the same committed tree and retains their traces. Later
assertions also verify Power Pack's four visible keywords and vigilance, and the disappearance
of a declined Paradigm copy from exile. Cosmic Cube pays and declines Ward through an actual
opponent's targeted permanent. Forge's negative fixture is a genuinely red spell with no cast
permission, and Iteration's negative fixture partitions lands without treating them as spells.

Independent bounded primitive compositions passed 945 cases. A focused payment integration run
passed 126 cases across seven modules, including Grenzo/Convoke. Additional review checks cover
actual Ward payment/countering, failed Aura placement, exact exile identities, selected faces,
random targets and normal cast/activation paths. The full regression run and final source-bound
receipts are the merge gates; preliminary runs do not replace them.

Production and test typechecks and the production web build have passed. The authored-data
snapshots and card IR audit are checked separately. The mandatory offline card gate includes the
PR09 engine and server batches, and the dedicated browser suites enforce exact scenario-ID sets.
Chaos Warp is registered in the PR09 module, preserving the exact legacy authoring exemptions.

From a clean committed tree, generate the final receipts with:

```bash
bun run test:primitive-contracts --output .tmp/pr09-final-primitives
bun run card-capabilities --primitive-evidence .tmp/pr09-final-primitives --review-manifest packages/server/fixtures/card-verification-manifest.json
bun run primitive-promotions --base 89f6605f8b7dfa82d5b9c13a48b2a8adb5684c7a --primitive-evidence .tmp/pr09-final-primitives
bun run test:pr09-verification .tmp/pr09-final-verification .tmp/pr09-final-primitives
```

These commands reject stale sources, unsupported primitive scope, missing clause mappings,
missing/failed browser cases, retries and invalid traces. The pull request records the final
execution results and hosted-check status. GitHub's earlier run failed before its first job steps
and is not a code-validation result.

Reports, browser traces and scratch files stay under ignored `.tmp/` paths. No gameplay-AI strategy
assessment with a live provider has been performed. Lab opponents make scripted legal decisions;
that is separate from rules and viewer correctness.
