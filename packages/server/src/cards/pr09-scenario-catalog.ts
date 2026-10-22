import { PR09_SCENARIOS } from './pr09-scenarios';
import { PR09_LIBRARY_SCENARIOS } from './pr09-library-scenarios';
import { PR09_PERMANENT_SCENARIOS } from './pr09-permanent-scenarios';
import { PR09_CHOICE_SCENARIOS } from './pr09-choice-scenarios';

/** Original five-card batch retained for its focused server/browser suite. */
export { PR09_SCENARIOS };
export const PR09_SCENARIO_IDS = PR09_SCENARIOS.map((scenario) => scenario.id);

/** Complete PR09 catalog. Completion receipts require a trace for every declared scenario. */
export const PR09_ALL_SCENARIOS = [
  ...PR09_SCENARIOS,
  ...PR09_LIBRARY_SCENARIOS,
  ...PR09_PERMANENT_SCENARIOS,
  ...PR09_CHOICE_SCENARIOS,
];
export const PR09_ALL_SCENARIO_IDS = PR09_ALL_SCENARIOS.map((scenario) => scenario.id);
