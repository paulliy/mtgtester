# XMage translation pilot 01

Translates XMage card code (MIT, commit `31ede542`) into card IR patches for EDHREC cards blocked
by one unparsed rules line, then runs them through the batch card compiler's checks
(`scripts/card-compiler/run.ts import` and `check`). Tooling: `scripts/xmage-import/`. The checks
come from PR #58 and are not on this branch until it merges; this run used #58 at `a62bd703`.

Nothing here is registered with the engine, so none of these cards is playable. They are not yet
in the compiler's review queue (`docs/reviews/compiled-card-queue.json`, built by `run.ts queue`).
Add this directory to that queue once #58 is on main.

## Result

The final run translates 80 cards (about 0.40% of Commander deck slots). All 80 pass the authoring
validator and the generated smoke games. The meaning check passes 75 and flags 5. A hand audit of
the 5 found no wrong patch (below).

The first run translated 74. Three are gone because this PR's parser fixes made the interpreter
model them itself: Aqueous Form, Cloak of Mists and Wall of Mulch. Nine were added when review
found that the extractor read no `StaticFilters` fields, so any ability naming a shared filter
had been refused: Acolyte of Aclazotz, Ahriman, Baron Bertram Graywater, Bounce Off, Disdainful
Stroke, Jeskai Barricade, Oyobi, Who Split the Heavens, Perilous Vault and Rockslide Sorcerer.

The scan's estimate did not hold up at this adapter count. That estimate said 2,516 cards use only
XMage classes already seen in modeled cards. With about 70 adapters, 80 translate. Of the compiler
trial's 30 overlap cards, only Damning Verdict translated. A class name is not enough: the same
class appears with different overloads, filters, target pointers and conditions, and each needs
its own mapping.

## Funnel (5,917 one-line-blocked cards)

| Outcome                                                      | Cards |
| ------------------------------------------------------------ | ----: |
| Translated                                                   |    80 |
| Uses an XMage class, argument or call with no adapter        | 4,414 |
| No XMage ability confidently matches the Oracle line         |   618 |
| Interpreter now models the card (triage fixture is stale)    |   702 |
| Not in the pinned Oracle pool                                |    74 |
| No XMage class for the name                                  |    24 |
| Fails the validator (tapped selector in a continuous effect) |     5 |

The most common missing adapters are in `translation-results.json` (`topUnmapped`). They are
mostly conditional wrappers (`ConditionalContinuousEffect`, `withInterveningIf`, `DoIfCostPaid`),
multi-target forms, and less common triggers. An XMage anonymous class body (`new X(...) { ... }`)
is refused, because it can override behavior the adapter would not see. So is any card with a
constructor or static-block statement the extractor cannot read, that changes a local after it
was already built into an ability, or that adds a spell cost, since each may add a cost,
condition or restriction.
No translated card was affected by these rules.

## Parser bugs found

The pilot found two interpreter bugs, both fixed in this PR with regression tests:

- **Attached subjects.** `agreement.ts` showed "Equipped/Enchanted creature can't be blocked and
  has shroud" (Whispersilk Cloak) dropping "can't be blocked". The cause was wider:
  `parseSubject` read any phrase starting with "equipped " or "enchanted " as the attached
  creature. As a result, 15 pinned EDHREC cards reported modeled while dropping a clause. Examples
  are Ethereal Armor's buff, Tenza's conditions and Greater Auramancy pointing at nothing. Tests:
  `packages/engine/tests/attached-subject-clauses.test.ts`. A sweep of every grammar slot for
  accepted phrases that still carry a verb or clause found no other case of this kind.
- **Short names.** The meaning check flagged Wall of Mulch: "Sacrifice a Wall" had become
  "Sacrifice ~". The interpreter shortened every "X of Y" name, but only a legendary card refers
  to itself by a short name. The fix also changes Noggle the Mind and Curse of Misfortunes, which
  are unmodeled either way. Tests: `packages/engine/tests/self-name-short-form.test.ts`.

## Adapter accuracy

`agreement.ts` compares adapter output with the interpreter, token names included, on the 1,446
lines both can read:

- 1,379 identical.
- 59 differ only because XMage says "Elf creatures" where the interpreter writes "Elves". They
  differ only for a noncreature Kindred permanent.
- 8 are equivalent: keyword order, a nested `allOf`, a repeated `Creature` leaf, the probe card
  carrying a second ability, or the interpreter listing the six permanent types where XMage leaves
  "a permanent" unrestricted (Claws of Gix).

No disagreement was an adapter error. Review found one adapter gap that this check could not
catch, because generic tokens are named after their subtypes on both sides. A token named in
print ("Kobolds of Kher Keep", "Koma's Coil") had been given its subtype name. The adapter now
reads the name, and both patches were regenerated.

## Meaning-check flags

The final run used Haiku workers and #58's conventions at `a62bd703`. It flagged 5 of 80, the
same 5 as before the nine were added:

- Koma, World-Eater and Stimulus Package. The compiler redacts free-text fields as `<text>`, and
  the back-translator copied the placeholder into its rules text ("When `<text>`", "type line
  `<text>`").
- Plague Wind. The back-translator dropped `cantRegenerate`, which the patch has.
- Firespitter Whelp. The back-translator named no damage source. `eachOpponentDamage` is dealt by
  the source.
- Thopter Foundry. The judge counted "Sacrifice a nontoken artifact you control" as narrower than
  "Sacrifice a nontoken artifact". You can only sacrifice what you control (CR 701.21a), so both
  mean the same.

Earlier runs, against older conventions, flagged 21 and then 11. Every group of false alarms they
showed went into the conventions.

## Cost

Back-translation and judging ran on Haiku workers reading the prompt files, since there is no API
key. Estimated at under $0.01 per run. Translation itself is deterministic and free.

## Files

- `patches/`: the 80 patches, `source: "xmage@31ede542"`.
- `results.json`, `targets.json`, `work/`: the compiler checks' output from the final run.
- `translation-results.json`: translation summary and per-card outcome for translated and invalid
  cards.
- `agreement.json`: the adapter accuracy check.
