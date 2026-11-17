import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const RUN = join(ROOT, 'scripts/card-compiler/run.ts');

function run(...args: string[]) {
  return spawnSync('bun', ['run', RUN, ...args], { cwd: ROOT, encoding: 'utf8' });
}

describe('a trial holding calibration cases', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  // Review on PR #72: importing a real patch whose card is already one of the trial's calibration
  // cases reported "imported 0" and left the card out of the trial without a word.
  it('refuses a real import of a calibration case’s card, and changes nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'calibration-import-'));
    const trial = join(dir, 'trial');
    mkdirSync(trial);
    const calibrated = run('calibrate', trial, '--calibration', '10');
    expect(calibrated.status, calibrated.stderr).toBe(0);
    const statePath = join(trial, 'work/state.json');
    const before = readFileSync(statePath, 'utf8');
    const states = JSON.parse(before) as { name: string; calibration?: unknown }[];
    const taken = states.find((state) => state.calibration !== undefined);
    expect(taken).toBeDefined();

    const patches = join(dir, 'patches');
    mkdirSync(patches);
    writeFileSync(
      join(patches, 'collision.json'),
      JSON.stringify({ name: taken!.name, source: 'test@0', handledLines: [], def: {} }),
    );
    const imported = run('import', trial, patches);
    expect(imported.status).not.toBe(0);
    expect(imported.stderr).toContain(`${taken!.name} is already a calibration case`);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(existsSync(join(trial, 'targets.json'))).toBe(false);
  });
});
