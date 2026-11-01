import { describe, expect, it } from 'vitest';
import { PHASES } from './enums';
import { turnPositionLabel } from './turn-labels';

describe('turnPositionLabel', () => {
  it('names main phases by number and joins other phases with their step', () => {
    expect(turnPositionLabel('precombatMain', null)).toBe('Main phase 1');
    expect(turnPositionLabel('postcombatMain', null)).toBe('Main phase 2');
    expect(turnPositionLabel('combat', 'declareBlockers')).toBe('Combat · Declare blockers');
    expect(turnPositionLabel('ending', 'cleanup')).toBe('Ending · Cleanup');
  });

  it('never falls back to an internal identifier', () => {
    for (const phase of PHASES) expect(turnPositionLabel(phase, null)).not.toBe(phase);
  });
});
