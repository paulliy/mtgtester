# Rules-engine constraints

Read before changing `packages/engine`, `packages/bot`, or any provider code.

- The engine computes every legal action. Providers choose from its options; they never decide legality.
- Auto-resolve only mathematically forced actions. Strategic filtering belongs in provider policy or explicit player preference, not legal-action generation.
- Games are fully seeded. Do not use `Math.random()` in engine or bot paths; use the project PRNG/RNG.
- Providers receive a `PlayerView`, never `GameState`. Protect hidden information in UI, logs, events, action presentation, and AI context.
- Preserve deterministic replay: timing, wall clocks, and provider/network behavior must not alter fixed-seed engine outcomes.
- Prefer `unimplemented()` to an approximate card implementation. A modeled card must faithfully implement the semantics it claims.
- Coverage is evidence, not a general Commander-support claim. Add behavior tests and run coverage tools before reporting a card as modeled.
- Keep `packages/engine` free of I/O, network access, UI logic, and provider policy.
