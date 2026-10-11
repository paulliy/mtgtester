// Viewer evidence input, group: CLI options and generator adapters. Split from card-evidence-input.test.ts.
// Shared fixtures live in card-evidence-input.fixtures.ts.
// Parser-boundary mocks are opt-in per test; all other calls use the real filesystem and git.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
}));

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateArcaneDenialVerificationEvidence } from '../../../../scripts/generate-arcane-denial-evidence';
import { generateFabledPassageVerificationEvidence } from '../../../../scripts/generate-fabled-passage-evidence';
import { generateMyriadLandscapeVerificationEvidence } from '../../../../scripts/generate-myriad-landscape-evidence';
import { generateSmotheringTitheVerificationEvidence } from '../../../../scripts/generate-smothering-tithe-evidence';
import { generateWarRoomVerificationEvidence, WAR_ROOM_TRACE_PATHS } from '../../../../scripts/generate-war-room-evidence';
import { parseViewerEvidenceOptions, loadGeneratorViewerEvidence, type ValidatedViewerEvidence } from '../../../../scripts/card-evidence-input';

import { repoRoot } from './card-evidence-input.fixtures';

describe('viewer evidence input: CLI options and generator adapters', { timeout: 120_000 }, () => {
  // CPU-heavy discovery plus immediately rejected promises can starve worker IPC callbacks.
  afterEach(() => yieldToEventLoop());
  it('accepts only no flags or the strict complete spaced trio', () => {
    expect(parseViewerEvidenceOptions([])).toBeUndefined();
    expect(
      parseViewerEvidenceOptions([
        '--viewer-output',
        'out',
        '--viewer-source-manifest',
        'manifest',
        '--viewer-report',
        'report',
      ]),
    ).toEqual({ reportPath: 'report', outputRoot: 'out', sourceManifestPath: 'manifest' });
  });

  it.each(
    [
      ['--viewer-report=report'],
      ['report'],
      ['--bogus', 'value'],
      ['--viewer-report'],
      ['--viewer-report', ''],
      ['--viewer-report', '   '],
      ['--viewer-report', '--viewer-output'],
      ['--viewer-report', 'a', '--viewer-report', 'b'],
      ['--viewer-report', 'a', '--viewer-output', 'b'],
      [
        '--viewer-report',
        'a',
        '--viewer-output',
        'b',
        '--viewer-source-manifest',
        'c',
        'positional',
      ],
    ].map((args) => ({ args })),
  )('rejects invalid CLI tokens %#', ({ args }) =>
    expect(() => parseViewerEvidenceOptions(args)).toThrow(),
  );

  it('does not fall back when externally supplied CLI inputs are invalid', async () => {
    await expect(
      loadGeneratorViewerEvidence(
        [
          '--viewer-report',
          'missing',
          '--viewer-output',
          'missing',
          '--viewer-source-manifest',
          'missing',
        ],
        repoRoot,
      ),
    ).rejects.toThrow();
    // A main-less import and read-only loader have no writeReport path.
    for (const card of [
      'arcane-denial',
      'fabled-passage',
      'myriad-landscape',
      'smothering-tithe',
      'war-room',
    ]) {
      const source = readFileSync(
        resolve(repoRoot, `scripts/generate-${card}-evidence.ts`),
        'utf8',
      );
      const main = source.slice(source.indexOf('if (import.meta.main)'));
      expect(main.indexOf('await loadGeneratorViewerEvidence')).toBeGreaterThan(0);
      expect(main.indexOf('await loadGeneratorViewerEvidence')).toBeLessThan(
        main.indexOf('await writeReport'),
      );
    }
  });

  it('Arcane adapter rejects a forged context before engine or output', () => {
    expect(() => generateArcaneDenialVerificationEvidence({} as ValidatedViewerEvidence)).toThrow(
      /loader-validated/,
    );
  });

  it.each([
    generateFabledPassageVerificationEvidence,
    generateMyriadLandscapeVerificationEvidence,
    generateSmotheringTitheVerificationEvidence,
    generateWarRoomVerificationEvidence,
  ])('adapter %# rejects raw maps and forged contexts before engine or output', (generator) => {
    expect(() => generator({} as ValidatedViewerEvidence)).toThrow(/loader-validated/);
    expect(() => generator(WAR_ROOM_TRACE_PATHS as unknown as ValidatedViewerEvidence)).toThrow(
      /loader-validated/,
    );
  });

  it('keeps War Room no-argument unresolved failure and null colorless default', () => {
    expect(WAR_ROOM_TRACE_PATHS['war-room-viewer-colorless-mana']).toBeNull();
    expect(() => generateWarRoomVerificationEvidence()).toThrow(/unresolved or missing/);
  });

  it('rejects a partial trio rather than silently falling back', () => {
    expect(() => parseViewerEvidenceOptions(['--viewer-report', 'report.json'])).toThrow(
      /complete trio/,
    );
  });
});
