# MTGTester: Explainable Multiplayer Threat Assessment

## 1. Goal and scope

Determine which opponent most threatens our chances of winning, why, and when action is required. Supply the strategist with compact, evidence-backed assessments and supply the tactician with actionable threat sources and deadlines.

This is a proposed implementation, not a tested scoring system or a fresh repository audit. It extends the supplied AI Improvement Plan v2: observer-safe context, deterministic features, independent feature tests, and replay-based validation. Proposed module names must be checked against the current repository before implementation. No model change is required.

Do not collapse these distinct questions into one answer:

- Who can end the game soonest?
- Who can eliminate us before we get another useful opportunity?
- Who is building the strongest long-term position?
- Who can interfere with our own winning line?
- Which legal action best improves our position?

The biggest threat is not necessarily the player we should attack, and the correct removal target is usually a specific threat source, not simply any permanent controlled by the highest-ranked player.

## 2. Information boundary

Compute assessments from the observing player's permitted view and visibility-filtered history. The acting AI must never receive opponent hands, library order, private decklists, or evaluation-only state just because the server knows them.

For an opponent's hand, use hand size and identities currently known to the observer. Track how each identity became known and whether it remains known after movement or randomization. Unknown cards are flexibility, not confirmed removal or combo pieces. Our own private hand may affect our ability to answer a threat without being disclosed to opponents.

Every feature carries its source, observation sequence, and status: exact, estimated, unsupported, or unknown. Missing data is not zero. Unsupported mechanics must be visible in the result.

## 3. Features to extract

| Feature family           | Measurements                                                                                                                     | Interpretation and safeguards                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combat board             | Available attackers, power, evasion, effective keywords, attack restrictions, blockers, recurring damage, supported pump effects | Estimate feasible damage against each defender; raw total power is only a fallback. Respect current and next-combat availability separately.                                                 |
| Noncombat wins           | Supported visible combos, alternative victory progress, drain loops, recurring damage, relevant stack effects                    | Recognize only verified patterns and supported search results. A tutor or one combo component does not prove a win.                                                                          |
| Resource engines         | Repeatable card draw, token creation, recursion, mana engines, triggers and their usable enablers                                | Measure likely output within a stated horizon. Value a functioning engine differently from an inactive piece.                                                                                |
| Hand resources           | Unknown card count, currently known usable cards, recent draw rate                                                               | Diminishing returns for unknown hand size; known-card capabilities replace, rather than duplicate, generic unknown-card value.                                                               |
| Mana                     | Available colored mana, usable untapped sources, alternative uses, restrictions, burst resources, projected next-turn access     | Untapped lands are not automatically castable interaction. Do not count the same source twice. Keep present response capacity separate from future development.                              |
| Life and defeat exposure | Life, relevant counters, commander-damage relationships, supported loss prevention and alternative conditions                    | Life is a buffer or spendable resource, not a linear threat score. Low life can make someone vulnerable without making their combo harmless. Use engine-defined rules, not copied constants. |
| Recent pressure          | Damage and other harmful effects by actor and recipient, within a bounded history                                                | Separate combat, noncombat, self-inflicted loss, and non-damage life loss. Old damage is not a permanent grudge.                                                                             |
| Resilience               | Protection, expendable resources, recursion, replacement access, recovery cards known to observer                                | Estimate how much danger remains after a plausible answer. Protection is conditional on timing, costs, and scope.                                                                            |
| Disruption               | Known usable answers, restrictions/taxes affecting our plan, control effects, relevant open mana                                 | An opponent holding interaction is not automatically the table's biggest threat. Report interference separately.                                                                             |
| Timing and trajectory    | Turn order, next untap/combat, current priority window, resource changes, engine growth                                          | Equal boards can differ in urgency because one acts sooner. Compare snapshots at similar turn boundaries.                                                                                    |
| Commander dependence     | Commander abilities, state, recast access, dependency of engines on commander                                                    | Use actual visible abilities and deck evidence for our own deck; do not infer an opponent's hidden build from commander identity alone.                                                      |

