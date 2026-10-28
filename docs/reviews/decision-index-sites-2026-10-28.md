# Decision index sites (ADR 0034 decision 3)

Date: 2026-10-28. Baseline: `ec1b000`.

Every engine site that reads a decision answer's `index` into an option list with a fallback. A
**true fallback** builds its menu one-to-one from the list it reads, with no decline option, so an
index outside the list can come only from a test driver or an engine bug. Those sites now read
through `optionAt(options, outcome, site)`, which throws `EngineInvariantError`. `Engine.submit`
already rejects such answers, so production behavior is unchanged. A **decline site** treats an
index past the list as "choose nothing", with or without an explicit decline option; it is left as
it is.

Lines are at the baseline.

## True fallbacks, now `optionAt`

| Site                                                   | Line | Was                              |
| ------------------------------------------------------ | ---- | -------------------------------- |
| `resolve.ts` `chooseEnteringAttackTarget`              | 613  | `?? chosen` (`choices[0]`)       |
| `resolve.ts` `executeAbility` modal fallback           | 1725 | `?? selections[0]`               |
| `resolve.ts` `chooseOne`                               | 2046 | `?? effect.options[0]`           |
| `resolve.ts` `populate`                                | 2844 | `?? myTokens[0]`                 |
| `resolve.ts` `returnOneFromYourGraveyardToBattlefield` | 3815 | `?? selected` (`candidates[0]`)  |
| `resolve.ts` `shadrixModes`                            | 4529 | `?? eligible[0] ?? controller`   |
| `resolve.ts` `vindictiveLichModes`                     | 5166 | `?? opponents[0]`                |
| `resolve.ts` `halfLifeDrainTargetOpponent`             | 5355 | `?? opponents[0]`                |
| `resolve.ts` `reflexiveOnCreatedToken`                 | 6258 | `?? token` (`tokens[0]`)         |
| `resolve.ts` `returnOneToHand`                         | 6978 | `?? selected` (`candidates[0]`)  |
| `resolve.ts` `chooseOpponentForSource`                 | 7176 | `?? chosen` (`opponents[0]`)     |
| `resolve.ts` `searchBasicsNamedLikeChosenLand`         | 7443 | `?? byName[0]`                   |
| `resolve.ts` `addManaFromAbility` (no valid split)     | 9184 | `?? palette[0]`                  |
| `damage-modifiers.ts` `applyDamageModifiers` order     | 434  | `?? next` (`pending[0]`)         |
| `sba.ts` `pushTriggerOnStack` modes                    | 649  | `?? selection` (`selections[0]`) |
| `sba.ts` `pushTriggerOnStack` divided damage           | 883  | `?? 1` (`choices[0]`)            |

`shadrixModes` falls back through two lists. Its explicit check returns the controller before
asking when nobody else is eligible, which happens only when the controller is the last player in
the game, instead of asking with an empty menu.

## Decline sites, unchanged

| Site                                      | Line | Reads               | Why                                      |
| ----------------------------------------- | ---- | ------------------- | ---------------------------------------- |
| `resolve.ts` `chooseOpponentRecipient`    | 1557 | `?.id ?? null`      | `null` is "nobody gains control"         |
| `resolve.ts` Master Warcraft attack piles | 3631 | `?? []`             | no pile allowed                          |
| `resolve.ts` `searchLibraryGroup`         | 9769 | `?? []`             | the empty selection is an offered option |
| `choose.ts` `chooseCard`                  | 75   | range check, `null` | explicit decline option past the cards   |
| `damage-modifiers.ts` candidate choice    | 361  | `?.id ?? null`      | no modifier chosen                       |
| `objects.ts` as-enters option             | 1191 | `?.key`             | no option recorded                       |

The `DECLINE_INDEX` constant the ADR names is not added yet: no decline site above reads a
literal past-the-end index; each reads whatever index it is given.
