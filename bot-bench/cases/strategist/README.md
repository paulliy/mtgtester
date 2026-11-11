# Strategist cases

Reserved. The harness benchmarks the tactician only for now; `parseBenchCase` refuses any other
role.

What a strategist benchmark needs that the tactician one does not:

- The strategist is not an engine decision. It is called once per turn and returns a plan
  (`turnStrategy`), so there is no legal menu to grade an answer against and nothing for the
  engine to refuse.
- A plan is only as good as the turn the tactician plays from it. The honest measurement is the
  pair: run a whole-turn case with the strategist's plan given to a fixed tactician, and score the
  same objectives the tactician cases already use. `play.ts` runs the production provider with
  `strategistEnabled: false`; a strategist run would turn that on with the model under test and
  hold the tactician model fixed.
- Threat assessment over several turns needs positions longer than one turn, which the arranged
  scenario format can continue into (`continue.throughNextTurn`).

The case format, table, scoring, report and bundle are role-neutral and are meant to be reused.
