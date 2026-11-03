# Project commands

```powershell
bun install
Copy-Item .env.example .env             # provider key only for LLM games

bun run typecheck                       # production TypeScript + Vue templates
bun run typecheck:tests                 # engine/server test type projects
bun run lint
bun run format:check
bun run --cwd apps/web build            # web build
bun run test                            # full Vitest suite
bun run test <path-or-filter>           # one test file or pattern
bun run test:card-gate                  # offline card verification gate: every test file in scripts/card-gate.txt
bun run snapshots:check                 # interpretation/override snapshot drift, incl. the pinned fixture and one-line corpus nets (ADR 0038)
bun run scripts/one-line-corpus.ts [--check] # rebuild the one-line probe corpus after the ready list changes
bun run check:manifest-tests [--report] # each manifest engine test ID names one collected test (lists Vitest, ~2.5 min)
bun run mutate-cards --card "<name>"    # IR mutation: each mutant of the card must fail one of its manifest tests on an assertion
bun run mutate-cards --changed [--base S] # ...for reviewed cards whose definition snapshot changed against S
bun run mutate-cards --reviewed [--json F] # ...every reviewed card, as a report
bun run test:e2e                        # Playwright (Card Test Lab + mocked smoke)
bun run lab:index --write|--check       # Card Test Lab scenario fingerprints a sampled run compares against
bun run lab:select --seed S --out F [--base B] [--sample] [--latest] [--per-family N]
                                        # write the sample CI plays; LAB_SELECTION=F bun run test:e2e plays it
bun run test:e2e:setup                  # Playwright: setup screen + a seeded player game (DB-backed)
bun run test:e2e:table                  # Playwright: table games in two browsers on the built table bundle

bun run dev                             # server :3001 and UI :5173
bun run dev --table [--oracle-fixture F] # serve:table --dev :3002 and the table app on :5173
bun run serve [--port N] [--no-db] [--oracle-fixture packages/server/fixtures/coverage-oracle.json]
bun run serve:table --dev [--port N] [--oracle-fixture packages/server/fixtures/coverage-oracle.json]
                                        # multiplayer table server, loopback only
bun run serve:table [--insecure-lan]    # exposed table server; see docs/guides/table-hosting.md
bun run dev:web

bun run decks <deckUrlOrFile> [more...]
bun run decks --no-save <deckUrlOrFile>
bun run pool [--commanders]
bun run pool --play [--seed S] [--ai]
bun run pool --write [--seed S]
bun run play-decks <deckA> <deckB> ...

bun run retag                           # dry run
bun run retag --write [--force]
bun run coverage [--json] [--bulk]      # reads the pinned Oracle fixture; --bulk reads data/ instead
bun run staples [--bulk] [--complete]   # EDHREC top 200 nonland; unmodeled must match the contract's knownUnmodeled
bun run coverage:complete               # coverage --complete + staples over the full fixture population
bun run edhrec:fetch [--share 0.95]     # network: refreeze the EDHREC ranking and the staple list
bun run edhrec:ready-list [--check]     # needs the bulk bank: docs/plans/edhrec-ready-list.md
bun run edhrec:triage [--check]         # offline: the failing grammar slot of each one-line card (docs/plans/edhrec-triage.md)
bun run edhrec:triage --bank F --out D  # the same from real Oracle text, written into D
bun run coverage:rebaseline [--bulk | --oracle-fixture <file> [--write]]   # review Oracle drift; see below
bun run coverage:snapshot [url...]
bun run scryfall:update [--from oracle-cards.jsonl.gz]   # refresh data/ from Scryfall, or from a downloaded snapshot
bun run bulk-smoke [--bank F] [--write] # interpret and validate the whole bank; fails on a throw, invalid modeled IR or fewer modeled cards
bun run pilot:draw [--bank F]          # phase 6 pilot: draw 20 unmodeled cards and split them by seed
bun run snapshot:oracle
bun run modelled-cards
bun run combat-sweep [--games N] [--seed S] [--json out.json]
bun run fuzz [--from N] [--games N] [--changed [--base S]] [--card "<name>"] [--json F] [--report F]
                                        # ADR 0034 seeded four-player games, invariants on; prints each failure's replay
bun run diplomacy-sweep [--games N] [--seed S] [--turn-cap N] [--all] [--talk]   # ADR 0035 self-play
bun run ai-bench                        # AI benchmark harness (ADR 0026)
bun run agent-client [--seat P1] [--seed S] [--port N] [--provider random|ai]
bun run agent-client --table <invite link> --name <n> --deck <file> [--seat P1] [--policy first-legal]
bun run packages/server/src/cli/table-scripted-run.ts [--turn-cap 6] [--scenario disconnect]
                                        # scripted table games in workers (M3 and M4 exits)
```

