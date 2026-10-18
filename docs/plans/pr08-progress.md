# PR08 implementation progress

Prepared 2026-10-17. Draft PR: <https://github.com/paulliy/mtgtester/pull/26>.
Branch: `cards/pr08-control-choices`, based on `origin/main` at `af01d793`.

## Scope and status

PR08 retains the 23 cards in [the coverage chunks](card-coverage-chunks.md#pr08-control-changes-and-multiplayer-choices).
Expected combined inventory after implementation is 809/906 from 786/906. Mob Rule, Cut a Deal,
Cytoplast Manipulator, Humble Defector, Druid of Purification, Wishclaw Talisman, Reins of Power,
and Akroan Horse are the first eight implementation increments. The other 15 cards remain unsupported. The seven reopened quality-audit cards now belong
to PR12, as requested by the user.

## GitHub Actions limitation

[The initial CI run](https://github.com/paulliy/mtgtester/actions/runs/39058473513) did not start
its classification or format jobs. GitHub's check annotation states:

> The job was not started because recent account payments have failed or your spending limit
> needs to be increased. Please check the 'Billing & plans' section in your settings

The user subsequently instructed this session to ignore the Actions outage and continue using
tests on this device. Local validation is now the work gate; the unavailable GitHub checks remain
a reported limitation. No CI job, required check, or repository protection was weakened.

## Local preparation

- Frozen dependency installation, production typecheck, test typecheck, and lint passed.
- The full baseline suite exposed the existing async-provider test's 15-second timeout
  under concurrent load. The run was stopped after the billing blocker was confirmed;
  it is not a passing full-suite result. No test was changed or disabled.
- GLM 5.3 Flash/OpenCode tasks resumed after the user authorized local validation. The main
  thread reviewed and corrected the control-lifetime draft; isolated card tasks continue.
- Local scratch artifacts are retained under `.tmp/pr08/`: logs, the exact CI annotation,
  23 Oracle pins generated from the committed coverage bank, and the unfinished scaffolding
  patch. These artifacts are preparation, not completion evidence.

## Rules decisions for continuation

Control history should record effect timestamps, recipients, and permanent, end-of-turn, or
exact-source-object durations. Recompute from surviving effects, preserving the entry controller
as the fallback. A later effect giving the current controller control must still be recorded.
Only an actual controller transition changes summoning sickness or removes an object from
combat. A control effect gets a timestamp; a permanent does not get a new timestamp merely
because its controller changes (CR 613.7). Cover overlapping effects, source blink/phasing,
phased-out end-of-turn expiry, and obscured effects granted to an eliminated player.

The supplied handoff's tentative Kazuul note is incorrect: an attack on a planeswalker you
control also makes you the defending player. See the
[official Commander Masters release notes](https://media.wizards.com/2023/downloads/CMM_Release_Notes/EN_MTGCMM_ReleaseNotes_20230616.pdf).
Include that positive case and an attack on another player's planeswalker as a negative case.

Continue scaffolding and implement one card per green commit, with
each shared primitive accompanying its first card. Follow the sole
[card-completion standard](../guides/card-modeling-and-testing.md), including current engine
and real-viewer evidence. Keep the PR draft until all 23 cards, local gates, and review
findings are complete.

## Mob Rule increment (PR08.08)

The first implementation adds timestamped control durations and a fixed affected set for the
untap and haste clauses. Main-thread review corrected expiry transitions, absent-source
durations, and source/target phasing together. The exact-source runtime path never substitutes
a later incarnation through a physical card ID.

Local focused evidence: 35 engine/lab tests, 17 control-lifetime contracts, and three real-browser
scenarios passed. Both typechecks, lint, formatting, snapshots, and the web build passed. The
broader card gate's inventory expectations were updated after their failures; the clean-tree
primitive-evidence check and full suite run after the implementation commit.

The clean-tree card gate passed all 129 suites and 4,165 tests at `ebccb1cd`. The full local
suite then reported 419 passing suites and five failing suites: four evidence-input suites
require the new PR08 source/data bindings in the five existing generators, and the rules-sweep
fixture must create its stolen permanent through `changeController` rather than directly
assigning `controllerId`. The focused rerun follows those integration fixes; this is not yet a
passing full-suite result. Existing bulk-data skips were unchanged.

The review rerun passed all five suites and 184 tests. The test typecheck and affected-file
format check passed. A fresh real-browser run passed all three Mob Rule scenarios against the
current engine; JSON output and traces are retained under `.tmp/pr08/mob-rule-viewer-current*`.

The frozen original population measures 787/906 (692/802 deck cards, 189/200 staples). The
expanded default report includes white-black-control and is not the 906-card plan denominator.
Gameplay-AI quality has not been evaluated with a live provider; the lab uses scripted legal
choices. Those observations do not substitute for engine or viewer correctness.

## Cut a Deal increment (PR08.01)

`drawCards` returns the number of actual draw events. Cut a Deal counts an opponent only when
that opponent actually drew a card, preserving APNAP order and deferring state-based actions
until resolution finishes. Empty libraries, draw replacements, eliminated opponents, a
nonactive caster, payable costs, and sorcery timing have explicit regressions. The actual-draw
regression failed against the previous executor and passed after the fix.

Local integrated checks passed 141 card/lab/inventory tests, 105 related contracts, reviewed
override snapshots, and five real-browser PR08 scenarios (the three Mob Rule scenarios plus
Cut a Deal's full-library and empty-library cases). The OpenCode draft also passed the entire
452-scenario legacy lab spec in its isolated checkout. The main checkout's final full suite and
all-scenario viewer run remain required before marking the PR ready.

The frozen population now measures 788/906 (693/802 deck cards, 189/200 staples); the expanded
default deck report measures 746/855. Both reports use the committed Oracle fixture because the
optional bulk Scryfall download is absent from this worktree. Gameplay-AI quality remains
unevaluated with a live provider; the lab uses scripted legal choices.

## Local checkpoint at `b698932c`

The full suite completed with 424 passing suites, two timeout failures in ESLint-based tests,
and five existing skipped suites: 6,885 passed, two failed, and 36 existing skipped tests.
The two failing suites passed all 62 tests on a serial rerun without changing assertions or
timeouts. This is a full run plus a successful focused retry, not an entirely green full
invocation. The subsequent clean-tree card gate passed all 131 suites and 4,178 tests.
An entirely green full run remains required before the PR is ready.

Delegation is capped at two active subagents on different free OpenCode models. Beam and
Nemotron Lightning have produced isolated drafts after GLM, DeepSeek, MiMo, and Nemotron
Ultra encountered provider errors. Main-thread review rejects unfinished tests and artifacts;
their completion messages do not constitute card evidence.

## Cytoplast Manipulator increment (PR08.06)

The interpreter retains Graft 2, including its enters-with replacement and optional transfer.
The authored activation pays blue and taps, targets a creature with a +1/+1 counter, and binds
control to the exact source object remaining on the battlefield. Losing the target's counter
after resolution does not end control; source departure or phasing does. Source blink never
substitutes a new incarnation. Pending abilities retain their original controller.

All 16 card engine tests and three production-lab outcome tests passed. The normal casting
regression failed explicitly unsupported against the previous implementation, then passed
with the override restored. The integrated run passed 176 tests across 12 suites. All eight
PR08 real-browser scenarios passed, including accepting and declining Graft and stealing a
countered creature before returning the source to hand. Both typechecks, lint, formatting,
reviewed snapshots, benchmark pin validation, and the web build passed. Generated receipts
are refreshed against committed revisions after the implementation commit.

The frozen population now measures 789/906 (694/802 deck cards, 189/200 staples); the expanded
default deck report measures 747/855. Gameplay-AI quality remains unevaluated with a live
provider. Implementation review labels and primitive eligibility are separate final completion
requirements; current declarations remain `implemented-unreviewed` until that review is complete.

## Humble Defector increment (PR08.03)

The activated timing now distinguishes "during your turn" from sorcery timing in battlefield,
hand, and graveyard menus. The new control recipient names an ordinary player target slot,
validated for its domain, count, and mode ownership. A non-string timing cannot pass through
string coercion. The ability pays its tap cost, draws two for its original controller, then
transfers its exact source to the targeted opponent. An illegal sole target fizzles the whole
ability; source departure, blink, or phasing still permits the draw without transferring a
different incarnation. A permanent transfer to the already-current recipient masks older
temporary effects.

All 20 card engine tests, 20 independent recipient/timing contracts, and two production-lab
replays passed. New regressions fail the prior engine for off-turn timing and opponent control
transfer; four additional regressions failed the draft's coercion, count, or field-owner validation.
The integrated run passed 451 tests across 27 suites. All ten real PR08 viewer scenarios
passed, including the off-turn case while the human holds priority with a legal instant.
Both typechecks, lint, formatting, reviewed snapshots, benchmark pins, and the web build passed.
The clean-tree full suite/card gate is rerun separately before the next implementation push.

The frozen population measures 790/906 (695/802 deck cards, 189/200 staples); the expanded default
deck report measures 748/855. Gameplay-AI quality has not been evaluated with a live provider.

## Druid of Purification increment (PR08.02)

Each living player chooses in APNAP order starting with the ability's controller. Every choice
uses that controller's artifact/enchantment exclusion, permits declining, and is public without
targeting. All choices precede destruction; duplicate choices destroy once. The destruction batch
preserves indestructibility, regeneration and simultaneous death observations.

Fourteen direct engine tests, five normal-casting tests, three lab replays and three real-viewer
scenarios passed. Regression tests failed the previous executor before the corrected implementation
was restored. Both typechecks, lint, formatting, reviewed snapshots, benchmark pins and web build
passed. The clean-tree card gate passed 140 suites and 4,261 tests at `87016a33`; generated receipts
bind 148 engine cases and 13 real-viewer scenarios to that revision. The separate full-suite run
passed 435 suites and 6,970 tests, with 36 existing skips in optional bulk-data suites. That validated
checkpoint was pushed. The frozen inventory measured 791/906; the expanded report measured 749/855.

## Wishclaw Talisman increment (PR08.05)

The normal artifact cast retains its three-wish-counter replacement. Activation pays one mana,
taps and removes one wish counter during its controller's turn. It searches and shuffles before
the ability's original controller chooses a living opponent without targeting; the exact source
object then changes control permanently. Empty-library and departed-source cases preserve the
remaining applicable instructions; blink never substitutes a new incarnation.

Main review corrected an optional unrestricted search and an unusable recipient presentation.
Independent regressions failed those drafts and the previous search helper. Stated-quality
searches may still find nothing even with one matching card name; unrestricted searches must
find as many cards as possible. Two old optimization assertions and a Cultivate payment test now
exercise that legal search decision instead of assuming automatic selection.

The 36 focused engine/server tests and 16 real PR08 viewer scenarios passed. The broader engine
run passed 293 suites and failed three search-assumption tests; all three affected suites then
passed 36 tests after the corrections above. Generated evidence, clean-tree gates and the complete
local suite are refreshed separately against committed revisions. The frozen inventory measures
792/906 (697/802 deck cards, 189/200 staples), the expanded report measures 750/855, and the bulk
non-land inventory contains 6,472 modeled cards. These are inventory counts, not review evidence.
Gameplay-AI quality remains unevaluated with a live provider; the lab uses scripted legal choices.

The clean-tree six-card gate passed 144 suites and 4,297 tests. The first commit-bound viewer run
exposed a driver race that passed a new empty-stack priority request before Vue rendered the
resolved permanent. `cbf4355c` synchronizes passes with authoritative WebSocket request IDs and
stack state; all 16 viewer scenarios then passed. Generated receipts at that revision bind 184
engine tests, 16 viewer scenarios, 605 source hashes and retained validated traces.

The optional bulk data was then loaded into the validation checkout. All five additional suites
passed 39 tests after `1f4bc74b` corrected stale restoration inventories and replaced Druid's obsolete
containment assertion with a four-chooser behavioral regression. The complete six-card suite,
including those formerly skipped optional suites, runs separately on the frozen checkout.

## Reins of Power increment (PR08.17)

The instant pays its printed cost and targets one opponent. Its first instruction untaps both
creature groups. The executor then recomputes creature membership, freezes both groups before any
control grant, and gives those exact objects temporary control effects and haste. Either group
may be empty. Cleanup restores the underlying controller rather than the owner, preserves a newer
permanent grant, removes haste and leaves the creatures untapped. A blinked object inherits neither
effect; later arrivals are excluded and control changes remove combat participants from combat.

Nineteen card tests, five independent primitive tests and two production-lab replays passed.
Mutation checks caught reading the set before untapping, recomputing the haste set after changing
control, and using permanent duration; fixed bytes were restored. All 18 real PR08 viewer scenarios
passed, including a full swap through cleanup and an empty caster group. The broader engine run
passed 297 suites and 5,141 tests, with the previously observed async-provider timeout; that suite
then passed both tests in 10.7 seconds with its original 15-second timeout and assertions unchanged.
Both typechecks, lint, reviewed snapshots, benchmark pins and the web build passed. Current receipts
and the complete clean-tree push gates are generated separately against committed revisions.

The frozen inventory measures 793/906 (698/802 deck cards, 189/200 staples); the expanded report
measures 751/855. The bulk non-land inventory contains 6,473 modeled cards. Implementation review
and executable primitive eligibility remain separate final completion requirements. Gameplay-AI
quality has not been evaluated with a live provider.

## Akroan Horse increment (PR08.20)

The normal four-mana artifact-creature cast retains defender. Its enter trigger asks the original
ability controller to choose a living opponent without targeting, then grants that player permanent
control of the exact source object. A blinked incarnation is excluded. The upkeep trigger belongs
to the Horse's current controller; each living opponent of that ability controller creates a white
1/1 Soldier. The shared multiplayer token helper applies each creator's ownership and replacements
and queues entry observations only after the complete simultaneous batch exists.

Twelve card tests, seven independent token contracts and two production-lab tests passed. Reverting
the registration made the normal cast explicitly unsupported; replacing simultaneous creation with
sequential creation failed the entry-observer regression. Fixed bytes were restored after each bite.
The isolated broader engine run passed 298 suites and 5,137 tests; the integrated PR08 run passed
177 tests across 20 suites. All 20 real PR08 viewer scenarios passed. Both typechecks, lint,
formatting, reviewed snapshots, benchmark pin refresh and the web build are checked locally.
Revision-bound receipts are regenerated after the implementation commit.

The frozen inventory measures 794/906 (699/802 deck cards, 189/200 staples); the expanded report
measures 752/855. The bulk non-land inventory contains 6,474 modeled cards. Implementation review
and executable primitive eligibility remain separate final completion requirements. Gameplay-AI
quality has not been evaluated with a live provider.

The seven-card clean-tree gate passed 4,322 tests and failed one expected CLI diagnostic assertion
after a subprocess returned without its diagnostic text. An unchanged isolated retry failed during
the setup inventory subprocess before reaching that test. The push gate remains unresolved; no
timeout or assertion was weakened. The frozen six-card full suite continues separately with bulk
data enabled.
