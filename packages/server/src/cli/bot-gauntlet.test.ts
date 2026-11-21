/**
 * `bot-gauntlet --resume` reuses saved rows only when they were played under the same experiment:
 * the same seed, old arm, turn cap and pod schedule.
 */
import { describe, expect, it } from 'vitest';
import { coveringConfig, resumeConflict, runConfig, type RunConfig } from './bot-gauntlet';

const pods = [
  [{ name: 'urdragon' }, { name: 'token-triumph' }, { name: 'necron-dynasties' }, { name: 'ruby' }],
  [{ name: 'brigid' }, { name: 'urdragon' }, { name: 'pramikon' }, { name: 'living-energy' }],
];
const args = { seed: 'field', old: 'fixed-0043', turnCap: 120 };
const saved = runConfig(args, pods);

describe('bot-gauntlet --resume', () => {
  it('resumes the same experiment, with more pods or another arm', () => {
    expect(resumeConflict(saved, runConfig(args, pods))).toBeNull();
    const more = [...pods, [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]];
    expect(resumeConflict(saved, runConfig(args, more))).toBeNull();
  });

  it('refuses rows from a different seed, old arm or turn cap', () => {
    expect(resumeConflict(saved, runConfig({ ...args, old: 'fixed' }, pods))).toBe(
      'old was fixed-0043, now fixed',
    );
    expect(resumeConflict(saved, runConfig({ ...args, turnCap: 60 }, pods))).toBe(
      'turnCap was 120, now 60',
    );
    expect(resumeConflict(saved, runConfig({ ...args, seed: 'other' }, pods))).toBe(
      'seed was field, now other',
    );
  });

  it('refuses rows whose pods seated other decks (a different --decks list)', () => {
    const reseated: RunConfig = { ...saved, schedule: [saved.schedule[0]!, ['x', 'y', 'z', 'w']] };
    expect(resumeConflict(reseated, saved)).toMatch(/^pod 1 seated x, y, z, w, now brigid/);
  });

  it('refuses rows saved before the configuration was recorded', () => {
    expect(resumeConflict(null, saved)).toMatch(/no recorded configuration/);
  });

  it('keeps the longer saved schedule when a shorter run resumes', () => {
    const shorter = runConfig(args, pods.slice(0, 1));
    expect(resumeConflict(saved, shorter)).toBeNull();
    expect(coveringConfig(saved, shorter).schedule).toEqual(saved.schedule);
    expect(coveringConfig(null, shorter)).toEqual(shorter);
  });
});
