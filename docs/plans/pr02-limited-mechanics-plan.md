# PR02 limited mechanics follow-up plan

Status: planned. This plan sequences the four limitations recorded in [PR02 mechanics follow-ups](card-coverage-pr02-follow-ups.md) after [Card coverage PR02](https://github.com/paulliy/mtgtester/pull/15). Keep unsupported behavior fail-closed until its legality and resolution have executable evidence.

## Scope and affected cards

| Work area             | Affected PR02 card(s)                | Known limitation                                                                                                                         |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Life-paid casting     | Anrakyr the Traveller                | X spells are only offered at X=0; the life check omits additional life costs.                                                            |
| Convoke payment       | Conclave Tribunal; Hour of Reckoning | A non-convoke Adventure face can inherit convoke; colorless creatures can be assigned to pay {C}. Creature payer selection is automatic. |
| Target-dependent cost | Killian, Ink Duelist                 | “Up to N” target choices can show full price and later charge the reduced price; multiple reduced options can be indistinguishable.      |
| Replicate targets     | Changing Loyalty                     | Copies cannot retarget an “up to N” target slot.                                                                                         |

This plan is limited to those known PR02 mechanics. Other fail-closed cards remain tracked by the staged card coverage plan.

## Sequence

### 0. Establish behavior and test locations

- Trace the existing cost, target-assignment, copy, and decision flows before changing implementation.
- Add focused failing engine tests for each known incorrect or missing case.
- Keep rules correctness separate from presentation choices, especially automatic convoke payer selection.
- Do not change modeled-card claims or verification status at this stage.

### 1. Correct convoke eligibility and payment

For Conclave Tribunal and Hour of Reckoning, derive convoke from the spell face actually being cast. Fix payment planning so each creature pays at most one symbol: either generic {1} or one colored symbol matching that creature's color. A colorless creature cannot pay {C}.

Decide whether convoke payer selection should become a player decision. If the engine retains automatic selection, document that policy and require deterministic legal choices; do not block the rules fix on a UI change.

**Tests:** matching and nonmatching colors; generic payment; rejection of {C}; one symbol per creature; selected Adventure/non-convoke face; automatic selection stability or explicit payer-choice flow.

### 2. Complete Anrakyr life-paid casting

Extend the life-paid cast path so legal X values are represented and the replacement life payment uses the spell's chosen characteristics at the correct point in casting. Include additional life costs in the affordability check and charge each cost exactly once. Preserve the normal mana-cost path when Anrakyr's permission does not apply.

**Tests:** hand and graveyard casts; zero and positive X; insufficient life for replacement and additional costs; legal additional-cost payment; no duplicate life charge; rejection when the permission or card type does not match.

### 3. Bind Killian's reduction to the offered target assignment

Make each offered cast option carry a target assignment whose cost already reflects Killian's creature-target reduction. Keep the displayed cost, payment plan, and applied action consistent for normal casts and supported non-mana alternative casts. Give distinct descriptions to options with different target slots or prices.

**Tests:** zero targets, only noncreature targets, one or more creature targets, multiple “up to N” slots, and applicable alternative costs; verify the offered cost equals the amount actually charged.

### 4. Add optional retargeting for Replicate copies

Extend copy target selection to support each legal zero-to-N target choice for an “up to N” slot. Keep each copy's target list independent from the original and from other copies. Reuse the existing target-legality and copy-resolution contracts where possible.

**Tests:** no retarget, partial retarget, full retarget, multiple copies with independent choices, original target preservation, and targets becoming illegal before resolution. Add a real Card Test Lab case for Changing Loyalty if the existing scenario cannot exercise these choices.

### 5. Re-run evidence and update status

For each work area, require normal engine-path tests plus positive and negative cases. Update the card verification manifest and evidence inputs only after the implementation and current-head runs pass. Record known limitations that remain, especially any automatic convoke payer-selection policy.

Run the repository gates required for the affected changes: focused tests, full tests, production and test types, lint, format, card gate, snapshots, and web build when viewer code changes. Keep failures and platform-specific skips explicit; historical passing receipts do not certify changed source.

## Completion criteria

- All four known limitations above have either been fixed with current evidence or are explicitly retained as unsupported with a reason.
- No offered option displays a cost different from the cost paid.
- Copies, spell faces, target assignments, and life payments pass engine and viewer evidence for supported scenarios.
- Coverage and verification claims match the tested source revision.

## References

- [PR02 follow-up register](card-coverage-pr02-follow-ups.md)
- [Card coverage plan](card-coverage-chunks.md)
- [PR02 implementation and review notes](https://github.com/paulliy/mtgtester/pull/15)
