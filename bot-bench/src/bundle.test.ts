import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anonymise,
  benchFingerprint,
  newManifest,
  writeBundle,
  writeModelResult,
  type BundleResult,
} from './bundle';
import { loadCases } from './case';
import { collate, parseScorecard } from './collate';
import { fakeProvider, pick } from './fake-provider';
import { parseLineup } from './models';
import { runLineup, type TranscriptEntry } from './run';
import { readZipArchive } from './zip';

const SECRET = 'fake/secret-model-name';
const cases = loadCases().filter((benchCase) =>
  ['burn-out-the-low-player', 'lethal-alpha-strike', 'wrath-then-rebuild'].includes(benchCase.id),
);
const lineup = parseLineup([
  { id: 'local-heuristic', kind: 'local', policy: 'heuristic' },
  {
    id: 'secret-model-id',
    label: 'Secret Model 9000',
    kind: 'llm',
    provider: 'openrouter',
    model: SECRET,
  },
  {
    id: 'other-model-id',
    kind: 'llm',
    provider: 'openrouter',
    model: 'fake/other',
    reasoning: 'low',
  },
]);

/** Model one finds the Bolt; model two always passes or holds back. */
const fetchImpl = fakeProvider((turn) => {
  const has = (text: string) => turn.legalActions.some((a) => a.description.includes(text));
  // The secret model's first try fails with an error that names it, as a timeout does.
  if (turn.model === SECRET && turn.attempt === 1)
    return { status: 500, body: `upstream error from ${SECRET} (Secret Model 9000)` };
  if (has('Cast Lightning Bolt') && turn.model === SECRET)
    return { content: pick(turn, 'Cast Lightning Bolt', ['P4'], 'lethal on P4'), cost: 0.0001 };
  if (has('Declare attackers'))
    return {
      content: JSON.stringify({
        requestId: turn.requestId,
        actionId: 0,
        targets: turn.legalActions[0]!.targets!.map((slot) => ({
          slot: slot.slot,
          choice: '__no_attack__',
        })),
      }),
      cost: 0.0001,
    };
  return { content: pick(turn, 'Pass priority'), cost: 0.0001 };
});

