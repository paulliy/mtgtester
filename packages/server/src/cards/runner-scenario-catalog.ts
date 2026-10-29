import { RUNNER_SCENARIOS } from './runner-scenarios';

/** Runner scenarios as the Card Test Lab lists them; the viewer spec reads this list. */
export const RUNNER_ALL_SCENARIOS = RUNNER_SCENARIOS;
export const RUNNER_ALL_SCENARIO_IDS = RUNNER_SCENARIOS.map(({ id }) => id);
