# Card authoring mini-pilot

Date: 2026-10-29. Plan: [faster card authoring](../plans/card-authoring-and-fail-loud.md), phase 2
step 9. Baseline: [card authoring baseline](card-authoring-baseline-2026-10-28.md).

Three cards the manifest held as `unsupported` were modeled end to end with the phase 2 commands,
on the main thread, in commit `6fe9d34` (re-seal `45262c7`):

| Card                 | Shape                                                     | Scenarios | Viewer flows |
| -------------------- | --------------------------------------------------------- | --------- | ------------ |
| Mizzium Mortars      | targeted damage to a creature you don't control; overload | 2         | 2            |
| Electrickery         | the same shape at 1 damage                                | 2         | 2            |
| Ettercap // Web Shot | Adventure face: destroy target creature with flying       | 1         | 1            |

## Time

About 6 minutes of wall-clock time for all three, from `card:new` to the viewer flows passing in
the real Card Test Lab; then about 15 minutes of gate runs, two lint fixes and the commit. `card:new`
ran in under a second per card and `card:finish` in 11 seconds (snapshots, re-seal, scenario
registration, evidence binding for five generators, containment report, skeleton).

PR11's median card span is 2.8 hours and 546 prorated lines (baseline §1). The comparison is
indicative, not like for like: the baseline span is commit-time from a card's first to last
touching commit, these three cards share one shape and needed no engine change, and the pilot was
run by the same agent that wrote the commands. What the pilot does show is that none of the
mechanical tail (snapshots, pins, registration, evidence binding, containment) was typed by hand.

## Findings and fixes

1. **Spell faces.** `card:new` printed Web Shot's face-prefixed reason as the handled line and
   stubbed the front face. It now names the face and the `defineSpellFace` call with the face's own
   line. `card:check` also reads a face's `<oracleId>:back` registration.
2. **Builders.** The first definitions used numeric target slots copied from older files, which
   the authoring lint rejects. `card:new` now says to use the shared builders and `targetSlots()`.
3. **Registration order.** `card:finish` appended new scenario files; it now keeps the list in
   file-name order, the order the lab lists scenarios in.
4. **Snapshot report.** `card:finish` showed each override twice (real id and fixture alias); it
   now shows each card once.
5. **Audit inventory.** The override-file audit needed each new batch file listed; it now skips a
   batch that has its own `tests/cards/<batch>/` directory, which `card:new` creates.
6. **Containment.** `card:finish` reported all three cards as retiring containment, and the two
   contract tests that held them contained were the right ones to update.
7. **Negative cases.** The scenario format cannot say "this target is not offered"; the runner's
   `offeredTargetNames` answers it at the request level, which the three negatives use.
