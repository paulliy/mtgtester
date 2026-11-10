# XMage translation pilot 01

Translates XMage card code (MIT, commit `31ede542`) into card IR patches for EDHREC cards blocked
by one unparsed rules line, then runs them through the batch card compiler's checks
(`scripts/card-compiler/run.ts import` and `check`, PR #58). Tooling: `scripts/xmage-import/`.
Nothing here is registered with the engine. The patches wait in the review queue.

## Result

74 cards translated (0.39% of Commander deck slots). All 74 pass the authoring validator and the
generated smoke games. The meaning check passed 53 and flagged 21. A hand audit of the 21 found no
wrong patch. Every flag came from the blind back-translator missing an IR convention (below).

The scan's estimate did not hold up at this adapter count. That estimate said 2,516 cards use only
XMage classes already seen in modeled cards. With about 70 adapters, 74 translate. Of the compiler
trial's 30 overlap cards, only Damning Verdict translated. A class name is not enough: the same
class appears with different overloads, filters, target pointers and conditions, and each needs
its own mapping.

## Funnel (5,917 one-line-blocked cards)

| Outcome                                                      | Cards |
| ------------------------------------------------------------ | ----: |
| Translated                                                   |    74 |
| Uses an XMage class, argument or call with no adapter        | 4,386 |
| No XMage ability confidently matches the Oracle line         |   642 |
| Interpreter now models the card (triage fixture is stale)    |   699 |
| Not in the pinned Oracle pool                                |    74 |
| No XMage class for the name                                  |    24 |
| Spell patch would replace parsed spell effects               |    13 |
| Fails the validator (tapped selector in a continuous effect) |     5 |

The most common missing adapters are in `translation-results.json` (`topUnmapped`). They are
mostly conditional wrappers (`ConditionalContinuousEffect`, `withInterveningIf`, `DoIfCostPaid`),
multi-target forms, and less common triggers.

## Adapter accuracy

`agreement.ts` compares adapter output with the interpreter on the 1,239 lines both can read:

- 1,171 identical.
- 59 differ only because XMage says "Elf creatures" where the interpreter writes "Elves". They
  differ only for a noncreature Kindred permanent.
- 9 others. One is a parser bug: "Equipped/Enchanted creature can't be blocked and has shroud"
  (Whispersilk Cloak, Protective Bubble) drops "can't be blocked". The other 8 are equivalent
  (keyword order, a nested `allOf`, a repeated `Creature` leaf, or the probe card carrying a
  second ability).

No disagreement was an adapter error.

## Meaning-check false alarms

All 21 flags fall into four groups, each fixable in the back-translation prompt's conventions:

- `costReduction` rule statics apply only to spells you cast (10 cards).
- `attachedToSource` on an Aura or Equipment means the enchanted or equipped creature (4 cards).
- Mass-effect selectors (`destroyEach`, `exileEach`, `returnToHandEach`) and target kinds only
  ever see permanents, and subtype targets are read as creature types (4 cards).
- One judge misread a single target slot as three, one missed `allowSelf`, and one wanted a damage
  source named (3 cards).

## Cost

Back-translation and judging ran on Haiku workers reading the prompt files, since there is no API
key. Estimated at under $0.01 for the run. Translation itself is deterministic and free.

## Files

- `patches/`: the 74 patches, `source: "xmage@31ede542"`.
- `results.json`, `targets.json`, `work/`: the compiler checks' output.
- `translation-results.json`: translation summary and per-card outcome for translated, invalid and
  spell-merge cards.
- `agreement.json`: the adapter accuracy check.
