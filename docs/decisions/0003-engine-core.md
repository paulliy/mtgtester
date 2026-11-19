# 0003 — Engine core (Phase 2)

Date: 2026-07-24
Status: Accepted (2026-07-24)
Status note: implementation
Context: brief §5 (rules engine), §6 (hybrid boundary), §14.1 (Phase 2), §12 (testing).

Phase 2 delivers the deterministic rules engine: game state with identity-stable objects,
seeded RNG, the full CR 500–514 turn structure, priority/APNAP, the stack, state-based
actions, combat, Commander rules, London mulligans, and complete legal-action generation —
driven by scripted/random decision providers, no AI. A full four-player game plays from
opening hands to a single winner (see Verification).

## Architecture decisions

1. **Generator-driven flow behind the `advance()`/`submit()` driver (brief §5.1).** The
   whole game is one generator (`playGame`) built from sub-generators (turns, priority
   sequences, combat, SBA checkpoints, zone moves). Decision points `yield`; the `Engine`
   pump either surfaces them as `DecisionRequest`s or **auto-resolves forced decisions**
   (exactly one option, no real target choice) without surfacing — the §5.1 cost lever.
   In the demo game only 328 of thousands of decision points were surfaced.
   Consequence: engine state is not serializable mid-decision (a generator holds the
   continuation); recovery/replay is by seed + decision log, per brief §4. `advance()`
   currently never returns `{kind:'continue'}` — it runs to the next decision or game
   over. Turn-boundary checkpoint yields can be added when Phase 4 needs them.

2. **Stable `cardId` alongside CR 400.7 object identity.** Zone changes mint a new
   `ObjectId` (CR 400.7); every physical card also carries an immutable `cardId` assigned
   at game creation. Commander tax (`commanderCastCount`) and commander damage
   (`commanderDamageTaken`) are keyed by `cardId`, because commander-ness is a property of
   the physical card (brief §5.7) and must survive re-zoning. The shared types' `Record<ObjectId, …>`
   fields hold these strings unchanged.

3. **CR text over brief simplifications, recorded here (brief §14.2.4):**
   - _Priority after casting_: the brief (§5.4) says the active player receives priority
     after any cast. CR 117.3c says the **caster** retains priority; we implement the CR.
     All-players-pass-in-succession before resolution holds either way (tested).
   - _Commander zone returns_: the brief (§5.7) describes one replacement effect covering
     graveyard/exile/hand/library. Current CR splits it: graveyard/exile is a
     **state-based action** (CR 903.9a, offered once per arrival at the next SBA check);
     hand/library is a true **replacement** (CR 903.9b, applied mid-move). Both are owner
     decisions; all four zones are tested.
   - _Active player leaves the game_: CR 800.4j continues the turn without an active
     player. Phase 2 simplification: the stack finishes resolving among survivors, then
     the remainder of the turn is skipped. (Combat and further phases without an AP are
     meaningless in our modeled card pool.)
   - _Tokens_: cease immediately on leaving the battlefield rather than at the next SBA
     check (indistinguishable in the Phase 2 pool; dies-triggers still fire).

4. **The engine auto-pays mana costs.** Which lands to tap is engine-chosen by a
   deterministic solver, not an AI decision — the strategic content is negligible next to
   the API cost of asking (Phase 3). The solver is exact: a backtracking search over
   per-unit symbol choices, with an arithmetic fast path when every source produces
   single-choice units (all Phase 2 sources; the backtracking path degenerated on
   unpayable costs over many interchangeable lands). Floating pool mana is spent before
   tapping; pools empty at each step/phase end (CR 500.4). Permanents with **multiple**
   mana abilities halt as unmodeled (choice-of-ability not implemented). The plan carries
   the **specific symbol produced by each tapped unit** (`PaymentPlan.produced`), and
   payment adds exactly that to the pool — so a multi-color source ("Add {W} or {U}") pays
   the color the cost needs rather than its first symbol. (Single-symbol Phase 2 sources
   are unaffected; behavior stays byte-identical.)

5. **Multi-select decisions are sequential single-pick menus.** Attack declarations (one
   decision per eligible creature: which opponent or none), blocks (per potential
   blocker), damage-assignment order, trigger ordering, mulligan bottoming, and cleanup
   discard all decompose into pick-one-by-id decisions, matching the §7.3 contract
   exactly. Costs more (cheap) decisions; avoids an exponential combined action space.
   Combination-constrained blocking restrictions (menace) are deferred (see cuts).

6. **Oracle-text interpreter with full-line accounting (brief §6).** Every line of rules
   text must map to an implemented keyword list, a mana ability, an enters-tapped clause,
   a trigger pattern, or spell-effect sentence patterns — otherwise the card is
   `modeled: false` with specific reasons. The engine halts (`UnmodeledCardError` → a
   `halted` GameResult, never a wrong game — §6.3) the moment an unmodeled card sits in a
   deciding player's hand or command zone at legality-generation time: castability of an
   unknown card cannot be adjudicated, so the complete-legal-menu guarantee would break.
   The `unmodeledReasons` strings are the mechanics backlog. Tests inject custom
   `CardDefinition`s (auras, planeswalkers, equipment) to exercise SBAs the interpreter
   can't yet produce from text.

