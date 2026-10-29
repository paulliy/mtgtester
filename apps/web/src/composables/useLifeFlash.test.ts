/**
 * Life flashes come from the server's `lifeChange` cues (ADR 0032 decision 8, plan P6): the real
 * delta decides red or green, and nothing watches life totals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIFE_FLASH_MS,
  applyLifeCues,
  resetLifeFlashes,
  useLifeFlash,
  useLifeFlashBySeat,
} from './useLifeFlash';

afterEach(() => {
  resetLifeFlashes();
  vi.useRealTimers();
});

describe('life flashes from cues', () => {
  it('flashes damage for a loss and heal for a gain, then clears', () => {
    vi.useFakeTimers();
    const p1 = useLifeFlash(() => 'P1');
    const all = useLifeFlashBySeat();
    applyLifeCues([
      { kind: 'lifeChange', sequence: 3, player: 'P1', delta: -4 },
      { kind: 'lifeChange', sequence: 4, player: 'P2', delta: 2 },
      {
        kind: 'damage',
        sequence: 3,
        sourceId: 'o-1',
        target: { kind: 'player', id: 'P3' },
        amount: 4,
        combat: true,
        group: 0,
      },
    ]);
    expect(p1.value).toBe('damage');
    expect(all['P2']).toBe('heal');
    // Damage alone is not a life change (infect, a floor on life): no flash for P3.
    expect(all['P3'] ?? null).toBeNull();
    vi.advanceTimersByTime(LIFE_FLASH_MS);
    expect(p1.value).toBeNull();
    expect(all['P2']).toBeNull();
  });

  it('starts every game clear', () => {
    applyLifeCues([{ kind: 'lifeChange', sequence: 1, player: 'P4', delta: -1 }]);
    resetLifeFlashes();
    expect(useLifeFlash(() => 'P4').value).toBeNull();
  });
});
