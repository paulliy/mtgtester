# PR09: library access and casting during resolution

Branch: `cards/pr09-library-casting`. Draft: [PR #27](https://github.com/paulliy/mtgtester/pull/27).
The base remains PR08, `cards/pr08-control-choices` at
`b098dd4c8c9593babb055785f9cc48aceb91b76c` ([PR #26](https://github.com/paulliy/mtgtester/pull/26)).
Retarget to `main` after PR08 lands and regenerate evidence if the tested sources change.

## Current implementation

All 31 assigned cards now have authored implementations. Their exact definitions, including
Etali's back face, are pinned in
[coverage-pr09-oracle.json](../../packages/engine/tests/fixtures/coverage-pr09-oracle.json).
The verification manifest retains `implemented-unreviewed` until the final implementation review,
primitive contracts, engine results and real browser traces are complete. Authored support is
31/31; completed to the canonical evidence standard is not yet claimed.

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
- Etali's transform payment, sorcery timing, indestructible back face, and combat poison trigger
  have separate engine cases. The poison trigger accompanies ordinary damage; it is not infect.

## Validation and remaining work

A focused integration run passed 601 cases across 20 engine modules, including the 31-card
normal-cast/cost/timing boundary suite and existing casting/payment contracts. The subsequent
historical-containment reconciliation passed 46 cases across five modules. Eight additional audit
edge cases pass, including Forge spell faces, Dark Confidant, Etali's back face, flying/trample,
and Songbirds' legal Aura placement. These observations precede final source capture.

The shared library-look foundation has 13 focused cases for suspension, privacy, reveal, eligibility,
real zone changes, short/empty libraries, and seeded bottom ordering. Card-specific tests cover
all assigned cards. Independent bounded primitive compositions and their executable receipts are
being completed separately; production-card tests do not substitute for these contracts.

The Card Test Lab now has prepared batches for all 31 cards. Their server tests drive real engine
interactions and assert state/events. Real frontend/backend Playwright suites are being run and
repaired. A scenario that only loads, a collected browser test, or an old trace is not completion.
Each printed clause must retain current positive/negative engine and viewer mappings in the
verification manifest, including the back-face clauses and separate activated abilities.

Before marking the draft ready: finish every declared viewer case; complete independent primitive
scope; run production/test typechecks, lint, formatting, definition snapshots, card gate, full suite
and web build; refresh inventory and compatibility fixtures where required; commit the tested tree;
generate fresh primitive and PR09 verification receipts; push and inspect hosted checks/reviews.

Reports, browser traces and scratch files stay under ignored `.tmp/` paths. No gameplay-AI strategy
assessment with a live provider has been performed. Lab opponents make scripted legal decisions;
that is separate from rules and viewer correctness.
