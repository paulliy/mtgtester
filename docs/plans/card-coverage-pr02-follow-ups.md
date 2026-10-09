# PR02 mechanics follow-ups

Status: open follow-up work from [Card coverage PR02](https://github.com/paulliy/mtgtester/pull/15). PR02 is complete at its planned scope; this note tracks known limitations and correctness gaps that were left for later work. It does not change card support claims by itself.

## Anrakyr the Traveller: life-paid casts

**Known limits:** X spells are only offered at X=0, and the life check does not account for additional life costs.

**Follow-up:** Make life-paid casting validate and charge the complete cost for legal X values and additional life costs, while preserving the rule that life equal to mana value replaces the mana cost.

**Acceptance checks:**
- A life-paid cast with X can be offered at each supported, legal value and resolves with the announced value.
- A cast is not offered when the total life payment (replacement plus additional life costs) cannot be paid.
- The chosen payment is charged once, with regression coverage for the graveyard and hand paths.

## Convoke: face, color, and payer selection

**Known limits:** Convoke is read from the card's main face, so a non-convoke Adventure face can incorrectly inherit it. A colorless creature can currently be assigned to pay a {C} symbol. The engine also chooses which creatures convoke, rather than asking the player.

**Follow-up:** Determine convoke from the face actually being cast, and make the payment planner enforce the mana symbol rules: a creature may pay {1} or one colored symbol matching one of its colors; it cannot pay {C}. Decide separately whether convoke creature selection should become a player choice. Until that choice is implemented, keep the automatic selection deterministic and within the legal payment rules.

**Acceptance checks:**
- A spell face without convoke cannot use creatures to pay, even when another face has convoke.
- A colorless creature can pay generic mana through convoke but cannot pay colored or {C} symbols.
- A multicolor creature can pay only one matching colored symbol per creature.
- If payer selection remains automatic, equivalent game states choose a legal, deterministic set of creatures.

## Killian, Ink Duelist: target-dependent reductions

**Known limit:** For spells with only “up to N” targets, the full-price option can be offered even though choosing a creature target later causes the reduced price to be charged. Multiple creature-target slots can also produce identically labeled reduced-price options.

**Follow-up:** Make the offered cost match the selected target assignment for both normal and non-mana alternative casts. Give options distinct labels when different target slots produce different prices.

**Acceptance checks:**
- Choosing zero targets or only noncreature targets costs full price.
- Choosing a creature target receives the reduction before payment is planned.
- Each legal target assignment has an accurate, distinguishable option; applying an option charges exactly the displayed cost.
- Cover normal casts and applicable alternative casts with positive and negative tests.

## Replicate: up-to-N target slots

**Known limit:** A copy cannot retarget an “up to N” target slot.

**Follow-up:** Support legal optional retargeting for each copy without changing the original spell's target choices. Preserve the engine's existing handling for unchanged and illegal original targets.

**Acceptance checks:**
- For each copy, allow zero through N legal replacement targets where the spell text permits it.
- Verify each copy resolves with its own chosen targets and that the original spell's targets remain unchanged.
- Cover no-target, partial-target, full-target, and targets-becoming-illegal cases in engine tests and a real viewer scenario.

## Copies of transformed double-faced cards

**Known limit:** Copying a transformed double-faced card currently gives the copy the right mana value, but it may retain the front face's other characteristics. Its type, power/toughness, and abilities can therefore be wrong.

**Follow-up:** Make copy creation capture the copied object's current copiable characteristics, including its transformed face, while preserving the existing special mana-value rules. Do not copy unrelated state such as counters or damage.

**Acceptance checks:**
- A copy of a transformed creature has the characteristics of the transformed face, including name, types, color, abilities, and power/toughness.
- A copy of an untransformed card retains the expected front-face characteristics.
- A copy of a transformed double-faced card still has mana value 0 where required by the existing mana-value rules.
- Add engine regressions for both face states and verify downstream selectors and interactions read the copied characteristics.

## References

- [PR02 review notes and known limitations](https://github.com/paulliy/mtgtester/pull/15)
- [Card coverage plan](card-coverage-chunks.md)
