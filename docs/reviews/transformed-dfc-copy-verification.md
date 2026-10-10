# Transformed DFC copy verification requirements

This document declares evidence requirements for the shared copy-characteristics correction.
It does not promote Brigid, Quantum Misalignment, or Dack's Duplicate to reviewed card status.
Generated test reports and retained Playwright traces supply results; this document contains
no handwritten pass flags. Gameplay-provider observations are separate from correctness.

## Oracle pins

`packages/engine/tests/fixtures/transformed-dfc-copy-oracle.json` pins the full real Oracle
records, including both Brigid faces, from the repository's offline coverage snapshot. The
`retrievedAt` date records extraction from that snapshot, not a fresh Scryfall retrieval.

| Card                                           | Oracle ID                            | SHA256 of `JSON.stringify(card)`                                 |
| ---------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Brigid, Clachan's Heart // Brigid, Doun's Mind | 60fc89a1-cc6f-4a32-84c3-09abf7a4a1df | 14461035b68b70264c250bab1bb3240ad355b4d2ec0c50fc3d6712e81ce0dfd7 |
| Quantum Misalignment                           | 197582b9-4c86-41a3-ad0c-789a0db8e087 | 503d3f956ecb7c90f732a9455d0a4d0038155b93771afff5391f67c68440c80d |
| Dack's Duplicate                               | 724767ca-bd84-4137-9133-4ad2e96b8428 | f30e0537887ed463a4b71d9461a4b14c0b1a6c9353d8203142f86a91f053b6f1 |
| Blossoming Defense                             | 5a851367-1c4a-4cc9-a9c3-3d2775986b4c | 89b1e9da82e1119dd859191c28b979c96beb0dfeb1cdf983c4dee98fcc09ea98 |

## Changed rules and clause mappings

All scenario IDs below are registered in the production Card Test Lab. The prepared source
face stands in for a settled mid-game board. The copying spell itself must pass normal
legality, printed costs, legal target/copy selection, priority, stack and resolution.

| Requirement / exact affected Oracle clause                                                                                                                                                                                  | Primitive                                                                          | Positive evidence IDs                                                                                                                                                                                               | Negative evidence IDs                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy the currently exposed face's name, types, colors, P/T and complete ability definition (CR 707.2). Brigid back: `{T}: Add X {G} or X {W}, where X is the number of other creatures you control.`                        | `copiableDefinition`, `applyCopy`, `createTokenCopyOf`                             | Engine: `copies the active back face and all its abilities, excluding counters and later layers`; viewer/server: `brigid-viewer-token-copy-back`, `brigid-viewer-ordinary-copy-back`                                | Same engine test excludes counters/layer changes; both back-copy lab scenarios exclude the front-face entry trigger and Warrior typing                                                   |
| Brigid front: `Whenever this creature enters or transforms into Brigid, Clachan's Heart, create a 1/1 green and white Kithkin creature token.`                                                                              | Copied front-face trigger; ordinary ETB event dispatch                             | `brigid-viewer-token-copy-front` creates one Kithkin                                                                                                                                                                | `brigid-viewer-token-copy-back` and `brigid-viewer-ordinary-copy-back` create no Kithkin                                                                                                 |
| A token created as a copy of a transforming permanent has both faces and the same exposed face (CR 707.8a). Quantum Misalignment: `Create a token that's a copy of target creature you control, except it isn't legendary.` | `copiableDefinition`, double-faced token definition interning, `createTokenCopyOf` | Engine: `creates a double-faced token with its back face up and no transform trigger on entry`, `copies front-face tokens with both faces and separates their interned definitions`; lab: both token-copy scenarios | Front/back lab scenarios reject opposite-face abilities; engine face/definition separation assertions prevent front/back copies sharing a definition                                     |
| Double-faced token copies retain front-face mana value; ordinary single-faced back-face copies have mana value zero (CR 202.3, 707.8a).                                                                                     | `permanentManaValue`, ordinary copy metadata                                       | Engine: `kairi-the-swirling-sky-copied-double-faced-token-mana-value`, `copies the active back face and all its abilities, excluding counters and later layers`                                                     | Assertions distinguish double-faced token MV 3 from ordinary back copy MV 0                                                                                                              |
| Ordinary copies preserve copy exceptions. Dack's Duplicate: `You may have this creature enter as a copy of any creature on the battlefield, except it has haste and dethrone.`                                              | `entersAsCopy`, `applyCopy`                                                        | `brigid-viewer-ordinary-copy-back`; engine: `keeps copied face and copy exceptions when copying a copy`                                                                                                             | Ordinary copy is single-faced, cannot transform as though it were the original DFC                                                                                                       |
| Copies exclude temporary effects, face-down hidden identity, and reset correctly when the physical DFC changes zone or a temporary copy ends.                                                                               | `copiableDefinition`, copy restoration, transform state                            | Engine: `restores a transformed physical DFC at cleanup and its front face after a zone change`                                                                                                                     | Engine: `does not inherit a target DFC transform state when the copying physical card is transformed`, `copies face-down characteristics without exposing its printed face or abilities` |

