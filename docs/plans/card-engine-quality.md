# Card modeling quality and engine hardening

Status: implementation in progress. Baseline: `af6b4e3`.

This replaces the supplied **MTGTester Card Modeling Quality & Engine Hardening Plan**.
The review corrections are incorporated below; there is one roadmap and one completion
standard. Progress and blockers belong in the execution record at the end, not in
handwritten card/capability evidence flags.

## Objective and constraints

Cards describe declarative abilities, effects, selectors, conditions, values, costs,
target schemas, and rule statics composed from independently tested engine primitives.
Overrides must not implement casting, targeting, payment, zone movement, stack creation,
or trigger dispatch. Missing behavior stays explicit through `unimplemented()` or
`unsupportedCard()`; broader targets, fake costs, wrong events, and executable `noOp`
are unacceptable substitutes.

Preserve the interpretation/override pipeline, handled-line drift guard, real/fixture
registration equivalence, shared template layer, and shared token catalog. Preserve
deterministic replay and the `PlayerView` privacy boundary. The engine has no I/O or
provider policy. All new/changed cards follow
[the canonical completion guide](../guides/card-modeling-and-testing.md), including
pinned Oracle clauses, positive/negative engine scenarios, normal action paths, current
real-viewer evidence, and separately reported gameplay-AI evidence.

Centralize behavior under existing representations first. Introduce new representations
only after independent contracts protect the behavior. Keep snapshots as drift alarms;
inspect changes before regenerating them. Preserve correct existing behavior, but fix
demonstrated rules defects in separate, explicit regressions rather than encoding them
as compatibility requirements. Do not stop unrelated card additions.

## Phase 1: baseline and authoring/IR guardrails

1. Establish a baseline of required checks and document environment or existing failures.
2. Compose override lint restrictions cumulatively. `reviewed-*` restrictions must include
   the common bans on raw registration, raw mana parsing, inline tokens, and `noOp`.
   Test ESLint's effective behavior for ordinary and reviewed override files.
3. Introduce a shared `assertNever` and exhaustively handle `Effect`, `AbilityCost`,
   `TargetKind`, alternative-cast/permission discriminants, selectors, values, conditions,
   and trigger/event consumers where they dispatch the full union. Specialized consumers
   explicitly reject unsupported variants; do not invent executions for them.
4. Preserve `effect-op-coverage`, `ability-cost-coverage`, and `rule-static-coverage` as
   defense in depth. Exhaustiveness proves classification, not correct execution.
5. Require `defineCard`, shared ability/cost builders, named `targetSlots`, and token
   catalog references for new/materially changed card definitions. Audit legacy exemptions
   by card identity or exact grandfathered records; filename conventions alone are insufficient.
6. Correct stale target/filter/mana-ability comments and other authoring guidance.

Exit: missing union consumers fail compilation; stricter lint cannot drop shared rules;
unsupported specialized paths fail closed; the established gates remain usable.

## Phase 2: independent contracts before migrations

Build synthetic primitive fixtures independent of production-card wiring. Add bounded,
deterministic contract harnesses for targeting, combined payment, and cast preview/apply.
Every offered action needs at least one complete valid continuation. Later choice menus
must only offer feasible continuations. Recreate or clone the complete context separately
for every action, including RNG state, caches, pending triggers, and object counters.

Required invariant families:

- Offered target implies shared target legality; independent positive/negative scenarios
  prevent testing a filter only against itself.
- Offered action with valid choices applies successfully against unchanged state.
- Combined payment witness executes successfully against unchanged state.
- Cast preview matches prepared total cost, targets, metadata, triggers, and zones.
- Target/remembered object does not follow a new incarnation unless rules explicitly allow it.
- Fixed-seed replay is stable; new transaction/decision data does not reveal hidden cards.

Include negative boundary cases: malformed/stale responses, wrong player, stale object ID,
conflicting source-zone flags, invalid face/mode/X/optional costs, invalid slot maps,
consumed permissions, decline, and interrupted decisions. Reject before mutation.
Print deterministic seeds and minimal reproduction data; bound runtime and state sizes.
Use no live network/model calls. Random full games supplement these focused contracts.

Exit: the harnesses protect the targeting and casting migrations before those begin.

## Phase 3: unified targeting and semantic authoring validation

### Shared semantics under the current TargetSpec

Centralize target-domain and characteristic legality; use it for option generation,
announcement/application, copying/retargeting, and resolution. Target context includes:

- source object/card identity, controller, current or last-known source characteristics;
- trigger event player/context;
- current slot and target occurrence;
- ordinary/counted targets by slot and active modal/conditional slots;
- evaluation phase and any required assignment context.

Separate partial-assignment and completed-assignment checks from resolution rechecks.
Count minima, selection budgets, distinctness, and damage divisions do not all have
identical rules at these phases. Distinctness is scoped to an instance of the word
“target” (CR 601.2c), including separately repeated modal occurrences (CR 700.2d).
An ordinary two-target minimum does not revoke the one surviving legal target.
Announced divisions stay fixed and are not redistributed after target invalidation.
Document rechecking semantics for collective mana-value/name/controller constraints.

At resolution, compute CR 608.2b target-legality results once before effect execution
and pass them through all effects. Distinguish initial legality, current object existence,
and explicitly allowed cross-zone tracking. CR 400.7j permits other instructions of the
same effect to find objects it moved to public zones; track those exact transitions, stop
at hidden zones, and never recover a referent by physical card identity alone. Moves made
outside that effect while a decision is suspended do not acquire this exception. Do not re-evaluate an initial target condition
after an earlier instruction changes state. Preserve last-known source information.

