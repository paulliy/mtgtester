# 0026 — Observer-safe multiplayer threat assessment

Status: Experimental; production policy defaults unchanged.

The strategist previously received public board descriptions but no deterministic, attributable
multiplayer threat assessment. This implementation supplies urgency, strategic strength, direct
seat danger, evidence and uncertainty through the existing PlayerView boundary.

## Rollout

Set `AI_THREAT_ASSESSMENT_MODE` to:

- `off` (default): existing prompt and policy behavior. Public semantic projection is available,
  but assessment computation, logging and context are disabled.
- `shadow`: compute and log assessments in engine decision debug entries. Existing prompts,
  local answers, decision cache and action selection are unchanged.
- `context`: experimental compact assessment in strategist and tactician prompts. Urgent events
  bypass existing tactical plan/local shortcuts so the model sees the new evidence. The legacy
  tactical decision cache is disabled because its key omits threat history and observation timing.

Roll back with `off`. No model, API budget, legal action generator, card model or UI change is
required. Providers still choose complete engine-generated actions; threat rank never selects a
removal target or mandates an attack.

## Observation and semantic support

`packages/engine/src/view/threat.ts` produces typed public facts. It never passes card definitions,
GameState, opponent hands, library order or private decklists into the assessor. Structured damage
history copies only an allowlist of public player-damage fields, bounded to 64 events from the last
512 engine events; truncation is visible. Non-damage harm history is currently unsupported.

Permanent capabilities use layer-computed characteristics. The initial closed subset supports:

- Current creature readiness, computed evasion keywords, attack destinations, block markers and
  public commander identities. Current and next-combat upper bounds are separate fields.
- Fixed, unconditional tap-only mana alternatives, including restrictions and activation locks.
  One permanent contributes its largest available unrestricted alternative once. A rainbow unit
  is one mana. Complex costs, dynamic production, activation riders, floating mana and next-turn
  mana forecasts are explicitly outside current coverage. Colors are retained as alternatives;
  the scalar economy score is not a claim that a particular interaction spell is castable.
- Unconditional controller-upkeep/end-step/draw-step/precombat-main constant draw and token
  triggers, valued over one controller turn. Conditional engines, optional payments, loops and
  other activated engines are unsupported. Removing a capability removes its contribution.
- Constant targeted damage/life-loss stack objects whose resolution contains only those
  supported effects. Mixed or conditional sequences are not interpreted.

Face-down identity and abilities stay hidden. Missing capability fields in old/test views produce
unknown features, not zero-valued knowledge. A zero in a partially supported dimension denotes
zero detected contribution in its declared subset, with a broad interval for unsupported output.

## Assessment

`packages/server/src/ai/threat/` contains types, extraction, urgency, scoring, history, explanations,
caching and evaluation tools. The version is `threat-v1.0.0`.

The eight original weights are preserved without table-relative scaling or confidence discounts.
Unsupported W (noncombat win progress) and D (plan-specific disruption) retain `[0,1]` intervals;
the scalar score uses their midpoint without renormalizing the other dimensions. These provisional
scores are not win probabilities. Other dimensions expose their support and uncertainty as well.

Urgency is sorted before strategic strength and is never averaged into the score. The detectors
cover simple terminal stack impacts and declared unblocked combat damage, including remaining
first/double-strike steps, infect and per-commander damage thresholds. Thresholds are shared with
engine SBA checks. Outcomes are **possible under stated assumptions**, never forced or proven.
There is no general combo, alternative-win or bounded combat search; no detector result claims
that an unsearched position is safe. Taxes, prevention, replacement effects, future responses and
complex blocking are not proof-supported. The ordinary pairwise combat estimate is a greedy
screen used only as a heuristic, distinct from the narrow urgency detector.

The pairwise matrix keeps each alternative defender separate. Recent pressure decays by
`0.7^(elapsed turns / current live seats)`, an estimated table-round measure that ignores extra-turn
structure. It excludes self-damage and is reported independently of strategic strength, so old
aggression cannot outweigh a current urgent source. Current seat danger does not include the
next-combat upper bound as though tapped creatures could attack immediately.

