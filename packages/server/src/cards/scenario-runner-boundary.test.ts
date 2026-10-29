/**
 * The import lint that keeps contract tests off the scenario runner (`eslint.config.js`, ADR 0034
 * decision 10) matches files by their `-contract.test.ts` name, so every primitive contract test
 * must carry that name, and none may reach the runner today.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRIMITIVE_CONTRACTS } from '../../../../scripts/contracts/primitive-contracts';

const files = [
  ...new Set(PRIMITIVE_CONTRACTS.flatMap((contract) => contract.cases.map((test) => test.file))),
];

describe('contract tests and the scenario runner', () => {
  it('names every primitive contract test so the import lint covers it', () => {
    expect(files.filter((file) => !/-contract\.test\.ts$/.test(file))).toEqual([]);
  });

  it('keeps every primitive contract test from importing the runner', () => {
    const root = new URL('../../../../', import.meta.url);
    expect(
      files.filter((file) =>
        /from '[^']*\/scenario(?:\/[^']*)?'/.test(readFileSync(new URL(file, root), 'utf8')),
      ),
    ).toEqual([]);
  });
});