let directory: string;
let built: BundleResult;
let files: Map<string, Buffer>;
const text = (path: string): string => {
  const data = [...files].find(([name]) => name.endsWith(`/${path}`))?.[1];
  if (data === undefined) throw new Error(`bundle has no ${path}`);
  return data.toString('utf8');
};

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'bot-bench-'));
  const transcripts: TranscriptEntry[] = [];
  const results = await runLineup(cases, lineup, {
    mode: 'raw',
    trials: 1,
    concurrency: 3,
    spendCapUsd: null,
    env: {},
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
    onTranscript: (entry) => transcripts.push(entry),
  });
  writeFileSync(
    join(directory, 'run.json'),
    JSON.stringify({
      ...newManifest('test-run', 'raw', 1, cases, null, '2026-01-01T00:00:00.000Z'),
      modelIds: lineup.map((entry) => entry.id),
    }),
  );
  for (const result of results)
    writeModelResult(
      directory,
      result,
      transcripts.filter((entry) => entry.modelId === result.model.id),
    );
  built = await writeBundle(directory, loadCases(), { blind: true });
  files = readZipArchive(readFileSync(built.zipPath));
}, 120_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('the judge bundle', () => {
  it('is one ZIP with one root folder holding everything a judge needs', () => {
    const names = [...files.keys()];
    expect(new Set(names.map((name) => name.split('/')[0]))).toEqual(
      new Set(['bot-bench-test-run']),
    );
    const relative = names.map((name) => name.slice('bot-bench-test-run/'.length)).sort();
    expect(relative).toEqual(
      [
        'JUDGE_BRIEF.md',
        'PRIMER.md',
        'README.md',
        'SUMMARY.md',
        'cases/01-burn-out-the-low-player.md',
        'cases/02-lethal-alpha-strike.md',
        'cases/03-wrath-then-rebuild.md',
        'data/cases.json',
        'data/metrics.json',
        'data/results.json',
        'data/run.json',
        'data/transcripts.jsonl',
        'models/local-heuristic.md',
        'models/model-a.md',
        'models/model-b.md',
        'scorecard.schema.json',
        'scorecard.template.json',
      ].sort(),
    );
    // The folder beside the ZIP holds the same files.
    expect(readdirSync(join(built.directory, 'cases'))).toHaveLength(3);
  });

  it('hides which model is which, and keeps the key outside the bundle', () => {
    for (const [name, data] of files) {
      const content = data.toString('utf8');
      expect(content, name).not.toContain(SECRET);
      expect(content, name).not.toContain('Secret Model 9000');
      expect(content, name).not.toContain('FakeBackend');
      expect(content, name).not.toContain('fake/other');
      // The ids the run was given, which `--models` derives from the model names.
      expect(content, name).not.toContain('secret-model-id');
      expect(content, name).not.toContain('other-model-id');
    }
    expect(built.keyPath).not.toBeNull();
    const key = JSON.parse(readFileSync(built.keyPath!, 'utf8')) as {
      aliases: Array<{ alias: string; aliasId: string; model: { model: string } }>;
    };
    expect(key.aliases.map((entry) => [entry.alias, entry.aliasId, entry.model.model])).toEqual([
      ['Model A', 'model-a', SECRET],
      ['Model B', 'model-b', 'fake/other'],
    ]);
    expect([...files.keys()].some((name) => name.includes('judge-key'))).toBe(false);
  });

  it('tells the judge what to score, separately, and what to send back', () => {
    const brief = text('JUDGE_BRIEF.md');
    for (const heading of [
      '### 1. Accuracy',
      '### 2. Speed',
      '### 3. Cost',
      'blurb',
      'What to return',
    ])
      expect(brief).toContain(heading);
    expect(brief).toContain('**Model A** (`model-a`), **Model B** (`model-b`)');
    expect(brief).toContain('heuristic (local, no model)');
    expect(brief).not.toMatch(/\{\{[A-Z_]+\}\}/);

    const template = JSON.parse(text('scorecard.template.json')) as {
      runId: string;
      models: Array<Record<string, unknown>>;
    };
    expect(template.runId).toBe('test-run');
    expect(template.models.map((model) => model['modelId'])).toEqual(['model-a', 'model-b']);
    expect(Object.keys(template.models[0]!)).toEqual([
      'modelId',
      'accuracy',
      'speed',
      'cost',
      'overall',
      'blurb',
    ]);
    const schema = JSON.parse(text('scorecard.schema.json')) as {
      properties: { models: { items: { properties: { modelId: { enum: string[] } } } } };
    };
    expect(schema.properties.models.items.properties.modelId.enum).toEqual(['model-a', 'model-b']);
  });

  it('carries the live production primer rather than a copy', async () => {
    const { primerCatalog } = await import('../../packages/server/src/ai/primer');
    const primer = text('PRIMER.md');
    for (const section of primerCatalog().filter((entry) => entry.role === 'tactician'))
      expect(primer).toContain(section.text);
  });

  it('breaks the numbers into accuracy, speed and cost', () => {
    const summary = text('SUMMARY.md');
    for (const heading of [
      '## Accuracy',
      '### Reliability',
      '## Speed',
      '## Cost',
      '## Where the models disagreed',
    ])
      expect(summary).toContain(heading);
    const metrics = JSON.parse(text('data/metrics.json')) as Array<{
      modelId: string;
      accuracy: { single: number; turn: number };
      cost: { source: string; totalUsd: number };
      speed: { decisions: number };
    }>;
    const a = metrics.find((entry) => entry.modelId === 'model-a')!;
    const b = metrics.find((entry) => entry.modelId === 'model-b')!;
    // A: Bolt is best (1), no attack is a blunder (0). B: passing with the Bolt is weak (0.3).
    expect(a.accuracy.single).toBeCloseTo(0.5, 5);
    expect(b.accuracy.single).toBeCloseTo(0.15, 5);
    expect(a.cost.source).toBe('reported');
    expect(a.cost.totalUsd).toBeGreaterThan(0);
    expect(a.speed.decisions).toBeGreaterThan(2);
  });

  it('shows on one page who chose what, beside what the engine says it leads to', () => {
    const page = text('cases/01-burn-out-the-low-player.md');
    const row = (answer: string) =>
      page.split('\n').find((line) => line.startsWith(`| ${answer} |`));
    expect(row('Cast Lightning Bolt ({R}) → P4')).toMatch(
      /\*\*BEST\*\*.*P4 is ELIMINATED.*Model A \|$/,
    );
    expect(row('Pass priority')).toMatch(/weak.*nothing changes.*Model B \|$/);
    expect(page).toContain('lethal on P4');
    expect(page).toContain('Check for lethal first');

    const summary = text('SUMMARY.md');
    expect(summary).toContain('- `BEST` Cast Lightning Bolt ({R}) → P4: Model A');
    expect(summary).toContain('- `weak` Pass priority: Model B');

    const turn = text('cases/03-wrath-then-rebuild.md');
    expect(turn).toContain('| Wrath of God is cast (6) | yes | NO | NO |');
    expect(turn).toContain(
      'Leaves the best reference line at step 1: the line plays `Play Plains`',
    );
  });

  it('rebuilds with real names when asked, and then writes no key', async () => {
    const revealed = await writeBundle(directory, loadCases(), { blind: false });
    expect(revealed.keyPath).toBeNull();
    expect(existsSync(join(directory, 'judge-key.json'))).toBe(false);
    expect(readFileSync(join(revealed.directory, 'SUMMARY.md'), 'utf8')).toContain(
      'Secret Model 9000',
    );
    // Put the blind bundle and its key back for the tests that follow.
    built = await writeBundle(directory, loadCases(), { blind: true });
  }, 60_000);
});

