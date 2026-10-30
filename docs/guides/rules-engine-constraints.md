# Rules-engine constraints

Read before changing `packages/engine`, `packages/bot`, or any provider code.

- The engine computes every legal action. Providers choose from its options; they never decide legality.
- Auto-resolve only mathematically forced actions. Strategic filtering belongs in provider policy or explicit player preference, not legal-action generation.
- Games are fully seeded. Do not use `Math.random()` in engine or bot paths; use the project PRNG/RNG.
- Providers receive a `PlayerView`, never `GameState`. Protect hidden information in UI, logs, events, action presentation, and AI context.
- Preserve reproducible replay: a game is reproducible from its stored config, key and recorded inputs. A clock decides when a timeout fires, not what the engine does with a recorded input, and provider or network behavior must not alter the outcome of the same inputs. Out-of-band inputs (a cancelled yield, a concession) are recorded as events and replayed at their sequence. Replay is promised only on the same build and card data, and is checked with state hashes in tests ([ADR 0031](../decisions/0031-multiplayer-tables.md) decision 8).
- Prefer `unimplemented()` to an approximate card implementation. A modeled card must faithfully implement the semantics it claims.
- Coverage is evidence, not a general Commander-support claim. Add behavior tests and run coverage tools before reporting a card as modeled.
- An op that exits without acting is either rules-sanctioned or a bug ([ADR 0034](../decisions/0034-fail-loud-execution-and-strict-tests.md) decision 4). Mark the first with `noop(ctx, site, reason)` from `exits.ts`, whose closed list of reasons each cites its rule; it records only in the test-only diagnostics sink, which fuzz reads for its liveness report. Replace a guard with `invariant(site, reason)` only with a written argument that validation makes it unreachable and a test that reaches it through malformed IR. Add them to an op when a card touches it, not wholesale.
- Keep `packages/engine` free of I/O, network access, UI logic, and provider policy.