Do not score all permanents by mana value or count alone. Ten inert tokens and a small functioning win engine must remain distinguishable. Avoid generic name/keyword regexes for high-confidence interaction claims; use supported semantic capabilities, curated pattern definitions, and explicit uncertainty.

## 4. Assessment algorithm

### Step A: Detect urgent situations before scoring general strength

Create an urgent-event list for each opponent. Record the source, affected players, outcome, response deadline, available evidence, search scope, and uncertainty.

Suggested urgency classes:

1. Immediate terminal outcome pending, or a supported forced line within the current window.
2. Proven feasible terminal line within a specified upcoming opportunity, subject to stated response assumptions.
3. Credible but unproven terminal threat or a must-answer engine that will remove useful response opportunities.
4. No detected urgent event within the tested scope.

“A legal line exists” is not “a forced win.” Track feasibility and resistance to responses separately. Search results use proven, possible, not-found-within-bound, and unknown; never turn bounded-search failure into proof of safety.

Evaluate table-wide outcomes and danger to our seat separately. When urgent events compete, compare response deadlines and consequences. If an opponent's action is currently helping us prevent another opponent from winning, do not mechanically counter it because its controller ranks highly.

### Step B: Score underlying strategic strength

Compute eight normalized dimensions in [0,1]. Start with explicit versioned mappings and saturation caps; fit them later on development cases. Avoid table-relative min/max scaling: it would make a weak player score 100 simply because all other players are weaker.

Provisional strategic strength:

S = 100 × (0.25 W + 0.20 E + 0.15 C + 0.12 M + 0.10 H + 0.10 R + 0.05 D + 0.03 L)

Where:

- W: supported progress toward a win, excluding duplicate combat contribution.
- E: repeatable engine strength and expected near-term growth.
- C: feasible combat pressure, not total printed power.
- M: usable mana economy over the declared horizon.
- H: hand flexibility and known usable resources.
- R: resilience and rebuilding capability.
- D: disruption/control capability relevant to the game.
- L: effective survival buffer or usable life resource.

These weights are starting hypotheses, not measured optimal values. S is not a win probability. Urgency is not averaged into S: a confirmed immediate win must never be outweighed by a large but slow board.

Prevent double-counting by recording component contributions. For example, current cards belong to H, expected future draw belongs to E; current mana belongs to M, future recurring growth belongs to E. A synergy bonus covers added capability beyond the independently counted components, not their full value again.

Unknown features retain an uncertainty range or missing-feature flag. Do not silently renormalize weights around missing information or multiply the entire score by confidence, which would make poorly understood opponents appear safe.

### Step C: Estimate danger to our seat

Return a pairwise pressure matrix: attacker/source player → affected player. Include feasible combat, targeted engine effects, terminal conditions, and response windows. Each cell states its assumptions; do not sum hypothetical attacks against all defenders as if all were simultaneously possible.

As an initial historical-pressure feature, use:

recentPressure(p → q) = Σ severity(event) × 0.7^(elapsed table rounds)

The decay factor is provisional. Event severity separates damage from elimination exposure and other material effects. Avoid dividing by current life without a cap: this creates unstable scores near zero. History indicates demonstrated ability and direction, not a commitment to attack again.

Prioritize predicted future harm over historical damage. Someone who dealt substantial damage but then lost their board should fall in ranking immediately. Someone who dealt no damage but assembled a win engine should rise immediately.

### Step D: Return rankings with uncertainty

Return overall threat, direct danger to us, strategic leader, and interference with our current plan. Overall ranking compares urgent outcomes and deadlines first, then strategic strength within comparable urgency bands. Permit ties and uncertain top sets; do not force a confident winner when evidence does not support one.

