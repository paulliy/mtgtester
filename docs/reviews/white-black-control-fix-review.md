# White black control fix review

Reviewed 2026-10-14. Scope: the Hushbringer zone-watcher suppression, Dawn's Truce player-Aura legality, Promise of Loyalty duration expiry, and Perch Protection / Inkshield prevention-order fixes in the current working checkout. Production files were not changed during this review.

## [P2] Prevention choice omits active damage replacements

`packages/engine/src/effects/resolve.ts:307-313` enumerates protection and combat-prevention shields only. The selected shield then returns from `dealDamageToPlayer` before `damageAmountAfterReplacements` runs (`resolve.ts:361-379`). This leaves a pre-existing damage-replacement interaction unresolved by the prevention-order fix.

Reproduced through normal casts of the pinned Inkshield and Perch Protection followed by production combat: P2 controls Neriv, Heart of the Storm and attacks P1 with a fresh 5/5. The no-shield control deals ten damage. With both shields, the chooser offers only protection first or Inkshield first, and choosing Inkshield creates five Inklings. P1 must also be able to apply Neriv's doubling before Inkshield, preventing ten damage and creating ten Inklings. Five tokens is a legal outcome, but ten is currently inaccessible.

Rules 616.1e-f allow the affected player to choose applicable replacement and prevention effects together and repeat the process after each application. See the [current official Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.pdf). Integrate active damage replacements into the choice flow, preserving source-specific applicability and tracking effects already applied. Add a regression for both doubling-first and prevention-first outcomes; simply moving all damage replacements before prevention would still force the wrong order.

This interaction was reproduced with an ad hoc production-engine script. The temporary script and generated observations were removed during commit cleanup; the behavior and reproduction setup are recorded above.

## Verification and remaining limits

Seven focused test files passed, 55 tests total: the two new regression files plus damage replacements, targeting, card-zone identity, Promise interactions, and phasing/elimination contracts. These include all nine original fix regressions. No additional concrete defect was found in the inspected Hushbringer, Dawn's Truce, or Promise duration changes.

The existing development report records 466 engine checks and 84 browser tests passing, but the four bug-specific viewer factories/specs have not been added. The verification manifest and clause requirements do not yet reference the new regression files. Those aggregate passes do not establish current clause-level viewer evidence for these repairs. No card status was promoted and no new gameplay-AI evaluation was performed in this review.
