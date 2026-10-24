import { PR11B_SCENARIOS } from './pr11b-scenarios';

/** Complete PR11b catalog. Completion receipts require a trace for every declared scenario. */
export const PR11B_ALL_SCENARIOS = PR11B_SCENARIOS;
export const PR11B_ALL_SCENARIO_IDS = PR11B_ALL_SCENARIOS.map((scenario) => scenario.id);
