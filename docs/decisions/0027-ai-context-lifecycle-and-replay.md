# ADR 0027: Modular AI context, plan lifecycle, and fresh-engine replay

Status: Accepted
Status note: for benchmark evaluation; production toggles remain off by default. The ADR records no date.

## Decision

Public memory, observation-safe state features, effect-preserving card summaries, and deterministic
context budgeting are separate versioned components and flags. The budgeter never removes the
legal menu, stack, own hand, commander state, or battlefield objects. If mandatory context exceeds
the configured estimate, it reports `larger_context_required` instead of silently truncating it.

Executable turn plans use stable plan/action identities, a source observation hash and event
sequence, typed preconditions, dependencies, objectives, and explicit lifecycle events. Matching,
submission, and engine acceptance are distinct. Evidence-scoped invalidation is separately
flagged; the rollout default retains legacy behavior until production benchmarks justify changing
it. Scoped attribution cites visible event sequences or remains ambiguous.

Replay fixtures contain the complete initial `GameConfig`, seed, full submitted
`DecisionResponse`, normalized request, permitted player observation, and canonical state hashes.
Verification reconstructs a new generator-backed engine from initial conditions and replays the
transcript. Spectator snapshots and JSON-cloned engine instances are not execution checkpoints.

Controlled turn benchmarks reconstruct the same fork, freeze observation-only policies, and
report ready-plan and asynchronous-plan modes separately. They stop at the active-turn boundary,
elimination, game over, or a deterministic transition limit.

## Consequences

- Context ablations can change one component without confounding the others.
- Unknown lethal feasibility stays explicit; flexible mana sources are not double-counted.
- Opponent activity alone is not causal evidence under the scoped executor.
- Engine or fixture drift becomes a replay mismatch, not a model loss.
- Live quality/cost promotion still requires captured provider runs; deterministic tests do not
  claim model improvement.
