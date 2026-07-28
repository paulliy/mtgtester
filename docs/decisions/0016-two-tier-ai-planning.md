# 0016 — Match-scoped strategist and tactical decision tiers

Date: 2026-07-27
Status: Accepted

## Context

Per-decision prompting produced legal play but weak sequencing. The previous `TurnPlanManager`
also lived inside each seat provider, so the active player's queue never observed a different
provider's response. A real opponent intervention could therefore leave a stale local plan
alive. Unscoped actions could also execute in a later phase than the one that created them.

The project needs a measurable skill baseline before increasing model cost. Full Commander
games average roughly 50–60 turns and are too expensive for rapid comparisons.

## Decision

1. One match-scoped `StrategyCoordinator` is shared by every seat provider. Every surfaced
   response reaches it. A non-pass opponent action invalidates the active strategy and plan.
2. Once per active turn, at the first surfaced decision after the beginning phase, a strategist
   receives only that player's `PlayerView`, recent seat-local decisions, and public history.
   It returns a structured standing intent and phase-scoped planned actions.
3. This strategist request is deliberately not an engine choice. It is the accepted exception
   to brief §5.1's decision-only call timing. It cannot mutate game state. Every planned action
   must still match an engine-generated legal menu exactly.
4. Tactical calls receive the strategy as advice. They use a separate model/reasoning/output
   profile and cannot install replacement plans. Local execution fails closed on malformed
   fields, stale phases, missing actions, or invalid targets.
5. OpenRouter defaults are `deepseek/deepseek-v4-flash` with reasoning for strategy and
   `qwen/qwen3.7-flash` without reasoning for tactics. These, the effort, token budgets,
   enablement, history depth, and later rollout support are all environment-configurable.
6. Skill comparisons use `--ai`, fixed seeds, and an intentional 20-turn cutoff. They report
   land-drop opportunities missed, repeated non-pass state/action pairs, first elimination,
   cutoff board development, model calls, fallbacks, tokens, and latency.
7. Exact combat rollouts remain disabled behind configuration until the two-tier system has
   been measured independently.

## Consequences

- Calls can increase by at most one strategist request per active turn, while exact plan steps
  can remove later tactical calls.
- Plans can span a turn, but each action carries its intended phase/step. A missed earlier step
  expires rather than firing in combat or a later main phase.
- Strategy output is non-authoritative and hidden-information safe by construction.
- Model quality, reasoning cost, and response limits can be changed without code edits.
