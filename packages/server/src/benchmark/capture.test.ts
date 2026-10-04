import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureCase } from './capture';
import { loadCase, validateCaseHash } from './cases';
import { benchmarkSourceHashes } from './manifest';

function writeSource(root: string, relative: string, body: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body + String.fromCharCode(10), 'utf8');
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mtg-capture-'));
  writeSource(root, 'packages/engine/src/index.ts', 'export const engine = 1;');
  writeSource(
    root,
    'packages/engine/src/cards/definition.ts',
    'export type Card = { id: string };',
  );
  return root;
}

const RAW_CASE = {
  schemaVersion: 1,
  caseId: 'capture-001',
  role: 'tactician',
  categories: ['removal'],
  sourceGroup: 'unit',
  observerSeat: 'P1',
  turn: 3,
  phase: 'precombat_main',
  step: null,
  eventSequence: 42,
  input: {
    request: { decidingPlayer: 'P1', kind: 'priority', options: [] },
    view: {
      seat: 'P1',
      life: 40,
      hand: [],
      deck: [],
      graveyard: [],
      commanders: [],
      availableMana: {},
      manaSources: [],
      opponents: [],
      battlefield: [],
      exile: [],
      stack: [],
      recentLog: [],
    },
    guidance: { threats: [] },
  },
};

describe('captureCase', () => {
  it('seals the snapshot against the engine and card-definition hashes of the captured tree', () => {
    const root = makeRoot();
    try {
      const output = join(root, 'benchmarks', 'tactician', 'dev', 'capture-001.json');
      const sealed = captureCase(RAW_CASE, output, { repositoryRoot: root });
      const expected = benchmarkSourceHashes(root);

      expect(sealed.supportedEngineVersion).toBe(expected.engine);
      expect(sealed.supportedCardDefinitionHash).toBe(expected.cardDefinitions);

      const written = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
      expect(written['supportedEngineVersion']).toBe(expected.engine);
      expect(written['supportedCardDefinitionHash']).toBe(expected.cardDefinitions);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seals a content hash that covers the compatibility pins it just wrote', () => {
    const root = makeRoot();
    try {
      const output = join(root, 'benchmarks', 'tactician', 'dev', 'capture-001.json');
      const sealed = captureCase(RAW_CASE, output, { repositoryRoot: root });
      expect(() => validateCaseHash(sealed)).not.toThrow();
      expect(() => loadCase(output)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives both pins from the tree, overriding stale values carried on the input', () => {
    const root = makeRoot();
    try {
      // A capture input is often copied from an older case file. Honouring a pin it carries would
      // seal the new snapshot against semantics it was never taken from, which is exactly the
      // silent staleness the compatibility gate exists to catch.
      const output = join(root, 'benchmarks', 'tactician', 'dev', 'capture-002.json');
      const sealed = captureCase(
        {
          ...RAW_CASE,
          caseId: 'capture-002',
          supportedEngineVersion: 'stale-engine-pin',
          supportedCardDefinitionHash: 'stale-card-pin',
        },
        output,
        { repositoryRoot: root },
      );
      const expected = benchmarkSourceHashes(root);
      expect(sealed.supportedEngineVersion).toBe(expected.engine);
      expect(sealed.supportedCardDefinitionHash).toBe(expected.cardDefinitions);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
