# ADR 0031: Table diplomacy and deals

Status: Accepted

Date: 2026-10-27

## Context

Commander is a four-player game, and a large part of how it is played happens between the moves:
players point at the biggest threat, ask who is about to be attacked, and make non-binding deals
("leave me alone this turn and I'll leave you alone"). The simulator has none of this. Bots never
talk, and a human in a single-player game cannot negotiate with them.

Banter and courtesy messages ("GG", "nice play") are explicitly out of scope. This ADR covers only
communication that carries game information, and deals that change what players do.

Three properties of the project shape the design:

- **Cost and speed.** Full games run 50 to 60 turns with four seats. Anything that calls a model
  per message or per seat multiplies spend by thousands of calls and puts network latency in the
  middle of play.
- **Determinism.** Fixed-seed games must replay exactly (rules-engine constraints). Deals change
  decisions, so whatever produces and resolves them must be seeded and recorded.
- **Hidden information.** Providers see a `PlayerView`, never `GameState`. A deal or a message must
  never move hidden information between seats.

The heuristic bot (ADR 0023) also lacks the thing deals are priced against. Its attack declaration
sends every creature at the defender with the lowest life, and every other targeted choice takes
the first legal option. There is no estimate of who is winning.

A naive deal evaluator ("is this deal good for me?") is easy to exploit, because a deal that is
bad on its own can be used to set up a different deal that is good. The valuation rules below are
mostly about closing those openings.

## Decision

### Messages and deals are structured, not free text

1. Every table message is a typed record in `@mtg/shared` (`diplomacy.ts`), rendered to a sentence
   by a template. Bots read and answer messages with no model call, and every deal can be checked
   mechanically against decisions.