Graveyard contracts cover own/opponent/any scope, owner-slot dependencies, selector
positives/negatives, empty graveyards, missing dependency context, eliminated players,
copied/retargeted spells, one/all targets invalid, and leave-return/new-object identity.
`graveyardOwnerScope: 'opponent'` must be implemented or rejected rather than treated
as the controller's graveyard. Choices are not targets: hand/library search choices must
not acquire shroud/hexproof/protection semantics.

### Semantic IR validation

Validate final merged definitions in an enforced route, not only helper tests. Cover
generic interpretation, overrides, alternate faces, nested modes/effects/values/conditions,
and shared token definitions. Typed effect contracts distinguish battlefield permanent,
stack spell/object, player, and graveyard card references. Reject incompatible effects,
out-of-range/noninteger references, wrong ordinary/counted references, invalid dependencies,
mode-slot ownership errors, unsupported target-domain combinations, malformed costs, and
executable `noOp`. Unknown contracts do not imply unrestricted support.

Examples to reject: `destroy` using a graveyard-card slot; `graveyardToBattlefield` using
a player slot; spell-only countering using a battlefield slot. Validate nested effect
references in their correct owning ability scope. Audit and contain existing invalid
definitions explicitly; do not silently change support claims.

Exit: one shared target implementation, phase-correct assignments/rechecks, independently
tested object identity, and enforced semantic validation.

## Phase 4: combined payment and casting transactions

### Payment must be jointly feasible

Prepare one witness for the entire cost: mana production/activation dependencies,
nonmana assignments, life/energy/counter budgets, restricted mana, and legal payment order.
Independent `canPay(mana) && canPay(nonmana)` checks are insufficient. Preview and execution
use the same witness; subsequent payment choices must preserve completion feasibility.

Required examples:

- Six life cannot pay two four-life costs; taxes and Phyrexian costs share that budget.
- The same object cannot pay two tap costs or two sacrifice/discard/exile costs.
- A Treasure sacrificed for mana cannot also pay a required sacrifice.
- A creature may tap for mana and subsequently be sacrificed if that order is legal.
- Repeated/overlapping hand/graveyard selectors need distinct consumable cards.
- Mana produced by an earlier mana ability may fund a later mana activation.
- Total cost stays locked when a reducer/increaser leaves while paying it.

Ward is a triggered ability, not target legality or a required casting cost. A player can
target a ward permanent without being able to pay ward. Actual target taxes remain in
the total-cost contract. Specify cost-reduction/increase ordering and total-cost modifiers.

### Proposed spell versus completed cast

Extract from the normal cast path instead of building a second independent engine.
The current path is a migration baseline, not proof of CR correctness. Carry source zone,
permission, caster/owner, selected face, modes, alternative and optional additional costs,
announced X, targets/occurrences, divisions, total cost, witness, and destination metadata.

```text
preview without mutation
begin proposal: tentative move to stack (601.2a), capture source and permission
announce configuration (601.2b)
choose targets and record targeting triggers (601.2c)
choose divisions (601.2d)
validate proposed cast (601.2e)
determine and lock total cost (601.2f)
activate mana abilities (601.2g)
pay the entire cost (601.2h)
finalize cast and record cast triggers (601.2i)
resume enclosing flow
```

Tentative stack state may be internal, but evaluation must observe the proposed spell's
stack characteristics and source-zone departure. Record ward/becomes-targeted triggers
at target announcement, including if their source is later sacrificed. They wait for
legal trigger placement. Finalize successful casts exactly once. Consume permissions
according to their lifetime, including decline of one-shot opportunities.

For casts during resolution (CR 608.2g), finish the enclosing resolution before priority,
SBAs, and pending-trigger placement. Differentiate immediate resolution permissions,
temporary zone permissions, and ordinary timing. “Without paying its mana cost” is one
alternative cost; it cannot be combined with another alternative cost.

Abort/recovery covers complete context, RNG, logs/events, pending triggers, object counters,
and generator/decision progress. CR 733.1 limits reversal of library/reveal/shuffle actions:
do not implement unconditional state rollback as universal rules behavior. Prove supported
mana-ability scope and fail closed on unsupported irreversible cases. Invalid requests
must not consume permissions or publish events for a cast that never occurred.

### Migration and contracts

Migrate normal casting, commander-free, Rebound, Cascade, Hideaway, then remaining free/
non-hand paths one at a time. For each, compare legal actions, metadata, payment, triggers,
priority, and zone outcomes; explicitly fix known incorrect behavior with rules regressions.
Remove duplicate cast-stack construction. Copying stack spells has a separate operation;
copies are not casts and do not pay costs or fire cast triggers.

Run a common free-cast contract across mechanisms for mandatory/optional costs, modes,
ordinary/counted/conditional targets, divisions, X, restricted/spent mana metadata,
global casting restrictions, permission/timing, ward, source/owner/controller identity,
commander tax, replacement/destination metadata, and object incarnation. Include no printed
mana cost versus zero cost, text-defined X exceptions (CR 107.3), selected-face metadata,
and Cascade's resulting-spell mana-value restriction (CR 702.85a). Lands are played under
an explicit land permission rather than cast as spells. Unsupported faces fail closed.

Ban cast-spell construction outside the casting subsystem with a repository rule and
restricted exports. Preserve separate triggered/activated stack and copy constructors.

Exit: all cast paths share phases and a feasible payment contract; no duplicate casting
implementations or unguarded cast constructors remain.

## Phase 5: capabilities and evidence integration

Derive capability fingerprints from final typed executable IR, not per-card handwritten
`requiresCapabilities`. Exhaustively traverse nested abilities/modes/effects, selectors,
values, conditions, costs, faces, token definitions, keyword/replacement behavior, and
rule statics. Include transitive capability dependencies and canonical Oracle identities
so fixture aliases do not duplicate results. Produce card→capabilities and capability→cards
maps for review, reporting, and regression impact analysis.

