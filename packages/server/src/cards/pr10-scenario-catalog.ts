import { PR10_SCENARIOS } from './pr10-scenarios';

/** Complete PR10 catalog. Completion receipts require a trace for every declared scenario. */
export const PR10_ALL_SCENARIOS = PR10_SCENARIOS;
export const PR10_ALL_SCENARIO_IDS = PR10_ALL_SCENARIOS.map((scenario) => scenario.id);