Each feature includes status, observation sequence, evidence source IDs and explanation. Outputs
include raw scores, five-point tie groups, uncertainty-aware overall top sets, strategic/direct
rankings and a stabilized display leader. Missing plan-specific interference is explicitly unknown;
its empty ranking is not a claim that no one can interact. New urgency, elimination and removed
sources bypass display stabilization. Raw scores are always fresh.

The cache is bounded to 16 observers and keyed on the filtered view, observation sequence,
timing, history and evaluator version. It contains no private hand/deck data. Observation timing
comes from the projected state, including when the strategist prefetches a future turn. Wall-clock
latency is diagnostic only and never controls deterministic decisions.

## Plan milestones and remaining work

The original proposal is preserved in `docs/plans/threat-assessment-plan.md`.

| Milestone | Implemented now                                                                         | Remaining acceptance work                                                                |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| T0        | Typed boundary, 16 development positions, actual-engine hidden-card invariance tests    | Independent label review and expansion to 40 grouped cases                               |
| T1        | Public board, hand size, scoped mana/engine features, life/counters/timing              | Wider mana, known-card provenance, conditions and future resource support                |
| T2        | Narrow combat and stack urgency detectors with explicit assumptions                     | Verified visible-win patterns and response-aware bounded search                          |
| T3        | Eight dimensions, versioned mappings, evidence, uncertainty, ties                       | Calibration on independently reviewed development cases                                  |
| T4        | Directed bounded damage history, decay, source/score changes                            | Non-damage harm and comparable-turn trajectory analysis                                  |
| T5        | Shadow integration, observer/sequence/version/latency traces, cache and isolation tests | Representative production workload and long-game overhead measurement                    |
| T6        | Context toggle and three-repeat paired strategist harness                               | Actual fixed-model trials, blinded review, clustered uncertainty and activation decision |
| T7        | No gameplay-strength claim                                                              | Replay parity, controlled answer evaluation and seat-balanced games                      |

This is an executable initial rollout, not completion of every proposed detector or empirical gate.
No automatic activation is tied to passing the synthetic tests. Unknown mechanics, privacy failures
or new supported critical regressions block activation.

## Validation and reproduction

Use the repository's normal Bun installation:

```sh
bun run test -- packages/server/src/ai/threat packages/engine/tests/threat-view.test.ts
bun run typecheck
bun run typecheck:tests
bun run lint
bun run format:check
bun run test
```

The focused suites include 49 checks at this revision. They cover 16 handcrafted positions,
hidden-hand/library changes through the real projection, face-down redaction, mana alternatives,
missing fields, source removal, seat renaming, direction and decay, commander/infect thresholds,
first strike, stack projection, tie stabilization, observation invalidation and prompt isolation.
The paired-trial harness is tested with a deterministic stub, not a paid model or real game.

On the local Node 24.19.0 / AMD EPYC 9V74 environment, the 16 development cases produced zero
missed labeled urgent threats and zero false urgent alerts. The raw leader matched the authored
acceptable sets in 16/16 cases versus 11/16 for each simple baseline. The uncertainty-aware
assessment abstained from a unique top set in 11/16. These are development sanity checks, **not**
held-out performance, independent review, or evidence of better decisions/win rate.

A 4-seat/80-permanent synthetic workload (200 measured iterations after warmup) measured core
assessment P95 about 0.36 ms and cache lookup P95 about 0.14 ms. This excludes engine projection,
logging, network and any bounded search. It does not certify the plan's end-to-end latency target.

Production TypeScript, engine/server test types, Vue type checks and repository lint passed. The
full suite run passed 2,224 tests with 29 skipped, with one environment failure:
`packages/server/src/db/batches-recovery.test.ts` could not spawn the missing `bun` executable.
The later added evaluation/projection checks were run in the focused suite. The full-suite blocker
is unrelated to threat logic; it must still pass in the normal Bun/CI environment before merge.