Register executable primitive contracts and required case IDs once per capability. CI
must actually execute required cases; test-file existence or source-text names are not
behavioral proof. Changed primitives update their contracts independently of card wiring.
Source changes within the same discriminator also invalidate prior evidence.
Historical implementation declarations remain review history; a label alone grants no
current eligibility. Generate lifecycle states from registered contracts and fresh executions,
and expose the supported scope beside each proven capability. Enforce primitive prerequisites
in CI for new or changed reviewed declarations (including changed pinned clauses); preserve
independent card/viewer gates. A tooling review request for any existing declaration must also
fail if its current dependencies are experimental or outside proven scope.

Keep capability lifecycle distinct from card evidence. Experimental capabilities cannot
support reviewed cards. Engine-proven eligibility is generated from current passing
contracts, supported scope, and implementation/contract source hashes. Missing registrations,
failures, required skips, or stale evidence block eligibility. Integrate the existing
`scripts/card-evidence-input.ts` source/evidence machinery rather than accepting manual
success flags. A reviewed consumer is card evidence, not proof of every capability combination.

Broaden the Phase 2 bounded invariants and add mutation/negative evidence tests for the
new registries. Reuse affected-card maps to select evidence, without weakening full gates.

Exit: primitive impact is derived, evidence is fresh and generated, unknown/experimental
capabilities fail closed for reviewed cards, and invariants cover the shared paths.

## Phase 6: representation cleanup and authoring migration

Only after earlier contracts pass, separate domains from selectors where useful:
battlefield/permanent, stack/spell or stack object, graveyard/card with explicit owner
scope, explicitly supported command-zone cards, and players. Hand/library choices remain
separate. Introduce relationships with explicit occurrence scope and evaluation phase:
different name, same/different controller, owner-of-player-slot, distinct objects, and
collective budgets. Migrate incrementally rather than replacing every TargetKind at once.

Add builders only for dangerous hidden rules contracts: graveyard-card targeting,
without-mana-cost casting, graveyard/exile casting, reanimation/return, linked exile,
library searches, and counter-spell targeting. Preserve builder absent-key behavior and
named-slot identity. Deprecate bespoke fields only after all consumers migrate. Migrate
touched legacy overrides under the stricter rules and preserve shared token identity.

Exit: new cards compose trusted primitives; invalid dangerous combinations fail validation;
representation changes preserve independently proven behavior.

## Gates, delivery, and completion

Use focused regressions first, then the full suite and affected required checks:

```bash
bun run typecheck
bun run typecheck:tests
bun run lint
bun run format:check
bun run test
bun run test:card-gate
bun run snapshots:check
bun run --cwd apps/web build
bun run test:e2e
bun run test:e2e:setup
```

Run coverage/staples/implemented-card inventory tools for card-coverage changes. Real
viewer evidence remains required for changed card clauses/decision flows even when no
frontend source changes. Gameplay-AI evidence remains separate and deterministic CI
must not call live providers. Record baseline failures without weakening checks.

Use small architecture-preserving commits on a new branch, with separate behavior-fix
and mechanical-refactor evidence. Each stage documents removed duplicate paths, affected
cards, source hashes, current checks, residual unsupported scope, and concrete blockers.
Do not mark a phase done by scaffolding its types or by declaring success.

The whole plan is complete only when all six exit criteria and relevant repository gates
pass, all casts and target rechecks share their authoritative semantics, capability evidence
is enforced and current, and card-specific verification retains the canonical standard.
Then open a PR and notify the user. If blocked, preserve reviewable completed changes
and report the exact failed action, attempted recovery, and remaining work.

## Execution record

- Plan corrected: casting order/trigger timing, phase-specific target checks, combined
  payment, cumulative lint, generated capability evidence, and one six-phase roadmap.
- Guardrails (`6609dcd`): cumulative override restrictions, exhaustive core effect/cost/target/
  selector/value/condition dispatch, and an actual remove-counters executor with independent cases.
- Shared targeting (`0ebff01`): common domain/filter/owner/protection semantics; CR 608.2b
  legality is captured before instructions. Ordinary and counted surviving targets retain the
  initial legality result. New-incarnation and non-target-choice regressions protect the move.
- Enforced IR validation (`9e99933`): final merged definitions, custom definitions, and token
  definitions check reference domains/scopes, modes, costs, and executable placeholders.
  Sivitri and Zurgo/Ojutai are explicitly unsupported with pinned negative action evidence.
- Bounded contracts and payment (`286050f`): full-context replay isolates state, definitions,
  RNG position, and caches for every action/continuation; bounds fail evidence. Normal casting
  and its existing alternatives use a joint mana/additional-cost witness with feasible choice
  menus. Life/Phyrexian budgets, Treasure double use, overlapping hand/graveyard costs, and
  tapping before sacrifice have independent regressions. Payment values are locked.
- Complete Oracle audit and inventory recovery (`e06f0e8`): the 2026-10-06 Scryfall bulk
  download contains 38,708 Oracle records. Semantic auditing reports no interpreter errors,
  6,511 modeled definitions, and three placeholder-contained cards. Forbidding Spirit is the
  third and now has pinned containment evidence. These counts are semantic inventory only.
  Coverage tools accept explicit committed Oracle projections and keep all baseline identity/
  population checks. Against the 906 pinned cards, fixture coverage is 537/802 and staples
  coverage is 186/200; remaining unsupported cards are reported, not certified complete.
  Obsolete PR01 backlog lists and the generated interpreter inventory are corrected.
