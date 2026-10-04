import { describe, expect, it } from 'vitest';
import { PHASES } from '@mtg/shared';
import { playerFacingPrompt, turnPositionLabel } from './turnLabels';

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

describe('playerFacingPrompt', () => {
  it('rewrites the engine priority prompt parenthetical', () => {
    expect(playerFacingPrompt('You have priority (precombatMain). Choose an action.')).toBe(
      'You have priority (Main phase 1). Choose an action.',
    );
    expect(playerFacingPrompt('You have priority (beginning, upkeep). Choose an action.')).toBe(
      'You have priority (Beginning · Upkeep). Choose an action.',
    );
  });

  it('leaves other parentheticals alone', () => {
    expect(playerFacingPrompt('Discard down to seven cards (8 in hand).')).toBe(
      'Discard down to seven cards (8 in hand).',
    );
    expect(playerFacingPrompt('Pay (beginning, notAStep) now')).toBe(
      'Pay (beginning, notAStep) now',
    );
  });
});
