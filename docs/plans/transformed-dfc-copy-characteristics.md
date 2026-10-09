# Copy characteristics from transformed double-faced cards

Status: planned. This addresses the open limitation recorded in [PR02 mechanics follow-ups](card-coverage-pr02-follow-ups.md#copies-of-transformed-double-faced-cards) and documented by [PR #16](https://github.com/paulliy/mtgtester/pull/16).

## Goal

When a permanent becomes a copy of a transformed double-faced card, give the copy the transformed face's copiable characteristics: name, types, subtypes, colors, rules text and abilities, power/toughness, and the face's copied values. Keep the existing mana-value rule for a copy of a back face: mana value is 0.

## Current implementation

- `applyCopy` in `packages/engine/src/state/objects.ts` copies fields directly from the target and saves the recipient's original fields in `copyOriginal`.
- Transform state is stored on `EnginePermanent.transformed`. The code path must resolve the target's current face when building a copy; reading only its front-face definition loses back-face fields.
- `computeCharacteristics` and the layer pipeline in `packages/engine/src/effects/continuous.ts` provide current characteristics, while `packages/engine/src/effects/layer-cache.ts` keys cached results using transform and copy state.
- `packages/engine/tests/permanent-mana-value.test.ts` already protects mana value for transformed DFCs and their copies. Preserve those cases.
- `packages/engine/tests/spell-copy-contract.test.ts` covers stack spell copies; keep those semantics separate from permanent-copy characteristics.

## Plan

### 1. Define the copiable-characteristics source

Audit transform, copy, and layer evaluation before changing data flow. Define one helper or equivalent path that returns the target's copiable values for its current face, including an existing copy effect and its copy exceptions.

Do not use the target's fully modified displayed characteristics as the copy source. Counters, damage, temporary boosts, and unrelated later-layer effects must not become part of the copy. Keep copy-layer additions/removals (such as added types, added keywords, removed supertypes, and name overrides) consistent with the existing copy rules.

### 2. Make permanent copying use that source

Update `applyCopy` and its callers so they copy the resolved current-face values rather than front-face fields. Extend the recipient's `copyOriginal` snapshot only where required to restore its own characteristics correctly when a temporary copy ends or the object changes zones.

Preserve existing copy behavior for untransformed cards, tokens, copy exceptions, and temporary-copy cleanup. Do not change spell-stack copying as part of this fix.

### 3. Keep mana value and cached characteristics consistent

Preserve the current behavior in `permanentManaValue`: transformed nonmodal permanents retain their printed front-face mana value, while a copy of a transformed back face has mana value 0. Check selectors and other consumers against the corrected copied characteristics.

Review layer-cache invalidation so changing the copied face, copy options, or restored original values cannot reuse stale characteristics.

### 4. Add focused regressions

Extend `packages/engine/tests/permanent-mana-value.test.ts` or add a dedicated permanent-copy contract test for:

- Copying a transformed DFC uses the back face's name, type line/subtypes, colors, rules text/abilities, and power/toughness.
- Copying an untransformed DFC still uses its front-face characteristics.
- Copying a transformed DFC retains mana value 0, while the transformed original keeps its front-face mana value.
- A copy does not inherit the target's counters, damage, temporary power/toughness modifiers, or unrelated continuous effects.
- Copying an already copied or modified copy respects its copiable values and copy exceptions.
- Temporary copy expiration and zone changes restore the recipient correctly.
- Characteristics selectors, ability queries, and relevant gameplay actions read the copied back-face values.

Add a Card Test Lab viewer scenario if the affected copy path is exposed there and the UI needs end-to-end evidence. Do not treat the existing spell-copy contract tests as coverage for this permanent-copy issue.

## Completion criteria

- The engine resolves copiable values from the target's current face through one reviewed path.
- The existing mana-value regressions and all new positive/negative cases pass.
- Copy cleanup, transformation, cache, and untransformed-copy regressions pass.
- Run the repository's required checks for engine changes: focused tests, full test suite, types, lint, format, card gate, snapshots, and web build where applicable.
- Update this plan with implementation commits and any remaining rules limitations; do not broaden card support claims until evidence supports them.
