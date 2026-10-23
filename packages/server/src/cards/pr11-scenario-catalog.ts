import { PR11_SCENARIOS } from './pr11-scenarios';

/** Complete PR11 catalog. Completion receipts require a trace for every declared scenario. */
export const PR11_ALL_SCENARIOS = PR11_SCENARIOS;
export const PR11_ALL_SCENARIO_IDS = PR11_ALL_SCENARIOS.map((scenario) => scenario.id);
