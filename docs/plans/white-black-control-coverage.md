# White black control coverage and implementation plan

Deck source: [Moxfield](https://moxfield.com/decks/2ZPO0WX1o0WMesn6B5ZuOg).
Decklist imported on 2026-10-12. Commander: **Breena, the Demagogue**.

The source list passes the repository's Commander validation: 100 cards, including the
commander, with 79 unique Oracle identities. Sideboard and maybeboard cards are outside this
measurement. The committed plaintext fixture is `packages/server/fixtures/coverage-decks/white-black-control.txt`.
It is discovered by default coverage, and its URL is registered for repeatable snapshots.

## Initial inventory (before implementation)

| Work category                                       | Unique cards | Meaning                                                                                                                               |
| --------------------------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| Import using current card interpretation            |           26 | Already recognized by the parser/overrides; no new card authoring identified by this inventory                                        |
| Author using existing primitives                    |            2 | Duelist's Heritage: optional targeted double strike; Restoration Magic: mode-bound additional costs and target selection              |
| New or extended engine support, then card authoring |           51 | At least one clause cannot currently be represented faithfully; many need small shared extensions rather than entirely new subsystems |
| Total requiring modeling work                       |           53 | The preceding two work categories combined                                                                                            |
| Total unique cards                                  |           79 | Basic-land copies count once per Oracle identity                                                                                      |

The 26 recognized identities account for 47 physical cards; the 53 blocked identities account
for 53 physical cards. Coverage is **26/79 (32.9%)** by unique identity.

All 79 resolve from the local Scryfall bank: there are no missing Oracle records to download.
52 identities are new to the committed Oracle population. Four of those already parse:
Despark; Drana, Liberator of Malakir; Dusk Legion Duelist; Selfless Spirit. The number of
new Oracle records is 52. Implementation confirmed that Restoration Magic can use existing
mode-bound additional costs, correcting the original estimate from 52 to 51 cards needing
engine extensions. These are different sets.

These are implementation estimates from the pinned text and current IR/executors, not card
completion claims. `modeled: true` is inventory only. Every card implementation must satisfy
[the canonical modeling/testing guide](../guides/card-modeling-and-testing.md), including
clause mapping, positive/negative engine scenarios, normal casting/activation, real-viewer
evidence, and separately reported gameplay-AI observations when evaluated. Existing recognized
cards still need that audit before they can be called verified.

## Implementation groups

Each blocked card has one primary group below; cross-group dependencies do not add to the count.
Use reusable builders and grammar after extending the underlying engine contracts, then add
card-specific overrides where necessary. Keep unsupported clauses explicit until implemented.

| Group                                          | Cards | Shared work                                                                                                                                                                                 |
| ---------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-primitives repair                     |     2 | Duelist's Heritage: optional targeted double strike; Restoration Magic: existing mode-bound additional costs                                                                                |
| Discard foundations and payoffs                |    17 | Player-scoped chosen/random discard; reveal-and-controller-select discard; discard/cycle events; results and turn history; hand-size predicates; multi-player/count-target effects          |
| Combat, politics and defender relations        |     5 | Correct Breena opponent-life comparison; player/planeswalker defender relations and tax/target legality; keep-one sacrifice with vow restrictions; opponent-relative attacker token routing |
| Graveyard events and replacements              |     7 | Destination replacements across all origins, event object identity, discard-cause-aware replacement, pregame Leyline choice, sacrifice/discard reanimation, permanent back-face casting     |
| Stax and trigger/entry rules                   |     7 | Per-player spell limits by category; opposing entries tapped; global ETB/death trigger suppression                                                                                          |
| Stack interaction and casting provenance       |     4 | Return/exile a spell without countering it; plotted permission; zone-specific cost increases; change existing spell targets; target predicate inspecting a spell's targets                  |
| Protection, counters and phase triggers        |     3 | Choose-color single-creature protection; flying/lifelink counter semantics; second-main trigger, counter transfer with last-known facts                                                     |
| Gift and player protection                     |     3 | Gift announcement and recipient, gift-before-effect ordering, temporary player hexproof/casting prohibition, extra turns, phasing, life-total lock and protection from everything           |
| Classes, planeswalkers and specialized effects |     5 | Class levels; unblocked-attack combat-damage substitution; reveal-and-put-into-hand; discard failure outcomes; targeted sacrifice and pile splitting; tiered mode/additional-cost binding   |

### Discard foundations and payoffs — 17

Archfiend of Ifnir; Bottomless Pit; Duress; Geth's Grimoire; Hymn to Tourach;
Hypnotic Specter; Necrogen Mists; Oppression; Painful Quandary; Rankle, Master of Pranks;
Syphon Mind; Thoughtseize; Tinybones Joins Up; Tinybones, Trinket Thief; Vicious Rumors;
Waste Not; Whispers of Emrakul.

Existing discard and random-discard effects operate on the ability controller. They do not
implement opponent/target/event-player discard. Emitted discard log entries also do not supply
the missing typed discard-trigger dispatcher. Add that foundation once, including actual
discard results for Syphon Mind, discard-vs-cycle de-duplication for Archfiend, turn history for
Tinybones, and card-type-in-your-graveyard counting for Whispers. Rankle's modal framework
already exists; its multi-player effect scopes need work.

### Combat, politics and defender relations — 5

Breena, the Demagogue; Archon of Absolution; Soul Snare; Promise of Loyalty;
Curse of Disturbance.

Breena is explicitly contained because its old condition compares the wrong players. Existing
attack taxes protect a player, without implementing Archon's planeswalker protection. Soul
Snare needs the exact corresponding defender target relation. Curse already has player-Aura
attachment, an enchanted-player-attacked event and token creation/routing; conservatively
extend the event-player relationship check for its opponent-only bonus. A current-turn proxy
must not replace that event relationship.

### Graveyard events and replacements — 7

Leyline of the Void; Library of Leng; Planar Void; Rest in Peace; Stone of Erech;
Tergrid, God of Fright // Tergrid's Lantern; The Haunt of Hightower.

Planar Void is a trigger after the zone change; Rest in Peace/Leyline/Stone use replacement
effects before it. Preserve that distinction, including whether death/discard events occur.
Existing from-anywhere card events help, but their scope must support the exact graveyard
object required by Planar Void and Tergrid. Library of Leng distinguishes effect-caused discard
from costs. Tergrid depends on the discard group and needs both permanent faces, including the
Lantern's sacrifice-or-discard-or-life-loss choice; it is not merely another spell/land MDFC.

### Stax and trigger/entry rules — 7

Archon of Emeria; Authority of the Consuls; Deafening Silence; Doorkeeper Thrull;
Hushbringer; Karn, Argent Defender; Rule of Law.

Cast tallies exist, but a per-player, per-category casting limit is not currently a rule
static. Trigger suppression must apply to every affected ability source, with correct entry
and death event semantics, rather than removing only the entering creature's own trigger.

### Stack interaction and casting provenance — 4

Aven Interrupter; Imp's Mischief; Rebuff the Wicked; Reprieve.

Countering is not a substitute for returning or exiling a spell. Aven needs plotting plus
opponent-zone cost increases; Imp's Mischief changes the original spell's target, not a copy.
Rebuff's filter concerns the candidate spell's targets, not its card characteristics.

### Protection, counters and phase triggers — 3

Mother of Runes; Sejiri Shelter // Sejiri Glacier; Reluctant Role Model.

Protection from fixed colors exists; choosing a color and applying protection to a single
creature needs an extension. Keyword counters must continuously grant flying/lifelink, not
just store counters with those names. Reluctant Role Model also needs its second-main timing
and both self/other death paths with optional targeting and captured counters.

### Gift and player protection — 3

Bilbo's Gambit; Dawn's Truce; Perch Protection.

Build gift once at spell announcement, with the promised opponent stored on the stack. Bilbo
depends on spell return; Perch additionally needs extra-turn scheduling, phasing, life-total
locking and protection from everything. Ordinary permanent hexproof and damage prevention
are insufficient for these player protections.

### Classes, planeswalkers and specialized effects — 5

Bandit's Talent; Cloak of Confusion; Dark Confidant; Liliana of the Veil;
Liliana, Waker of the Dead.

Loyalty costs and emblems already exist: the Lilianas do not need a new planeswalker system.
Their missing player-scoped effects, failed-discard outcomes and two-pile choice do need work.
Bandit's Talent reuses discard/hand-size foundations after adding Class level state. Dark
Confidant is contained because its old implementation draws instead of revealing and putting
a card into hand. Restoration Magic needs mode-bound additional costs and target selection at
announcement, not a mana-cost approximation after resolution begins.

## Suggested order

1. Restore Duelist's Heritage with current primitives; fix Breena's comparison early so the commander becomes usable.
2. Build discard/player scope and event foundations; implement the 17-card discard group in small batches.
3. Extend graveyard replacement/identity support; implement the seven graveyard cards, including both Tergrid faces.
4. Add spell limits, entry rules and trigger suppression for the seven stax cards.
5. Finish the remaining combat/defender cards, then stack interaction and protection/counters.
6. Build gift and its shared announcement contract; leave Perch's extra-turn/phasing features as a separate dependent batch.
7. Finish the specialized cards, sharing the discard foundation with both Lilianas and Bandit's Talent.

Run clause-level engine and real-viewer evidence per batch rather than postponing it until all
53 cards are authored. No card behavior was changed as part of this deck import.

## Reproduction and Oracle provenance

`packages/server/fixtures/white-black-control-oracle.json` contains all 79 projected identities,
including back faces. Existing committed Oracle projections/hashes were reused for overlapping
cards; the 52 additions were projected from the local Scryfall bank on 2026-10-12. This was not
a live Oracle refresh. The aggregate fixture and contract preserve all previous Oracle pins.

```powershell
bun run coverage packages/server/fixtures/coverage-decks/white-black-control.txt --oracle-fixture packages/server/fixtures/coverage-oracle.json
bun run coverage --oracle-fixture packages/server/fixtures/coverage-oracle.json
bun run coverage:snapshot --only white-black-control
```

The pinned full-population run passes and measures 13 decks, 855 unique cards, and 640 recognized
cards. The unpinned `bun run coverage` currently rejects the local bulk bank at the pre-existing
Adaptive Omnitool Oracle hash; changing that unrelated baseline is outside this import.

## Implementation progress (2026-10-13)

The deck is registered in default coverage. The current pinned coverage run recognizes
**79/79 unique cards**: all 53 initially blocked cards have authored overrides registered,
including Perch Protection. This is implementation inventory, not reviewed completion.

The initial split is **26 importable identities**, **2 cards authored with existing primitives**,
and **51 cards requiring shared engine extensions**. These count cards, not distinct systems.
The two existing-primitive cards are Duelist's Heritage and Restoration Magic.

Implementation batches cover discard choices/events/payoffs, graveyard replacements and object
identity, combat and planeswalker defenders, spell limits and entry suppression, stack targeting
and modal permanent faces, keyword counters and second-main survival, Classes, planeswalkers,
and Gift announcement/fulfillment. Perch adds extra-turn scheduling, phasing and player shields.

The historical combined development verification passed **457 engine/contract/prepared-scenario checks**
and **84 real frontend/backend/WebSocket viewer scenarios**, with no skips or flaky
results. It captured 84 Playwright traces and checked source hashes before and after execution:
all captured sources stayed unchanged. Temporary reports, traces, receipts, and the verification
checkout were removed during commit cleanup. These counts record historical observations;
fresh evidence must be generated before reuse (the original `scripts/run-white-black-verification.ts` was retired; it is in history at `fae4d11`).
Engine and server test typechecks passed.
These are generated observations from isolated committed candidate
`86aee6b`, with a clean tree and unchanged captured sources. The user's working checkout is
preserved separately. The report does not certify reviewed implementation.
All 53 authored manifest entries remain **implemented-unreviewed**. All 108 clauses now have
declared viewer scenarios. Implementation review remains outstanding; a declaration alone
does not establish coverage of every branch or interaction.
Independent normal-cast contracts now cover narrow printed-keyword behavior and the exact
opponent reveal/selection/discard composition used by Duress. The clean-tree runner passed
**78 checks**, generating receipts for **18 capabilities**. Those historical receipts bound
to the isolated candidate, not the dirty parent checkout. The generated capability inventory accepted all
12 Duress dependencies with no blockers. Duress still requires implementation review.
The other **52 cards** exceed the registered scopes, with **167 distinct dependency keys**
remaining outside eligible scopes across those cards. Broader independent contracts remain
prerequisites for their reviewed promotion; registering a capability does not grant unrestricted
support for every card that uses it.
All 47 receipt-loading, eligibility, freshness/mutation and promotion-boundary regressions
passed across two complementary filtered runs on that candidate. The three initial CLI
timeouts were resolved by allowing 60 seconds for those subprocesses; their assertions and
evidence checks were preserved. The six Windows/POSIX containment regressions also pass.
Separate random and heuristic gameplay observations completed all 168 prepared runs across
84 scenarios. Prepared-run output was temporary and removed during cleanup. The two full-pod runs in
`docs/reviews/white-black-control-gameplay-ai.json` ended naturally after 67 and 95 turns;
they are source-bound historical quality observations and do not certify rules correctness.
The historical full-population count above describes the initial import.