- Validation so far: full suite 3,420 passed with 29 bulk-input skips; after installing bulk
  data the previously skipped suites were executed, obsolete expectations corrected, and the
  implemented-card gate passed without skips. Current card gate: 1,310 passed. Production/test
  typechecks, lint, formatting, snapshots (93 cards/723 registrations), and web build pass.
  All 130 browser tests passed earlier at `0d8ffe0`; browser evidence must be refreshed for the
  later changes. Compatibility pins are refreshed through the benchmark CLI; inputs/gold are
  unchanged.
- Legacy authoring protection: stricter ability-envelope/named-slot rules now apply to all
  new or materially changed overrides. The 220 legacy scopes have exact AST fingerprints;
  formatting does not invalidate them, but changed registrations and reused raw helpers do.
  An inventory check rejects stale/duplicate exemptions. All 15 actual ESLint contracts pass.
- Browser recovery: the later 130-test run and the exact 126-scenario Card Test Lab run at
  `152cea3` pass. The retained catalog report/traces validate against their captured source
  tree. DB-backed player setup also passes after refreshing the supported-pool seed and
  releasing player seats after failed tests. Subsequent casting behavior still needs fresh
  viewer evidence.
- Remaining value classifications (`8493c89`) now enumerate all typed variants, including
  explicit rejection by specialized consumers. The comparison operator also fails closed.
- Expression validation (`3ddb770`) has compiler-enforced shapes for every Selector, Value,
  Condition, and expression-bearing Effect field. Nested unknown variants, missing operands,
  invalid comparisons, malformed hybrid/Phyrexian symbols, and choice predicates in pure checks
  are rejected. Entry choices remain supported. The 2,146-test engine suite passes; repeating
  the full 38,708-record audit adds no contained cards or interpreter errors.
- Shared free casting (`4565355`) replaces duplicate free-spell execution with the normal cast
  subsystem. It preserves additional/optional costs, modes, slot identities, counted targets,
  owner/controller, spent-mana metadata, ward, and cast triggers. Hideaway now offers play/decline,
  casts permanents onto the spell stack, and enforces own-turn land-play limits. Collective
  counted budgets are checked at resolution start; later instructions retain that result.
  Target menus preserve joint payment and graveyard-owner dependencies instead of advertising
  invalid cross-products. Independent engine contracts and all 128 real viewer scenarios pass
  for the shared-casting stage. Final source-bound viewer receipts still need refreshing.
- Executable-container validation (`f336d45`) rejects malformed target scopes, ability roles,
  arrays, mode entries, and continuous operands without interpreter crashes. Optional mana
  activation costs retain their typed default-tap convention. The complete Oracle audit still
  reports 6,511 modeled definitions, three contained placeholders, and no interpreter errors.
- Casting proposals (`881489c`) leave the source zone before configuration and cost evaluation;
  preview projects that same tentative stack state. Target triggers are recorded before payment,
  and validated permissions remain locked when a granting source is sacrificed. Supported
  interrupted proposals restore state, RNG, logs, object counters, and held object references.
  This recovery is not a general CR 733 reversal of irreversible library actions.
- Repository verification at `f6e82e8`: all 293 test files / 3,531 tests pass with bulk data
  installed; all 128 Card Test Lab browser tests pass. The latter report is useful regression
  evidence but has no valid pre-run source capture; do not treat it as a source-bound receipt.
  Final viewer evidence still requires a fresh captured run after implementation stabilizes.
- Mana activation ordering (`20c1633`) pays activation costs before resolving production and
  riders, retains last-known damage keywords for sacrificed sources, and cannot place counters
  on a vanished battlefield object. Life costs, Phyrexian payments, and ward now pay the exact
  amount independently of life-loss replacements. Seven independent ordering cases plus affected
  casting/payment/ward checks pass (45 tests); engine production/test types and focused lint pass.
  Aggregate rider effects on later payment affordability remain outstanding.
- Alternative configuration/payment consolidation (`7449368`) shares modes, optional costs,
  targets, X and commander tax across ordinary, energy, commander-free, nonmana, Overload,
  Adventure and Omen announcements. The engine suite passes 2,214 tests. Costless spells retain
  a distinct null mana cost. A Card Test Lab fixture that needs a zero-cost creature now declares
  `{0}` explicitly (`c3f5415`); all 128 browser tests pass with successful pre-run capture and
  final unchanged-source verification at that checkpoint. Later changes require new receipts.
- Free-cast boundaries (`20bfd73`) require the actual zone incarnation and exact advertised
  target responses; direct casting also rejects unsupported definitions before proposing them.
- Confirmed spell-face errors (`73a7ba5`) contain Claim Territory's substitute search, Coil and
  Catch's substitute bounce, and Zoological Study's omitted Adventure. Pinned Oracle hashes,
  clause mappings and negative engine cases record the exclusions without completed-card claims.
  The full Oracle audit reports 6,508 modeled definitions and zero interpreter errors; the
  generated nonland inventory is 5,840. Interpretation/override snapshots reflect exactly these
  three exclusions. Their new file is included in the audit ledger and all five evidence
  generators' source bindings (`6549b81`). The 199 affected evidence/inventory tests pass.
- Resolution references (`9f7eb08`, `24b6ecb`) follow exact transitions made by the same effect
  to public zones (CR 400.7j), stop at hidden zones, and cannot recover an unrelated incarnation
  through card identity. Ordinary and counted targets, explicit source identity, scoped values,
  and stable player/stack references retain separate rules. Independent positive/negative
  contracts plus delayed-trigger, lifetime, linked-exile, Arcane Denial and Cascade/Rebound
  regressions pass. The broad engine run found only three stale face-support expectations;
  those are corrected and separately verified by `6549b81`; combined verification is recorded
  below.
- Alternative source permissions (`f0ab0df`) reject mismatched face indexes and unsupported
  source combinations, honor Adventure ownership, validate library permission even for an
  alternative cost, and consume its type budget. Face timing uses the selected alternative
  when the index is omitted. All 57 affected casting/permission tests pass, with production
  and test typechecks and focused lint. Selected-face characteristics remain outstanding.
