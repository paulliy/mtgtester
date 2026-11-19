# 0023 — Heuristic bot opponent and batched combat declarations

Date: 2026-08-05

Status: Accepted (2026-08-05)

## Context

Two problems, discovered together and resolved together.

### The random opponent is not an opponent

`RandomDecisionProvider` (`packages/engine/src/providers/providers.ts`) picks uniformly from the
legal menu. It was built for Phase 2, when the game needed _any_ driver, and it is still wired in
as a live gameplay opponent at `packages/server/src/match/session.ts` (`providerKind !== 'ai'`),
`bun run pool --play`, and `bun run play-decks`.

Uniform choice has no concept of cost, so it produces play that is not merely weak but
pathological: a permanent with a life-payment activated ability gets activated repeatedly until
its controller dies. Nothing in the provider distinguishes an action that advances the board from
one that is purely self-destructive.

The provider remains genuinely valuable as a _fuzzer_ — `determinism.test.ts`, `fullgame.test.ts`,
`spectator-seek.test.ts`, and the deck-coverage tests rely on it to walk the engine into states a
sensible player never reaches. Removing it outright would silently stop exercising rare rules code.

### Search-based play is not available

`Engine` holds a live generator (`private readonly gen: GameGen<GameResult>`, `engine.ts:110`) and
the whole flow layer is written as generators yielding `PendingDecision`s. **JavaScript generators
cannot be cloned or forked**, and no `clone()`/snapshot facility exists. Monte Carlo Tree Search —
the academic state of the art for Magic, via ensemble determinization (Cowling, Ward & Powley,
IEEE 2012) — needs thousands of forked simulations per decision and is therefore unavailable
without rewriting the engine core into a re-entrant state machine. That rewrite is not worth it.

Reinforcement learning is likewise rejected as a primary approach: the literature is consistent
that collectible card games are harder than Go or poker for RL and need very large compute, and
this project's card pool changes every time a new card is modeled, invalidating learned weights.

### Combat is declared one creature at a time

`combat.ts:180` loops over eligible creatures, surfacing a separate decision per creature
("does Grazilaxx attack?"), with `noAttackRest`/batch shortcuts appended. Blocking does the same at
`combat.ts:346`.

This is wrong on three counts:

1. **Attacking is a joint decision, and its value depends on more than count.** Whether three 2/2s
   should attack into one 3/3 turns on what those creatures can actually do — deathtouch, first
   strike, menace, flying, indestructible, protection, and removal backup all change the answer,
   and none of it is visible if creatures are evaluated one at a time. The fix is not a fixed
   combat-math rule; it's that the engine must surface every eligible attacker **together**, with
   its relevant keywords attached, so one evaluation pass can reason about the group instead of
   guessing at candidates it can't see yet. Answering greedily per creature gets this wrong
   systematically, for the bot and the LLM alike, because neither ever sees the others.
2. **Legality is a property of the whole set.** `canPayAttackTax` (`combat.ts:71`) scales the tax
   by attacker _count_, so whether a given creature may attack depends on how many others do.
3. **It does not match how a player expects to declare attacks.** The browser already works around
   this: `apps/web/src/stores/combatPlan.ts` composes a full attack locally in a `composing` mode
   and then `replaying`s it into the engine one decision at a time.

### Correction: goad was already fixed; this ADR's first draft was wrong about it

An earlier draft of this document claimed goad was modeled but unenforced — a bare
`goadedThisTurn` boolean, no goader identity, never cleared, citing CR 701.38. That was simply an
analysis error, caught on external review and confirmed against the actual code and against the
bundled rules text (`docs/rules/comprehensive-rules.txt`, effective 2026-06-19 — goad is CR
**701.15**, not 701.38).

