/**
 * The calibration set (`scripts/card-compiler/calibration.ts`): patches with known answers that
 * are mixed into every trial's meaning check to test the check itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_PATH,
  buildCalibrationSet,
  pickCases,
  scoreCalibration,
  type CalibrationCase,
} from '../../../../scripts/card-compiler/calibration';
import {
  applyPatch,
  canonicalBehavior,
  compileTarget,
  pinnedPool,
} from '../../../../scripts/card-compiler/lib';
import { textCheck } from '../../../../scripts/card-compiler/render';

const root = resolve(import.meta.dirname, '../../../..');
const committed = (
  JSON.parse(readFileSync(resolve(root, CALIBRATION_PATH), 'utf8')) as { cases: CalibrationCase[] }
).cases;
const pinned = new Map(pinnedPool().map((row) => [row.card.name, row]));
const targetOf = (name: string) => compileTarget(pinned.get(name)!)!;

describe('the calibration set', () => {
  it('is the one the audited trial patches build today', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildCalibrationSet())));
  }, 60_000);

  it('holds the two patches the trial 01 audit found wrong, and correct ones', () => {
    const wrong = committed.filter((item) => item.expected === 'different');
    expect(wrong.map((item) => item.id)).toEqual(
      expect.arrayContaining(['charmbreaker-devils', 'thran-turbine']),
    );
    expect(wrong.length).toBeGreaterThanOrEqual(20);
    expect(committed.filter((item) => item.expected === 'same').length).toBeGreaterThanOrEqual(20);
    expect(new Set(committed.map((item) => item.id)).size).toBe(committed.length);
  });

  it('has only valid patches, and every broken variant differs from its correct patch', () => {
    const correct = new Map(
      committed.filter((item) => item.expected === 'same').map((item) => [item.name, item]),
    );
    for (const item of committed) {
      const target = targetOf(item.name);
      const applied = applyPatch(target, item.def);
      expect(applied.ok, `${item.id}: ${applied.issues.join('; ')}`).toBe(true);
      if (!item.id.includes('~')) continue;
      const original = applyPatch(target, correct.get(item.name)!.def);
      expect(canonicalBehavior(applied.definition!), item.id).not.toBe(
        canonicalBehavior(original.definition!),
      );
    }
  }, 60_000);

  it('never gets a wrong patch past the free text check', () => {
    // The renderer settles a patch as "same" with no model call, so it must not match these.
    for (const item of committed.filter((entry) => entry.expected === 'different')) {
      const target = targetOf(item.name);
      const verdict = textCheck(item.def, target.lines, target.name, target.card.oracleText ?? '');
      expect(verdict.verdict, item.id).not.toBe('match');
    }
  });
});

describe('choosing calibration cases for a trial', () => {
  it('is repeatable, takes one case per card, and leans to wrong cases', () => {
    const picked = pickCases(committed, 'chunk-001', 10, new Set());
    expect(pickCases(committed, 'chunk-001', 10, new Set())).toEqual(picked);
    expect(picked).toHaveLength(10);
    expect(new Set(picked.map((item) => item.name)).size).toBe(10);
    expect(picked.filter((item) => item.expected === 'different')).toHaveLength(6);
    expect(pickCases(committed, 'chunk-002', 10, new Set())).not.toEqual(picked);
  });

  it('leaves out a card the trial compiles itself', () => {
    const first = pickCases(committed, 'chunk-001', 10, new Set());
    const excluded = new Set([first[0]!.name]);
    const again = pickCases(committed, 'chunk-001', 10, excluded);
    expect(again.map((item) => item.name)).not.toContain(first[0]!.name);
    expect(again).toHaveLength(10);
  });
});

describe('scoring a trial against its calibration cases', () => {
  const state = (
    id: string,
    expected: 'same' | 'different',
    verdict: 'same' | 'different' | undefined,
  ) => ({
    name: id,
    stage: verdict === undefined ? 'judge' : 'done',
    ...(verdict === undefined ? {} : { verdict }),
    calibration: { id, expected },
  });

  it('reports a wrong patch judged "same" as missed, and a flagged correct one as a false alarm', () => {
    expect(
      scoreCalibration([
        state('caught', 'different', 'different'),
        state('missed', 'different', 'same'),
        state('right', 'same', 'same'),
        state('alarm', 'same', 'different'),
        state('waiting', 'different', undefined),
        { name: 'A real card', stage: 'done', verdict: 'same' as const },
      ]),
    ).toEqual({ cases: 5, pending: ['waiting'], missed: ['missed'], falseAlarms: ['alarm'] });
  });
});
