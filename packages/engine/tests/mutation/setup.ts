/**
 * The mutation run's setup file (`vitest.mutation.config.ts`): installs the definition transform
 * for the mutant `scripts/mutate-cards.ts` provides, and records on each test how many times it
 * was applied in that file so far. A mutant never applied is unreached, not survived.
 */
import { afterEach, inject } from 'vitest';
import { installDefinitionTransform } from '../../src/testing/definition-transform';
import { cardMutants, mutate } from './operators';

export interface MutationTarget {
  card: string;
  index: number;
  label: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    mutation: MutationTarget | null;
  }
  interface TaskMeta {
    /** Times the mutant was applied in this file, up to the end of this test. */
    mutationApplied?: number;
  }
}

const target = inject('mutation');
let applied = 0;

if (target !== null)
  installDefinitionTransform((definition) => {
    if (definition.name !== target.card) return definition;
    const label = cardMutants(definition)[target.index]?.label;
    if (label !== target.label)
      throw new Error(
        `${target.card}: mutant ${target.index} is "${label}" here, not "${target.label}"`,
      );
    applied++;
    return mutate(definition, target.index);
  });

afterEach(({ task }) => {
  task.meta.mutationApplied = applied;
});
