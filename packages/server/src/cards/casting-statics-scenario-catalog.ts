import { CASTING_STATICS_SCENARIOS } from './casting-statics-scenarios';

/** Complete casting-statics catalog. Completion receipts require a trace for every declared scenario. */
export const CASTING_STATICS_ALL_SCENARIOS = CASTING_STATICS_SCENARIOS;
export const CASTING_STATICS_ALL_SCENARIO_IDS = CASTING_STATICS_ALL_SCENARIOS.map(
  (scenario) => scenario.id,
);
