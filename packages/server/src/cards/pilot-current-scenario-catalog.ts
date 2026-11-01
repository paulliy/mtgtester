import { PILOT_CURRENT_SCENARIOS } from './pilot-current-scenarios';

/** Complete pilot-current catalog. Completion receipts require a trace for every declared scenario. */
export const PILOT_CURRENT_ALL_SCENARIOS = PILOT_CURRENT_SCENARIOS;
export const PILOT_CURRENT_ALL_SCENARIO_IDS = PILOT_CURRENT_ALL_SCENARIOS.map(
  (scenario) => scenario.id,
);
