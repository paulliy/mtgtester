# White black control card bug review

Review date: 2026-10-13. Scope: the deck's authored card models, shared engine paths,
and selected imported-card interactions, against the repository's pinned Oracle fixture.
This is a bug review, not a card-completion certificate. Production models and review
statuses were not changed.

Four concrete defects were reproduced in the working checkout at the time of the review.
The temporary reproduction script and generated observations were removed during commit
cleanup. Permanent regressions are retained in
`packages/engine/tests/white-black-control-review-bugs.test.ts` and
`packages/engine/tests/white-black-control-prevention-order.test.ts`.

The ten observations contain five mismatches and five matching controls. Two mismatches
are separate manifestations of the Promise of Loyalty duration defect. These are prepared
engine reproductions using production executors and legality/SBA paths, not new real-viewer
traces or reviewed promotions. This pass does not establish that other cards are bug-free.

## 1. [P1] Hushbringer misses creature-death events in the graveyard watcher dispatcher

Location: `packages/engine/src/state/objects.ts:1832` in `queueCardZoneTriggers`.

With Hushbringer, Planar Void and The Haunt of Hightower on the battlefield, destroying an
opponent's ordinary creature queues both graveyard watcher abilities. Neither should trigger
while Hushbringer remains present. This lets Planar Void exile the card and lets Haunt grow
despite the suppression effect. The object-event dispatcher handles suppression, but this
separate card-zone dispatcher never consults it.

Observed: two pending watcher triggers both with and without Hushbringer. Expected: zero
with Hushbringer, two without it. The control cases still correctly queue two triggers for
an opponent's noncreature artifact dying and for a creature card discarded from hand.

Suppression must distinguish a creature death from other graveyard entries and preserve
post-event handling when Hushbringer itself leaves. Wizards explicitly covers graveyard
watchers and the exceptions in the [Hushbringer release notes](https://magic.wizards.com/en/news/feature/throne-eldraine-release-notes-2019-09-20).

## 2. [P2] Dawn's Truce incorrectly removes an existing Curse from its player

Location: `packages/engine/src/targets/legality.ts:217`, called by
`packages/engine/src/sba/sba.ts:780` for Aura attachment legality.

Prepare an opponent-controlled Curse of Disturbance already attached to P1, then resolve
Dawn's Truce for P1. At the next production priority/SBA checkpoint, the engine puts the
Curse into its owner's graveyard. It should remain attached: gaining hexproof prevents new
opponent targeting, not an existing Aura's continued attachment. The player branch applies
hexproof even when the caller is checking attachment rather than targeting.

Observed: the initially legal Curse is removed after hexproof. The contrasting Perch
Protection control correctly removes it after protection from everything.

Keep enchant restrictions and protection checks for attachment, while applying hexproof
only when targeting. See rules 702.11c and 303.4 in the [Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt).

## 3. [P2] Promise of Loyalty's expired attack restriction returns

Location: `packages/engine/src/combat/combat.ts:159`; the restriction is installed at
`packages/engine/src/effects/resolve.ts:2357` and retained on the permanent.

After Promise of Loyalty resolves, remove the kept creature's last vow counter, then put
a new vow counter on that same creature. The engine first allows attacking the caster, then
forbids it again. The original continuous effect's duration ended when the last counter was
removed; the new counter must not revive that effect.

A second reproduction phases the vowed creature out and back in. The same restriction
incorrectly survives. This matters when Promise of Loyalty and Perch Protection interact.

Observed legal defending players: P3/P4 initially; P1/P3/P4 without the counter; P3/P4 after
the new counter. After phasing, P1 also remains absent. Both final cases should permit P1.

Record permanent expiry of the generated restriction when its duration ends, rather than
testing only the present counter count. Rules 611.2b and 702.26f cover the duration and
phasing behavior in the [Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt);
the [Promise of Loyalty release notes](https://magic.wizards.com/en/news/feature/strixhaven-school-mages-and-commander-2021-edition-release-notes-2021-04-16)
also explain removal and transfer of the vow counter.

## 4. [P2] Perch Protection forces the wrong prevention order with Inkshield

Location: `packages/engine/src/effects/resolve.ts:322`.

Resolve Inkshield, apply Perch's promised-gift protection, then deal five combat damage to
the protected player. The damage resolver returns immediately for Perch's protection before
considering Inkshield. It creates no Inklings and offers no prevention-order choice.

The affected player may apply Inkshield first, preventing the damage and creating five
Inklings. Zero tokens is a valid choice if protection is applied first; it is not the only
legal result. The control without Perch's protection creates five tokens.

Implement the affected player's choice among applicable prevention effects before applying
one. This is required by rule 616.1 in the [Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt).

## Review limits

The read-only tracing pass did not identify another concrete defect in the inspected
discard, Gift, stack, counters, stax, and planeswalker paths. That is not proof of correctness.
Additional useful tests include an actual response changing Duress's target hand, a
creature-land discarded with Waste Not, and source departure during Survival resolution.
Existing green aggregate checks do not cover the four failing interactions above.

## Resolution status (2026-10-14)

The original four reproductions pass after the engine fixes. The subsequent
[fix review](white-black-control-fix-review.md) records a remaining damage-replacement
interaction and the missing bug-specific viewer evidence:

1. **Hushbringer creature-death suppression**: Fixed in `packages/engine/src/state/objects.ts:1848`. Graveyard zone-watcher triggers (`putIntoGraveyardFromAnywhere`) inspect `departureFacts` against `suppressObjectTriggers` for `'dies'` events when `fromBattlefield` is true. Positive controls for noncreature deaths, hand discard, and simultaneous departure with Hushbringer continue to function as expected.
2. **Dawn's Truce existing Aura attachment**: Fixed in `packages/engine/src/targets/legality.ts:217`. Hexproof checks are now guarded by `context.targeting !== false`, ensuring hexproof does not invalidate existing Aura attachments during SBA attachment legality checks (`packages/engine/src/sba/sba.ts:780`). Protection from everything continues to shed Auras.
3. **Promise of Loyalty expired duration**: Fixed in `packages/engine/src/state/counters.ts:5`, `packages/engine/src/effects/resolve.ts`, and `packages/engine/src/state/phasing.ts:33`. Counter-bound attack restrictions permanently expire when the counter count reaches zero via `expireCounterBoundAttackRestrictions`, and are permanently cleared when the vowed creature phases out per CR 611.2b and 702.26f.
4. **Prevention order choice (Inkshield + Perch Protection)**: Fixed in `packages/engine/src/effects/resolve.ts:317` and `packages/engine/src/combat/combat.ts:1165`. Defending players are prompted to choose the prevention order per CR 616.1 via `choosePlayerDamagePrevention`. Choosing Inkshield first prevents damage and creates Inklings; choosing protection first prevents damage without Inklings. `dealDamageToPlayer` requires an explicit choice when competing prevention effects exist.

Verification results:

- The temporary reproduction script produced 10/10 expected observations before cleanup.
- Targeted regression tests in `packages/engine/tests/white-black-control-review-bugs.test.ts` and `packages/engine/tests/white-black-control-prevention-order.test.ts` all pass.
- Full verification script `scripts/run-white-black-verification.ts` completed with 0 errors across all engine tests and Playwright real-viewer scenarios.
