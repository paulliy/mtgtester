# PR08 implementation review

Review date: 2026-10-20. Pull request: <https://github.com/paulliy/mtgtester/pull/26>.

The implementation audit covers all 23 assigned cards, including the nine previously remaining
cards: Tragic Arrogance, Aetherspouts, Boseiju, Who Endures, Winds of Abandon, Shadrix Silverquill,
Vindictive Lich, Alexios, Deimos of Kosmos, Varchild, Betrayer of Kjeldor, and Olórin’s Searing Light.
The seven reopened quality-audit cards remain in PR12.

## Findings and fixes

- Source-bound control ended before departure observers captured their controller. Death,
  leave, and sacrifice observers now retain the pre-event facts; token sacrifices also fire
  their sacrifice event. Independent and normal Cytoplast activation regressions cover this.
- `moveObjects` lost the sacrifice reason when delegating a batch. The batch now preserves it
  and excludes permanents that cannot be sacrificed before capturing observers.
- Batch library destinations could be recomputed after an earlier departure changed control.
  The full destination is now planned once per object before any departure.
- Greatest-power selection failed when every candidate had negative power. Selection now
  uses the actual maximum, and Olórin retains pre-exile power for simultaneous damage.
- Distinct modal player targets could strand later choices under partial peer graphs.
  Authoring now accepts the complete reciprocal same-domain relation supported by the chooser.

The integration audit also aligned the exact supported-pool and unsupported-backlog lists for
Olórin, Shadrix, and Vindictive Lich, and refreshed benchmark compatibility pins with
`ai-bench refresh --suite core-fast --write`. The two existing legacy registrar fingerprints
changed only because obsolete unsupported registrations were removed: normalized AST comparison
found no other code changes, and no new legacy exemption was added.

The review also checked real costs and targets, source-incarnation identity, simultaneous
multiplayer actions, ownership versus control, optional searches, overload, sacrifice and attack
restrictions, ability loss, phasing, and private owner-library choices. Unsupported executable
composition variants remain outside the bounded primitive scopes.

## Evidence requirements and reproduction

The manifest declares 23 reviewed implementations and maps pinned Oracle clauses to positive,
negative, normal cast/activation, and real-viewer requirements. The catalog has 51 PR08 browser
scenarios. The registry has 121 capabilities with 828 unique required executions. Each required
execution is independently identified; adding a composition preserves earlier scopes and cases.
At the audited `fec91e9f` checkpoint, the primitive suite passed 956 tests and the exact 23-card
review-boundary inventory reported 23 eligible definitions and zero blocked definitions.

Final evidence must be generated after the final source commit, from a clean working tree:

```sh
bun run test:primitive-contracts --output .tmp/pr08-final-primitive
bun run primitive-promotions --base af01d79320cd87b85e4f2826cbf6e78e007b2e95 --primitive-evidence .tmp/pr08-final-primitive
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium bun run test:pr08-verification .tmp/pr08-final-verification .tmp/pr08-final-primitive
```

Use a fresh output directory for every attempt. The optional browser variable selects an installed
Chromium; CI can use Playwright’s installed browser without it. The runner executes real engine,
server, frontend, and WebSocket paths without retries and validates the generated reports and
retained CRC-checked traces. Its receipt binds the Git tree, source hashes, exact Oracle/scenario
requirements, primitive report, and every trace. Repository typechecks, lint, formatting,
snapshots, full tests, card gate, benchmark contracts, and web build remain separate gates.
The PR description records their final execution results and tested commit. Generated receipts
and traces are local artifacts, not hand-authored success declarations.

## Inventory and limits

The frozen original population reaches **809/906** (from 786/906): 713/802 deck cards and 190/200
staples. This is 23/23 of the planned PR08 inventory increase. Expanded deck coverage is 766/855.
On the documented 2026-08-28 bulk snapshot, nonland support increases from 6,449 to 6,457 with
no removed previously supported identities. Coverage counts remain separate from correctness.

Gameplay-AI quality was not evaluated with a live provider; lab opponents use scripted legal
choices. GitHub Actions has an account-billing outage. The user authorized device-local gates;
no CI job, required check, or protection was changed. The draft may become ready only after the
final local gates and current engine/viewer receipts pass; this review does not authorize merging.
