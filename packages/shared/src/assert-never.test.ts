import { describe, expect, it } from 'vitest';
import { assertNever } from './assert-never';
import type { GameMode } from './protocol';

describe('assertNever', () => {
  it('fails closed on a value outside the union', () => {
    const mode = 'party' as unknown as GameMode;
    expect(() => {
      switch (mode) {
        case 'spectator':
        case 'singlePlayer':
        case 'table':
          return;
        default:
          assertNever(mode, 'game mode');
      }
    }).toThrow('game mode: "party"');
  });
});
