import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();
const forbidden = [
  ['raw registration', 'registerOverride({});'],
  ['raw mana parsing', "parseManaCost('{2}');"],
  ['inline tokens', "export const token = { typeLine: 'Creature', subtypes: [], colors: [] };"],
  ['executable placeholders', "export const effect = { op: 'noOp' };"],
] as const;

describe('cumulative card authoring restrictions', () => {
  for (const file of ['reviewed-quality-probe.ts', 'quality-probe.ts']) {
    it.each(forbidden)(`rejects %s in ${file}`, async (_label, code) => {
      const results = await eslint.lintText(code, {
        filePath: `packages/engine/src/cards/overrides/${file}`,
      });
      expect(
        results
          .flatMap((result) => result.messages)
          .some((message) => message.ruleId === 'no-restricted-syntax'),
      ).toBe(true);
    });
  }

  it('retains the stricter reviewed ability-envelope rule', async () => {
    const results = await eslint.lintText(
      "export const ability = { kind: 'spell', targets: [], effects: [] };",
      { filePath: 'packages/engine/src/cards/overrides/reviewed-quality-probe.ts' },
    );
    expect(
      results
        .flatMap((result) => result.messages)
        .some(
          (message) =>
            message.ruleId === 'no-restricted-syntax' && message.message.includes('spell()'),
        ),
    ).toBe(true);
  });
});
