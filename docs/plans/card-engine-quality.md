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
  those are corrected and separately verified by `6549b81`. A combined full run is pending.
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
  primitive behavior or cards. Executable contracts and freshness/eligibility enforcement remain
  pending, and Phase 5 is not complete.
- Remaining exit work: remaining union consumers;
  wider malformed-action/free-cast/payment contracts; target relationships/collective rechecks
  and explicit cross-zone reference permissions; remaining implicit-reference/continuous IR
  validation; remaining alternative/face casting, interrupted-decision integration, and CR 733 supported-scope proof; mana
  activation side-effect/resource scope; generated capability contracts/evidence enforcement;
  and guarded representation/builders migration. No phase is declared complete by this record.
- No current environment blocker: Bun is installed in a temporary toolchain, system Chromium
  replaces the blocked browser download, and the bulk input was recovered. Continue the roadmap
  before opening its completion PR.