Initially use a 5-point strategic-score tie band as a tunable heuristic, not a statistical confidence interval. Avoid rank flicker from minor resource changes with a provisional 5-point switch margin for nonurgent leader changes. Bypass stabilization for new urgent events, eliminated players, and removed threat sources. Always expose fresh raw scores even when a displayed label is stabilized.

## 5. From threat ranking to an action

The strategist consumes the assessment, our deck objectives, and our available resources. It chooses whether to answer, race, defend, develop, or wait. The tactician selects a complete legal action and targets through the existing engine interface.

Evaluate candidate answers by threat reduced, urgency, resource cost, likelihood of success under declared assumptions, collateral consequences, and which remaining opponent benefits. Answering the leading player can hand the game to someone else; recompute the remaining threats before recommending a major commitment.

Examples of intended behavior:

- Preserve interaction for a supported win attempt rather than spend it on a large irrelevant creature.
- Attack a vulnerable engine player when doing so meaningfully prevents their win, not simply because their life is low.
- Do not eliminate a player solely because it is possible when that player is currently containing a more dangerous opponent.
- Do not assume another opponent will spend their removal. Distinguish known capacity from observed action or a supported explicit commitment.

If a separate micro-agreement system is implemented, consume only visible, active, scoped agreements as a later optional feature. They do not change legality, guarantee compliance, or erase objective danger. This plan does not implement negotiations or persistent grudges.

## 6. Output and integration contract

Proposed modules: threat/features.ts, threat/urgency.ts, threat/score.ts, threat/history.ts, threat/explain.ts, and threat/types.ts. Reuse existing observer-safe projections and bounded evaluators where suitable; do not expose full simulation state through convenience helpers.

Each assessment contains:

- Observer seat, observation/event sequence, phase, scoring version, and coverage flags.
- Opponent ID; overall rank/tie group; strategic score and components.
- Urgent events with affected seats, deadlines, source object IDs, and assumptions.
- Direct danger to observer, interference with our current plan, and vulnerability as separate fields.
- Top three reasons, evidence references, uncertainty, and suggested sources to investigate or answer.
- Changes since the previous assessment and their causes.

Example explanation: “Player B is the immediate threat: a supported visible engine has a feasible win line before our next turn. Player C has the largest combat board but no detected lethal against us within the searched scope. B's unknown hand may contain protection; that is not confirmed.”

Generate explanations from component evidence first. An optional LLM interpretation may challenge a ranking, but must give source-backed reasons and remain distinguishable from the deterministic assessment. Do not ask the model to regenerate a long analysis at every priority pass.

Recompute on relevant board/zone changes, draws/discards, source availability, attack/block declarations, important stack changes, life/counter changes, and turn transitions. Mark assessments stale by event sequence. Cache only against an observer-safe fingerprint that includes timing, history version, and evaluator version. Bound search work; on timeout return partial coverage and uncertainty, never fabricated safety.

Keep the prompt summary compact: top opponents, urgent events, reasons, uncertainty, and response deadlines. Preserve essential evidence even when the token budget is tight. Benchmarks must compare strategist behavior with and without supplied rankings to detect anchoring bias.

## 7. Small, provable implementation milestones

| Milestone                  | Deliverable                                                 | Acceptance evidence                                                                                                                             |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| T0: Contract and fixtures  | Types, observation boundary, first 12 handcrafted positions | Hidden-hand permutations produce identical outputs when visible information is unchanged; self and eliminated opponents excluded.               |
| T1: Basic features         | Board, hand count, mana, life and timing extraction         | Supported feature fixtures match manually checked values; source alternatives cannot double-count mana; unknown fields remain explicit.         |
| T2: Urgency                | Supported combat/stack/visible-win detectors                | All reviewed supported urgent fixtures detected; impossible lines rejected; search-limit results remain unknown or bounded.                     |
| T3: Strategic ranking      | Eight components, initial weights, evidence explanations    | Deterministic outputs; functioning engines outrank inert boards in reviewed cases; reasons map to actual features.                              |
| T4: Directed history       | Pressure matrix, decay, trajectory                          | Damage to someone else is distinguished from damage to us; board wipes remove stale danger; old aggression cannot override urgent threats.      |
| T5: Shadow integration     | Log assessments alongside unchanged production choices      | Every output traceable to observer/event/version; stale state and runtime overhead measured; no behavior change yet.                            |
| T6: Strategist experiment  | Context toggle with identical model and other settings      | Paired reviewed results show useful threat/objective improvements without new confirmed critical regressions; uncertainty reported.             |
| T7: Action/game validation | Controlled turn tests and later seat-balanced games         | Better threat recognition translates to useful answers or gameplay outcomes without unacceptable latency/cost; otherwise keep feature disabled. |

