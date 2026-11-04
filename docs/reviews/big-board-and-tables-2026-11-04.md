# Residual risks: big boards, mana planning, bulk data, Bun and tables (2026-11-04)

The six residual risks [current state](../guides/current-state.md) listed on 2026-11-04, each
investigated and fixed or narrowed. Baseline: `8529a76`.

## Engine speed on big boards

Method: a harness replayed fuzz pods 1, 2 and 6 (`fuzz-plan.ts`'s `pod`, the fuzz game's engine
configuration with `strictInvariants`, without the invariant checker), timing every `advance()`
and every decision, then took Bun CPU profiles (`--cpu-prof`). Pod 2 is the big board: 69 to 71
permanents by turn 35, Council of Reeds among them. Each change was checked to leave the game
identical: the SHA-256 of the whole event log matched the baseline after every step.

The layer pass and its cache took 80 to 90% of each game. Five costs, in the order they were
removed:

1. **Attachments.** `candidateOf` scanned the battlefield for Auras and Equipment on every call,
   and the layer pass calls it once per effect per permanent, so a pass was O(effects ×
   permanents²). An attachment index is now built once per pass and per `selectPermanents`.
2. **Dependency probes.** CR 613.8 ordering asked `dependsOn(effect, other)` for every pair,
   and each call recomputed the effect's fingerprint and cloned and re-applied the other effect.
   Within one ordering round both are pure functions of the working state, so each is now
   computed once per effect and shared by every pair (k instead of k² of each).
3. **`gatherRuleStatics`.** It asked `computeCharacteristics` once per permanent with a rule
   static, and each ask digests the whole board. `manaSourcesFor` then called it once per
   permanent it controls (through `activatingAbilitiesBlockedFor`), which made a mana-source
   listing cubic in board size. It now reads one `computeAllCharacteristics` map, and the
   per-permanent check takes the list gathered once.
4. **Cold copies.** The layer cache is keyed on the context object, and the stateful mana
   planner, the casting checkpoint's restore and every casting preview started cold. Each now
   starts from a related context's results: the planner's copies from the original, the restore
   from the results captured with the checkpoint, and a preview from the last preview of the same
   state. Every read still checks the results against a digest of the reader's own state, so a
   copy that differs recomputes.
5. **Definitions in the digest.** Seeding previews exposed a gap the cold starts had hidden: the
   digest did not cover definitions, so replacing one under the same oracle id (`ctx.defs.set`,
   which tests do about 200 times and the engine never does) returned the old results. The digest
   now folds each permanent's definition object's identity.

| Pod | Board            | Before | After  | Slowest step before → after |
| --- | ---------------- | ------ | ------ | --------------------------- |
| 1   | up to 59, random | 49.9 s | 36.0 s | 2.5 s → under 2 s           |
| 2   | up to 71         | 99.6 s | 22.9 s | 5.4 s → 1.4 s               |
| 6   | small            | 8.0 s  | 5.5 s  |                             |

Three games ran in parallel on four cores for each column, so the absolute times carry load
noise; the event logs were identical in every run. What remains is mostly `digestOf` itself:
each characteristics query still folds the whole board, so a loop that asks once per permanent
is quadratic. `sbaPass` is the largest such loop, but its first loop changes state as it goes
(a regeneration shield taps the creature and removes its damage), so hoisting its query would
change behavior and is left alone.

## Mana planner

Two bounds were missing, each now with a regression in `stateful-payment-copy.test.ts`.

- **Dynamic sources** (`stateful-payment-bound-dynamic-colors`). A dynamic source counted as
  "any type" in the capacity bound, so an Exotic Orchard that makes only {G} passed for the white
  source {1}{W} needs, and the search tried every subset of twelve Forests until it halted the
  game. A dynamic source's symbols are already resolved in the current state, and they are read
  only from characteristics, exile contents, entry choices and commander identity, none of which
  a fixed-capacity activation changes. That is the premise the existing count bound rests on.
- **Life and energy reservations** (`stateful-payment-bound-life`, found by `fuzz-11`). A spell
  needing {2}{B} and 32 life, cast at 29 life with sixteen lands, searched for a minute and
  halted. Under fixed capacity no cost pays energy, and life rises only through a life-gain
  rider, so a reservation the payer cannot meet now stays unmet, and the search stops.

`fuzz-11`, which halted on `main`, now finishes (P4 wins on turn 80). The planner is still
exponential in distinct sources when no bound can disprove a payment.

## Weekly bulk data

