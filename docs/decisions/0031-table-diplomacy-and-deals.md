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
mostly about closing those openings. They were revised after an adversarial review; see
"Review" at the end.

## Decision

### Messages and deals are structured, not free text

1. Every table message is a typed record in `@mtg/shared` (`diplomacy.ts`), rendered to a sentence
   by a template. Bots read and answer messages with no model call, and every deal can be checked
   mechanically against decisions.
2. Message kinds: `threatCall` (names the table leader and why), `proposal`, `response` (accept,
   decline, or a counter-proposal), `breach` (a deal was broken, with the reason the breaker
   gives: `lethal`, `worthIt` or `selfDefense`), and `dealEnded` (kept, or void with a reason).
   Logged deals are deep copies, so what was said never changes afterwards. Questions ("who are
   you attacking?") and requests ("someone deal with that flyer") are later phases.
3. A deal is two-party and is a list of obligations, each owed by one of the two parties:
   - `noAttack(by, against)`: `by` declares no attacker at `against` or a permanent `against`
     controls. Continuous.
   - `noTarget(by, against)`: `by` chooses no target that is `against`, or a permanent, stack
     object or graveyard card `against` owns or controls. Continuous.
   - `noCounter(by, against)`: the stack-object part of `noTarget` only. Continuous.
   - `attackPlayer(by, target)`: at `by`'s next attack declaration inside the deal, at least
     `attackPlayerShare` of the power that could attack goes at `target` (capped at what could
     reach it). A token attack does not count. One-shot.
4. Deals cover offense only. No obligation constrains blocks, so accepting a deal never lowers a
   seat's defenses.
5. Deals are short and are counted in turns, not turn numbers: a deal lasts until each party has
   taken `rounds` turns of its own since it was accepted (the accepting turn counts for whoever is
   active), with `rounds` an integer from 1 to `maxRounds`. Eliminations and extra turns cannot
   stretch or shrink it. At each turn's window:
   - a party that left the game ends the deal void;
   - a promiser that could now kill the seat it promised to spare ends it void: deals do not
     survive lethal, and calling one off in the open beats breaking it by surprise;
   - a party that became the table leader after the deal started frees the other party (a
     `released` message), while its own promises stand: nobody owes a leader restraint, and taking
     the lead is no way out of a deal.

   When the deal runs out, an unmet `attackPlayer` promise is a breach if its seat started a turn
   inside the deal with attackers on board (holding creatures back, or tapping them before combat,
   is no way out), and ends the deal void if it could never have been made. A void deal credits
   and charges nobody. After a deal ends, the pair waits `pairCooldownRounds` before another, or
   `reproposeCooldownRounds` after a breach, so a deal cannot be renewed forever.

6. Compliance is judged from decisions, not prose. A submitted decision violates an obligation
   when one of its chosen targets (attack slots for `noAttack`, every other slot for `noTarget`
   and `noCounter`) belongs to the protected seat. A violation is excused only in a forced
   decision (anything but a priority decision, where passing always complies) whose slot offered
   no option that complies, so a forced target never counts as a breach but casting a spell whose
   only targets are protected does. `attackPlayer` is excused when the target was out of reach.
   An attack declaration is judged only once the engine has accepted it: a rejected declaration
   is asked again, so the table holds the latest one until the next decision. One the engine
   repaired (its public `attackDeclarationRepaired` event) is the engine's choice, not the seat's,
   and is not judged.

### Valuation heuristics

All weights live in `WEIGHTS.deals` in `packages/bot/src/weights.ts`, in life-equivalent points
(LEP) like every other bot weight.

7. **Position.** Each living seat's position is computed from public information only: life
   (points at or below `dangerousLifeThreshold` count `lowLifeMultiplier` times), board value
   (creature values as in combat search, plus a flat value per noncreature nonland permanent),
   cards in hand, and lands. Poison counters reduce position. Commander damage is left out of
   position because a seat only sees the commander damage it has taken itself, and counting it
   for one seat only would bias every comparison; it enters the danger and temptation checks
   instead.
8. **Win share.** `w_s = softmax(position_s / τ)` across living seats. It is a rough probability
   that each seat wins, used to weigh everyone's gains against each other.
9. **Leader and danger.** The seat with the highest win share is the leader when its share is at
   least `leaderShareRatio` times the mean. A seat is in danger at low life, or when some
   opponent's attack could kill it after it blocks that opponent's biggest attackers one each.
10. **Pricing obligations.** Everything one seat owes is priced jointly, per round, on public
    information, so two obligations cannot count the same pressure twice:
    - Attack obligations move that seat's predicted attack (its own threat-aware preference,
      decision 16), on top of what it already owes in deals in force, so chained deals cannot each
      pretend the seat still attacks the others: spared seats are removed, and an `attackPlayer`
      target takes `attackPlayerShare` of it. Each other seat gains the position it no longer
      loses. The obligor pays the value of the best attack it gives up (its best defender before
      against its best one still allowed, plus the share sent at a worse target). That cost is
      never negative, and it is zero when another target is just as good: sparing one of two equal
      opponents costs nothing, which is why a one-sided ask is refused by the bar, not the price.
      Each side's gain and the obligor's cost use the bot's existing scale, own life at 1 and an
      opponent's at `opponentLifePointValue`.
    - `noTarget` and `noCounter` move a flat per-round interaction value the same way, scaled by
      the promiser's ability to interact (`handSize / fullInteractionHandSize`, capped at 1), and
      the promiser pays `interactionForegoneShare` of what it moved. A seat with no cards promises
      nothing.
