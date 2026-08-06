# 0024 — Bounded combat search for the heuristic bot (ADR 0023 Phase 7)

Date: 2026-08-06

Status: Proposed

## Context

ADR 0023 built a heuristic bot (`packages/bot`) that scores every decision — including combat —
as a one-shot evaluation of the _current_ board (`evaluate.ts`). That is a reasonable model for
most decisions (cast this spell, play this land: consequences are local and immediate) but it is
known-weak for combat specifically. A block or damage-split choice's real cost often only shows up
a turn later: a chump-block that turns out to matter once a wrath resolves, a trade that opens a
lethal swing back, a damage split that leaves the wrong creature alive. 0023 named this gap and
deliberately deferred fixing it (its Phase 7 row: "Deferred, optional, separately-scoped — bounded
combat search"), because the prerequisite — some form of lookahead — runs into a real constraint:

> Full fork-based MCTS remains unavailable while the engine is generator-driven [...] Neither claim
> rules out _bounded_ search that doesn't need to clone the whole engine [...] If full-engine search
> ever becomes desirable, the prerequisite is still a cloneable state representation, and that
> should be its own ADR.

0023 named two plausible bounded techniques without committing to either:

1. **Seed-replay branching** — since every game is fully seeded (brief §5.9), reach a hypothetical
   alternate branch by replaying recorded decisions from the seed and diverging at the fork. Exact,
   but expensive: a full generator re-run per hypothetical.
2. **Combat-only structured search** — restrict the search to the attack/block candidate space
   itself, validate candidates with the engine's own legality checks, and estimate the opponent's
   response with a cheap greedy/beam-limited heuristic rather than full search.

This ADR picks between them and defines a minimal, shippable Phase 7.

## Decision

Adopt **technique 2 (combat-only structured search)** as the primary mechanism. Seed-replay
branching is exact but pays a full engine re-execution per hypothetical branch explored, which is
disproportionate for what is, in the cases that matter, a same-phase, single-decision lookahead.

1. **Scope stays narrow: block declaration and combat-damage-split only.** Attack declaration is
   explicitly out of scope for this phase — the attacker already benefits from `evaluate.ts`'s
   threat-weighting against public information (0023 item 8), and the "wrong choice costs you a
   turn later" failure mode 0023 identified is concentrated on the _defending_ side, where declining
   to block or misjudging a split is what actually loses games.

2. **A separate, minimal `CombatSnapshot`, not a `GameState` clone.** The search operates over just
   what a single combat phase needs to resolve — attacker/blocker power, toughness, and the
   keywords that change combat math (first strike, deathtouch, trample, indestructible, menace) —
   built once per decision from the same `PlayerView` the bot already has. It is never a general
   engine clone, and it carries no reference to full game state.

3. **Search shape, bounded on both axes:**
   - Generate a **top-K candidate set** of block assignments, seeded from `evaluate.ts`'s existing
     scoring (not exhaustive enumeration — a wide board makes the full assignment space
     combinatorial).
   - For each candidate, resolve combat on the snapshot, then run a **single greedy 1-ply estimate**
     of the opponent's best response (attack-back or obvious removal) using the same `evaluate.ts`
     scoring against the resulting snapshot.
   - Score candidates on (post-combat board + 1-ply opponent response) instead of Phase 4's
     (post-combat board) alone; pick the max.

4. **Legality is never delegated to the snapshot.** Every candidate the search proposes is still
   validated through `combat.ts`'s real `validateBlockDeclaration` (including the menace check)
   before it can be chosen — the snapshot informs scoring, never legality. This keeps "engine is
   authoritative on legality" (brief §1.2) intact exactly the way 0023 kept it for
   `repairBlockDeclaration`.

5. **A hard bound with a static fallback, not a timeout.** If candidate count or combat width
   exceeds a fixed bound (e.g., more than 6 blockable attackers or 8 total permanents in combat),
   skip search entirely and fall back to Phase 4's existing static heuristic. This mirrors the
   project's existing cost-consciousness (brief §5.1, "no AI call when there's only one legal
   action") applied to compute cost instead of API cost — search is an enhancement, never a
   dependency.

6. **Determinism is non-negotiable.** No `Math.random()` anywhere in the snapshot simulator or
   candidate generation (brief §4/§5.9). Any tie-breaking among equally-scored candidates draws from
   the bot's existing seeded RNG (`packages/bot/src/rng.ts`).

7. **The snapshot must not leak hidden information.** It is built from the deciding seat's own
   `PlayerView`, exactly like every other bot decision — never from `GameState`. The 1-ply opponent
   estimate scores what the _view_ shows, not what the engine internally knows; this needs explicit
   test coverage because it is a new code path that constructs its own state object rather than
   reading one the engine already scoped correctly.

### Non-goals

- No `GameState` cloning, now or as an implicit stepping stone.
- No multi-turn lookahead — one combat phase, one opponent-response ply. Deeper search is future
  scope, not this phase.
- No change to attack declaration, mana decisions, or any non-combat decision type.
- No dependency on Phase 6 (offline weight tuning) — independently shippable, though the top-K and
  width bounds below are natural candidates for that process once both exist.

## Consequences

- Closes the lookahead gap 0023 identified for the specific decisions where it costs games, without
  requiring a cloneable engine or reopening the MCTS/RL rejection from 0023's Context section.
- Adds a second, parallel combat-resolution model (the snapshot simulator) that must stay in sync
  with `combat.ts`'s real keyword/damage rules. This is a real maintenance cost and a drift risk:
  any future combat rules fix in `combat.ts` (new keyword support, a CR correction) needs a matching
  update in the snapshot, or the search starts scoring against rules the engine no longer has.
- Adds nonzero compute cost per block/damage-split decision. Bounded by design (top-K, 1-ply, hard
  width cutoff), but still real; needs measurement once built, not assumed free.
- Needs its own fixture-driven test suite comparing the snapshot simulator's predicted outcomes
  against `combat.ts`'s actual resolutions across a battery of hand-built board states (multi-block,
  first strike, trample, deathtouch, menace, indestructible), independent of the bot's own tests —
  this is what catches drift from item above before it silently degrades decision quality.

## Open questions

- The top-K and width-cutoff values need real numbers before this ships; picking them by feel risks
  either under-searching (no benefit over Phase 4) or over-searching (violates the cost bound this
  ADR itself sets). Likely resolved empirically, in coordination with Phase 6's self-play harness
  once both exist, rather than guessed up front.
- Whether attack declaration deserves the same treatment as a follow-on phase (7b) once block/
  damage-split search has shipped and proven itself, or whether the asymmetry (attacker already
  scores adequately) holds up in practice.

## Suggested sub-phasing

| Phase | Scope                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7a    | `CombatSnapshot` + resolution simulator, with fixture tests against `combat.ts`. No bot wiring.                                                               |
| 7b    | Top-K candidate generation + 1-ply opponent scoring, wired into `blockDeclarationTargets`/`combatDamageSplitFor` behind a bound/fallback per Decision item 5. |
| 7c    | Empirical tuning of top-K and width bounds (coordinates with Phase 6's self-play harness, if it exists by then).                                              |

Each sub-phase is independently shippable and stops at a boundary for approval, per brief §14 — the
same convention 0023 followed throughout.