- Combined verification at `8869766`: all 296 repository test files / 3,570 tests and all
  68 card-gate files / 1,415 tests pass, with production/test typechecks, lint and formatting.
- Capability derivation traverses final typed IR, including modes, costs, faces, replacement
  behavior, continuous/rule statics, selectors, values, conditions and nested token abilities.
  Field and discriminator tables are compiler obligations; unknown fields/tags and cyclic or
  oversized graphs fail closed. Implicit tap costs remain visible. Canonical aliases require
  explicit identity, equivalent aliases deduplicate, and differing final definitions conflict.
  The new `card-capabilities` CLI emits reproducible source/input/definition/capability hashes
  and both impact maps, with adapter omissions reported separately. Eleven independent cases,
  production/test types and lint pass; all 6,508 modeled definitions in the 38,708-record bulk
  traverse without errors, yielding 482 dependency keys. This inventory does not certify
  primitive behavior or cards. Broader executable contracts and promotion enforcement remain
  pending, and Phase 5 is not complete.
- Verification at `561367a`: expanded card gate passes 69 files / 1,426 tests; web build and
  snapshots pass. All 132 browser checks pass. The separate exact 128-case Card Test Lab run
  also passes and its report is loader-validated against the unchanged pre-run capture of 163
  source inputs, with the required trace archives validated. These are tested-checkpoint
  receipts; subsequent source or tree changes require fresh evidence.
- Primitive evidence (`ef5d600`) now executes registered independent contracts, captures actual
  test closures and implementation/framework inputs before execution, verifies them afterward,
  and binds framework results to source hashes. Skips, retries, repeats, duplicate or missing
  executions, stale/incomplete sources, and changed report bytes fail closed. The capability CLI
  accepts only loader-validated current evidence and derives scope-limited prerequisites. The
  first contract proves fixed-count `removeCounters` on ordinary permanent target slots; other
  dependencies remain experimental, so this receipt makes no complete card eligible. All 41
  focused tests, including actual runner/CLI execution, pass with test/tooling typechecks and
  focused lint. CI retains execution artifacts. Broader registration and reviewed promotion
  enforcement remain outstanding.
- Graveyard exile transitions (`4842103`) use `moveObject`, create a new object incarnation,
  and let other instructions of the same effect follow that exact public-zone transition.
  Stale physical-card aliases cannot recover targets. All 25 affected target/transition tests,
  test typechecks and focused lint pass; no production card is promoted by this primitive fix.
- Combined verification at `1371dea`: all 299 repository files / 3,610 tests and all 71
  card-gate files / 1,455 tests pass, with production/test/tooling types, lint and formatting.
  The retained actual primitive run and full-bulk eligibility inventory agree on 6,508 modeled
  definitions and 482 dependency keys. The single registered primitive scope proves no complete
  card: all 6,508 definitions remain blocked by other uncontracted prerequisites.
- Command-zone authorization shares a guard between preview and application: normal casts need
  the owner's designated commander in that actual zone. Forged ownership/designation/zone
  records are rejected without proposal side effects. Explicit hand-only alternatives and
  currently unsupported command-zone Adventure/Omen paths cannot bypass their restrictions.
  Default alternatives keep normal casting permissions and commander tax. All 53 affected
  commander/alternative/free-casting tests, test/tooling types and focused lint pass.
- Generic counterspell parsing no longer invents an opponent-only restriction absent from
  Oracle. Pinned Counterspell, Negate, Mana Leak and Stubborn Denial projections exercise normal
  own/opponent casting and resolution, exact tax payment, Ferocious at resolution, creature
  restrictions, actual activated abilities, and self-target rejection. All 96 affected tests,
  test/tooling types, snapshots and focused lint pass. The sole 93-card snapshot change removes
  Stubborn Denial's incorrect controller restriction. Their clause requirements remain
  implemented-unreviewed with real viewer work pending; no card completion is claimed.
- Overload alternatives now carry an explicit executable ability. Bounded lowering preserves
  Cyclonic Rift's opposing-nonland bounce, Vandalblast's opposing-artifact destruction, and
  Damn's all-creature destruction with its regeneration prohibition. Preview and application
  reject a missing alternative rather than substituting Cyclonic Rift. Six pinned canonical
  projections and positive/negative normal-path scenarios cover the supported profiles and
  remaining unsupported scopes. All 97 affected tests, test/tooling types, snapshots and
  focused lint pass. The existing card gate passes 73 files / 1,488 tests. The full 38,708-card
  bulk has no unexpected implementation-status changes or invalid modeled IR; 6,508 remain
  modeled. Changed card clauses remain implemented-unreviewed pending real viewer evidence.
- Authoring validation bounds graph depth and node occurrences before semantic recursion,
  rejecting cycles while accepting shared acyclic subtrees. Definitions, override data, and
  direct expression checks fail closed; 80 affected contracts pass with test/tooling types
  and focused lint.
- Immediate mana riders use a narrow typed union and explicit scope checks. Unsupported
  effects, targeted counter placement, unavailable ability-relative values, malformed numeric
  operands, and cyclic values are rejected before preview or activation costs. Prepared plans
  and direct rider application also enforce the contract. Supported damage, scope-free life
  gain, and source counters retain actual activation ordering and last-known-source behavior.
  All 121 affected contracts pass, with test/tooling types, focused lint and snapshots. The
  full-bulk dependency inventory reports 6,508 modeled definitions and 484 keys; the two new
  keys are `AlternativeCast.ability` and `Effect.overloadBounceAllNonlandOpponents`. This
  does not yet prove a joint witness for changing resources across multiple activations.
