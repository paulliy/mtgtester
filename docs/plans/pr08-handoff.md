# PR08 handoff: control changes and multiplayer choices

Prepared 2026-10-17 from `origin/main` at `af01d79` (PR07 merged, 786/906). This is the starting
brief for whoever builds PR08. The authoritative scope, card table and per-PR rules are in
[card coverage chunks](card-coverage-chunks.md#pr08-control-changes-and-multiplayer-choices); this
note adds the oracle text, what the engine already has, the open decisions, a suggested commit
order and the lessons from PR01–PR07.

## Goal

Model all 23 PR08 cards faithfully, one card per commit, every commit green. Expected result:
**809/906** combined (786 + 23). The plan's "814" column assumed the seven cards reopened by main's
quality merge would be owned by some PR; they are still unowned (see [Open decisions](#open-decisions)).

Deck deltas when PR08 lands (a card in two decks counts in both): PRA −10, QMQ −7, FF4 −3, MAR −2,
SIL −1, LEN −1, BRI −1, staples −1 (Boseiju). PRA then has the planned 6 left plus the reopened
Dingus Staff.

## Before the first card

1. Branch from current `main` (use the branch the session is assigned; otherwise
   `cards/pr08-control-choices`). Open the PR **as a draft** early: since PR07's CI change, draft
   PRs skip `engine-tests` and `viewer-evidence`, which saves Actions minutes. Mark it ready only
   when every card is done and the local gates pass. The account's Actions minutes ran out in
   October 2026; check the billing page before relying on CI.
2. First commit (docs only): fix the stale status line at the top of `card-coverage-chunks.md`
   ("PR06 is in review and PR07 is next" → PR01–PR07 complete, PR08 in progress).
3. Create the PR08 scaffolding, following the PR07 files:
   - `packages/engine/src/cards/overrides/coverage-pr08.ts`, registered in
     `packages/engine/src/cards/overrides/index.ts` (`registerDeck('coverage-pr08', …)`);
   - `packages/engine/tests/pr08-card-coverage.test.ts`;
   - `packages/server/src/cards/card-test-scenarios-pr08.test.ts`, with scenarios in
     `card-test-scenarios.ts` and manifest entries;
   - add both new test files to the `test:card-gate` script in `package.json`.
     The old fail-closed entries stay in their deck override files (listed per card below) until each
     card's commit replaces them; see how `coverage-pr07` is referenced from the deck files.

## Engine survey: what exists, what is missing

Paths are under `packages/engine/src`. The survey used grep and was not exhaustive. Confirm a gap
before building for it.

| Area                       | Exists                                                                                                                                                                                                                                                                                                                         | Missing for PR08                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gain control               | `gainControlTarget` (`cards/ability.ts:829`, `effects/resolve.ts:2703`), `gainControl {selector}` (`ability.ts:1150`, `resolve.ts:5307`), `regainControlOfOwnCreatures` (`ability.ts:1255`, `resolve.ts:2266`). Control is **mutated** by `changeController` (`state/objects.ts:264`), which appends to `perm.controlChanges`. | No duration (until end of turn, for as long as X remains). No recipient other than the source's controller (target opponent / an opponent / each player / that player). No simultaneous exchange.                            |
| Activation timing          | `timing: 'any' \| 'sorcery'` (`cards/templates.ts:365`, checked in `actions/legal.ts:1615/1800/1874`). `yourTurnOnly` exists only for statics (`legal.ts:390/449`).                                                                                                                                                            | An "activate only during your turn" timing for activated abilities.                                                                                                                                                          |
| Decisions to other players | `PendingDecision.player` (`decisions.ts:45`) can address any player. Ops that loop over players: `discardEachPlayer` (APNAP), `eachPlayerKeepsCreatureWithVow`, `eachPlayerDiscardHandThenDraw`.                                                                                                                               | A generic "starting with you, each player [may] choose …" step, where later players see earlier choices. Voting. A caster choosing on behalf of every player (Tragic Arrogance).                                             |
| Choose an opponent         | `chooseOpponentForSource` (`ability.ts:1435`, `resolve.ts:5575`) stores the choice on a source permanent.                                                                                                                                                                                                                      | Choosing an opponent at resolution, bound to the resolving spell or ability (Benevolent Offering chooses twice, independently).                                                                                              |
| Modes                      | `modes` (`ability.ts:1980`): `minChoices`, `maxChoices`, `repeatable`, `maxChoicesIf`, per-mode `targetSlots`. Chosen at announcement.                                                                                                                                                                                         | A "different target player per mode" constraint. Optional "you may choose two" (0 or exactly 2). Modes on **triggered** abilities, which still needs confirming (Shadrix, Vindictive Lich).                                  |
| Unless pays                | `unlessPays {payer: 'eventPlayer' \| 'controller', cost}` (`ability.ts:1329`).                                                                                                                                                                                                                                                 | Probably enough for Kazuul if the attack trigger binds the attacking creature's controller as the event player. Verify.                                                                                                      |
| Searching libraries        | `searchLibrary` (`ability.ts:967`); destinations include `libraryTop` (`:1718`).                                                                                                                                                                                                                                               | Another player as the searcher (target player, the exiled creature's controller, "that player may"). "Shuffle, then put that card on top" ordering.                                                                          |
| Goad / counters            | `goad`, `goadEachOpponent`, `tapAndGoadEachChosen`.                                                                                                                                                                                                                                                                            | "Each player may put two +1/+1 counters on a creature they control", then goad exactly those creatures.                                                                                                                      |
| Channel / overload         | `discardSelf` cost with `zone: 'hand'` (Kogla and Yidaro in `coverage-pr01.ts` / `coverage-pr02.ts`). Overload exists, but its only op is card-specific (`overloadBounceAllNonlandOpponents`, `ability.ts:1379`).                                                                                                              | A cost reduction per legendary creature you control (check `costReductionFor`, `casting/cast.ts:744`). Generic overload ("target" → "each") for Winds of Abandon.                                                            |
| Misc                       | Spell history (PR04) for "cast a noncreature spell this turn". Attack requirements and restrictions (PR07).                                                                                                                                                                                                                    | Owner chooses top or bottom per object. "Can't be sacrificed". "Can't attack its owner". Counts that depend on an earlier step's result ("each opponent who drew a card this way", "the power of the creature they exiled"). |

## Open decisions

Settle these before writing code. The first two are rules-correctness calls for the main thread.

1. **Control as layer-2 effects or as mutation.** Durations need control that reverts correctly when
   several effects overlap. Example: a Mob Rule steal ends while a permanent Humble Defector-style
   change was applied later. Under CR 613.1b and 613.7, the controller is whatever the
   latest-timestamped control effect still in force says, falling back to the owner. Recommended:
   keep `perm.controlChanges` as the record, give each entry an expiry (`endOfTurn`, `whileSourceOnBattlefield: ObjectId`,
   `permanent`), and recompute `controllerId` whenever an entry ends. Cleanup ends the
   until-end-of-turn entries (CR 514.2). Leaving the battlefield ends the source-bound ones. A
   player leaving ends every entry that gave that player control (CR 800.4a). Expiring a change must
   go through the same path as gaining control: timestamp, summoning sickness, removal from combat
   (CR 506.4), and retargeting of "you control" auras.
2. **Seven cards no PR owns:** Black Bolt and Dingus Staff (IR validation), Sivitri and Zurgo and
   Ojutai (executable `noOp`), Bloomvine Regent, Marang River Regent and Monster Manual (contained).
   Either fold them into PR08–PR11 where their mechanics fit, or add a PR12. Ask the user. Without
   them, 906/906 can't be reached.
3. **Kazuul's payer.** Does the attack trigger already expose the attacking creature's controller as
   the event player? If not, add a payer reference instead of a Kazuul-only op.

## Suggested order (shared primitive first, then the cards that reuse it)

| Step | Primitive introduced                                                             | Cards                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Control durations and recipients (decision 1)                                    | 8.08 Mob Rule (until end of turn, plus untap and haste), 8.06 Cytoplast Manipulator (while source remains), 8.17 Reins of Power (simultaneous swap, until end of turn) |
| B    | Recipient = opponent; "only during your turn" activation timing                  | 8.03 Humble Defector, 8.05 Wishclaw Talisman, 8.20 Akroan Horse                                                                                                        |
| C    | Per-player control and owner-keyed restrictions                                  | 8.14 Alicia Masters, 8.21 Alexios, 8.23 Varchild                                                                                                                       |
| D    | "Starting with you, each player chooses"; voting; caster chooses for each player | 8.02 Druid of Purification, 8.15 Council's Judgment, 8.18 Tragic Arrogance, 8.13 Agitator Ant                                                                          |
| E    | Opponent or owner decisions on their own objects; result-dependent counts        | 8.12 Aetherspouts, 8.07 Olórin's Searing Light, 8.01 Cut a Deal, 8.22 Benevolent Offering                                                                              |
| F    | Modes on triggers with different target players                                  | 8.09 Shadrix Silverquill, 8.10 Vindictive Lich                                                                                                                         |
| G    | Another player searches; overload; channel cost reduction                        | 8.04 Scheming Symmetry, 8.19 Winds of Abandon, 8.11 Boseiju                                                                                                            |
| H    | Unless-pays by the attacking creature's controller                               | 8.16 Kazuul                                                                                                                                                            |

## Cards

Oracle text is from `packages/server/fixtures/coverage-oracle.json`. "Notes" are the clauses and
rulings to test. Verify rulings marked _check_ against Scryfall rulings before relying on them.

#### 8.01 Cut a Deal — {2}{W} Sorcery · QMQ, FF4 · fail-closed (`queen-marchesa-queens-gambit-remaining.ts:192`)

`8b5cffd5-5db3-4151-9275-d91387554412`

> Each opponent draws a card, then you draw a card for each opponent who drew a card this way.

Notes: an opponent with an empty library doesn't draw, so it doesn't count. A draw replaced by
something else also doesn't count (_check_). Eliminated players are not opponents.

#### 8.02 Druid of Purification — {3}{G} Creature · LEN · fail-closed (`living-energy.ts:1106`)

`5bb32efd-9e58-4021-bbda-4ffccfa1d601`

> When this creature enters, starting with you, each player may choose an artifact or enchantment you don't control. Destroy each permanent chosen this way.

Notes: "you" is the Druid's controller for every chooser. The choices don't target, so hexproof
doesn't apply. Choices are made in turn order and are visible. Each player may decline. Two players
choosing the same permanent destroys it once.

#### 8.03 Humble Defector — {1}{R} Creature · PRA, QMQ · fail-closed (`queen-marchesa-queens-gambit-remaining.ts:254`)

`1582e16d-4825-4cc5-b12c-449c45e4e449`

> {T}: Draw two cards. Target opponent gains control of this creature. Activate only during your turn.

Notes: the new controller can activate it on their own turn. If the target becomes illegal, the
whole ability fizzles and no cards are drawn. The control change is permanent.

#### 8.04 Scheming Symmetry — {B} Sorcery · QMQ · fail-closed (`queen-marchesa-queens-gambit-remaining.ts:318`)

`6dfb50d7-359b-4644-90e3-7ecdacee7c12`

> Choose two target players. Each of them searches their library for a card, then shuffles and puts that card on top.

Notes: each target player searches their own library and picks the card. The card goes on top after
the shuffle. The two targets must be different players, and you may target yourself.

#### 8.05 Wishclaw Talisman — {1}{B} Artifact · QMQ · fail-closed (`queen-marchesa-queens-gambit-remaining.ts:362`)

`81c70ae7-3c18-4c9b-8505-e4db9e0e6518`

> This artifact enters with three wish counters on it.
> {1}, {T}, Remove a wish counter from this artifact: Search your library for a card, put it into your hand, then shuffle. An opponent gains control of this artifact. Activate only during your turn.

Notes: you choose the opponent at resolution, without targeting. The control change is permanent.
The new controller can activate it on their turn.

#### 8.06 Cytoplast Manipulator — {2}{U}{U} Creature · MAR · fail-closed (`marchesa-the-black-rose.ts:156`)

`026ef98e-4f0a-4a6d-b74f-d17ac8b10e37`

> Graft 2 (This creature enters with two +1/+1 counters on it. Whenever another creature enters, you may move a +1/+1 counter from this creature onto it.)
> {U}, {T}: Gain control of target creature with a +1/+1 counter on it for as long as this creature remains on the battlefield.

Notes: control lasts only while the Manipulator stays on the battlefield. The stolen creature
losing its counter later doesn't end it. A Manipulator that leaves before the ability resolves gives
no control (_check_ CR 611.2b). Graft probably already exists; confirm.

#### 8.07 Olórin's Searing Light — {2}{R}{W} Instant · QMQ · fail-closed (`queen-marchesa-queens-gambit-remaining.ts:306`)

`e6f2ba06-2c92-48b7-a95f-ea6bf35aa0fe`

> Each opponent exiles a creature with the greatest power among creatures that player controls.
> Spell mastery — If there are two or more instant and/or sorcery cards in your graveyard, Olórin's Searing Light deals damage to each opponent equal to the power of the creature they exiled.

Notes: each opponent picks among their own tied creatures. Spell mastery is checked on resolution,
and the spell itself is still on the stack, so it doesn't count. The damage uses each exiled
creature's last-known power. An opponent with no creature takes no damage.

#### 8.08 Mob Rule — {4}{R}{R} Sorcery · QMQ · fail-closed (`queen-marchesa-queens-gambit.ts:207`)

`acca2128-6ebb-48a5-a6a2-1bc5e4aa86ce`

> Choose one — • Gain control of all creatures with power 4 or greater until end of turn. Untap those creatures. They gain haste until end of turn. • … power 3 or less …

Notes: the creature set is locked in on resolution, so a later power change doesn't add or release
creatures. It includes your own creatures, which also untap and gain haste. Control reverts at
cleanup.

#### 8.09 Shadrix Silverquill — {3}{W}{B} Legendary Creature · QMQ, SIL · fail-closed (`queen-marchesa-queens-gambit-remaining.ts:331`, also `silverquill-influence.ts:104`)

`2143f413-7baa-4fd6-a7ca-32f52bfa553f`

> Flying, double strike
> At the beginning of combat on your turn, you may choose two. Each mode must target a different player.
> • Target player creates a 2/1 white and black Inkling creature token with flying.
> • Target player draws a card and loses 1 life.
> • Target player puts a +1/+1 counter on each creature they control.

Notes: choose either no modes or exactly two different modes. The two targets must be two different
players, and you can be one of them. The Silverquill deck has a second entry; both must resolve to
the same faithful definition.

#### 8.10 Vindictive Lich — {3}{B} Creature · MAR · fail-closed (`marchesa-the-black-rose.ts:469`)

`6dc7f837-158f-4ccf-86a5-a07a20891ec5`

> When this creature dies, choose one or more. Each mode must target a different player.
> • Target opponent sacrifices a creature of their choice. • Target opponent discards two cards. • Target opponent loses 5 life.

Notes: choose one to three modes, with a different opponent for each. With a single opponent left,
at most one mode is legal.

#### 8.11 Boseiju, Who Endures — Legendary Land · staple · unmodeled

`bf1341dd-41a3-49f6-87ec-63170dde4324`

> {T}: Add {G}.
> Channel — {1}{G}, Discard this card: Destroy target artifact, enchantment, or nonbasic land an opponent controls. That player may search their library for a land card with a basic land type, put it onto the battlefield, then shuffle. This ability costs {1} less to activate for each legendary creature you control.

Notes: the reduction lowers only the generic part, so the minimum cost is {G}. The search is
optional, made by the destroyed permanent's controller, and finds any land with a basic land type
(for example dual lands with types). The land enters untapped.

#### 8.12 Aetherspouts — {3}{U}{U} Instant · PRA · unmodeled

`48369aec-a991-4bef-8554-01c84302b063`

> For each attacking creature, its owner puts it on their choice of the top or bottom of their library.

Notes: the owner decides, not the controller. When several cards go to the same position, the owner
orders them (_check_). Tokens cease to exist.

#### 8.13 Agitator Ant — {2}{R} Creature · PRA · unmodeled

`abe377f8-35f0-4dea-a681-91d31a36815c`

> At the beginning of your end step, each player may put two +1/+1 counters on a creature they control. Goad each creature that had counters put on it this way.

Notes: this includes you, so your own creatures get goaded by you as well. Only creatures that
actually received counters are goaded, so not one under a "can't have counters" effect. The goad
lasts until your next turn and uses PR07's goad store.

#### 8.14 Alicia Masters, Skilled Sculptor — {1}{R} Legendary Creature · FF4 · unmodeled

`223504ba-174a-46f2-a4a2-5d663a82dfd3`

> At the beginning of combat on your turn, if you've cast a noncreature spell this turn, create a Treasure token.
> Sense the Good — At the beginning of your end step, each player gains control of all creatures they own.

Notes: the first trigger has an intervening "if" checked both on triggering and on resolution
(spell history from PR04). For Sense the Good, check whether `regainControlOfOwnCreatures` is the
same thing as a new control effect with a fresh timestamp for each owner. It probably isn't once
control effects become layered.

#### 8.15 Council's Judgment — {1}{W}{W} Sorcery · PRA · unmodeled

`acf4d685-a718-42f7-9a7a-dee069ae8db2`

> Will of the council — Starting with you, each player votes for a nonland permanent you don't control. Exile each permanent with the most votes or tied for most votes.

Notes: voting doesn't target, so it gets past hexproof and protection. Each vote must be for a
nonland permanent the caster doesn't control. Every permanent tied for most votes is exiled. Votes
are public and cast in turn order.

#### 8.16 Kazuul, Tyrant of the Cliffs — {3}{R}{R} Legendary Creature · PRA · unmodeled

`f8bf3d91-cb50-48ce-88c6-cdcb37b64b57`

> Whenever a creature an opponent controls attacks, if you're the defending player, create a 3/3 red Ogre creature token unless that creature's controller pays {3}.

Notes: it triggers once per attacking creature. It counts only attacks on you, not on your
planeswalkers (_check_ the "defending player" meaning in CR 506.2). The attacking player decides
whether to pay.

#### 8.17 Reins of Power — {2}{U}{U} Instant · PRA · unmodeled

`96381388-1e82-411c-8290-1f3e909d3b5f`

> Untap all creatures you control and all creatures target opponent controls. You and that opponent each gain control of all creatures the other controls until end of turn. Those creatures gain haste until end of turn.

Notes: both sets are locked in before either control change. The control changes are simultaneous,
both revert at cleanup, and creatures removed from combat follow CR 506.4.

#### 8.18 Tragic Arrogance — {3}{W}{W} Sorcery · FF4 · unmodeled

`8a29bd35-33ef-4317-9fe5-8aaff5d7d64d`

> For each player, you choose from among the permanents that player controls an artifact, a creature, an enchantment, and a planeswalker. Then each player sacrifices all other nonland permanents they control.

Notes: the caster makes every choice, without targeting. Whether one permanent with several types
can fill several categories is a _check_ against Scryfall rulings. Lands are untouched. The
sacrifice is simultaneous.

#### 8.19 Winds of Abandon — {1}{W} Sorcery · BRI · unmodeled

`499a4715-6776-461b-bee4-22ed172d455e`

> Exile target creature you don't control. For each creature exiled this way, its controller searches their library for a basic land card. Those players put those cards onto the battlefield tapped, then shuffle.
> Overload {4}{W}{W}

Notes: with overload, it exiles each creature you don't control and doesn't target. Each controller
searches once per creature of theirs that was exiled. A creature that wasn't exiled (for example a
token that left first) gives no search.

#### 8.20 Akroan Horse — {4} Artifact Creature · PRA · unmodeled

`8d0213d7-9e25-49d2-93fa-1d346cb2e869`

> Defender
> When this creature enters, an opponent gains control of it.
> At the beginning of your upkeep, each opponent creates a 1/1 white Soldier creature token.

Notes: "your upkeep" belongs to whoever controls the Horse, usually the opponent after the ETB
trigger. The "opponents" are measured from the current controller, so the original caster gets the
tokens.

#### 8.21 Alexios, Deimos of Kosmos — {3}{R} Legendary Creature · PRA · unmodeled

`81c6c4f0-81ad-463c-a42b-60a73e6d70f3`

> Trample
> Alexios attacks each combat if able, can't be sacrificed, and can't attack its owner.
> At the beginning of each player's upkeep, that player gains control of Alexios, untaps it, and puts a +1/+1 counter on it. It gains haste until end of turn.

Notes: it can't be sacrificed for costs or effects. It can't attack its owner, but it can attack
that owner's planeswalkers (_check_). The control change is permanent until the next upkeep's change
replaces it. Uses PR07's attack-requirement store.

#### 8.22 Benevolent Offering — {3}{W} Instant · PRA · unmodeled

`3db8466c-864f-48ba-b617-f2c863dfdcbd`

> Choose an opponent. You and that player each create three 1/1 white Spirit creature tokens with flying.
> Choose an opponent. You gain 2 life for each creature you control and that player gains 2 life for each creature they control.

Notes: the two choices are independent and made on resolution. The life counts happen after the
tokens are created.

#### 8.23 Varchild, Betrayer of Kjeldor — {2}{R} Legendary Creature · PRA · unmodeled

`26ae37ab-91f8-4113-beb0-1154f9b62d28`

> Whenever Varchild deals combat damage to a player, that player creates that many 1/1 red Survivor creature tokens.
> Survivors your opponents control can't block, and they can't attack you or planeswalkers you control.
> When Varchild leaves the battlefield, gain control of all Survivors.

Notes: "Survivors" means every creature with the Survivor subtype, not only Varchild's tokens. The
control gain on leaving is permanent and goes to Varchild's last controller. The restriction keys
on Varchild's controller and uses PR07's attack and block restriction stores.

## Working rules (carried over from PR01–PR07)

- One card per commit. Commit subject: `feat(cards): model <Card> (PR08.nn)`, or `fix(cards): …` for
  a fail-closed override. A primitive lands with the first card that needs it, together with a
  generic primitive test. A review fix gets its own `fix(engine|cards): …` commit. Never amend,
  rebase, force-push, stash, use empty commits, or skip or disable a test.
- Every commit satisfies §7 of the [modeling guide](../guides/card-modeling-and-testing.md): the
  pinned oracle and hash, the clause → primitive → positive and negative test mapping, a whole-game
  cast through legality, priority and the stack, a Card Test Lab scenario with its manifest entry,
  reviewed snapshots, and the ledger row.
- Never ship a partial override. If a card needs a later PR's primitive, move it in
  `card-coverage-chunks.md` in its own commit.
- **Bite-check every fix**: save the fixed file to the scratchpad, `git show HEAD:<file> > <file>`,
  confirm the new test fails, then restore the file.

### Gates before each push

```sh
bun run typecheck && bun run typecheck:tests   # both; missing the second broke CI in PR07
bun run lint && bun run format:check
bun run test                                    # from the repo root, never from packages/engine
bun run test:card-gate && bun run snapshots:check
bun run ai-bench refresh --suite core-fast --write   # after any engine change; commit the refreshed pins
bun run coverage --json && bun run staples --json
bun run test:e2e                                # before marking ready; Card Test Lab scenarios
```

### Pitfalls seen in PR07

- `primitive-evidence.test.ts` fails on a dirty working tree. Re-run it after committing.
- `noPropertyAccessFromIndexSignature` is on, so event payloads need `payload['blocker']`, not
  `payload.blocker` (TS4111). Only `typecheck:tests` catches this.
- The required check names are pinned in `packages/server/src/cards/ci-card-gate.test.ts`. Don't
  rename CI jobs.
- Some oracle phrasings are not interpreted, for example "can't be blocked by creatures with power
  2 or less". Pick test helper cards the parser already understands.
- After combat ends, `blocking`/`attacking` state is cleared. Assert on `eventLog` instead.
- Codex and CodeRabbit review every push. Treat each finding as a claim, trace it, and fix it or
  answer it on the thread with the reason.

## Done when

- All 23 rows are ticked in `card-coverage-chunks.md`, each with its commit.
- The baseline and per-deck tables are regenerated from real coverage output, and any difference
  from the plan is written up (expected 809/906, not 814, unless the seven unowned cards are
  assigned here).
- No deck reaches 0 in PR08 (TOK and URD already did in PR07), so no new acceptance games are due.
- The PR body lists every card with its oracle ID, the primitives introduced, test paths and the
  coverage delta. The PR is marked ready, CI is green, and every review thread is answered.
