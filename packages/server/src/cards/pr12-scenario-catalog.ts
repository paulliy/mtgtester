import { PR12_SCENARIOS } from './pr12-scenarios';

/** Complete PR12 catalog. Completion receipts require a trace for every declared scenario. */
export const PR12_ALL_SCENARIOS = PR12_SCENARIOS;
export const PR12_ALL_SCENARIO_IDS = PR12_ALL_SCENARIOS.map((scenario) => scenario.id);