- Coverage gates read the pinned Oracle fixture, `packages/server/fixtures/coverage-oracle.json`, which `coverage-contract.json` hashes. To check the local Scryfall download for drift, run `bun run coverage:rebaseline --bulk`; it prints each changed card's fields and exits 1 if any changed. To accept an intended change, put the revised projection in a file and run `bun run coverage:rebaseline --oracle-fixture <file> --write`. That updates the hashes only. Then copy the file over the pinned fixture and run `bun run coverage:complete`, all in one commit.
- If the production typecheck runs out of memory, set `NODE_OPTIONS=--max-old-space-size=8192` for that command.
- Viewer evidence input tests are split by group, so a change to one area only needs its group: `bun run test card-evidence-input.resolution` (installed resolution and routing drift), `card-evidence-input.discovery` (runtime discovery and source lists), `card-evidence-input.zip` (trace ZIP validation), `card-evidence-input.manifest` (manifest, report, catalog and attachments), and `card-evidence-input.cli` (CLI options and generator adapters). Shared setup is in `packages/server/src/cards/card-evidence-input.fixtures.ts`. The full set is the same path without a suffix: `bun run test card-evidence-input`.
- `serve:table` is the multiplayer table server (ADR 0031), separate from `serve`. It prints a host secret at startup; `POST /tables` with `Authorization: Bearer <secret>` creates a table and returns `{tableId, hostToken, inviteUrl}` once. With `--dev` it allows clock `off` and `TABLE_TEST_RNG_KEY` (64 hex digits), and refuses any non-loopback `Host`/`Origin` and any proxy, TLS or allowlist setting (`TABLE_ALLOWED_ORIGINS`, `TABLE_ALLOWED_HOSTS`, `TABLE_BEHIND_TLS_PROXY`, `TABLE_TLS_CERT`, `TABLE_TLS_KEY`, `TABLE_TRUSTED_PROXY`). Without `--dev` it needs `TABLE_PUBLIC_ORIGIN`, both allowlists, and TLS or `--insecure-lan`: see [table hosting](table-hosting.md). Other settings: `TABLE_PORT` (default 3002), `TABLE_HOST` (loopback only in dev), `TABLE_PUBLIC_ORIGIN` (invite links; defaults to the loopback URL), `TABLE_DB_PATH` (default `data/tables/tables.sqlite`, outside the served directory), `TABLE_WEB_DIR` (default `apps/web/dist-table`, built by `bun run --cwd apps/web build:table`), `TABLE_CLOCK` (`off`, `relaxed`, `standard`; default `off` in dev, `relaxed` otherwise), `TABLE_MAX_TABLES` (default 8), and for scripted runs `TABLE_TURN_CAP`, `TABLE_PACE_MS` (0 is no presentation delay) and `TABLE_CLOCK_SCALE` (every clock duration divided by it), and for end-to-end tests `TABLE_HOST_SECRET` (a fixed host secret, 16 to 128 URL-safe characters) and `TABLE_MAX_STEP_WORK` (the engine's events per step, to force a halt); all of these are development mode only. A timed table (`relaxed` or `standard`) gives each shown decision a 10-second allowance and then the seat's bank, pauses it during a 60-second disconnect grace charged to a 5-minute budget, hands a seat to its fallback bot after three timeouts in a row or when its grace runs out (the player takes it back with `resumeControl`), and ends at the game cap as a draw. Each start attempt runs in its own worker thread: the main thread writes the attempt's private manifest (approved decks, the key, limits, build and card-data identity) to the table database first, probes the worker every 5 seconds and stops it after 30 seconds without an answer, and records the attempt's end before the post-game view (results, every decklist, the key, and `replayTurn`) unlocks.
- `table-scripted-run.ts` starts the table server in workers with the fixture oracle, seats two `first-legal` agent clients beside two bots, finishes a game and prints a JSON report with a frame scan of everything the players received. `--scenario disconnect` seats four agent clients at a relaxed clock scaled 60 times faster, and one drops its socket past its grace, rejoins and takes control back. `--scenario tls` runs the server in production mode behind a TLS proxy with a certificate made at run time (needs `openssl`). `table/scripted-run.test.ts` runs all three.
- `agent-client` plays one seat over the running server's `/ws` as a JSON process (NDJSON on stdout, one reply line per decision on stdin, diagnostics on stderr). It is a client of the single-player flow, not another way to run a game. With `--table` it plays one seat at a local table server instead. See [the JSON agent client](json-agent-client.md).
