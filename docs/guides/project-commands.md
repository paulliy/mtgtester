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
bun run test:e2e:setup                  # Playwright: Play my deck + a seeded player game (DB-backed)

bun run dev                             # server :3001 and UI :5173
bun run serve [--port N] [--no-db] [--oracle-fixture packages/server/fixtures/coverage-oracle.json]
bun run dev:web

bun run decks <deckUrlOrFile> [more...]
bun run decks --no-save <deckUrlOrFile>
bun run pool [--commanders]
bun run pool --play [--seed S] [--ai]
bun run pool --write [--seed S]
bun run play-decks <deckA> <deckB> ...

bun run retag                           # dry run
bun run retag --write [--force]
bun run coverage [--json]
bun run staples
bun run coverage:complete               # coverage + staples over the full fixture population
bun run coverage:snapshot [url...]
bun run snapshot:oracle
bun run modelled-cards
bun run combat-sweep [--games N] [--seed S] [--json out.json]
bun run ai-bench                        # AI benchmark harness (ADR 0026)
bun run agent-client [--seat P1] [--seed S] [--port N] [--provider random|ai]
```

- If the production typecheck runs out of memory, set `NODE_OPTIONS=--max-old-space-size=8192` for that command.
- `agent-client` plays one seat over the running server's `/ws` as a JSON process (NDJSON on stdout, one reply line per decision on stdin, diagnostics on stderr). It is a client of the single-player flow, not another way to run a game. See [the JSON agent client](json-agent-client.md).
