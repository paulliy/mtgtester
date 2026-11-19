# 0026 — Attempt-level AI observability, snapshot benchmarks, and role-specific context

Date: 2026-09-20

Status: Accepted (2026-09-20)

## Context

The strategist and tactician shared one primer and nearly one serialized context even though they
perform different jobs. Provider recovery, heuristics, plan execution, and the decision cache also
made the existing `ai_calls` row an unreliable proxy for a raw model sample: rejected transport and
generation attempts disappeared when a later retry succeeded, and missing billing data became zero.

The project needs a small deterministic benchmark surface before it can justify model, routing, or
cache changes. It must not leak gold labels or hidden state to a model, and it must distinguish raw
model behavior from the production recovery pipeline.

## Decision

1. Every physical chat-completions request emits an `AiNetworkAttempt`. It records exact rendered
   messages, non-secret effective configuration, requested and response-reported model identity,
   backend/request identifiers when supplied, status, timing, raw output/error, and explicit
   reported/estimated/unknown usage provenance. Live games persist these in `ai_attempts`; benchmark
   writers fail the run when their append-only artifact cannot be written.
2. `ai_calls` remains the logical-decision/debug surface. Missing network cost is stored as `NULL`,
   while local sources remain known zero-cost decisions. Summaries expose accounting coverage.
3. Version-controlled benchmark cases keep model-facing `input` separate from optional `gold`.
   Runtime validation and a canonical content hash seal each fixture. Legal-menu arrays retain their
   original order; semantic response keys preserve target and allocation choices.
4. The benchmark CLI implements only `capture`, snapshot `eval`, and `report`. Raw mode bypasses
   local decisions and corrective recovery. Production mode enables the bounded local/retry/fallback
   chain. Turn, league, replay, and counterfactual commands are intentionally absent until replay
   parity exists.
5. The former strategist prompt is an explicit `v1` variant. `v2` uses `STRATEGIST_PRIMER`; tactical
   combat serialization remains in `TACTICIAN_PRIMER`. The strategist response envelope is unchanged.
6. Current context restores public graveyards, exile, revealed tops, poison, current battlefield
   keywords/types, and observer-safe commander text already available through `PlayerView`. It never
   accepts an opponent deck profile.
7. A deterministic, offline `StrategyProfile` reuses archetype features and reusable card-role
   evidence. Profiles are keyed by immutable deck snapshot, profile version, and card-definition
   hash. A separate current pointer can advance without rewriting historical profiles.
8. CI runs deterministic fixture/hash, semantic-scoring, privacy/context, attempt-capture, and
   profile tests without provider credentials. Live promotion remains a trusted manual/release job.

## Consequences

- Failed and superseded requests remain visible, and an unknown billed amount is no longer reported
  as free.
- `baseline-v1` and `current` can evaluate the same immutable cases while holding the model config
  fixed.
- The committed `core-fast` suite is a starter contract suite, not statistical evidence. It must
  grow from captured failures toward the planned 50 tactical and 25 strategic positions.
- Production defaults now use the role-specific v2 strategist context; the v1 path remains callable
  and hashable for regression comparisons.
- Replay, plan-lifecycle attribution, memory/features/budgeting, routing, provider-cache studies, and
  live promotion gates remain later phase boundaries rather than placeholder CLI commands.
