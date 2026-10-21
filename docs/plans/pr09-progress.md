# PR09 progress: library access and casting during resolution

Branch: `cards/pr09-library-casting`.
Stacked base: `cards/pr08-control-choices` at
`b098dd4c8c9593babb055785f9cc48aceb91b76c` (PR #26). Retarget to `main` after PR08
lands, reconciling any changes to its shared mechanics before regenerating evidence.

## Scope and completion

The assigned scope is the 31 cards in [the chunk plan](card-coverage-chunks.md#pr09-library-access-and-casting-during-resolution).
All 31 full Oracle definitions are pinned in
[`coverage-pr09-oracle.json`](../../packages/engine/tests/fixtures/coverage-pr09-oracle.json),
copied from the committed coverage fixture, with per-definition SHA-256 hashes. This is an
offline scope fixture, not a fresh Scryfall retrieval or correctness evidence.

**Newly completed to the canonical standard in this PR: 0/31 (0%).** The shared foundation is
in progress. Existing support (including Dark Confidant's earlier restoration) still needs a
PR09 audit; this table does not revoke it or claim it has current PR09 evidence.

## First implementation slice

The shared `lookAtTopN` operation now supports explicitly revealing the chosen card before
moving it to its destination. It keeps looked-at cards in the library while choices suspend
resolution, moves the chosen card through the normal zone-transition path, then reorders the
remainder with the seeded RNG. Merely looking and bottoming are not zone changes or draws.

The player-view boundary redacts the chosen name from another player's `lookAtTop` event
unless it was explicitly revealed. This also protects historical unrevealed look events.
The existing public `revealCard` event carries a chosen reveal; the other looked-at cards
remain private. No card is promoted to reviewed support by this foundation change.

The focused primitive regressions are in
[`pr09-library-look.test.ts`](../../packages/engine/tests/pr09-library-look.test.ts):

| Contract                                                             | Positive / negative case IDs                          |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| Exact scope identities and hashes                                    | `pr09-oracle-pins`                                    |
| Explicit chosen reveal, real hand move, no draw, other cards private | `pr09-look-reveal`                                    |
| No reveal requested: chosen hand identity remains private            | `pr09-look-private`                                   |
| Pending choice preserves library membership and counts               | `pr09-look-suspension`                                |
| Pending ordering and destination replacement preserve membership     | `pr09-look-order-suspension`; `pr09-look-replacement` |
| Chosen library-top card stays above the ordered remainder            | `pr09-look-library-top`                               |
| Only eligible cards among the top six are offered                    | `pr09-look-filter`                                    |
| Decline and no-match paths still bottom the remainder                | `pr09-look-decline`; `pr09-look-no-match`             |
| Empty and short libraries                                            | `pr09-look-empty`; `pr09-look-short`                  |
| Seeded random bottom order, untouched tail and no duplication        | `pr09-look-random`                                    |

These primitive tests do not satisfy a card's normal paid-cast/activation, triggered-ability,
viewer, or gameplay-AI requirements. Generated reports remain under ignored `.tmp/pr09-*` paths.

## Validation at the initial implementation slice

The focused library/capability/spectator run passed 68 tests across six modules, including all
13 new PR09 cases. Production and test typechecks, lint, formatting, definition snapshots
(93 interpreted cards and 742 override registrations), and the web build passed. The core-fast
benchmark fixtures were refreshed with the standard CLI; only compatibility pins and content
hashes changed. The full suite and card gate are tracked in the draft PR as they complete.
No PR09 browser or gameplay-AI evidence has been generated yet.

## Next implementation slices

1. Audit Chaos Warp and Adaptive Omnitool against the pinned clauses. For Omnitool, map the
   artifact-count equipment bonus, equipped-creature attack trigger, reveal-and-put choice,
   random bottom, and paid equip to positive and negative engine cases. Verify real cast and
   equip paths; leave its unsupported guard until the complete behavior is implemented.
2. Add exact clause mappings and real frontend/backend Card Test Lab scenarios before claiming
   either card complete. Generate primitive, engine and browser evidence against the tested tree.
3. Audit reveal-and-put behavior (Dark Confidant, Keen Duelist), look/exile/free-cast transitions,
   then build narrowly scoped card-bound cast/play permissions with explicit expiry. Lands and
   spells require separate permissions.
4. Implement the remaining discover/cascade/explore/hideaway and multi-player compositions in
   dependency order. Preserve explicit unsupported guards for unavailable mechanics.
5. Report scripted/heuristic/live gameplay-AI observations separately from correctness. None
   have been collected for PR09 yet.

## Assigned-card audit queue

| Assignment | Card                                              | PR09 completion    |
| ---------- | ------------------------------------------------- | ------------------ |
| 9.01       | Chaos Warp                                        | Pending PR09 audit |
| 9.02       | Adaptive Omnitool                                 | Pending PR09 audit |
| 9.03       | Armored Skyhunter                                 | Pending PR09 audit |
| 9.04       | Dark Confidant                                    | Pending PR09 audit |
| 9.05       | Dream Pillager                                    | Pending PR09 audit |
| 9.06       | Etali, Primal Conqueror // Etali, Primal Sickness | Pending PR09 audit |
| 9.07       | Keen Duelist                                      | Pending PR09 audit |
| 9.08       | Songbirds' Blessing                               | Pending PR09 audit |
| 9.09       | Szarekh, the Silent King                          | Pending PR09 audit |
| 9.10       | Tibalt's Trickery                                 | Pending PR09 audit |
| 9.11       | Aetherworks Marvel                                | Pending PR09 audit |
| 9.12       | Herald of Amity                                   | Pending PR09 audit |
| 9.13       | Mystic Forge                                      | Pending PR09 audit |
| 9.14       | Cosmic Cube                                       | Pending PR09 audit |
| 9.15       | Expressive Iteration                              | Pending PR09 audit |
| 9.16       | Franklin Richards, Ascendant                      | Pending PR09 audit |
| 9.17       | Genesis Ultimatum                                 | Pending PR09 audit |
| 9.18       | Into the Time Vortex                              | Pending PR09 audit |
| 9.19       | Lurking Predators                                 | Pending PR09 audit |
| 9.20       | Mind's Dilation                                   | Pending PR09 audit |
| 9.21       | Monstrous Vortex                                  | Pending PR09 audit |
| 9.22       | New Generation's Technique                        | Pending PR09 audit |
| 9.23       | Path of Discovery                                 | Pending PR09 audit |
| 9.24       | Power Pack                                        | Pending PR09 audit |
| 9.25       | Sunbird's Invocation                              | Pending PR09 audit |
| 9.26       | Celebrate the Mountain-king                       | Pending PR09 audit |
| 9.27       | Chimil, the Inner Sun                             | Pending PR09 audit |
| 9.28       | Improvisation Capstone                            | Pending PR09 audit |
| 9.29       | Rabble Rousing                                    | Pending PR09 audit |
| 9.30       | Trumpeting Carnosaur                              | Pending PR09 audit |
| 9.31       | Grenzo, Havoc Raiser                              | Pending PR09 audit |