The job is pinned to `oracle-cards-20261103220204.jsonl.gz`; the variable values are in
[data/README.md](../../data/README.md). Run locally as the job runs it:

- The bank builds byte for byte the same twice from the same file (SHA-256 `d6d36538bf62…`).
- The six suites marked `allowed-skip: needs the Scryfall bulk file` pass 58 tests with none
  skipped.
- `bulk-smoke`: 35,460 cards, 7,987 modeled, none threw, none invalid. Its baseline is committed.

Outside the job, the newer bank shows 133 of the 1,031 pinned coverage-fixture cards with changed
Oracle text (`coverage:rebaseline --bulk`), so `staples --bulk` and `edhrec:ready-list --check`
report drift against it. That is the fixture being pinned on purpose; refreshing it is its own
change. The repository variables cannot be set from a branch: the owner sets them.

## Bun

Pinned to 1.4.3 (25 days old) in `package.json` and both CI setups. A repro (a Bun server whose
WebSocket closes from the server side, then `server.stop(true)`) hangs on 1.3.14 and settles at
once on 1.4.3 and 1.4.4. `stop()` no longer races a one-second timer, and `serve:table` refuses
to start on Bun older than 1.4.3. The table suites pass on 1.4.3: 14 files, 283 tests, including
the three scripted worker runs.

## Sacrifice ten

An activation's sacrifice cost that owes as many permanents as are eligible now sacrifices them
all without asking (Bolas's Citadel with exactly ten nonland permanents: no picks, where it asked
nine). With a spare, every pick is still asked. A spell's additional sacrifice cost already
behaved this way through its casting proposal; a test now pins that.

## Tables

### The served bundle

| Check                   | Result                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files served            | Only `index.html` and the files `.vite/manifest.json` names; the manifest itself is 404                                                                                                                  |
| Source maps             | None in `dist-table`                                                                                                                                                                                     |
| Script sinks            | No `v-html` in the app; `innerHTML` only inside Vue's runtime                                                                                                                                            |
| Tokens                  | Seat and host tokens in `localStorage`; the invite code in the fragment, which no request or referrer sends                                                                                              |
| Third parties           | `cards.scryfall.io` (images) and `api.scryfall.com` (token art), from each player's browser                                                                                                              |
| Content Security Policy | Was `frame-ancestors 'none'` only. **Fixed:** `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, images and connections limited to the origin and the two Scryfall hosts |

The policy matters because the tokens are in `localStorage`: any script that ran in the page
could take a seat. Styles keep `'unsafe-inline'`, because Vue writes hoisted static markup,
`style` attributes included, through `innerHTML`; a style cannot run script. The table e2e now
fails on any policy refusal in any page it opens, and `table-http.test.ts` checks the directives.

Accepted: Scryfall sees each player's address and which cards are shown; no HSTS header is sent
in TLS mode (the proxy or certificate setup is the owner's).

### The LAN game

Two network namespaces joined by a veth pair: the server at 10.77.0.1 in one, every client at
10.77.0.2 in the other, neither reachable from the container's own network. The server ran in
production mode with `--insecure-lan`, the public origin and both allowlists set, on the
coverage fixture.

- Over the LAN: the page carried the new policy, a wrong `Host` was refused (403), and an
  encoded `..` and the Vite manifest were not served (404).
- A whole game: the host's socket (bots in P3 and P4, approving claims) and two `agent-client`
  seats over `--insecure-lan`, `first-legal`, played 48 turns to a winner in 10 seconds; both
  seats saw `game-over`, nothing halted.
- In Chromium from the guest namespace, two browser contexts: the host created the table with
  the host secret, both joined through the lobby by name, the host approved the claims, made two
  bots and started; both kept their hands on the board and the host ended the game, which both
  saw. No policy refusals and no console errors apart from the card images, which could not
  resolve with no internet in the namespace (the board showed placeholder faces). The
  unencrypted-network banner showed in the lobby and on the board.

This separates the network stacks, not the machines: a run on two physical machines, with real
browsers on a real network (Wi-Fi, a phone, a firewall), is still worth doing once. One agent
seat logged a non-fatal "a reply for q1 was already submitted" from its own client; the game was
unaffected.

## Not fixed here

Three tests fail on `main` before and after this change, with or without the Scryfall bank:
`interpret.test.ts` (a "Whenever you cast a spell" line the grammar now models),
`coverage.test.ts` (an unmodeled card's blocking families) and `diplomacy-game.test.ts` (no
negotiation messages in the seeded game). `primitive-evidence.test.ts` needs a clean working tree
and passes on a commit.