Brigid's first-main-phase `{G}` / `{W}` optional transform clauses and Quantum Misalignment's
Rebound clause are pinned without authored changes. These copy scenarios do not constitute
a complete fresh audit of those clauses. A reviewed card declaration still requires their
positive/negative normal activation/timing scenarios under the canonical completion guide.

## Real viewer requirements

`apps/web/e2e/transformed-dfc-copy.spec.ts` drives the real frontend and backend over the
production WebSocket protocol. Each case must assert visible P/T, copied identity and
authoritative public type/Oracle text, absence of opposite-face abilities, and the appropriate
Kithkin result. The public `imageFace` and actual card-image URL must match the exposed face;
back-face copies must request back-face art. Board chips and hover previews forward this face.
Ordinary copies also retain haste. The ordinary-copy case exhausts its lands
casting Dack's Duplicate, then uses its copied Brigid mana ability to pay `{G}` for the pinned
Blossoming Defense, targeting the 1/1 Copy Companion. The companion becomes 3/3 with hexproof
and the copied Brigid is tapped. This proves normal copied-ability activation during spell
payment. Passing traces and screenshots are retained.

Each test attaches generated JSON with its scenario ID, Git revision, scenario-source hash,
all Oracle hashes, the complete pin-file hash, hashes of every changed or new engine source
file, viewer-test hash, copied public object and final public battlefield. The tested working-tree
changes must be preserved alongside the reports; the Git revision alone does not identify
uncommitted source contents. Mana value and both-face transform behavior are engine evidence,
because the public viewer protocol does not expose mana value or internal copy definitions.

## Separate gameplay-provider observation

`brigid-gameplay-scripted-copy-back` in
`packages/server/src/cards/transformed-dfc-scenarios.test.ts` uses `ScriptedDecisionProvider`
against the production engine menu. It records/selects a normal Dack's Duplicate cast and
the legal back-face copy, then casts Blossoming Defense using the copied mana ability. This is
deterministic scripted-provider evidence, with no live LLM
or heuristic-provider quality claim. It cannot override a rules or viewer failure.

## Reproduction

```powershell
bun run test -- packages/engine/tests/tier3-transform.test.ts packages/engine/tests/pr01-card-coverage.test.ts packages/server/src/cards/transformed-dfc-scenarios.test.ts
bun run test:e2e -- apps/web/e2e/transformed-dfc-copy.spec.ts
```

To generate machine-readable engine results, append `--reporter=json --outputFile=<new-path>`
to the first command. Preserve the Playwright `test-results` directory or supply a dedicated
`--output=<new-directory>` for the second command.

Generated artifacts from the current working-tree verification are stored locally at
`test-results/transformed-dfc-engine.json`,
`test-results/transformed-dfc-server.json`,
`test-results/transformed-dfc-isolated-viewer-report.json`, and the retained trace directory
`test-results/transformed-dfc-isolated-viewer/`. The final viewer run uses
`test-results/playwright.dfc.config.ts` with a dedicated backend on 3211 and the normal
frontend origin on 5173; the same production frontend, backend and WebSocket protocol run.
The viewer report contains the generated hash-bound JSON receipts as attachments. These
generated paths are evidence locations, not reviewed implementation labels or manual results.

Concurrent tasks share this checkout and can edit the engine during verification.
The attached hashes identify the tested snapshots; compare them against the final combined
working tree before using the receipts as current reviewed-card acceptance evidence.
The broader checks encountered stale benchmark bindings, the primitive generator's
clean-working-tree requirement, concurrent evidence-binding changes, and formatting issues.
