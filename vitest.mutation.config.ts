// suite-integrity: reruns vitest.config.ts
// IR mutation (ADR 0034 decision 5): the root config's tests, rerun by `scripts/mutate-cards.ts`
// with the definition-transform hook installed. It claims no file of its own.
import { defineConfig, mergeConfig } from 'vitest/config';
import root from './vitest.config';

export default mergeConfig(
  root,
  defineConfig({
    test: {
      setupFiles: ['packages/engine/tests/mutation/setup.ts'],
      provide: { mutation: null },
    },
  }),
);