describe('collating returned scorecards', () => {
  const card = (judge: string, accuracy: number) => ({
    schemaVersion: 1,
    runId: 'test-run',
    judge,
    models: ['model-a', 'model-b'].map((modelId, index) => ({
      modelId,
      accuracy: { score: accuracy - index * 3, reason: 'see burn-out-the-low-player' },
      speed: { score: 9, reason: 'fast' },
      cost: { score: null, reason: 'no price given' },
      overall: { score: accuracy - index * 3, reason: 'accuracy first' },
      blurb: `${judge} thinks ${modelId} is fine.`,
    })),
    ranking: ['model-a', 'model-b'],
    referenceDisagreements: [
      {
        caseId: 'lethal-alpha-strike',
        answer: 'No attack',
        referenceGrade: 'blunder',
        yourGrade: 'weak',
        reason: 'It loses nothing.',
      },
    ],
  });

  it('puts the judges side by side under the real model names', () => {
    const cards = [card('judge-one', 8), card('judge-two', 6)].map((json) =>
      parseScorecard(json, 'card.json', 'test-run'),
    );
    const page = collate(directory, cards);
    expect(page).toContain(
      '| Secret Model 9000 (Model A) | 7.0 (6 to 8) | 9.0 (9 to 9) | n/a | 7.0 (6 to 8) | 1.0 |',
    );
    expect(page).toContain('> judge-two thinks model-b is fine.');
    expect(page).toContain(
      '`lethal-alpha-strike`, "No attack": reference `blunder`, judge-one says `weak`.',
    );
  });

  it('refuses a scorecard for another run or with a score out of range', () => {
    expect(() => parseScorecard({ ...card('j', 8), runId: 'other' }, 'x.json', 'test-run')).toThrow(
      /x.json: is for run other/,
    );
    expect(() => parseScorecard(card('j', 14), 'x.json', 'test-run')).toThrow(/must be 0 to 10/);
  });
});

describe('the run fingerprint', () => {
  it('changes when a case changes under the same id, so --out cannot mix two tests', () => {
    const before = benchFingerprint(cases);
    expect(benchFingerprint(loadCases().filter((c) => cases.some((d) => d.id === c.id)))).toBe(
      before,
    );
    const edited = cases.map((benchCase, index) =>
      index === 0 ? { ...benchCase, briefing: `${benchCase.briefing} (revised)` } : benchCase,
    );
    expect(benchFingerprint(edited)).not.toBe(before);
    expect(newManifest('r', 'raw', 1, cases, null).fingerprint).toBe(before);
  });
});

describe('blind redaction', () => {
  it('redacts names from free text but never rewrites a case id that contains one', () => {
    const result = {
      model: { id: 'turn', label: 'turn', kind: 'llm', model: 'vendor/turn' },
      status: 'aborted',
      abortReason: 'RequestTimeoutError: vendor/turn timed out',
      startedAt: '',
      endedAt: '',
      wallClockMs: 0,
      cases: [
        {
          caseId: 'land-for-the-turn',
          trial: 1,
          run: { decisions: [{ actionKey: 'turn', failure: 'provider error: vendor/turn' }] },
          score: { score: 0, flags: [] },
        },
      ],
    } as unknown as Parameters<typeof anonymise>[0][number];
    const transcript = {
      modelId: 'turn',
      caseId: 'land-for-the-turn',
      error: 'vendor/turn timed out',
    } as unknown as Parameters<typeof anonymise>[1][number];
    const { models, transcripts } = anonymise([result], [transcript]);
    const shown = models[0]!;
    expect(shown.cases[0]!.caseId).toBe('land-for-the-turn');
    expect(transcripts[0]!.caseId).toBe('land-for-the-turn');
    expect(shown.cases[0]!.run.decisions[0]!.actionKey).toBe('turn');
    expect(
      JSON.stringify([shown.abortReason, shown.cases[0]!.run.decisions[0]!.failure]),
    ).not.toContain('vendor/turn');
    expect(transcripts[0]!.error).not.toContain('vendor/turn');
    expect(transcripts[0]!.modelId).toBe('model-a');
  });
});