First useful stopping point: T0–T3. T4–T6 determine whether richer context actually helps the AI. T7 depends on the replay work in Improvement Plan v2; it must not be presented as implemented before replay parity exists.

## 8. Evaluation design

Grow to 40 reviewed positions: 24 development and 16 held-out cases, grouped by source game/deck family to limit leakage. Use acceptable top-threat sets, deadline labels, rationales, feature ground truth where possible, confidence, and support status. Relabel a small shuffled subset later without viewing earlier answers. Ambiguous cases remain ambiguous.

Cover: wide boards versus compact engines; low-life combo players; high-life inactive players; large unknown hands versus small known actionable hands; open colored mana versus unusable sources; tapped-out current turns versus upcoming untaps; commander-specific danger; public graveyard recursion; obsolete damage history after wipes; third-player interventions; near ties; eliminated players; unknown mechanics; and threat rankings that differ by observing seat.

Required metamorphic tests:

- Change only hidden cards: unchanged observable assessment.
- Change player labels and seat IDs consistently: equivalent assessment, accounting for preserved turn order.
- Increase feasible damage without other effects: combat-pressure component cannot decrease.
- Remove an engine enabler: dependent capabilities disappear or weaken.
- Remove a mana source used in a line: feasibility is rechecked.
- Change attack direction: direct-danger estimates change appropriately.
- Move the response deadline earlier: urgency cannot become lower solely from that timing change.

Compare against simple baselines: highest creature power, largest resource count, current strategist without features, and proposed assessment. Report acceptable-top-threat rate, missed critical threats, false urgent alerts, pairwise ordering accuracy on labeled pairs, abstention/coverage, privacy failures, and per-category results. Do not grade the system against gold labels generated from its own weights.

For strategist A/B tests, use the same snapshots, model settings and output budget; begin with three independent trials per case to expose instability. Cluster uncertainty by case/source game. A small suite cannot establish a 2-percentage-point quality difference reliably; inconclusive results retain defaults and motivate preplanned sample expansion.

Separate identifying a threat from choosing an answer. Measure wasted interaction, urgent threats left unanswered when a supported answer existed, opportunity costs, and source-target correctness. Full games come later; vary seats and decks, keep opponents fixed, and report win/finish results alongside tactical evidence.

Before candidate evaluation, freeze tolerances and runtime budget. Proposed initial engineering target: cached/basic assessment P95 ≤ 5 ms and bounded-search-inclusive P95 ≤ 25 ms on a declared representative machine and workload. These are unverified targets, not promises. Search-budget exhaustion is a coverage metric, not proof that no threat exists. Privacy failures and new confirmed supported critical regressions block activation; noisy win-rate results do not alone justify changing defaults.

## 9. Definition of success

The system recognizes urgent threats, explains its evidence, respects hidden information, responds to changed circumstances, and helps the strategist choose better objectives or answers at acceptable cost. A visually convincing score, always picking one leader, or attacking the highest-scored player more often does not establish success.

Version weights, feature mappings, pattern support, and fixtures. Ship behind a feature flag with the previous validated configuration available for rollback. Expand capability from observed failures rather than adding speculative heuristics without tests.
