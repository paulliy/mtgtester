import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// A cold ESLint start (config load) can exceed the 5s default when files run in parallel.
const ESLINT_TIMEOUT_MS = 60_000;

const eslint = new ESLint();
async function messages(code: string, file = 'packages/engine/tests/sample.test.ts') {
  const results = await eslint.lintText(code, { filePath: file });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'test-skips/annotated-skips');
}

describe('skipped and focused tests need an allowed-skip reason', () => {
  it.each([
    "it.skip('a', () => {});",
    "test.skip('a', () => {});",
    "describe.skip('a', () => {});",
    "it.todo('a');",
    "it.only('a', () => {});",
    "describe.only('a', () => {});",
    "describe.skipIf(flag)('a', () => {});",
    "it.skipIf(flag)('a', () => {});",
    "it.runIf(flag)('a', () => {});",
    "it.concurrent.skip('a', async () => {});",
    "test.describe.skip('a', () => {});",
    "test.fixme('a', () => {});",
    "it.skip.each([1])('a', () => {});",
  ])(
    'rejects %s',
    async (code) => {
      expect(await messages(code)).toHaveLength(1);
    },
    ESLINT_TIMEOUT_MS,
  );

  it.each([
    "// allowed-skip: needs the Scryfall bulk file\ndescribe.skipIf(flag)('a', () => {});",
    "describe.skipIf(flag)('a', () => {}); // allowed-skip: needs the Scryfall bulk file",
    "// allowed-skip: waits on upstream fix\nit.todo('a');",
  ])(
    'accepts an annotated skip: %s',
    async (code) => {
      expect(await messages(code)).toEqual([]);
    },
    ESLINT_TIMEOUT_MS,
  );

  it(
    'rejects an annotation two lines away',
    async () => {
      expect(await messages("// allowed-skip: too far\n\nit.skip('a', () => {});")).toHaveLength(1);
    },
    ESLINT_TIMEOUT_MS,
  );

  it(
    'rejects an annotation with no reason',
    async () => {
      expect(await messages("// allowed-skip:\nit.skip('a', () => {});")).toEqual([
        expect.objectContaining({ messageId: 'noReason' }),
      ]);
    },
    ESLINT_TIMEOUT_MS,
  );

  it(
    'applies to spec files and ignores other receivers',
    async () => {
      expect(await messages("it.only('a', () => {});", 'apps/web/e2e/x.spec.ts')).toHaveLength(1);
      expect(await messages('items.skip(2); list.only(1);')).toEqual([]);
    },
    ESLINT_TIMEOUT_MS,
  );
});
