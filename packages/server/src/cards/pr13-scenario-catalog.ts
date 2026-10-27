import { PR13_SCENARIOS } from './pr13-scenarios';

/** Complete PR13 catalog. Completion receipts require a trace for every declared scenario. */
export const PR13_ALL_SCENARIOS = PR13_SCENARIOS;
export const PR13_ALL_SCENARIO_IDS = PR13_ALL_SCENARIOS.map((scenario) => scenario.id);