The real code already does this correctly: `GoadRequirement[]` (`state/types.ts:37-41`) records
`goaderId` and `appliedTurn` per goader, independently — CR 701.15c ("a creature can be goaded by
multiple players... creates additional combat requirements"). `turn.ts:52-61` clears each
requirement specifically when _that_ requirement's own goader's next turn begins, not on a fixed
per-permanent schedule, correctly implementing "until your next turn" (CR 701.15a) even when it
spans several other players' intervening turns in a four-player pod. `attackTargetsFor`
(`combat.ts:83-93`) already prefers a non-goader defender when one is legal and only falls back to
the goader otherwise (CR 701.15b). None of this needs redoing. It's referenced going forward as
"the existing goad model," not as a bug.

### Goad interacted wrongly with attack tax — fixed in Phase 3a

CR 508.1d is explicit: **a player is never required to pay a cost merely to satisfy an "attacks
if able" requirement**, even though paying it and attacking would satisfy more requirements than
not paying it. `attackTargetsFor` didn't honor this: it filtered defenders down to
`canPayAttackTax(...)` first, and only _then_ did `declareAttackers` compute
`mustAttack = goadedBy.length > 0 && attackableOpponents.length > 0`. If the tax was payable, the
creature's "does not attack" option was withheld from the menu entirely and the tax was charged
automatically when the (only) attack was committed — a goaded creature behind an affordable
Ghostly-Prison-style tax was forced to pay it, which CR 508.1d says should never happen: the
requirement is "attacks if able," and paying an optional cost is never what "able" is conditioned
on. **Fixed directly in the per-creature loop as Phase 3a** (item 15) — no decision-contract
change needed, since this was a pure legality-computation bug independent of batching.

### Damage division is modeled as an obsolete rule — timing fixed in Phase 3a, mechanic in Phase 4

`declareBlockers` asked the attacking player to choose a **damage assignment order** among an
attacker's multiple blockers, before the post-blockers priority window resolved. Damage-assignment
order was removed from the rules some time ago; the glossary carries it explicitly as **"Damage
Assignment Order (Obsolete)"** and points to the current rule: a creature blocked or blocking by
two or more creatures **divides its combat damage as its controller chooses among them** (CR
510.1c-d) — no ordering, an arbitrary split (including non-lethal splits a player might want for
some other effect), decided at the combat damage step. Two things were wrong here, independent of
each other:

1. It asked **during the declare-blockers step**, before the priority window CR 509.2/510 places
   between blockers being declared and damage being dealt — the board can still change in that
   window (removal, a bounce spell, another blocker leaving combat), which could make an
   already-locked-in choice stale or illegal by the time damage would actually apply. **Fixed in
   Phase 3a**: the decision moved to fire right before each combat-damage-dealing step, after that
   step's priority window, recomputed fresh per step (see item 18).
2. It asked for an _order_ rather than a _division_ — order happens to determine one particular
   division (lethal-then-cascade), but that's a strict subset of what a player is actually allowed
   to choose. **Fixed in Phase 4**, alongside the batched block declaration: the decision now asks
   for the division directly (see item 18).

## Decision

### Workstream A — a heuristic bot in its own package

1. **Create `packages/bot`**, a fourth top-level package: `shared → engine → bot → server`. It
   depends only on `@mtg/shared` types and `PlayerView`. It is deliberately _not_ placed under
   `packages/server/src/ai/` (that directory is the LLM path) and not merged into
   `ai/heuristics.ts` (that file is a _cost_ mechanism for skipping model calls, a different job).

2. **`HeuristicDecisionProvider` implements the existing `DecisionProvider` interface** so it drops
   into every site the random provider occupies. Because scoring needs the deciding player's own
   life total, it is constructed with a view accessor rather than changing the interface:
   `new HeuristicDecisionProvider(seed, () => engine.view(seat))`.

3. **One common currency.** Every score is expressed in life-equivalent points (LEP), anchored on
   Commander's 40 life. All weights live in a single `weights.ts` table; no magic number appears
   outside it. This is the tuning surface.

4. **Every score is relative to passing — but that zero is a per-decision reference point, not a
   claim that passing is free.** `pass` is defined as exactly `0`; an action must justify itself
   with a positive score. This is the architectural fix for the suicide loop: "pay 2 life: do X"
   scores `value(X) − cost(2 life)`, and when the bot cannot establish a concrete use for X the
   score is negative and pass wins on the arithmetic. No card-specific rule needed.

   The risk this raises is the mirror image of the suicide loop: a quiet board with no flashy
   follow-up could score every real action near zero and let `pass` win by default even when
   development was clearly correct. To avoid that, the weight table (item 3) gives ordinary
   tempo plays — playing a land, casting the commander, deploying a mana rock — a small positive
   baseline score that doesn't depend on an immediately visible payoff, the same way a human
   plays a land on an unremarkable turn without calculating a follow-up first. Missed lethal
   attacks, missed blocks, and other real opportunity costs are not folded into this decision's
   `pass` score itself — see item 9 for where that distinction actually matters, in the LLM
   fallback chain.

5. **A veto layer as a hard floor**, independent of scoring, keyed on the already-typed
   `abilityCosts` (`ability.ts:48` — `payLife`, `sacrificeSelf`, `sacrificeOther`, `discardSelf`,
   `discardHand`). `payLife` where `amount >= life` is never legal to choose. A scoring bug must
   not be able to kill its own player. A repeat-activation damper decays the Nth activation of the
   same ability within one priority window so loops die structurally.

6. **Dispatch on `DecisionType`, not action type.** The bot is a set of handlers across all 14
   decision types; the action scorer is the `priority` handler. The long tail (`orderTriggers`,
   `bottomCards`, `chooseModes`) gets deliberately simple safe defaults until combat and priority
   are good.

7. **Mana value is the universal prior for card impact.** A card is worth roughly its mana value
   in board impact — approximately what Magic's costing guarantees — overridden upward where
   structure is readable (creatures score `power × w₁ + toughness × w₂` from `CardView`). This
   gives graceful degradation across the whole pool and avoids Forge's documented failure mode,
   where per-card `canPlayAI()` methods do not compose.

8. **Threat weighting is per-opponent.** In a four-player pod, damage to a player at 6 life is
   worth far more than damage to one at 40, and attacking a non-threatening player is a real
   error. Threat combines closeness to death, board strength, and commander damage already dealt.

9. **The bot becomes the LLM path's fallback, replacing the reflex to pass, not just the
   string-matching.** `safestFallback` (`packages/server/src/ai/fallback.ts`) tries `pass`
   _unconditionally first_, before evaluating anything else, and only falls through to
   string-matching (`description.toLowerCase().includes('sacrifice')`) if no pass action exists.
   That first rule is the same bug as the suicide loop, in the opposite direction: a fixed action
   taken irrespective of its actual value, just inert instead of destructive. Passing a mandatory
   land drop, a lethal attack, or a needed blocker is not free — it compounds across a turn, and
   a run of failed LLM calls can silently pass through several such decisions in a row ("yielding
   until the turn," in effect). The replacement hands the _specific failed decision_ to the bot's
   real `evaluate()` and takes whatever scores highest, which is `pass` only when `pass` genuinely
   is the best legal action at that decision point — never by default.

10. **`RandomDecisionProvider` is retained for tests and removed as an opponent.** Call sites in
    `session.ts`, `pool.ts`, and `play-decks.ts` switch to the bot; engine and coverage tests keep
    using it as a fuzzer. A follow-up may rename it `FuzzDecisionProvider` to make the intent
    visible.

11. **Determinism is preserved.** Score ties break through a seeded PRNG. `Math.random()` remains
    banned (brief §4, §5.9). Same seed still yields the same game.

12. **Offline weight tuning is deferred, but its method is chosen now so item 3's table doesn't
    need reshaping later.** Existing rule-based MTG bots cap out on hand-tuned weights: Forge's
    `canPlayAI()` evaluates each card in isolation and, by its own maintainers' account, "will
    never use two Shocks to kill a 4/4" — the same compositional failure item 7 is designed to
    avoid. Two published tuning methods were considered as the eventual upgrade path, both
    compatible with a linear weight table and both fed by data `pool --play` already produces:

    - **Evolutionary search over the weight vector** (genetic algorithms / CMA-ES), fitness-scored
      by self-play win rate — the approach used for feature-weighted linear evaluation functions in
      [Miernik & Kowalski's tuning work on the Strategy Card Game AI Competition](https://arxiv.org/abs/2105.01115).
      It needs only a win/loss signal, no labeled positions.
    - **Texel-style supervised tuning**, borrowed from chess engines: extract positions from
      self-play games and fit weights by gradient descent/local search against actual game
      outcomes (see the [chess programming wiki](https://www.chessprogramming.org/Texel's_Tuning_Method)).
      It converges faster than evolutionary search when the evaluation is linear — which item 3
      commits to by design — at the cost of needing outcome-labeled positions logged per game,
      which `pool --play`'s SQLite persistence can already provide.

    Texel-style tuning is the better fit given the linear table this ADR commits to; evolutionary
    search is the fallback if the table later grows enough nonlinear structure (e.g. piecewise
    per-opponent threat curves) that it stops being cleanly differentiable. Learned card
    embeddings — e.g. [Bertram, Fürnkranz & Müller's generalised card representations for
    MTG](https://arxiv.org/abs/2407.05879), which predict human evaluations for cards a model has
    never seen — solve a different problem (unseen-card generalization for draft/deckbuilding, not
    in-game action scoring) and are not a substitute for the mana-value prior in item 7. None of
    this is in scope for this ADR; the design does not depend on it.

    **A curriculum refinement to the same deferred phase, from external review:** rather than
    starting tuning straight from self-play outcomes, stage it — (1) hundreds of small
    hand-authored scenarios with a known pairwise preference ("lethal attack beats nonlethal",
    "don't pay life for nothing") fit by pairwise ranking, which is far cheaper and cleaner signal
    than win/loss over a full game; (2) the LLM as a sparse teacher, ranking only the positions
    where the heuristic's top two candidates are close or an effect is weakly modeled, rather than
    every position; (3) outcome tuning over self-play last, against a league of opponents
    (including older weight versions) rather than pure mirror self-play, since the cited
    evolutionary-tuning work found opponent choice measurably affects what gets learned. This is a
    refinement of item 12's method, not a new phase — it still activates only when item 12 does.

### Testing: a coverage-guided fuzzer (accepted, deferred)

Also from external review, and independent of Workstream B: `RandomDecisionProvider`'s retained
fuzzer role (item 10) could be complemented by a `CoverageDecisionProvider` that scores actions by
novelty — a hash over `{decisionType, actionType, sourceEffectOps, targetZone,
resultingZoneTransitions, unusualStatusFlags}` — and prefers rarely-visited combinations instead of
picking uniformly. This would very likely find rare rules paths faster than uniform random fuzzing
does today, at a small implementation cost. Not built as part of this ADR; a natural companion to
whichever phase next touches the test-fuzzing story.

### Scoring model: accepted refinements, not rework

Two more points from external review are worth recording as the acknowledged next steps for
Workstream A's scoring model, without redoing what Phases 1-2 already shipped, tested, and used to
fix the reported bug:

- **LEP is a debug/display convenience, not a claim that life converts linearly.** One life at 3
  is not worth what one life at 30 is, Commander damage (21) and poison (10) are separate loss
  thresholds from life total, and some decks trade life for cards on purpose. Before scoring is
  asked to make real decisions under life pressure, `weights.ts` should grow a small nonlinear
  life-danger feature (a handful of thresholds, not a raw per-point weight) rather than treating
  every point of life as the same fixed cost regardless of the total it's coming out of. Not done
  yet — the current placeholders don't distinguish life totals at all.
- **The repeat-activation damper (item 5) is the cheap fix for the reported bug, not the general
  answer.** Decay can in principle suppress a legitimately-repeatable good action (a mana ability,
  several pump activations building toward one lethal swing) exactly as readily as a pointless
  one. A state-fingerprint-keyed cycle detector — same decision, same state, no board progress —
  is a strictly more general replacement and a reasonable follow-up once Workstream A returns to
  scope; decay stays until then because it already fixes the bug that was reported, is tested, and
  doesn't need the state-fingerprinting infrastructure a cycle detector would.

One correction to a suggestion, rather than an acceptance: a `RULES_VERSION` constant was proposed
citing the bundled Comprehensive Rules as effective 2026-08-07. The actual bundled file
(`docs/rules/comprehensive-rules.txt`) states **2026-06-19** as its effective date, matching
`CLAUDE.md`. Nothing in the engine currently branches on rules version at runtime, so this is
better kept as the existing doc header/comment reference it already is than promoted to an
exported runtime constant, unless a real multi-version need appears later.

### Workstream B — batched combat declarations

13. **Replace the per-creature loop with one declaration per combat step.** Declare-attackers
    surfaces a single decision listing every eligible creature, each legal defender, and each
    creature's requirements. Declare-blockers does the same. The engine still validates
    everything; nothing about rules authority moves to the client. **Landed for both sides**:
    `declareAttackers` (Phase 3b) surfaces one `AttackDeclarationSubject[]` and one decision for
    the whole set; `declareBlockers` (Phase 4) does the same per defending player, in APNAP order,
    with `BlockDeclarationSubject[]` — one batched decision per defender, not one per creature.

14. **Combat moves from a menu contract to a propose-and-validate contract.** For combat, enumerating
    the legal option set is not possible: n creatures against k opponents give (k+1)ⁿ candidate
    declarations, and attack tax makes legality a property of the whole set. This ADR therefore
    carves out combat as the one place a caller _proposes_ a structured declaration that the
    engine validates, and is the reason the retry loop in item 17 exists.

    **What this changes in brief §1.2 is the enumeration mechanism, not the authority principle.**
    §1.2 makes three claims: the engine computes every legal option; it presents them as a numbered
    menu the AI picks from by index; and anything not on the menu is rejected. Batched combat breaks
    the first two _for combat only_ and preserves the third exactly — validation _is_ that rejection.
    The engine still decides what is legal, still rejects, and still applies only what it validated;
    the AI still never asserts legality. Note also that §1.2's own split table already assigns
    "Attack and block declarations" — plural, as a unit — to the AI's column, so a whole-declaration
    contract is closer to that table's intent than the per-creature loop is.

    **Landed in Phase 3b, but leaner than this item first sketched.** The shipped design reuses the
    engine's existing multi-slot `targets`/`TargetChoice[]` mechanism instead of a parallel wire
    protocol: `declareAttackers` still yields exactly one `EngineActionOption`, but that option
    carries one target slot per eligible creature (`option.targets[i]`), each slot's `options`
    being that creature's own legal defenders plus a `NO_ATTACK_TARGET` sentinel (omitted when the
    creature can't legally decline — item 19). `Engine.submit()` already rejects a response
    choosing anything outside a slot's `options`, so restrictions and requirements (CR 508.1c/d)
    are enforced by construction, per creature, with zero new validation code — only the ONE thing
    that genuinely can't be checked per-slot (several creatures' combined attack tax against a
    shared defender exceeding the attacking player's mana, since tax scales with attacker count)
    needs the actual propose-and-validate/retry/repair cycle items 16/17 describe. This is a
    smaller, more literal reading of "propose and validate" than the original `AttackDeclaration`/
    `CombatConstraints` sketch below, arrived at because per-slot legality already gives the menu
    contract's rejection guarantee for everything except that one joint-cost case.

    **Blockers landed the identical shape in Phase 4.** `declareBlockers` yields one
    `EngineActionOption` per defending player, one target slot per eligible blocker, each slot's
    `options` being that creature's own legal attackers plus `NO_BLOCK_TARGET`. The one thing that
    can't be checked per-slot on the blocker side isn't a joint cost — blocking has none — it's
    menace (CR 702.111b): whether an attacker ends up with fewer than two blockers is a property of
    how many proposed blockers land on it, the blocker-side mirror of attack tax's "several
    creatures share one constraint" shape. Same propose-and-validate/retry/repair cycle, same
    reason it's needed, different cross-cutting rule.

15. **Attack legality is three separate collections, not one collapsed check** — CR 508.1c/d's own
    structure: **restrictions** (a creature can't attack, or can't unless a condition holds),
    **requirements** (a creature attacks if able, or if a condition holds), and **costs** (what
    must be paid to attack with a chosen creature).

    The reason this has to be three collections and not one: **a requirement is never satisfied
    by paying an optional cost.** CR 508.1d is explicit that a player is not required to pay a
    cost to attack merely because doing so would satisfy more requirements. **This half of the
    item landed ahead of batching** (Phase 3a): the bug was live in `attackTargetsFor`/`mustAttack`
    independent of batching, so it was fixed directly in the then-still-per-creature loop via a new
    `freeAttackTargetsFor` (`combat.ts`) that computes requirement-mandatoriness from cost-free
    defenders only, leaving the cost-affordable menu (`attackTargetsFor`) untouched.

    **What actually shipped in Phase 3b is not the standalone `CombatConstraints` type this item
    originally sketched.** Restrictions and costs collapse into one list per creature —
    `AttackDeclarationSubject.defenders: { playerId, life, attackTax }[]`, built by
    `buildAttackSubjects` from exactly the same `attackTargetsFor` call Phase 3a already fixed —
    and the requirement collapses into one boolean, `mustAttack`, computed the same way item 15's
    Phase 3a fix already computed it. A separate `CombatRestriction[]`/`CombatRequirement[]`/
    `CombatCostRule[]` typed union was not built: nothing downstream (the bot, the browser, the
    validator) ever needed to inspect a restriction or a requirement _as its own object_ rather
    than as "is this defender in the legal list" / "is decline offered," so the extra type layer
    would have been ceremony without a consumer. If a future card needs a restriction/requirement
    shape richer than "legal defender list" + "must decline is or isn't offered" can express, that
    is the trigger to revisit this.

    **The blocker-side mirror is even flatter** (Phase 4): blocking has no cost at all (nothing
    analogous to attack tax), so `BlockDeclarationSubject.attackers` is purely a restriction list
    (evasion/protection, CR 509.1b) and `mustBlock` is purely a requirement boolean — there was
    never a three-way split to collapse in the first place.

16. **Rejections carry a violation list, not a claimed legal set.** Item 14 already establishes
    that the complete legal set can't be enumerated for combat — so a retry response must not
    turn around and call something "the recomputed legal set," which was this ADR's own
    inconsistency on an earlier draft.

    **What actually shipped is smaller than this item's original sketch**, for the same reason
    item 15 shrank: restrictions/requirements/costs are already enforced per-slot (item 14), so
    `kind` is a discriminated union of exactly the two cross-cutting rules that exist:

    ```ts
    interface CombatViolation {
      subjectId: ObjectId;
      kind: 'attackTax' | 'menace'; // menace added in Phase 4 alongside batched blockers
      message: string;
    }
    interface CombatRejection {
      violations: CombatViolation[];
    }
    ```

    No `stateRevision`, no separate `AttackerConstraint`/`DefenderConstraint`/`costRules` —
    those existed in the original sketch to describe a legal-set-shaped rejection; once
    restrictions/requirements/costs moved into the per-slot menu itself (item 14), a rejection only
    ever needs to say which subjects violated the one remaining cross-cutting rule and why. `kind`
    being a real union rather than a bare string is exactly what let `'menace'` land additively in
    Phase 4 — no breaking change to the attacker side's `'attackTax'` consumers. The rejection rides
    on the retry decision's `presentation.attackDeclaration.rejection` /
    `presentation.blockDeclaration.rejection` (UI-only, same as every other `presentation` field —
    never sent to the AI/heuristics layer, which reads `LegalAction.data` instead); the browser's
    `combatPlan` store surfaces `rejection.violations` as `rejectionMessage` and drops back into
    `composing`, seeded from whatever of the player's prior assignment is still legal, so only the
    flagged creature(s) need fixing — one code path for both declaration kinds now (see the Phase 4
    landed note below).

17. **One informed retry, then an engine-owned repair — never the bot guaranteeing legality.** An
    illegal proposal is re-asked exactly once, with the rejection (item 16) attached, so the caller
    can fix what it missed or mis-assigned. If the second attempt also fails, the engine itself
    repairs it — not the bot. **Landed in Phase 3b** as:

    ```ts
    function repairAttackDeclaration(
      ctx: GameContext,
      attackingPlayerId: PlayerId,
      eligible: readonly EnginePermanent[],
      opponents: readonly EnginePlayerState[],
      assignment: ReadonlyMap<ObjectId, PlayerId | null>,
    ): Map<ObjectId, PlayerId | null>;
    ```

    Only the `'minimum-change'` policy this item originally listed is implemented — repeatedly pick
    the lowest-power violating creature (ties broken by id, for determinism), redirect it to a free
    defender if a requirement makes it mandatory that it attack someone, otherwise stand it down;
    bounded by the eligible count so it always terminates. `'minimum-required'`/`'safe-default'`
    were sketched as alternate policies but have no caller today — the bot doesn't pass a `policy`
    argument (there is only one), so building them now would be speculative.

    **`repairBlockDeclaration` landed in Phase 4**, same signature shape and same
    `'minimum-change'` policy, applied to menace instead of attack tax: repeatedly pick the
    lowest-power violating blocker; if it's `mustBlock`, first try redirecting it to a different
    legal attacker that isn't itself menace-and-under-blocked (never manufacturing a second
    violation while fixing the first), otherwise — or if no such attacker exists — stand it down.
    Bounded by the candidate count, same termination guarantee.

    This is a correction from an earlier draft, which had the heuristic bot's own planner produce
    "a guaranteed-legal declaration" as the final fallback. That puts the legality guarantee in
    the wrong place: unless the bot re-derives every rule the engine already encodes, the two
    will eventually drift, and the whole point of brief §1.2 is that the engine — not any
    caller, bot included — is the one thing legality can never depend on getting right twice. Games
    never stall, and the repaired declaration still plays sensibly rather than throwing the turn
    away.

18. **A block declaration expresses only blocking relationships — never damage division.** Damage
    division does not belong at blocker-declaration time, for two independent reasons traced in
    the Context section above: CR 510.1c-d places it at the combat damage step, after a full
    priority window the board can still change in, and the "assignment order" framing an earlier
    draft of this item used is the same obsolete mechanic the engine code asked for before Phase
    3a — real division is an arbitrary split, not an order. **The timing half landed in Phase 3a**:
    the decision moved out of `declareBlockers` into its own per-step call from `runCombatPhase`,
    right after that step's priority window, recomputed fresh per step. **Both remaining halves —
    the mechanic and the decision shape — landed in Phase 4**, as `assignDamageDivisions(ctx, step)`
    (renamed from `assignDamageOrder`, which it replaces rather than extends):

    - It no longer asks for an order at all. `combatDamageSplit: { amount, targets }` rides the
      same one-call-distribution wire shape `manaSplit` already established (Klauth's mana
      trigger) — `targets` is the live blockers' ids, plus the defending player's id appended when
      the attacker has trample — and the response is `combatDamageSplit: Record<targetId, number>`
      summing to `amount`, not an index into an ordered list.
    - The one thing that still needs validating: CR 702.19b's actual trample constraint — nothing
      may go to the defending player until every blocker's entry in the split already meets its
      own lethal threshold (`deathtouch` makes that threshold 1, CR 702.2c). Without trample, the
      split is fully free (CR 510.1c has no lethal-first requirement at all — that was the
      obsolete pre-2018 mechanic, confirmed against the bundled Comprehensive Rules' own glossary
      note during this pass). A malformed or missing split (a provider that doesn't know the
      field, e.g. the random fuzzer) falls back to dumping the whole amount on the first live
      blocker — always legal regardless of trample, mirroring `addManaFromAbility`'s own
      single-bucket fallback for the same reason.
    - The separate `assignCombatDamage` `DecisionType` is preserved, not removed, exactly as this
      item originally said — but it's genuinely skipped now (not just "skippable") whenever there
      are fewer than 2 live blockers: CR 510.1c already forces the whole amount to a single
      blocker with no real choice, and trample's own lethal-first/excess-to-player split still
      applies deterministically in that case with nothing to ask.
    - Gang-blocking is expressed in the batched block declaration (item 13); only the division of
      damage among a gang-block's members stays this separate, now fully-general decision — exactly
      the split this item always intended.

19. **The goad model does not need fixing** — see the Context section's correction above. What the
    batched declaration validator does need is to _read_ the existing `GoadRequirement[]`
    correctly when computing requirements (item 15): a goaded creature's requirement is "attacks a
    player other than a goader if able," check restrictions-only legality first, and never treat
    an affordable tax as making that requirement mandatory to pay for (the actual bug, item 15).
    A batched UI that reports "this creature must attack" is lying if the engine doesn't enforce
    it — which, per the Context correction, it already mostly does; the tax interaction is the one
    piece the batched validator has to get right that the current per-creature loop does not.
    **Landed in Phase 3b**: `buildAttackSubjects`'s `mustAttack` is the exact same
    `freeAttackTargetsFor`-based computation item 15's Phase 3a fix introduced, so the batched
    declaration's "must attack" claim and the engine's own enforcement (via omitting
    `NO_ATTACK_TARGET` from that creature's slot) can never drift apart — they're the same call.

20. **Supporting projection changes**, both small and independently useful to the LLM path and the
    browser:
    - `PermanentView` gains computed `keywords: string[]`. Combat evaluation needs deathtouch,
      first strike, trample, and lifelink to judge a trade; `status` carries game statuses
      (`tapped`, `summoningSick`, `faceDown`), not keywords, and the engine's `hasKeyword`
      (`combat.ts:503`) is not projected. Evasion is _not_ needed for legality — `canBlock`
      already filters the menu. A bare `string[]` is a deliberately small starting point, not a
      ceiling: if scoring later needs numeric combat traits (power/toughness deltas already exist
      on `CardView`; counters, protection colors, and similar do not), that's an additive
      extension to this same field's neighborhood, not a redesign.
    - Cast options gain numeric `manaValue` on the `data` bag. `data.manaCost` is a formatted
      string and `paymentPreview` returns only `paymentSourceIds`/`paymentSourceNames`.

    Neither of these landed in Phase 3b — both are Workstream A scoring inputs, orthogonal to the
    attacker-batching work. What Phase 3b _did_ add in this same spirit, because the batched
    decision needed it and nothing upstream already carried it: `attackDeclaration`'s
    `LegalAction.data.subjects` — `{ subjectId, power, toughness, hasTriggers, mustAttack }[]`,
    one entry per target slot, in slot order. This is the AI/heuristics-visible twin of
    `presentationAttackDeclaration.subjects` (UI-only, per the split above): it's what let
    `packages/server/src/ai/heuristics.ts`'s zero-power-attack rule (previously reading
    per-creature `noAttack`/`attack` options that the batched contract no longer produces) keep
    working — decline the WHOLE declaration locally, at zero model-call cost, when every eligible
    creature is powerless, trigger-free, and not `mustAttack`; a mixed board still goes to the
    model, which now decides every subject in one call instead of the old rule's per-creature
    version needing to fire once per powerless creature.

## Consequences

- The pathological self-destruction is fixed twice over: structurally, because costs are subtracted
  and pass scores zero, and defensively, by the veto layer.
- The opposite failure — defaulting to `pass` regardless of value — is fixed the same way: the LLM
  fallback chain no longer tries `pass` first unconditionally (item 9); it only ever passes when
  passing scores highest for that specific decision.
- Combat legality becomes verifiable as a whole set, which fixes attack tax interactions that the
  per-creature loop could not express correctly, and attacker evaluation happens with every
  candidate's keywords visible at once instead of one creature at a time.
- The goad-versus-attack-tax bug (item 15) is fixed as part of this work — a live, real bug, but a
  narrower one than this ADR's first draft claimed. The rest of the goad model (goader identity,
  multi-goader tracking, turn-scoped expiry) was already correct beforehand and needed no change;
  see the Context section's correction and item 19.
- Damage division moves to the combat damage step, where CR 510.1c-d actually places it, and is
  described as a division rather than the obsolete "assignment order" the engine's own code and
  comments still use in places (item 18). This is a correctness fix independent of batching, not
  only a batching-driven cleanup.
- Legality repair moves into the engine (`repairAttackDeclaration`/`repairBlockDeclaration`, item 17) instead of being a guarantee the heuristic bot's planner was asked to uphold on its own —
  keeping the "engine is authoritative on legality" principle (brief §1.2) intact even in the one
  place (combat) where the menu contract itself doesn't hold.
- The browser's `combatPlan` store loses its `replaying` mode: it composes a declaration and
  submits it. This is a deletion, not new UI work, and its existing tests narrow accordingly.
- Single-player combat matches player expectation — declare the whole attack, confirm once — and
  gets real inline error messages from the same rejection-packet data (item 16) the retry and
  repair path consumes.
- Brief §1.2's "engine generates the complete menu, AI picks by index" no longer holds for combat.
  Its rejection guarantee and its allocation of authority are untouched, and every other decision
  type keeps the menu contract in full. This carve-out must be kept narrow; if it starts spreading
  to other decision types, that is a signal to revisit.
- A fourth package adds build and tsconfig wiring to the workspace.
- Engine tests continue to fuzz with random providers, so rare-path coverage does not regress.
- Full fork-based MCTS remains unavailable while the engine is generator-driven; reinforcement
  learning remains rejected as a primary approach for the reasons in the Context section. Neither
  claim rules out _bounded_ search that doesn't need to clone the whole engine — replaying
  recorded decisions from the seed to reach an alternate branch, or a small combat-only search over
  a structured snapshot (attack/block candidate generation, engine validation, greedy or
  beam-limited opponent-response estimation) — which is a plausible, separately-scoped future
  improvement to Workstream A's combat scoring, not something this ADR commits to now. If
  full-engine search ever becomes desirable, the prerequisite is still a cloneable state
  representation, and that should be its own ADR.

## Phasing

Each phase is independently shippable and stops at a boundary for approval, per brief §14.

| Phase | Scope                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------- |
| 1     | ✅ `packages/bot` skeleton, veto layer, `evaluate(view)`. Wired as LLM fallback only.              |
| 2     | ✅ Replace `RandomDecisionProvider` as the live opponent at all three call sites.                  |
| 3a    | ✅ Two standalone rules bugfixes inside the existing per-creature loop — no contract change.       |
| 3b    | ✅ Batched attack declaration (items 13/14), rejection/retry (item 16), `repairAttackDeclaration`  |
|       | (item 17), and — bundled in rather than deferred to Phase 5 — the browser's attacker-side rework.  |
| 4     | ✅ Batched block declaration with multi-block/menace (items 13/14/16/17, `repairBlockDeclaration`) |
|       | true arbitrary combat-damage division (item 18, CR 510.1c-d) in place of the lethal-cascade-order  |
|       | approximation 3a leaves in place — and, bundled in for the same reason 3b bundled attackers, the   |
|       | browser's blocker-side rework, completing Phase 5's row ahead of schedule (see below).             |
| 5     | ~~Browser `combatPlan` simplification for blockers~~ — landed early, bundled into Phase 4.         |
| 6     | _(Deferred, optional)_ Offline weight tuning over batch self-play.                                 |
| 7     | _(Deferred, optional, separately-scoped)_ Bounded combat search — see Consequences.                |

Phase 1 landed: `packages/bot` (`weights.ts`, `veto.ts`, `evaluate.ts`, `provider.ts`, `rng.ts`),
wired into `packages/server/src/ai/provider.ts`'s `escalateOrFallback` in place of
`safestFallback`. `fallback.ts` itself is left in place (still exported, still tested) but is no
longer on the live fallback path — nothing currently imports `safestFallback` outside its own
test.

Phase 2 landed: `HeuristicDecisionProvider` replaced `RandomDecisionProvider` as the live opponent
in `packages/server/src/match/session.ts` (`providerFor`), `packages/server/src/cli/pool.ts`
(`playHeuristic`, renamed from `playRandom`), and `packages/server/src/cli/play-decks.ts`. Per
item 10, `RandomDecisionProvider` itself is untouched and still used as the test fuzzer everywhere
it previously was (`determinism.test.ts`, `fullgame.test.ts`, `spectator-seek.test.ts`,
`async-providers.test.ts`, coverage tests, and the ad hoc human-response checks in
`living-energy.test.ts`/`remaining-four-decks.test.ts`/`session.test.ts`/`runner.test.ts`) — only
the three real-opponent call sites moved. A `bun run pool --play` smoke run confirmed the game
completes normally (78 turns, no self-destruction loop) rather than needing a search-based
opponent's help to avoid the original bug.

Phase 3a landed, deliberately scoped to skip the decision-contract change (item 14) — a smaller,
lower-risk slice chosen specifically because full attacker batching changes the engine's
`declareAttackers` decision shape, and the browser's `combatPlan.ts` (single-player's only way for
a human to declare attacks) is built entirely around the current per-creature contract; cutting
that over without also doing Phase 5's browser rework in the same pass would have broken
single-player combat in the gap between phases. Both fixes below are pure logic changes inside
the still-per-creature `declareAttackers`/`declareBlockers` generators — no protocol change, no
browser risk:

- **The CR 508.1d bug (item 15's core claim)**, fixed in `combat.ts`'s `attackTargetsFor` /
  `declareAttackers`: a new `freeAttackTargetsFor` checks `attackTax(...) === 0` rather than
  `canPayAttackTax(...)`, so a goad requirement is only ever mandatory when a truly free defender
  exists — an affordable Ghostly-Prison-style tax no longer forces the attack. The menu itself
  (`attackTargetsFor`, cost-affordability-gated) is unchanged — the tax-gated attack remains a
  legal, offerable choice, just never a forced one.
- **Damage-assignment timing**, fixed by extracting the old order-decision loop out of
  `declareBlockers` into a new `assignDamageOrder(ctx, step)`, called from `runCombatPhase`
  immediately before each combat-damage-dealing step (after that step's priority window), instead
  of before blockers even finish resolving. This still expresses the choice as an order feeding a
  lethal-then-excess cascade — not yet the fully general arbitrary division CR 510.1c-d actually
  allows, which stays scoped into Phase 4 alongside the batched block declaration, exactly as
  planned. Recomputed fresh per step (not once for the whole combat), since a blocker from the
  first-strike step can die before the regular step runs.
- Fixed two pre-existing broken tests discovered while touching this code: two of the three
  existing goad tests spawned the goaded creature under a non-active player, so their
  `d.player === 'P2'`/`'P3'` branch never matched and their assertions silently never ran — one had
  an outer assertion that caught it (now fixed), one didn't (added one). Neither was related to
  this ADR's changes; both predate this session.
- Added `combat.test.ts` coverage for both fixes directly (tax-gated goad menu stays optional
  even when affordable; a free non-goader defender still forces the attack; the damage-order
  decision now reports `ctx.state.step === 'combatDamage'`, not `'declareBlockers'`).
- The added decision points measurably slow `determinism.test.ts`/`fullgame.test.ts`'s
  random-fuzzed full-game runs (about 2.5× — recomputing per step instead of once, and random
  blocking hits multi-block scenarios more than considered play would). Both tests still complete
  in a few seconds; only vitest's 5s default timeout under full-suite parallel load needed
  headroom, bumped to 20s on the two affected tests.
- All 534 engine tests and 432 server tests pass; `packages/bot`'s and `packages/server`'s
  typecheck and lint are unaffected (the one pre-existing `combat.ts` lint error, an unrelated
  `as any` on `attachedToPlayerId`, predates this session and this diff doesn't touch that line).

Phase 3b landed, including the browser's attacker-side rework that Phase 5's row originally
reserved — the earlier AskUserQuestion choice for this phase was explicitly to bundle that rework
in rather than leave single-player attacks broken between 3b and Phase 4/5 landing, the same
concern that drove the 3a/3b split in the first place. Blockers are entirely untouched — still the
per-creature contract, still `combatPlan.ts`'s old replay path — so this bundles only the
attacker-side half of what Phase 5 would otherwise have needed to do:

- **`declareAttackers` rewritten** (`combat.ts`) as the propose/validate/retry/repair loop items
  14/16/17 describe: `buildAttackSubjects` computes every eligible creature's legal defenders and
  `mustAttack` (unchanged logic from Phase 3a's fix); `buildAttackOption` reuses the existing
  multi-slot `targets` mechanism (one slot per creature) instead of a new wire shape;
  `validateAttackDeclaration` checks only the joint attack-tax case per-defender-group, since
  per-slot legality already rules out everything else; `applyAttackDeclaration` pays each
  defender-group's tax once and commits the whole set; `repairAttackDeclaration` implements the
  `'minimum-change'` policy. A defense-in-depth "must attack but was left undeclared" check guards
  the one invariant `Engine.submit()`'s slot-option validation would normally guarantee but that
  code driving the generator directly (`pump()` in tests) bypasses.
- **`packages/shared`** gained `AttackDeclarationSubject`, `CombatViolation`, `CombatRejection`,
  `AttackDeclarationPresentation`, and the `NO_ATTACK_TARGET` sentinel (`engine.ts`), plus
  `DecisionPresentation`'s `'attackDeclaration'` layout and `attackDeclaration?` field — additive,
  every other decision type and `combat`'s existing (blocker) shape is untouched.
- **`packages/bot`** (`evaluate.ts`) gained a dedicated `attackDeclarationTargets` per-slot chooser
  — attack the legal defender at the lowest life total (item 8's threat weighting, in its simplest
  honest form) rather than `firstTargets`' positionally-arbitrary pick. Full keyword-aware group
  evaluation (trades, visible blockers) is still a Workstream A refinement, not built here.
- **`packages/server/src/ai/heuristics.ts`**'s zero-power-attack cost optimization (Rule B) would
  have gone silently dead — it pattern-matched the old `noAttack`/`noAttackRest` option types,
  which the new contract never produces — so it was rewritten against `data.subjects` (a new
  `AttackDeclarationSubject`-shaped field added to `LegalAction.data` for exactly this, since
  `presentation` is UI-only and never reaches the AI/heuristics layer): decline the whole
  declaration locally, at zero model-call cost, when every eligible creature is powerless,
  trigger-free, and not `mustAttack`; a mixed board goes to the model, which now handles every
  subject in the one call it already gets instead of needing a per-creature heuristic pass.
- **`packages/server/src/ai/primer.ts`** rewritten to describe the new one-decision, one-slot-per-
  creature attacker contract (including the `NO_ATTACK_TARGET` sentinel) in place of the old
  per-creature/`attackRest` guidance; blocker guidance is unchanged.
- **`apps/web/src/stores/combatPlan.ts`** reworked for attackers only: `onRequest` now detects
  `presentation.attackDeclaration`, builds the same `order`/`assignment` shape the UI already
  rendered from, and a new `pendingSubmission(request)` returns one `{ actionId, targets }` to
  submit in a single call on `confirm()` — no more per-creature replay for attackers. A rejected
  retry (`attackDeclaration.rejection` present) drops the store back into `composing`, carrying
  over whatever of the prior assignment is still legal, with a new `rejectionMessage` field the
  template surfaces inline; a `mustAttack` creature left unassigned at submit time defaults to its
  first legal defender rather than producing a declaration the engine would refuse. Blockers are
  untouched in this phase — same `answerCurrent` replay path as before, superseded in Phase 4 (see
  below), where `answerCurrent` is deleted entirely rather than merely gaining a blocker branch.
  `PlayerGameView.vue` picked up the matching small changes: `confirmCombatPlan` submits via
  `pendingSubmission` for attackers, the replay-loop watcher only fires for `kind === 'blockers'`,
  and the "stay home" control is hidden for a `mustAttack` entry instead of offering a choice the
  engine would reject.
- **Found and fixed along the way, unrelated to this ADR**: `packages/engine/tests/fixtures.js`/
  `.d.ts` (plus `.map`s) were stale compiled artifacts sitting next to `fixtures.ts` — untracked,
  predating this session — that Node's module resolution was silently preferring over the real
  `.ts` source, so edits to `fixtures.ts` (the new `declareAttacks`/`declareNoAttacks` test
  helpers, below) had no effect at runtime until they were deleted. Not regenerated by any project
  script (`typecheck:tests` is `--noEmit`); their origin is unknown, but removing them is a pure
  correctness fix for anyone editing that file.
- **Test coverage**: `combat.test.ts` rewritten throughout for the batched contract, with two new
  `fixtures.ts` helpers (`declareAttacks(decision, chooseDefender)` builds a full per-slot outcome
  from a callback, throwing if it's asked to decline a `mustAttack` subject; `declareNoAttacks` is
  the all-decline shorthand) — both operate on the engine-internal `PendingDecision`, so they read
  `presentationAttackDeclaration` directly rather than parsing option descriptions.
  `combat-presentation.test.ts`, `trigger-events.test.ts`, `trigger-events-2.test.ts`, and
  `tokens.test.ts` updated for the same contract change (all had local `attackAll`-style helpers
  scripting the old per-creature menu). `heuristics.test.ts` and `combatPlan.test.ts` rewritten for
  their respective new shapes.
- **Full-suite timeout headroom bumped again**: batched declarations add an occasional
  rejection/retry cycle on top of Phase 3a's per-step damage-division ask, which — combined,
  apparently, with this session's own heavy sequential tool usage inflating background load —
  pushed `determinism.test.ts`/`fullgame.test.ts`'s already-bumped 20s timeouts to actually time
  out under a full-suite parallel run; `session.test.ts`'s three `finishedGame()`-based tests
  (also full random-fuzzed games, previously undertimed) hit the same wall. All bumped to 30s;
  isolated runs complete in 4-10s, so this is headroom for parallel contention, not a real slowdown
  of that magnitude.
- All 121 test files / 1004 tests pass across `packages/engine`, `packages/server`, `packages/bot`,
  and `apps/web`; full monorepo `tsc --build` and `tsc -p packages/engine/tsconfig.test.json
--noEmit` are clean; lint is unaffected (`combat.ts` still carries only the one pre-existing,
  unrelated `attachedToPlayerId` error; the 84 total repo lint errors are entirely in files this
  session never touched — pre-existing WIP predating this session, per the git status at its
  start); every touched file is `prettier`-clean.

Phase 4 landed, including the browser's blocker-side rework that Phase 5's row originally reserved
as its own phase — the same reasoning that drove bundling the attacker-side rework into Phase 3b
applies again: batching `declareBlockers`' contract without also reworking `combatPlan.ts` in the
same pass would have broken single-player blocking in the gap between phases. That decision wasn't
re-asked this time; it was applied as the established precedent from 3b, disclosed as such rather
than silently assumed.

- **`declareBlockers` rewritten** (`combat.ts`) as the exact `declareAttackers` propose/validate/
  retry/repair shape, retargeted at menace instead of attack tax: `blockCandidatesFor` snapshots
  every candidate blocker and its legal attackers up front (assigning one block never taps the
  blocker or removes an attacker, so — like attacker eligibility — this can't change mid-
  declaration); `buildBlockSubjects`/`buildBlockOption` build the per-defender-player decision;
  `validateBlockDeclaration` groups the proposed assignment by attacker and flags any menace
  attacker left with fewer than two blockers; `applyBlockDeclaration` commits the whole validated
  set; `repairBlockDeclaration` implements `'minimum-change'` for the blocker side (item 17). The
  same defense-in-depth "must block but was left undeclared" guard `declareAttackers` has protects
  `pump()`-driven tests the same way. One batched decision per DEFENDING PLAYER, in APNAP order —
  multiple defending players (a multi-attacked combat) still each get their own decision, since
  each is a different decider, but every one of THEIR creatures is asked about in that one call.
- **Menace validation replaces the old post-hoc undo.** The pre-Phase-4 code let an illegal single
  block onto a menace attacker get committed, then found and undid it after the fact
  (`menaceViolations`, since deleted). The batched validator catches it before commit, as one more
  instance of the same propose-and-validate pattern attack tax already established — a genuine
  simplification, not just a rename, since "commit then undo" and "reject and let the proposer fix
  it (or have the engine repair it)" are different guarantees about what state the game ever
  actually enters.
- **Damage division widened to true arbitrary split** (item 18): `assignDamageOrder` is gone,
  replaced by `assignDamageDivisions`, which asks via the new `combatDamageSplit` one-call
  distribution field (mirroring `manaSplit`'s existing wire shape) instead of an ordering pick.
  `resolveDamageDivision` validates the response — well-formed (integers, non-negative, summing to
  the attacker's power, over exactly the offered targets) and, only when the attacker has trample
  and the split names the defending player, that every blocker in the split already has lethal
  (CR 702.19b) — falling back to dumping the whole amount on the first live blocker for anything
  malformed, mirroring `addManaFromAbility`'s own single-bucket fallback. `dealCombatDamage` now
  takes the resolved `DamageDivisions` map as a parameter instead of recomputing a lethal-cascade
  from `blockedByOrdered`'s order; the 0-or-1-live-blocker forced cases (CR 510.1c's "assigns all
  its damage" / trample's own lethal-first-then-excess split with nothing to choose) stay inline,
  unchanged, since there's genuinely no decision to make there either way.
- **`packages/shared`** gained `BlockDeclarationSubject`, `BlockDeclarationPresentation`, and the
  `NO_BLOCK_TARGET` sentinel — the blocker-side mirrors of Phase 3b's attacker types — plus
  `'menace'` added to `CombatViolation.kind`'s union and `combatDamageSplit` added alongside
  `manaSplit` on `DecisionRequest`/`DecisionResponse`. The now-fully-obsolete per-creature
  `CombatDeclaration`/`CombatSubject` types and `DecisionPresentation.combat`/`layout: 'combat'`
  were deleted outright rather than left dead: once blockers batched too, nothing built `kind:
'blockers'` presentation any more, and this ADR's own convention (Phase 3b already established
  it for `damageOrder`'s `EngineActionOption.type`) is to remove a shape once its last producer is
  gone rather than carry it as unreachable scaffolding.
- **`packages/bot`** (`evaluate.ts`) gained `blockDeclarationTargets` (per-slot: block the biggest
  incoming attacker this blocker can either survive or trade with, or — once its controller is at
  `WEIGHTS.dangerousLifeThreshold` or below — any attacker at all, chump-blocking rather than
  taking the damage; declines otherwise) and `combatDamageSplitFor` (kills blockers cheapest-
  lethal-first until the attacker's power runs out, sending any leftover over the top with
  trample). Both are the same "simplest honest realization" of item 8 the attacker side landed
  with in 3b — no cross-blocker coordination, no full keyword-aware group evaluation (that stays a
  Workstream A refinement) — and `combatDamageSplitFor` in particular reads blocker toughness as
  the "lethal" estimate since `PermanentView` doesn't expose damage already marked or deathtouch
  (item 20's still-deferred projection gap): always a safe overestimate, never an illegal split.
- **`packages/server/src/ai/heuristics.ts` needed no change.** Its zero-power-attack rule (Rule B)
  gates on `decisionType === 'declareAttackers'` explicitly, so the blocker contract change never
  touched it; unlike Phase 3b's attacker-side heuristic fix, there was no dead-rule regression to
  catch here, because no blocker-declining heuristic exists (declining a block is a genuine
  judgment call, per the file's own stated scope, not a dominated-option shortcut).
- **`packages/server/src/ai/primer.ts`** rewritten to describe the batched blocker contract
  (`NO_BLOCK_TARGET`, menace's two-blocker requirement) alongside the existing attacker paragraph,
  plus a new paragraph for `combatDamageSplit` covering the trample constraint in prose. `context.ts`
  gained a `combatDamageSplit`/`responseFormat` hint mirrored from `manaSplit`'s existing one, and
  `client.ts` gained the matching response-parsing branch.
- **`apps/web/src/stores/combatPlan.ts` rewritten, not just extended** — with blockers now batched
  too, the store's entire reason for a replay loop (`answerCurrent`, `answered`, `currentEntry`,
  and the `'interrupted'` mode that existed only to recover from a stale board mid-replay)
  disappeared, since nothing submits more than once per declaration on either side any more.
  `pendingSubmission` is now one function handling both `kind`s (reading
  `attackDeclaration`/`blockDeclaration` presentation and `mustAttack`/`mustBlock` by `kind`)
  instead of attacker-only; `CombatPlanEntry.mustAttack` is renamed `mustAct` since it now means
  either "must attack" or "must block" depending on `kind`. `PlayerGameView.vue` simplified to
  match: the `watch(request, ...)` handler that used to drive blocker replay is now just
  `combatPlan.onRequest(req)`, `confirmCombatPlan` is unconditional (`pendingSubmission` +
  submit), and every `combatPlan.mode === 'interrupted'` branch in the template is gone. This
  finishes what Phase 5's row would have done, ahead of schedule, per the bundling decision above.
- **Found and fixed along the way, unrelated to this ADR**: `packages/engine/tests/fixtures.js`/
  `.d.ts` (plus `.map`s) reappeared next to `fixtures.ts` partway through this session — the same
  stale-artifact class Phase 3b already deleted once, regenerated by an incidental full (non-
  `--noEmit`) `tsc --build` run during this session's own verification work, silently shadowing
  three new `fixtures.ts` exports (`declareBlocks`, `declareNoBlocks`, `splitDamage`) at runtime
  despite a clean typecheck. Deleted again; still not produced by any project script
  (`typecheck:tests` stays `--noEmit`), so this remains a build-tooling footgun to watch for after
  any ad hoc non-`--noEmit` `tsc --build` invocation, not a recurring one under normal `bun run`
  usage.
- **A real regression caught before it shipped, not by a test failure**: two `trigger-events-2.test.ts`
  cases matched the old per-creature block menu by regexing option descriptions for `/blocks/`
  (`"X blocks Y"`). Against the batched contract that regex matches nothing (the one option's
  description is `"Declare blockers (N eligible creature(s))"`, which doesn't contain the
  substring `"blocks"`), so both silently fell through to "decline everything" — and because
  `pump()` drives the generator directly, bypassing `Engine.submit()`'s slot validation, that
  produced a legal-looking outcome instead of an error. One test's assertion still held by
  coincidence (it only checks the trigger fires once total, which is true whether or not the
  block happened); the other's didn't (`fires when a Dragon connects, and not when it is blocked
out`, which needs the block to actually occur) and failed loudly. Both rewritten with the new
  `declareBlocks` fixture helper, which reads `presentationBlockDeclaration` directly instead of
  parsing descriptions — the same reason `declareAttacks` was built that way in Phase 3b.
- **Test coverage**: `combat.test.ts`'s block-related cases (the Giant-Growth worked example,
  first strike, trample/deathtouch, flying evasion) converted to a new `blockWith` fixture helper
  mirroring `attackWith`; the old damage-assignment-_order_ test replaced with three division
  tests (asks at the right step; arbitrary lopsided division, not lethal-cascade; the malformed-
  split fallback); the old "no-blocks-at-all shortcut" test — meaningless once batching IS the
  shortcut — replaced with three new tests covering batching itself, gang-blocking, and the
  menace reject-then-repair cycle end to end. `combat-presentation.test.ts`'s blocker case rewritten
  to check `blockDeclaration`'s per-slot shape the same way its attacker case already checked
  `attackDeclaration`'s. New `fixtures.ts` helpers: `declareBlocks`/`declareNoBlocks` (the
  `declareAttacks`/`declareNoAttacks` mirror) and `splitDamage` (builds a `combatDamageSplit`
  outcome directly). `packages/bot/src/evaluate.test.ts` gained coverage for
  `blockDeclarationTargets` and `combatDamageSplitFor` via `decide()`. `heuristics.test.ts`'s two
  stale blocker fixtures (scripting the old `noBlock`/`block`/`noBlockRest` option types) collapsed
  into one accurate test of the batched shape.
- **No timeout changes needed this time** — the full suite, including the previously-bumped 30s
  tests, passed in one run without further headroom.
- **A pre-existing, unrelated gap surfaced by a from-scratch rebuild**: a plain (non-`--force`)
  `tsc --build` after this session's earlier `--force` runs had cleared the incremental
  `.tsbuildinfo` caches reported `packages/server/src/cards/card-suite-l1-l3.test.ts` (and three
  other server test files) violating `rootDir` by importing
  `packages/engine/tests/fixtures.ts` directly across the package boundary. This predates this
  session — none of the implicated files, nor `packages/server/tsconfig.json`'s `include`/`rootDir`
  settings, were touched by this work — and most likely was never actually re-verified by a truly
  clean build before now, since normal incremental builds don't reprocess a project boundary that
  hasn't changed. Left unfixed as out of scope for this ADR; worth a follow-up since it means the
  documented `bun run typecheck` may not be catching everything it appears to between clean
  checkouts.
- All 123 test files / 1025 tests pass across `packages/engine`, `packages/server`, `packages/bot`,
  and `apps/web` — 2 more files (`fixtures.ts` change didn't add a file; the two new/expanded
  cross-package test additions did) and 21 more tests than Phase 3b's count. Every package
  typechecks clean in isolation (`packages/shared`, `packages/engine` incl. `tsconfig.test.json`,
  `packages/bot`, `apps/web`); `packages/server` typechecks clean except the pre-existing rootDir
  gap noted above. Lint is unaffected — zero new errors in any file this phase touched; the
  repo-wide error count and `combat.ts`'s one pre-existing `attachedToPlayerId as any` are
  unchanged from Phase 3b. Every touched file is `prettier`-clean.
