# AI benchmark assets

These are the frozen snapshot fixtures of ADR 0026. The engine-backed tactician benchmark that
plays models' answers through the engine and writes a bundle for judge models is separate: see
[bot-bench/README.md](../bot-bench/README.md) (ADR 0039).

Snapshot cases and suites are immutable inputs. Generated outputs belong under the gitignored
`benchmark-output/` directory.

## Immutable snapshot content vs refreshable compatibility pins

A case file holds two different kinds of data, and only one of them is immutable.

- **Snapshot content is immutable.** `input` (the request, view, guidance, recent decisions, memory,
  profile), `gold`, `categories`, and the case identity are the model's input and the reviewed
  judgement about it. They are never edited in place. A changed observation is a _new_ case captured
  with `ai-bench capture`, so a scored result always refers to the exact bytes that were reviewed.
- **Source-compatibility pins are refreshable.** `supportedEngineVersion` and
  `supportedCardDefinitionHash` record which engine and card semantics the snapshot was taken
  against. They are derived, not authored: `captureCase` always computes them from
  `benchmarkSourceHashes` and ignores any pin carried on a capture input. They go stale whenever
  engine sources legitimately change, and `assertFixtureCompatibility` then fails closed rather than
  scoring a snapshot against semantics it was never taken from.
- **`contentHash` seals both.** It covers the whole case including the pins, so re-pinning also
  reseals it. That is why the pins cannot be hand-edited.

Re-pin with the dedicated command. It is a dry run by default and prints every old-to-new value:

```powershell
bun run ai-bench refresh --suite core-fast            # dry run: report only, writes nothing
bun run ai-bench refresh --suite core-fast --write    # apply the reported re-pin
bun run ai-bench refresh --case benchmarks/tactician/dev/priority-removal-001.json
```

`refresh` verifies each fixture's original `contentHash` against its original content before
computing new pins, even in a dry run. A stale hash fails with the fixture path and no writes. It
preflights every selected case before writing any case. Each changed file is written to an exclusive
temporary file in the same directory and renamed into place. The operation is atomic per file, not
across multiple files: if a later rename fails, the error lists the paths already updated. Rerun
`refresh --write` after resolving the failure; already-current files are skipped. Only the three
sealed scalars change, preserving all other bytes.

`--case` and suite entries stay within `benchmarks/`; suite files stay within
`benchmarks/suites/`, and variant files within `benchmarks/variants/`. Suite entries may use `../`
to leave `suites/` for another directory under `benchmarks/`. Traversal, absolute suite entries,
and symlink escapes are rejected. Capture manifest outputs must also stay within `benchmarks/`,
including paths whose final file does not yet exist. Other explicit output paths retain their
existing behavior.

The runtime fixture boundary accepts only documented top-level `PlayerView` and `OpponentView`
keys and checks `view.seat` against `observerSeat`. Authorized own-player `hand` and `deck` remain
available. Shape allowlists do not prove that private identities have not been mislabeled as
public fields. never return opponent decklists or private card data.

The pins are computed from a filesystem walk of `.ts` files under `packages/engine/src` (and
`packages/engine/src/cards`), with CRLF normalized to LF and relative paths normalized to forward
slashes before sorting. Real-but-untracked source is therefore covered, generated artifacts are not,
and a Windows checkout with `core.autocrlf=true` produces the same hash as CI on Linux. The walk does
not shell out to git, so the hash is computable where git is absent.

Commands:

```powershell
bun run ai-bench eval --suite core-fast --role tactician --variants current,context-combined-v1
bun run ai-bench eval --suite core-fast --role tactician --variant jev-1.13-v1 --tactician-policy jev --mode raw
bun run ai-bench replay --config path/to/game-config.json --output benchmark-output/run/replay.json
bun run ai-bench replay --input benchmark-output/run/replay.json
bun run ai-bench turn --input benchmark-output/run/replay.json --strategy path/to/strategy.json --seat P1 --fork 12 --mode ready
bun run ai-bench turn --input benchmark-output/run/replay.json --strategy path/to/strategy.json --seat P1 --fork 12 --mode asynchronous --arrival-decisions 3
bun run ai-bench counterfactual --input benchmark-output/run/replay.json --fork 12 --seat P1 --candidate candidate.json --baseline baseline.json
bun run ai-bench cache-report --attempts benchmark-output/run/attempts.jsonl
bun run ai-bench promote --baseline baseline-report.json --candidate candidate-report.json --policy benchmarks/release-policy.json --critical-blunders 0 --privacy-leaks 0 --illegal-actions 0 --comparable-workload true --deterministic-gates-passed true
bun run ai-bench league --config path/to/game-config.json --output benchmark-output/league.json
bun run ai-bench refresh --suite core-fast [--write]
```

The E-component variants are independent. Promote none of them from benchmark results produced by
another toggle. `context-combined-v1` is for the incremental/leave-one-out stage only. The scoped
executor variant changes attribution and execution behavior, so compare raw strategist output and
production results separately.

The policy registry is initially shadow-only: model-backed candidates remain `unmeasured` and are
not eligible for active routing. The release policy is also `proposed`; promotion evaluation must
return `inconclusive` until it is validated against measured baseline data. Cache reports claim
hits only from provider-reported cache token fields and never infer a cold cache from a fresh local
process.

Jev evaluation writes typed-decision attempts to `attempts.jsonl` with `kind: "decision"` and
policy outcomes to `jev-traces.jsonl`. Raw mode measures Jev alone; production mode permits the
configured chat and heuristic recovery chain. Neither command promotes or enables Jev.