- Source bindings for the five viewer evidence generators include the actual runtime imports
  for Overload lowering, command-zone authorization, bounded IR and mana-rider validation.
  The combined repository run passed 303 files but correctly rejected 132 evidence-input
  cases because those frozen lists were incomplete. After closure discovery added the missing
  inputs, all 162 evidence-input contracts pass. This repaired checkpoint still needs a fresh
  complete-suite run before final roadmap sign-off.
- Changing-resource payment uses isolated actual activation replay for fixed-production mana
  sources without strategic cost decisions. The search discovers newly affordable activations,
  recomputes life/counter resources, tries other sources and orders, and preserves actual infect,
  lifelink and deferred state-based-action semantics. Target life taxes and alternative energy
  payments follow mana activation. Prechecks use the joint witness rather than separate mana
  affordability. State-dependent production, strategic activation continuations and exhausted
  search budgets remain explicit unsupported witness scopes; they are not successful proofs or
  ordinary unpayable results. The complete engine suite passes 199 files / 2,334 tests with
  test/tooling types and focused lint. Wider production/continuation scopes remain outstanding.
- Exhaustive structural IR field tables now run at final-definition and partial-override
  authoring boundaries, not only in dependency inventory. Unknown fields across abilities,
  effects, targets, values, selectors, conditions, costs, alternatives and statics cannot execute.
  Primitive leaves count toward the graph budget. All 94 focused contracts and the complete
  engine suite (199 files / 2,336 tests) pass with test/tooling types and focused lint. The full
  bulk retains 6,508 modeled definitions and 484 dependency keys without unexpected containment.
- The expanded card gate at `ee2067d` passes 76 files / 1,527 tests. Subsequent payment and
  field-boundary changes require combined verification; earlier receipts are checkpoint evidence.
- Combined run at `b2947ad`: 305 files / 3,707 tests pass; the multi-seed full-game
  test times out under combined load. Its unchanged-source isolated rerun passes both tests
  in 23.68 seconds. Production types identify the unavailable platform cloning API; this is
  corrected with a pure data copy that preserves aliases, sparse arrays and own property names.
  Zero-life payment follows CR 119.4b even below zero; Phyrexian pips remain payable with mana.
  All 64 focused payment contracts pass with production/test/tooling types and focused lint.
  The full run is not recorded as passing; combined verification must be repeated.
- Combined verification at `4aa7aaa`: all 307 repository files / 3,719 tests and all
  79 card-gate files / 1,564 tests pass, with production/test/tooling types, lint and formatting.
  The earlier full-game timeout does not recur in this complete run.
- Selected-face characteristics (`1b30709`) interpret the actual Adventure/Omen half and
  retain its own cost, types, colors, mana value, ability, keywords and additional costs on
  the stack and its copies. Shared consumers apply those characteristics to timing, targets,
  protection, reductions, restricted mana, cast triggers, countering and public descriptions.
  Physical cards retain their ordinary characteristics off the stack. Contradictory or ignored
  alternative-face fields fail authoring and direct application before side effects.
- Canonical projection preserves an empty front instead of borrowing back-face rules, and
  retains each face's separate cost/type line and own color indicator or cost-derived colors.
  Omen is recognized from its printed subtype even under Scryfall's `adventure` layout.
  The complete 38,708-record audit identifies 71 affected cards: 27 now have representable
  front/spell halves, and 44 omitted unsupported halves are explicitly contained. Seven of
  the 27 were previously misprojected vanilla fronts. All changed clauses remain unreviewed.
  The final bulk has 6,471 modeled definitions and 487 dependency keys; no status changes
  outside the audited face population remain. Full engine verification passes 203 files /
  2,582 tests; final consistency guards separately pass 256 contracts, with types and lint.
- Independent canonical outcomes caught an untap-pronoun defect. A preceding clause that
  declares one battlefield target now binds "untap it" to that same occurrence; an unbound
  spell pronoun is unsupported rather than treated as its stack source. Sixteen other pinned
  spells retain their first-clause effects and correctly untap only the selected object.
  Fresh source bindings include the selected-face helper. Combined and viewer verification
  remain required after this checkpoint.
- Combined verification at `f73884d`: all 309 repository files / 3,951 tests pass, with
  production/test/tooling types, lint and formatting. The initial card gate has three receipt
  validation timeouts under competing full-suite load; all 24 unchanged-source receipt tests
  pass separately, then the complete serial card gate passes 81 files / 1,794 tests. These
  successful reruns are recorded separately rather than rewriting the initial failed run.
- Dynamic mana dispatch (`360aa74`) explicitly classifies opponent-land production and rejects
  unknown runtime variants rather than falling through to it. The authoring boundary validates
  all seven typed variants, including nested granted abilities and prototype-named inputs.
  All 36 focused contracts, both type checks and lint pass. This is a subsequent change;
  the preceding combined results are checkpoint evidence, not current-head proof.
- Spell copies (`8e4250e`) share a separate CR 707.10 constructor. A normal-path negative
  regression demonstrates that counted copying used the copier's identity; both consumers now
  preserve the original selected frame and allocate independent target/division selections.
  Nonspells, tentative casts, missing definitions and invalid ability roles reject before mutation.
  Cast-stack constructors are confined by a tested repository rule, including asserted/spread
  typed objects and internal import/export routes. Lab stack arrangement uses a guarded fixture
  constructor inside the casting module. All 347 focused checks, both type checks and lint pass.
- Post-cost production (`6dc1771`) carries unresolved mana production into actual activation.
  The isolated witness evaluates it after paying costs and replays the complete activation;
  live application verifies the selected production against that same post-cost result.
  Counter-dependent quantities, repeated activations, conditional linked symbols and sacrifice
  color changes retain exact production. The broader engine checkpoint passes 203 files /
  2,603 tests; final strict-type fixes separately pass 99 contracts, both type checks and lint.
  Static mana-production riders and strategic activation continuations remain unsupported
  witness scopes rather than approximate proofs.
