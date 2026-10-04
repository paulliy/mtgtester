import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureCase } from './capture';
import { assertFixtureCompatibility, loadCase } from './cases';
import { benchmarkSourceHashes } from './manifest';
import { refreshCaseCompatibility } from './refresh';

const LF = String.fromCharCode(10);

function writeSource(root: string, relative: string, body: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body + LF, 'utf8');
}

const RAW_CASE = {
  schemaVersion: 1,
  caseId: 'refresh-001',
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

/**
 * A tree holding one sealed case whose engine semantics then moved on, exactly as the committed
 * fixtures went stale: the snapshot is untouched, the sources under it changed.
 */
function makeStaleFixture(): {
  root: string;
  casePath: string;
  stale: string;
  sealed: { engine: string; cardDefinitions: string };
} {
  const root = mkdtempSync(join(tmpdir(), 'mtg-refresh-'));
  writeSource(root, 'packages/engine/src/index.ts', 'export const engine = 1;');
  writeSource(
    root,
    'packages/engine/src/cards/definition.ts',
    'export type Card = { id: string };',
  );
  const casePath = join(root, 'benchmarks', 'tactician', 'dev', 'refresh-001.json');
  captureCase(RAW_CASE, casePath, { repositoryRoot: root });
  const sealed = benchmarkSourceHashes(root);

  writeSource(
    root,
    'packages/engine/src/cards/definition.ts',
    'export type Card = { id: string; name: string };',
  );
  return { root, casePath, stale: readFileSync(casePath, 'utf8'), sealed };
}

describe('refreshCaseCompatibility', () => {
  it('defaults to a dry run that reports old-to-new values and writes nothing', () => {
    const { root, casePath, stale, sealed } = makeStaleFixture();
    try {
      const report = refreshCaseCompatibility({ repositoryRoot: root, casePaths: [casePath] });

      expect(report.write).toBe(false);
      expect(readFileSync(casePath, 'utf8')).toBe(stale);

      const current = benchmarkSourceHashes(root);
      const [entry] = report.cases;
      expect(entry?.caseId).toBe('refresh-001');
      const byField = Object.fromEntries(entry!.changes.map((c) => [c.field, c]));
      expect(byField['supportedEngineVersion']).toMatchObject({
        from: sealed.engine,
        to: current.engine,
      });
      expect(byField['supportedCardDefinitionHash']).toMatchObject({
        from: sealed.cardDefinitions,
        to: current.cardDefinitions,
      });
      expect(byField['contentHash']?.to).toMatch(/^[a-f0-9]{64}$/);
      expect(byField['contentHash']?.to).not.toBe(byField['contentHash']?.from);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repins and reseals the fixture under an explicit write', () => {
    const { root, casePath } = makeStaleFixture();
    try {
      // The snapshot is still internally sealed; what broke is its compatibility with the tree.
      expect(() =>
        assertFixtureCompatibility([loadCase(casePath)], benchmarkSourceHashes(root)),
      ).toThrow('compatibility mismatch');

      const report = refreshCaseCompatibility({
        repositoryRoot: root,
        casePaths: [casePath],
        write: true,
      });
      expect(report.write).toBe(true);

      const current = benchmarkSourceHashes(root);
      const reloaded = loadCase(casePath);
      expect(reloaded.supportedEngineVersion).toBe(current.engine);
      expect(reloaded.supportedCardDefinitionHash).toBe(current.cardDefinitions);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('touches only the three sealed scalars and leaves the rest byte-for-byte', () => {
    const { root, casePath, stale } = makeStaleFixture();
    try {
      const report = refreshCaseCompatibility({
        repositoryRoot: root,
        casePaths: [casePath],
        write: true,
      });
      let expected = stale;
      for (const change of report.cases[0]!.changes)
        expected = expected.replace(change.from, change.to);
      expect(readFileSync(casePath, 'utf8')).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no changes for an already-current fixture', () => {
    const { root, casePath } = makeStaleFixture();
    try {
      refreshCaseCompatibility({ repositoryRoot: root, casePaths: [casePath], write: true });
      const second = refreshCaseCompatibility({ repositoryRoot: root, casePaths: [casePath] });
      expect(second.cases[0]!.changes).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'rejects edited gold with stale hash without mutation (write=%s)',
    (write) => {
      const { root, casePath } = makeStaleFixture();
      try {
        const edited = readFileSync(casePath, 'utf8').replace('"removal"', '"changed"');
        writeFileSync(casePath, edited);
        expect(() =>
          refreshCaseCompatibility({ repositoryRoot: root, casePaths: [casePath], write }),
        ).toThrow(/hash mismatch/);
        expect(readFileSync(casePath, 'utf8')).toBe(edited);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('preflights a later invalid fixture before writing an earlier one', () => {
    const { root, casePath, stale } = makeStaleFixture();
    try {
      const later = join(root, 'benchmarks', 'tactician', 'dev', 'later.json');
      writeFileSync(later, stale.replace('"removal"', '"changed"'));
      expect(() =>
        refreshCaseCompatibility({
          repositoryRoot: root,
          casePaths: [casePath, later],
          write: true,
        }),
      ).toThrow(/later.json.*hash mismatch/);
      expect(readFileSync(casePath, 'utf8')).toBe(stale);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps one fixture intact and removes its temp file when rename fails', () => {
    const { root, casePath, stale } = makeStaleFixture();
    try {
      expect(() =>
        refreshCaseCompatibility({
          repositoryRoot: root,
          casePaths: [casePath],
          write: true,
          rename: () => {
            throw new Error('injected rename failure');
          },
        }),
      ).toThrow(/already updated: \(none\)/);
      expect(readFileSync(casePath, 'utf8')).toBe(stale);
      expect(readdirSync(dirname(casePath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports exact completed paths after a later rename fails and safely recovers', () => {
    const { root, casePath, stale } = makeStaleFixture();
    try {
      const later = join(dirname(casePath), 'later.json');
      writeFileSync(later, stale);
      let count = 0;
      expect(() =>
        refreshCaseCompatibility({
          repositoryRoot: root,
          casePaths: [casePath, later],
          write: true,
          rename: (from, to) => {
            if (++count === 2) throw new Error('injected later failure');
            renameSync(from, to);
          },
        }),
      ).toThrow(new RegExp(`already updated: .*refresh-001.json.*injected later failure`));
      expect(readFileSync(later, 'utf8')).toBe(stale);
      expect(() => loadCase(casePath)).not.toThrow();
      const retry = refreshCaseCompatibility({
        repositoryRoot: root,
        casePaths: [casePath, later],
        write: true,
      });
      expect(retry.cases[0]?.changes).toEqual([]);
      expect(() => loadCase(later)).not.toThrow();
      expect(readdirSync(dirname(casePath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