7. **Combat damage follows CR defaults deterministically.** Blocked attackers assign
   lethal (deathtouch ⇒ 1) to each blocker in the chosen order; excess goes to the last
   blocker, or to the defending player with trample (CR 510.1c-d, 702.19). No manual
   damage-division decision in Phase 2. First/double strike create the extra damage step
   only when present (CR 510.5). Commander damage: combat only, per (victim, commander
   cardId) pair, 21 eliminates via SBA (CR 903.10a).

8. **Continuous effects: until-end-of-turn P/T deltas and keyword grants only.** Effective
   P/T = printed + counters + until-EOT deltas; cleared in cleanup (CR 514.2). The full
   CR 613 layer system (timestamps, dependencies, CDAs) is deliberately deferred until a
   mechanic needs it; `GameState.effects` is the seam.

9. **Event log vs debug log (brief §13).** `GameState.eventLog` is the replayable record
   (determinism test compares it byte-for-byte; surfaced decisions are logged as events
   with request ids). The engine-internal debug log (SBA checks, priority passes, legal
   action sets, zone changes, auto-resolutions) is separate via `getDebugLog()`. The
   `PlayerView` recent-log filters events that reveal hidden information (decision
   records, draw identities, any library-touching zone change).

10. **Providers and the driver.** `RandomDecisionProvider` (seeded, per-seat) and
    `ScriptedDecisionProvider`/rule-based test providers drive games via
    `runToCompletion`. `submit()` validates responses against the offered menu and throws
    `IllegalDecisionError` leaving state unchanged (the §7.7 retry chain builds on this in
    Phase 3). `view(playerId)` exposes the §7.1 `PlayerView` projection.

## Phase 2 scope cuts (brief §16.1 — flagged for approval, not silent)

Implemented keywords: flying, reach, trample, deathtouch, lifelink, first/double strike,
vigilance, haste, defender, indestructible, hexproof, flash. **Unmodeled (halt loudly):**
menace (needs block-set constraint validation), ward, protection, {X}/hybrid/Phyrexian/snow
costs, modal spells, auras/equipment as casts, non-mana activated abilities (including
planeswalker loyalty abilities), multi-choice mana abilities ("Add {G} or {W}") as _card
text_, non-`normal` layouts (DFC/split/adventure), `*` power/toughness. Each halts with a
named reason rather than misplaying; they form the ordered backlog for early Phase 3 /
follow-up work, sized by how often real decks hit them.

## Post-review follow-ups (2026-07-24)

A rules review flagged two latent traps; both are now fixed:

- **Planeswalkers and battles are permanent card types.** Structural handling is complete:
  the interpreter accepts both types and requires a readable starting loyalty/defense; such
  a spell resolves **onto the battlefield** (was: graveyard) under its caster, entering with
  its printed loyalty/defense counters (CR 306.5b / 310.6); and it leaves via the matching
  SBA when that reaches zero (CR 704.5i / 704.5s). Their _abilities_ (loyalty abilities;
  attacking/defending a battle) remain unmodeled — and every real planeswalker/battle is
  double-faced, so real cards still halt — but a single-faced or fixture-injected one is now
  handled correctly instead of being tucked to the graveyard on resolution.
- **Payment consistency** — see decision 4: the payment planner now returns the exact mana
  it chose (`produced`), and `payCost` adds that rather than each source's first symbol, so
  a future multi-color source can never mispay.

## Verification

- `typecheck` / `lint` / `test` green — 122 tests (incl. planeswalker/battle enter-and-die,
  and multi-color payment `produced` correctness).
- §12 scenario coverage: stack LIFO; counterspell; fizzle on illegal target; the
  Giant-Growth-during-blocks §5.4 worked example end to end; APNAP with four players
  (incl. caster-retains-priority and zero-response auto-pass); simultaneous triggers for
  the same and different controllers; every §5.6 SBA (incl. legend rule choice, aura,
  equipment, counter annihilation, token cease, simultaneous-loss draw halt); commander
  tax over multiple casts; command-zone returns from graveyard, exile, hand, and library;
  21 commander damage across seven combats with the game continuing among three
  survivors; first-strike second damage step; mid-game elimination with play continuing;
  London mulligan free-first-mulligan hand sizes and the 8-mulligan cap; determinism
  (byte-identical event logs for same seed + decisions); `PlayerView` hidden-information
  absence; full four-player random games to a winner across multiple seeds.
- Demo (`bun demo`, scratch script): seed `phase2-demo-seed` → P3 wins on turn 87 of a
  random-decision pod; 2,685 events, only 328 surfaced decisions; eliminations by combat
  (life), and deckout; mulligans taken 0/1/2/0.
