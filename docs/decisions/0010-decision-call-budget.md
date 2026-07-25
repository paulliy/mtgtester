# 0010 — Decisions are metered: local answers, and batch shortcuts in combat

Date: 2026-07-25
Status: Accepted

## Context

[ADR 0003](0003-engine-core.md) decision 5 chose sequential single-pick menus for every
multi-select decision, accepting that it "costs more (cheap) decisions" to avoid an exponential
combined action space. That trade was correct for the engine, but it rested on decisions being
cheap. Once decisions are answered by a remote model they are not: each one is a metered
network call, and the RPM ceiling — not engine speed — is what limits how many turns a game
gets through.

A logged 30-turn four-player game surfaced 320 decisions. Reading them, the overwhelming
majority were not choices at all:

- An idle player was asked "pass priority?" at every step of every turn for ten straight turns.
  `isForced` (brief §5.1) never fired, because a pump instant that can legally target *any*
  creature stays a legal `castSpell` forever — so the menu is permanently `[pass, Cast
  Predator's Strike]` and never has exactly one option.
- A 0-power creature was asked "does it attack?" every single combat.
- Combat asked one call **per creature**, every turn, for both attackers and blockers.

Measured over three full games from the supported pool, combat declarations alone are **752 of
1,326 decisions (57%)**.

## Decision

1. **Local answers upstream of the rate limiter.** `tryHeuristic` and a per-game decision
   cache run in `OpenAiDecisionProvider.decide()` *before* `queue.enqueue()`, so a locally
   answered decision costs nothing against the RPM budget. Both are env-toggleable
   (`AI_HEURISTICS_ENABLED`, `AI_DECISION_CACHE_ENABLED`) and default on.

   Every heuristic must be *unambiguous* — dominated options only, never board judgment. A
   heuristic that misfires degrades play quality in a way the turn log will not obviously show,
   so the rules are deliberately narrow and leave savings on the table.

2. **`LegalAction.data` carries engine-computed facts.** The engine populates numbers it has
   already computed (`instantSpeed`, attacker `power`/`toughness`/`hasTriggers`, group
   aggregates) so consumers reason numerically instead of parsing `description` text. It is
   purely descriptive: the engine never reads it back, and **legality never depends on it**.

   This is what keeps a heuristic from rotting. The 0-power attack rule requires
   `hasTriggers === false` rather than assuming no attack triggers exist, so on the day one is
   modeled the decision routes back to the model automatically. Absent data fails closed.

3. **Combat declarations gain batch shortcuts, revising ADR 0003 decision 5.** The declaration
   stays sequential — a pick-one menu still cannot express a set without enumerating 4^creatures
   subsets — but each menu additionally carries `noAttackRest` / `attackRest` / `noBlockRest`,
   which settle every creature still undeclared in one answer.

   These only ever **add** options. A mixed attack is still declared creature by creature, with
   the same call count as before, so there is no regression case; per-creature option indices
   are unchanged because the shortcuts are appended. The shortcuts appear only while creatures
   remain undeclared.

   There is deliberately **no `blockRest`** counterpart: "everyone blocks attacker X" is not a
   plan a defender usually means, so batching it would invite bad blocks rather than save a
   call on a common one. "No blocks at all" is a coherent single intent, and is offered.

## Consequences

- Measured over three full games (1,326 decisions), heuristics + cache answer **15.8%** of
  decisions locally. Combat declarations would fall from **752 → 286** if every combat plan is
  uniform — a further **35% of all decisions** — but that ceiling depends on the model actually
  choosing the shortcuts, which is why the rules primer now describes them.
- The 0-power rule refuses to fire while the player holds any instant. That is a deliberate
  over-approximation of "holds a pump spell" (attack with the 0/1, then pump it is a real line);
  it errs toward asking. It cost ~2 points of savings and is worth it.
- The decision cache scored **zero hits** across all three benchmark games: its digest includes
  the whole battlefield — correctly, since the right answer depends on it — and opponents
  develop their board every turn, so state never repeats exactly. It is kept because it is
  cheap and correct, and because a stalled AI game (the case the random benchmark does not
  represent) is exactly where states do repeat.
- Random-provider benchmarks are combat-heavy and understate the priority-pass savings that
  dominated the real logged game. Treat the percentages as a floor for that workload.
- `ai_calls` gains a `source` column (`primary`/`retry`/`fallback`/`heuristic`/`cache`) and
  `summary()` reports `skippedCalls`, so the savings stay measurable rather than assumed.