- Sixteen canonical untap-pronoun cards now have real lab scenarios and browser assertions
  for the complete first clause, counters/keywords, and the untouched tapped bystander.
  Both server scenario files pass 102 tests. The combined focused checkpoint passes seven
  files / 383 tests with production/test/tooling types, lint and formatting. Actual browser
  execution is still required; the clauses remain implemented-unreviewed.
  Fresh generator discovery adds the copy helper, untap fixture and scenario module.
  Full-bulk inventory retains 6,471 modeled definitions and 487 capability keys.
- Viewer catalog at `ecc8126`: all 144 actual Lab cases pass without skips, retries or
  flaky outcomes. The source-bound loader validates the complete execution catalog and ten
  original generator traces against 173 captured inputs (tested tree
  `ee659d13f8c75306e58efa372e3665b8c983f3d3`, report SHA-256
  `beb8e93e6d55b887d39a275b5609864fda7262e4f16ed59a146b2060b4c82935`).
  This exposes a further receipt hole: traces for other catalog cases were retained but were
  not parsed and hashed by that loader. Every catalog execution now requires a validated trace;
  the preceding browser result remains checkpoint evidence pending a fresh complete receipt.
- Bounded spell foundations (`b0ebd1d`) add independent positive/negative contracts for eight
  final-IR dependencies of ordinary untargeted fixed life-gain spells. Scope includes the
  tested 0..1000 amount boundary, up to two instructions, and green/generic cost at most {1}{G}.
  Actual framework execution generates nine primitive facts including remove-counters;
  complete in-scope compositions become eligible, while unknown dependencies and malformed or
  out-of-scope definitions remain blocked. All 49 receipt/foundation checks pass in isolation
  with both type checks and lint. Earlier competing-load runs time out and remain failed records;
  the successful isolated rerun does not replace them.
- Post-cost linked symbols and initially empty mana production (`ad27d5e`) pass all 25
  changing-resource casting checks. Constructor binding guards (`8e3d9d3`) reject local
  re-exports, dynamic imports and aliased stack literals while retaining the explicit trigger
  helper route; all 58 focused combined checks, test/tooling types and lint pass.
- Capability lifecycle and promotion prerequisites are generated from executable registrations,
  current loader-validated receipts and exact supported scope. CLI review requests reject
  experimental/missing dependencies, unproven composition scopes and changed Oracle pins.
  CI checks new or changed reviewed declarations against the base commit, and retains a
  current impact/lifecycle artifact alongside the primitive receipts. Historical labels do
  not grant current certification. Both established complete-projection pin encodings are
  accepted; changed text/cost is rejected under either encoding.
  All 65 lifecycle/receipt/promotion contracts pass without reporting errors, with production
  and test/tooling types and lint. Earlier runs retain their hook/RPC failures separately.
  Asynchronous child execution and yielding between receipt cases correct event-loop starvation;
  the hook deadline now covers both independently bounded child operations.
- Complete trace receipt at `9f9c666`: all 144 actual Lab cases pass again without skips,
  retries or flaky outcomes. All 144 retained archives are parsed, checked and hashed against
  173 source inputs (tested tree `add011e677c9cca78532769bf94c9f24335e108c`, report SHA-256
  `e55c7a1bd83a72af4d7edcccc4dec4801ec55f5a8f45633a6c850cf41dbd0cf9`).
  All 169 loader/viewer-gate checks pass, including missing, duplicate and corrupt new untap
  traces. Subsequent source changes require final fresh receipts; this is checkpoint evidence.
- Additional life X (`170c5ee`) uses the actual joint mana/payment witness rather than a
  starting-life ceiling. Two before-fix normal-path regressions omit valid X choices when
  mana gains life, including a caster starting below zero; both now offer and apply the exact
  payable range. Final authoring, previews and application require a bounded direct pay-X-life
  envelope; mixed unproven X expressions are contained. Excessive menus fail with an explicit
  1,024-choice scope error instead of truncating legal choices. All 303 focused ordinary,
  alternative, face/free-cast, zero-life and authoring checks pass with production/test/tooling
  types and lint. Fresh generator discovery includes the shared cost-contract helper;
  benchmark refresh changes only current engine/card source bindings and dependent content hashes.
  The actual 38,708-record bulk re-audit retains 6,471 modeled definitions and 487 keys.
- Combined verification at `9572c1d`: all 314 repository files / 4,093 tests and all
  87 card-gate files / 1,941 tests pass, with production/test/tooling types, lint and formatting.
  No receipt RPC failures recur. Later builder and counter changes require fresh checks.
- Guarded target builders preserve exact existing IR while requiring explicit graveyard owners
  and spell domains. Six counter grammar construction sites adopt the spell builder. Independent
  normal casts prove own/opponent/any graveyard returns and unrestricted/restricted spell targets;
  malformed options and owner dependencies reject before mutation. Named target slots preserve
  prototype-named data keys. All 145 focused contracts, both type checks and lint pass; the 93
  interpretation and 729 override snapshots remain unchanged. Builders do not grant primitive
  or card-review evidence by themselves.
- Casting constructor guards now also reject typed function/arrow returns, namespace-qualified
  stack types and locally aliased constructor exports, including exported variable declarations.
  Explicit triggered/activated returns remain legal. All 60 effective lint contracts and the
  complete repository lint pass.
