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
bun run test:card-gate                  # offline card verification gate
bun run snapshots:check                 # interpretation/override snapshot drift
bun run test:e2e                        # Playwright (Card Test Lab + mocked smoke)
bun run test:e2e:setup                  # Playwright: setup screen + a seeded player game (DB-backed)

bun run dev                             # server :3001 and UI :5173
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
bun run staples [--bulk]
bun run coverage:complete               # coverage + staples over the full fixture population
bun run coverage:rebaseline [--bulk | --oracle-fixture <file> [--write]]   # review Oracle drift; see below
bun run coverage:snapshot [url...]
bun run snapshot:oracle
bun run modelled-cards
bun run combat-sweep [--games N] [--seed S] [--json out.json]
bun run diplomacy-sweep [--games N] [--seed S] [--turn-cap N] [--all] [--talk]   # ADR 0035 self-play
bun run ai-bench                        # AI benchmark harness (ADR 0026)
bun run agent-client [--seat P1] [--seed S] [--port N] [--provider random|ai]
bun run agent-client --table <invite link> --name <n> --deck <file> [--seat P1] [--policy first-legal]
bun run packages/server/src/cli/table-scripted-run.ts [--turn-cap 6] [--scenario disconnect]
                                        # scripted table games in workers (M3 and M4 exits)
```

- Coverage gates read the pinned Oracle fixture, `packages/server/fixtures/coverage-oracle.json`, which `coverage-contract.json` hashes. To check the local Scryfall download for drift, run `bun run coverage:rebaseline --bulk`; it prints each changed card's fields and exits 1 if any changed. To accept an intended change, put the revised projection in a file and run `bun run coverage:rebaseline --oracle-fixture <file> --write`. That updates the hashes only. Then copy the file over the pinned fixture and run `bun run coverage:complete` and `bun run staples --complete`, all in one commit.
- If the production typecheck runs out of memory, set `NODE_OPTIONS=--max-old-space-size=8192` for that command.
- Viewer evidence input tests are split by group, so a change to one area only needs its group: `bun run test card-evidence-input.resolution` (installed resolution and routing drift), `card-evidence-input.discovery` (runtime discovery and source lists), `card-evidence-input.zip` (trace ZIP validation), `card-evidence-input.manifest` (manifest, report, catalog and attachments), and `card-evidence-input.cli` (CLI options and generator adapters). Shared setup is in `packages/server/src/cards/card-evidence-input.fixtures.ts`. The full set is the same path without a suffix: `bun run test card-evidence-input`.
- `serve:table` is the multiplayer table server (ADR 0031), separate from `serve`. It prints a host secret at startup; `POST /tables` with `Authorization: Bearer <secret>` creates a table and returns `{tableId, hostToken, inviteUrl}` once. With `--dev` it allows clock `off` and `TABLE_TEST_RNG_KEY` (64 hex digits), and refuses any non-loopback `Host`/`Origin` and any proxy, TLS or allowlist setting (`TABLE_ALLOWED_ORIGINS`, `TABLE_ALLOWED_HOSTS`, `TABLE_BEHIND_TLS_PROXY`, `TABLE_TLS_CERT`, `TABLE_TLS_KEY`, `TABLE_TRUSTED_PROXY`). Without `--dev` it needs `TABLE_PUBLIC_ORIGIN`, both allowlists, and TLS or `--insecure-lan`: see [table hosting](table-hosting.md). Other settings: `TABLE_PORT` (default 3002), `TABLE_HOST` (loopback only in dev), `TABLE_PUBLIC_ORIGIN` (invite links; defaults to the loopback URL), `TABLE_DB_PATH` (default `data/tables/tables.sqlite`, outside the served directory), `TABLE_WEB_DIR` (default `apps/web/dist-table`; until M6 a placeholder page is served), `TABLE_CLOCK` (`off`, `relaxed`, `standard`; default `off` in dev, `relaxed` otherwise), `TABLE_MAX_TABLES` (default 8), and for scripted runs `TABLE_TURN_CAP`, `TABLE_PACE_MS` (0 is no presentation delay) and `TABLE_CLOCK_SCALE` (every clock duration divided by it). A timed table (`relaxed` or `standard`) gives each shown decision a 10-second allowance and then the seat's bank, pauses it during a 60-second disconnect grace charged to a 5-minute budget, hands a seat to its fallback bot after three timeouts in a row or when its grace runs out (the player takes it back with `resumeControl`), and ends at the game cap as a draw. Each start attempt runs in its own worker thread: the main thread writes the attempt's private manifest (approved decks, the key, limits, build and card-data identity) to the table database first, probes the worker every 5 seconds and stops it after 30 seconds without an answer, and records the attempt's end before the post-game view (results, every decklist, the key, and `replayTurn`) unlocks.
- `table-scripted-run.ts` starts the table server in workers with the fixture oracle, seats two `first-legal` agent clients beside two bots, finishes a game and prints a JSON report with a frame scan of everything the players received. `--scenario disconnect` seats four agent clients at a relaxed clock scaled 60 times faster, and one drops its socket past its grace, rejoins and takes control back. `--scenario tls` runs the server in production mode behind a TLS proxy with a certificate made at run time (needs `openssl`). `table/scripted-run.test.ts` runs all three.
- `agent-client` plays one seat over the running server's `/ws` as a JSON process (NDJSON on stdout, one reply line per decision on stdin, diagnostics on stderr). It is a client of the single-player flow, not another way to run a game. With `--table` it plays one seat at a local table server instead. See [the JSON agent client](json-agent-client.md).