11. **Deal value.** For seat `me`, with `Δ_s` the projected change in each seat's position over
    the deal's duration (later rounds discounted by `roundDiscount`):

    `V = Δ_me − Σ_{s ≠ me} λ · (w_s · N) · Δ_s`

    where `N` is the number of living seats, so with equal shares every opponent's gain weighs
    `λ = opponentGainWeight`, and the leader's gain weighs far more. Helping the leader is
    expensive; moving pressure onto the leader is valuable even when it costs `me` something.

12. **Trust scales with the size of the deal, and is earned only under temptation.** The
    counterparty's obligations are discounted by the probability it keeps them:

    `P(keep) = (basePKeep + (maxPKeep − basePKeep) · kept/(kept+1) · min(1, biggestKept/stake)) · brokenDecay^broken`

    Trust earned keeping small deals barely transfers to a large one, which defeats "build trust,
    then cash it in". A kept deal credits a party only if some decision during it offered that
    party a way to break it (or, for `attackPlayer`, the attack was made), and then only as much
    as keeping it cost that party (its own priced cost, capped at the deal's size), and nothing
    below `minTrustCost`. Keeping a truce with no attackers, or a gift that cost nothing, proves
    nothing. Every seat sees every breach, so trust is a public record per seat.

13. **Temptation.** A promise the counterparty would want to break is assumed broken: its attack
    promises are worth nothing to `me` while its attack could kill `me`.
14. **Own obligations count in full.** A seat keeps its side until it sees a breach, so the cost
    of its own promises is real whatever the counterparty does. Only the counterparty's side is
    discounted by `P(keep)`.
15. **Acceptance.** Accept when `V > acceptThreshold + noise`, where the noise is seeded per
    proposal and uniform in `±thresholdNoise`. Early in the game (`round ≤ investmentRounds`,
    counted against the starting seats), for a reciprocal deal with a counterparty that has never
    broken one and does not lead, the threshold drops by `investmentAllowance`: a slightly bad deal
    is accepted to build trust that is worth more later. A one-sided ask earns nothing to invest
    in. Hard refusals, regardless of `V`:
    - a malformed deal: the parties must be two distinct living seats, every obligation owed by a
      party about another living seat, and `rounds` an integer in `[1, maxRounds]`;
    - padding: the same obligation twice, or more than `maxObligationsPerSide` on one side;
    - contradictions, within the deal or with deals in force (`attackPlayer` at a spared seat, or
      at two seats);
    - `me` would protect the leader (any `noAttack`, `noTarget` or `noCounter` against it) while
      not in danger. A deal in which the leader only gives is allowed: that is the leader's way to
      buy relief;
    - `me` would promise not to target or counter without the same promise back, or for more than
      one round: interaction is how a table stops a combo, and a bot does not sell it. A human may
      still offer its own interaction one-way; that only binds the human;
    - the counterparty has broken `maxBreachesTolerated` deals;
    - with the new deal, `me` would have fewer than two opponents left to attack when it has three
      or more, or none left otherwise: chained truces must not funnel all of a seat's pressure
      onto one player.

    The table enforces the rest for every proposer, bot or human (`DiplomacyTable.offer`): one
    offer per proposer per turn, no repeat of declined terms (including length, and including a
    declined counter) within `reproposeCooldownRounds`, and the pair cooldown of decision 5.
    `offer` takes only the terms (proposer, recipient, obligations, length); the turn, id and
    status are the table's own, so a caller cannot claim the early-game allowance or step around a
    cooldown.

### Deal-aware play

16. **Threat-aware attack targets.** With diplomacy on, attack declarations stop sending everything
    at the lowest-life defender. The plan has three passes. `attackPlayer` promises first, with as
    little power as meets the requirement (the smallest single attacker that does, else the
    biggest ones), so keeping a promise never takes a creature out of a later kill. Then kills:
    while some player can be killed by the free attackers that may reach them, after the
    defender's untapped creatures block the biggest of those one each, commit attackers to the kill
    worth most. Then every other attacker, largest first, to the allowed defender with the best
    marginal `damageValue`: the position the defender loses (non-linear life) at
    `opponentLifePointValue`, weighted up for the leader by `leaderFocus`, plus combat search's
    lethal term when the damage gets through and eliminates that player. Planeswalkers count as
    their controller at `planeswalkerFactor`. The blocker model is crude (one blocker stops one
    attacker), and evasion is ignored. Likely damage counts the defender's untapped creatures as
    blockers, but a kill must hold against all of them, tapped or not, so the bot never breaks a
    deal for a kill that an untap or a flash blocker would stop. This is the same count the table
    uses to call a deal off for lethal.
17. **Keeping and breaking.** For attacks, the bot builds the best plan that keeps every deal and,
    for each deal it owes anything on offense (`noAttack` or `attackPlayer`), the best plan that
    ignores only that deal; it breaks when the gain exceeds the reputation cost
    `breakPenalty · (living opponents / starting opponents)`, which shrinks late in the game, and
    says `lethal` when the broken plan eliminates someone the kept plan does not. A real kill
    always clears the cost. Short of a kill, the gain rarely does, so in practice bots break attack
    deals for lethal and almost never otherwise. For other targets, the bot keeps the plain bot's first option when it
    complies, else picks a complying option, and otherwise scores the action down by the same
    cost, so it usually does something else. A `noTarget` or `noCounter` promise stops binding when
    the protected seat leads the table or could kill the promiser: no deal stops a seat from
    answering what is about to beat it. The table applies the same test when it judges the
    decision, so answering such a seat ends the deal void (`selfDefense`) and costs no trust; a
    seat cannot bait a breach by taking the lead in the middle of a turn. The target penalty is on
    the same scale as spell scores, so a bot may still break a `noTarget` promise for a spell it
    rates far above the penalty.
18. **Proposing.** At its negotiation window a bot makes at most one proposal, and only with a
    reason: some seat's predicted attack takes at least `proposePressureShare` of its life, or a
    leader exists and another seat could be pointed at it. It generates a few candidates (mutual
    truce; truce plus the counterparty attacking the leader; `me` attacking the leader for the
    counterparty's truce), each at every allowed length, estimates the counterparty's `V` with the
    same public evaluator, and proposes the best for itself among those the counterparty should
    accept and it has not had declined recently. When it declines a proposal, it counters with its
    own best candidate for that pair. This is the anchoring move: the bot's counter comes from its
    own terms, never from splitting the difference.

### Where it runs

19. **Bots never call a model to negotiate.** Proposing, answering, keeping, breaking and judging
    compliance are all heuristic, synchronous and seeded. They add no API calls and no latency.
    The table skips all compliance work while no deal is active.
20. **`DiplomacyTable`** in `@mtg/bot` owns active deals, trust records, proposal history, and the
    message log for one game. It is pure logic with no I/O. Offers enter only through `offer`.
    The driver calls `beforeDecision`
    before every surfaced decision (the first one in a turn opens that turn's negotiation window,
    the same point the strategist runs in ADR 0016), `afterDecision` with every submitted decision,
    and `flush` when the game ends, and gives each bot its obligations through
    `HeuristicProviderOptions.diplomacy`. `withDiplomacy` and `withDiplomacyAsync` wrap a
    synchronous or asynchronous provider with those calls.
21. **Off by default.** Diplomacy changes bot decisions, so default games are byte-identical to
    today's until it is enabled. It ships behind an explicit option, measured first by self-play
    (`bun run diplomacy-sweep`), the same way combat search was in ADR 0024. The sweep has a
    `--no-deals` arm, threat-aware targeting without deals, so what deals add can be told apart
    from what the targeting does.
22. **Replay.** Bot-only negotiation is a pure function of the seed and the views, so a spectator
    game replays exactly. Before phase 2 persists anything, the table must become an
    event-sourced reducer: a versioned, serializable state rebuilt from an append-only log of
    negotiation events (offers, answers, judgments, window openings), with an explicit
    proposed/pending/decided lifecycle. Human proposals and answers (phase 3) are inputs in that
    log, persisted with the game the same way human actions are. Today the table's state lives in
    private fields and cannot be saved or resumed mid-game.
23. **Hidden information.** Obligations can only name seats, and compliance reads only chosen
    target ids and public owners. Valuation reads only public fields of the deciding seat's
    `PlayerView` (its own hand only as a count, through the same position function used for
    opponents). No message carries card names from hidden zones.

### Phases

- **Phase 1 (this change):** shared types; position, win share, pressure, blockers and
  threat-aware attack targets; deal validation, valuation, trust, compliance and proposals;
  deal-aware decisions; the `DiplomacyTable` with `offer` as the single entry point for proposals;
  and `bun run diplomacy-sweep`, which plays seeded games with two diplomacy seats against two
  plain seats (`--all` for four diplomats, `--no-deals` for targeting only) and reports wins, deal
  outcomes and the reasons deals broke or were called off. It runs offline on the committed
  coverage fixture when the Scryfall bulk file is absent.
- **Phase 2:** the event-sourced table of decision 22, then spectator delivery: a `tableTalk`
  server message carrying `TableMessage`s, a log filter and deal lines between seat panels, and a
  deals toggle on the new-game screen.
- **Phase 3:** single-player. A pending state for offers to and from a human (the human answers
  asynchronously; bots answer at once), a "propose deal" panel built on `offer`, accept, decline
  and counter cards for bot proposals, negotiation slots after attackers are declared as well as at
  the start of a turn, and an adversarial "exploiter" seat in the sweep that tries trust farming,
  threshold probing and padding, with a bound on the value it may extract.
- **Phase 4:** AI seats. Active deals and trust in the strategist's context (tokens, not calls),
  proposals in a structured strategist field, and an optional single cheap call to turn a human's
  free text into typed terms, falling back to the deal panel. All model output goes through
  `offer` and its validation like any other proposal.
- **Later vocabulary**, in rough order of value: block deals ("I won't block X", "I'll chump for
  you"); non-targeted hostility ("don't wrath", edicts, "each opponent" effects); protecting a
  specific permanent or commander; conditional terms ("if you attack X, I won't..."); table-wide
  pacts; Monarch and goad handoffs; questions with an explicit answer policy for hidden
  information; and a removal target scorer with effect polarity (the current `LegalAction` does
  not say whether a target is helped or harmed).

## Consequences

- Default behavior, fixed-seed games, and every existing snapshot are unchanged.
- Threat-aware attack targeting exists only under diplomacy for now. Whether it should become the
  heuristic bot's default is a separate measurement, and so is tuning `WEIGHTS.deals`.
- Position is a public-information estimate and ignores what is in hands and libraries, so a
  combo deck with an empty board looks harmless. Bots refuse to sell interaction, interaction
  promises are released against a seat that leads or threatens lethal, and deals are short, which
  together bound that blind spot without closing it.
- Commander damage between two opponents is not in `PlayerView`, so it does not enter their
  positions, and a bot predicting a counterparty's answer cannot see the commander damage that
  counterparty has taken; the viewer's own poison count is not in `PlayerView` either and reads as
  zero.
- A leader is the natural target of every other seat's proposals, so the table tends to gang up on
  it. That is how Commander tables play, but the sweep should watch whether it decides too many
  games.
- `noTarget` treats any targeting of a protected seat as a violation, helpful or harmful, because
  target polarity is not known. In practice a seat rarely targets an opponent's permanents
  helpfully.
- Win shares use `Math.exp`. A replay on a different JavaScript runtime could in principle differ
  in the last bit and flip a borderline decision; replays on the same runtime are exact.
- The noise on the acceptance threshold is seeded, so in a fixed-seed game the same deal draws
  the same noise. It stops a bot from being probed within a game (one offer per turn, declined
  terms on cooldown), not across replays of the same seed.

## Review

An adversarial review of the first implementation found that bad deals could still buy good ones.
Fixed in this change: padded and duplicated obligations and impossible lengths (now refused);
interaction promises priced without regard to the promiser's ability and sold for nothing (now
scaled by hand size, mirrored-only and one round); a known breaker accepted early on the same terms
as a clean seat (own obligations now count in full, the early allowance needs a clean record and a
reciprocal deal, and two breaches refuse outright); trust farmed by keeping deals that cost
nothing (credit now needs temptation); `attackPlayer` met by a token and counted as the seat's whole
attack (now a share of power, priced at that share); obligations from one seat double-counting the
same pressure (now priced jointly); promises free for the giver (the giver now pays what it gives
up); turn-number deal clocks distorted by eliminations (now counted in each party's turns);
kills and danger that ignored blockers; `attackPlayer` keeping that could spoil a kill and never
broke for lethal; the leader with no diplomatic route at all (it may now give without receiving);
unmet promises credited as kept; endless renewal; repaired attack declarations judged as the seat's
choice; mutable deals in the message log; and per-decision compliance work with no deal active.
Deferred, and recorded in the phases above: the event-sourced, resumable table; asynchronous
answers and a post-declaration negotiation slot for humans; the broader vocabulary; and the
adversarial exploiter in the sweep.

A second review checked those fixes and found more, fixed in a follow-up: a self-defense answer
was still charged as a breach; trust could be farmed with gifts that cost the keeper nothing (now
credited only up to the keeper's own cost); the giver's cost could turn into a payment (now
clamped, and taken from the best attack given up rather than an average); chained deals were each
priced as if the seat still attacked the others (now priced on top of deals in force, with at
least two opponents left open); the caller of `offer` chose the turn; a seat could skip a promised
attack for free by holding its creatures; taking the lead voided a deal for both sides (now it
frees only the other party); a declined counter could be re-asked at once; a breaker could re-deal
after one round; and the planner and the table counted blockers differently for lethal. Still
open: `attackPlayer` is not judged when another player chooses which creatures attack (Master
Warcraft's chooser mode).