2. Message kinds: `threatCall` (names the table leader and why), `proposal`, `response` (accept,
   decline, or a counter-proposal), `breach` (a deal was broken, with the reason the breaker
   gives), and `dealEnded` (kept to expiry, or voided by its escape clause). Questions ("who are
   you attacking?") and requests ("someone deal with that flyer") are later phases.
3. A deal is two-party and is a list of obligations, each owed by one seat:
   - `noAttack(by, against)`: `by` declares no attacker at `against` or a permanent `against`
     controls. Continuous.
   - `noTarget(by, against)`: `by` chooses no target that is `against`, a permanent `against`
     controls, or a stack object `against` controls. Continuous.
   - `noCounter(by, against)`: the stack-object part of `noTarget` only. Continuous.
   - `attackPlayer(by, target)`: at `by`'s next attack declaration inside the deal, at least one
     attacker goes at `target`. One-shot.
4. Deals cover offense only. No obligation constrains blocks, so accepting a deal never lowers a
   seat's defenses, and a broken deal can cost at most the damage of the turn it is broken in.
5. Deals are short: at most `WEIGHTS.deals.maxRounds` rounds (one round is one turn for each
   living player), and they end early on their escape clause: a deal is void the moment either
   party becomes the table leader (decision 9). A party leaving a voided deal is not a breach.
6. Compliance is judged from decisions, not prose. A submitted decision violates an obligation
   when one of its chosen targets (attack slots for `noAttack`, every other slot for `noTarget`
   and `noCounter`) belongs to the protected seat. A violation is excused only in a forced
   decision (anything but a priority decision, where passing always complies) whose slot offered
   no option that complies, so a forced target never counts as a breach but casting a spell whose
   only targets are protected does. `attackPlayer` is excused when the target was not an option
   in any attack slot. An attack declaration is judged only once the engine has accepted it: a
   rejected declaration is asked again (and after two rejections repaired by the engine, which is
   not the seat's choice), so the table holds the latest one until the next decision shows it
   stood.

### Valuation heuristics

All weights live in `WEIGHTS.deals` in `packages/bot/src/weights.ts`, in life-equivalent points
(LEP) like every other bot weight.

7. **Position.** Each living seat's position is computed from public information only: life
   (points below `dangerousLifeThreshold` count `lowLifeMultiplier` times), board value (creature
   values as in combat search, plus a flat value per noncreature nonland permanent), cards in hand,
   and lands. Poison counters reduce position. Commander damage is left out of position because
   a seat only sees the commander damage it has taken itself, and counting it for one seat only
   would bias every comparison; it enters the danger and temptation checks instead.
8. **Win share.** `w_s = softmax(position_s / τ)` across living seats. It is a rough probability
   that each seat wins, used to weigh everyone's gains against each other.
9. **Leader.** The seat with the highest win share is the leader when its share is at least
   `leaderShareRatio` times the mean.
10. **Pressure and redirection.** A seat's attack pressure is the total power of its creatures
    that can attack. Where that pressure goes is modeled with the bot's own threat-aware attack
    preference (decision 16), from the attacker's side and on public information. A `noAttack`
    obligation does not remove pressure, it moves it to the attacker's other opponents in
    proportion to their preference weights. `noTarget` and `noCounter` move a flat
    per-round interaction value the same way. `attackPlayer` moves one round of the obligated
    seat's pressure onto the target.
11. **Deal value.** For seat `me`, with `Δ_s` the projected change in each seat's position over
    the deal's duration (later rounds discounted by `roundDiscount`):

    `V = Δ_me − Σ_{s ≠ me} λ · (w_s · N) · Δ_s`

    where `N` is the number of living seats, so with equal shares every opponent's gain weighs
    `λ = opponentGainWeight`, and the leader's gain weighs far more. Helping the leader is
    expensive; moving pressure onto the leader is valuable even when it costs `me` something.

12. **Trust scales with the size of the deal.** A counterparty's continuous obligations are
    discounted by the probability they keep them:

    `P(keep) = (basePKeep + (maxPKeep − basePKeep) · kept/(kept+1) · min(1, biggestKept/stake)) · brokenDecay^broken`

    Trust earned keeping small deals barely transfers to a large one, which defeats "build trust,
    then cash it in". Every seat sees every breach, so trust is a public record per seat.

13. **Temptation.** A promise the counterparty would want to break is assumed broken: a
    `noAttack` protecting `me` is worth nothing if that seat's pressure could kill `me`.
14. **Delivery order.** If both sides' obligations are continuous, either side can stop when the
    other breaks, so `me`'s own continuous costs are also scaled by `P(keep)`. A one-shot
    obligation `me` delivers first is counted in full, while the counterparty's later delivery is
    discounted by `P(keep)`.
15. **Acceptance.** Accept when `V > acceptThreshold + noise`, where the noise is seeded per
    proposal and uniform in `±thresholdNoise`, so the threshold cannot be found by probing.
    Early in the game (`round ≤ investmentRounds`) and with a counterparty that is not the leader,
    the threshold drops by `investmentAllowance`: a slightly bad deal is accepted to build trust
    that is worth more later. Hard refusals, regardless of `V`:
    - the counterparty is the leader and `me` is not in danger;
    - `me` would owe `noAttack` against the leader, unless `me` is in danger;
    - with the new deal, `me` would owe `noAttack` against every living opponent;
    - the deal is longer than `maxRounds`;
    - the same proposer already proposed this turn, or proposed the same terms and was declined
      within `reproposeCooldownRounds`.

### Deal-aware play

16. **Threat-aware attack targets.** With diplomacy on, attack declarations stop sending everything
    at the lowest-life defender. Kills come first: while some player can be killed by the
    attackers still free to reach them, the fewest (largest first) are committed to the kill worth
    most. Each remaining attacker, largest first, goes to the defender with the best marginal
    `damageValue`: the position the defender loses (non-linear life) at
    `opponentLifePointValue`, weighted up for the leader by `leaderFocus`, plus combat search's
    lethal term when the damage eliminates that player. Planeswalkers count as their controller
    at `planeswalkerFactor`. Blockers are not modeled, as in the existing heuristic.
17. **Keeping and breaking.** A seat's own obligations are applied when it chooses targets. For
    attacks, the bot builds the best plan that complies and, for each deal it could break, the best
    plan that breaks only that deal; it breaks when the gain exceeds the reputation cost
    `breakPenalty · (living opponents / starting opponents)`, which shrinks late in the game.
    Lethal always clears it. For other targets, the bot picks a complying option when the slot has
    one, and otherwise scores the action down by the same penalty, so it usually picks a
    different action.
18. **Proposing.** At its negotiation window a bot proposes at most one deal, and only with a
    reason: the seat putting the most pressure on it is threatening at least
    `proposePressureShare` of its life, or a leader exists and another seat could be pointed at
    it. It generates a few candidates (mutual truce; truce plus the counterparty attacking the
    leader; `me` attacking the leader for the counterparty's truce), estimates the counterparty's
    `V` with the same public evaluator, and proposes the candidate with the best `V` for itself
    among those the counterparty should accept. When it declines a proposal, it counters with its
    own best candidate for that pair. This is the anchoring move: the bot's counter comes from its
    own terms, never from splitting the difference.

### Where it runs

19. **Bots never call a model to negotiate.** Proposing, answering, keeping, breaking and judging
    compliance are all heuristic, synchronous and seeded. They add no API calls and no latency.
20. **`DiplomacyTable`** in `@mtg/bot` owns active deals, trust records, proposal history, and the
    message log for one game. It is pure logic with no I/O. The driver calls `openWindow` at the
    first decision of each turn (the negotiation window, the same point the strategist runs in
    ADR 0016), gives each bot its obligations through `HeuristicProviderOptions.diplomacy`, and
    passes every submitted decision to `observe` for compliance.
21. **Off by default.** Diplomacy changes bot decisions, so default games are byte-identical to
    today's until it is enabled. It ships behind an explicit option, measured first by self-play
    (diplomacy seats against plain heuristic seats on the same seeds), the same way combat search
    was in ADR 0024.
22. **Replay.** Bot-only negotiation is a pure function of the seed and the views, so a spectator
    game replays exactly. Human proposals and answers (phase 3) are inputs, and will be persisted
    with the game's decisions the same way human actions are.
23. **Hidden information.** Obligations can only name seats, and compliance reads only chosen
    target ids. Valuation reads only public fields of the deciding seat's `PlayerView` (its own
    hand only as a count, through the same position function used for opponents). No message
    carries card names from hidden zones.

### Phases

- **Phase 1 (this change):** shared types; position, win share, pressure and threat-aware attack
  targets; deal valuation, trust, compliance and proposals; deal-aware decisions; the
  `DiplomacyTable`; and `bun run diplomacy-sweep`, which plays seeded games with two diplomacy
  seats against two plain seats (or `--all` diplomats) and reports wins and deal outcomes. It runs
  offline on the committed coverage fixture when the Scryfall bulk file is absent.
- **Phase 2:** spectator delivery. A `tableTalk` server message carrying `TableMessage`s, a log
  filter and deal lines between seat panels, and a deals toggle on the new-game screen.
- **Phase 3:** single-player. A "propose deal" panel, accept/decline/counter cards for bot
  proposals, human decisions observed for compliance and trust, and persisted negotiation inputs.
- **Phase 4:** AI seats. Active deals and trust in the strategist's context (tokens, not calls),
  proposals in a structured strategist field, and an optional single cheap call to turn a human's
  free text into typed terms, falling back to the deal panel.
- **Later:** questions and requests, targeted-removal and vote deals, and a removal target scorer
  with effect polarity (the current `LegalAction` does not say whether a target is helped or
  harmed).

## Consequences

- Default behavior, fixed-seed games, and every existing snapshot are unchanged.
- Threat-aware attack targeting exists only under diplomacy for now. Whether it should become the
  heuristic bot's default is a separate measurement, and so is tuning `WEIGHTS.deals`.
- Position is a public-information estimate and ignores what is in hands and libraries, so a
  combo deck with an empty board looks harmless. Deals are short and void on a new leader, which
  bounds the damage of that blind spot.
- Commander damage between two opponents is not in `PlayerView`, so it does not enter their
  positions.
- `noTarget` treats any targeting of a protected seat as a violation, helpful or harmful, because
  target polarity is not known. In practice a seat rarely targets an opponent's permanents
  helpfully.
