/**
 * Mutant kills for scenario files, in process (hill-climb S4's authoring probe and
 * `card:scaffold`): the same operators as `bun run mutate-cards` and the same rule, that only a
 * failed expectation kills. Lives under tests/ because it installs the definition transform.
 */
import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from '../../src/cards/definition';
import type { CardScenarioFile } from '../../src/testing/card-scenario';
import { installDefinitionTransform } from '../../src/testing/definition-transform';
import { runScenario, scenarioFailures } from '../scenario/runner';
import { cardMutants, mutate } from './operators';

/**
 * Events one engine step may emit under a mutant before the game halts. A mutant can loop
 * forever (a once-each-turn token trigger that now retriggers on its own token); the halt makes
 * that run a crash, which is not a kill. No unmutated draft comes near it.
 */
const MUTANT_STEP_WORK = 50_000;
/**
 * New objects a mutant run may create. Some loops create tokens without a log entry, which the
 * step budget never sees (Mechan Assembler without "only once each turn" ran forever).
 */
const MUTANT_OBJECTS = 500;
/** Decisions a mutant run may take; the longest unmutated draft takes a few dozen. */
const MUTANT_DECISIONS = 200;

/**
 * Runs `file`'s scenarios under each mutant of the card and returns the indexes a scenario's
 * expectations catch. A mutant that makes a run throw (the script no longer fits, the game
 * halts) is not counted as killed, exactly as `mutate-cards` counts only assertion failures.
 */
export function mutantKills(
  definition: CardDefinition,
  file: CardScenarioFile,
  resolve: (name: string) => OracleCard,
): number[] {
  const mutants = cardMutants(definition);
  const killed: number[] = [];
  const names = new Set([definition.name, ...definition.name.split(' // ')]);
  for (let index = 0; index < mutants.length; index++) {
    const previous = installDefinitionTransform((candidate) =>
      names.has(candidate.name) ? mutate(candidate, index) : candidate,
    );
    try {
      const caught = file.scenarios.some((scenario) => {
        try {
          return (
            scenarioFailures(
              runScenario(file, scenario, {
                resolve,
                maxStepWork: MUTANT_STEP_WORK,
                maxDecisions: MUTANT_DECISIONS,
                maxObjects: MUTANT_OBJECTS,
              }),
              scenario,
            ).length > 0
          );
        } catch {
          return false;
        }
      });
      if (caught) killed.push(index);
    } finally {
      installDefinitionTransform(previous);
    }
  }
  return killed;
}
