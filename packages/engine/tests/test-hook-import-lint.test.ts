/** ADR 0034 decisions 4, 5 and 8: product code may run the test-only hooks, never install them. */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// A cold ESLint start (config load, type info) can exceed the 5s default when files run in parallel.
const ESLINT_CHILD_TIMEOUT_MS = 60_000;

const eslint = new ESLint();
async function violations(path: string, code: string) {
  const results = await eslint.lintText(code, { filePath: path });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

describe('test-only hook imports', () => {
  it.each([
    [
      'packages/engine/src/cards/probe.ts',
      "import { checkStateInvariants } from '../testing/invariants';",
    ],
    [
      'packages/server/src/match/probe.ts',
      "import { installStateInvariants } from '@mtg/engine/src/testing/invariants';",
    ],
    [
      'packages/engine/src/cards/probe.ts',
      "import { installDefinitionTransform } from '../testing/definition-transform';",
    ],
    [
      'packages/engine/src/flow/probe.ts',
      "import { installCheckpointHook } from '../testing/checkpoint-hook';",
    ],
    [
      'packages/server/src/match/probe.ts',
      "import { installDefaultDiagnostics } from '../../../engine/src/testing/diagnostics';",
    ],
  ])(
    'rejects %s installing a hook: %s',
    async (path, code) => {
      expect(await violations(path, code)).toEqual([expect.stringMatching(/tests and tools only/)]);
    },
    ESLINT_CHILD_TIMEOUT_MS,
  );

  it.each([
    [
      'packages/engine/src/cards/probe.ts',
      "import { transformDefinition } from '../testing/definition-transform';",
    ],
    [
      'packages/engine/src/sba/probe.ts',
      "import { runCheckpointHook } from '../testing/checkpoint-hook';",
    ],
    [
      'packages/engine/src/state/probe.ts',
      "import { defaultDiagnostics } from '../testing/diagnostics';",
    ],
    [
      'packages/engine/src/testing/probe.ts',
      "import { installCheckpointHook } from './checkpoint-hook';",
    ],
    [
      'packages/engine/tests/probe.test.ts',
      "import { installStateInvariants } from '../src/testing/invariants';",
    ],
  ])(
    'allows %s: %s',
    async (path, code) => {
      expect(await violations(path, code)).toEqual([]);
    },
    ESLINT_CHILD_TIMEOUT_MS,
  );
});
