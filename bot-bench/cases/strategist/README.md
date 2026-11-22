# Strategist cases

Not written yet. The harness can already put any strategist in front of any tactician and score
the pair on the existing cases (see "Strategists" in [the bot-bench README](../../README.md)), but
those cases were written for the tactician: mostly one turn of arithmetic, where a plan adds little.

What a strategist case needs that a tactician case does not:

- **A position where the plan matters.** The strategist is not an engine decision: it is called once
  per turn and returns a plan (`turnStrategy`) or bot knobs, so there is no legal menu to grade it
  against. A strategist case is a whole-turn (or longer) case whose objectives only a good plan
  meets: holding a sweeper or counterspell for the right threat, choosing which opponent to
  pressure, honouring a deal, not overextending into a likely wipe.
- **A reviewed `context`.** Its hand-written strategy is the `case` row of a grid: what a perfect
  strategist would have said, so the gap between a model row and the `case` row is the
  strategist's own shortfall.
- **Usually more than one turn.** Holding something back pays off on a later turn; the scenario
  format continues into it with `continue.throughNextTurn` and `"turns": 2`.

The case format, table, scoring, report and bundle are shared with the tactician cases. Strategist
cases will live here once written, and `parseBenchCase` will accept them as ordinary turn cases.