- Shared counter access now uses owned numeric data, including prototype-named counters in
  removal, collective effects, creation, activation costs, layer/resolution values and remembered
  values. Nine before-fix normal casts demonstrate phantom removals or nonnumeric creation.
  All 18 independent counter cases pass, including unchanged-state/RNG rejection of inherited
  counter costs. The complete engine suite passes 206 files / 2,673 tests with production and
  test/tooling types and lint. Executable remove-counter registrations now require six owned/absent
  prototype-name cases; old receipts cannot satisfy the strengthened contract.
- Strengthened remove-counter receipts and target builders pass all 85 actual evidence,
  promotion and builder checks without reporting errors, with test/tooling types.
- Trigger-head validation classifies every event with an exhaustive dispatcher and validates
  the event's required subject/caster/player shape rather than a combined field inventory.
  Eleven malformed shapes passed before the fix. Object, cast, life and step triggers each
  execute through independent normal casting; specialized dispatchers reject wrong/unknown
  families before mutation, even with empty subjects. All 37 focused checks and the complete
  engine suite (208 files / 2,712 tests) pass with production/test/tooling types and lint.
  The full 38,708-record comparison preserves 6,471 modeled definitions and 487 keys with no
  support changes; the committed-fixture IR audit reports no failures.
- Nested event references use the exhaustive effect-reference contracts and traverse current
  conditional/choice instructions without entering separately owned ability/token scopes. Four
  before-fix normal-cast regressions followed a blinked incarnation or registered the wrong
  delayed object. Dying subjects, graveyard-functioning triggers and emblems also retain exact
  event IDs; three further pre-fix boundaries lacked them. The redundant direct-only delayed
  detection is removed. All 62 focused identity, delayed and existing trigger cases pass with
  production/test/tooling types and lint. Broader implicit numeric/LKI references remain open.
- Counter/trigger combined checkpoint: 317 files / 4,172 tests pass; the multi-seed full-game
  case times out at 30 seconds while other checks are running. This remains a failed full run.
  An isolated rerun passes both full-game cases in 20.49 seconds. Production/test/tooling types,
  lint and formatting pass. Final whole-suite verification is still required.
- Guarded effect envelopes cover graveyard returns, linked temporary exile, linked free play,
  bounded hand/search free casting, fixed-count library searches and flashback/escape metadata.
  Unknown options and unsupported origins reject rather than invent permissions. All 79 focused
  contracts and 209 engine files / 2,739 tests pass with both type checks and lint. The full
  35,063-projection comparison preserves all final IR, 6,471 modeled definitions and 487 keys;
  both snapshot sets remain unchanged. These builders do not grant review certification.
- Generic graveyard-return grammar carries the explicit owner through ordinary, modal, trigger
  and activation target allocation. An independent ordinary cast previously omitted the opposing
  graveyard for “a graveyard”; collective unspecified-owner returns also incorrectly claimed
  support and now remain unsupported. All 109 focused contracts, test/tooling types and lint pass.
  The complete 35,063-projection audit preserves every final IR and support status (6,471 modeled,
  487 keys). No current printed card in the bulk population changes from this grammar correction.
- Added ordinary-front and selected-half real Lab scenarios for all 27 supported pinned spell
  faces. All 54 engine scenarios and four Lab-wiring checks pass. Independent expectations
  include entry effects, targeted/collective changes, tokens, draws/discards, scry, and
  Adventure exile/Omen shuffle. Browser verification and final type checks remain pending.
- Counter/overload real viewer checkpoint at `68edecf`: all 158 actual Lab cases pass without
  skips, retries or flaky outcomes, including eight own/opponent counter cases and six
  normal/overload cases. All 158 archives are parsed, CRC/DEFLATE-checked and hashed against
  181 source inputs; tested tree `688c70da3bc7bbc38d735c30e5b92649b09db2e1`, report SHA-256
  `d4966636197d33f7fa2b6c5b7d5e16991884ec5327387440d4b424736a910f19`.
  An earlier run retains 153 passes, one grouped-land-chip assertion failure and four serial
  skips. The corrected assertion counts actual server objects. Subsequent engine and face-scenario
  additions require a fresh combined receipt. The interrupted effect-builder card-gate run
  ended without a result; it is not a passing verification record.
- Remaining exit work: remaining union consumers;
  wider malformed-action/free-cast/payment contracts; target relationships/collective rechecks
  and explicit cross-zone reference permissions; remaining implicit-reference/continuous IR
  validation; remaining alternative/face casting, interrupted-decision integration, and CR 733 supported-scope proof; mana
  activation side-effect/resource scope; generated capability contracts/evidence enforcement;
  and guarded representation/builders migration. No phase is declared complete by this record.
- No current environment blocker: Bun is installed in a temporary toolchain, system Chromium
  replaces the blocked browser download, and the bulk input was recovered. Continue the roadmap
  before opening its completion PR.
- Delayed object events (`35a652d`, verified first on `a6fad6f`): remembered incarnations
  cannot match a blinked card; one-shot object registrations are consumed on firing; explicit
  event-player context survives dispatch. Authoring and execution reject delayed events with
  no dispatcher and invalid expiry values. Twelve independent normal-path contracts plus
  existing delayed/nested/event-head contracts pass (54 tests). The complete engine suite
  passes 2,795 tests across 213 files; production/test/tooling types, lint, and snapshots pass.
  The complete Oracle comparison has zero definition/status changes or derivation failures
  (35,063 projected records, 6,471 modeled definitions, 487 capability keys).
- Selected-face viewer driver investigation: the captured 212-case runs at `212c278` and
  `0a5298c` are preserved as failed runs, respectively 158 and 159 passing cases followed by
  one failure and serial skips. The traces showed an unsubmitted land-review dialog, then a
  normal land-drop reminder. The driver now uses the land review's Play land button and
  acknowledges Pass anyway when offered. These are driver corrections; neither failed run
  grants a passing viewer receipt. Complete source-bound evidence remains outstanding.
