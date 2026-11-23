import { describe, expect, it } from 'vitest';
import { fitTileWidth } from './fitTiles';

describe('fitTileWidth', () => {
  it('caps a lone card at the maximum', () => {
    expect(fitTileWidth(1, 800, 400, { min: 40, max: 150 })).toBe(150);
  });

  it('is limited by the height in one row', () => {
    // 140px tall: 140 * 5/7 = 100 wide.
    expect(fitTileWidth(3, 800, 140, { min: 40, max: 200, gap: 0 })).toBe(100);
  });

  it('wraps into a second row when that gives larger tiles', () => {
    // Ten cards in 500px: one row is 50 wide; two rows of five, each 140 tall, are 100 wide.
    expect(fitTileWidth(10, 500, 280, { min: 40, max: 200, gap: 0 })).toBe(100);
  });

  it('never goes under the floor', () => {
    expect(fitTileWidth(80, 300, 100, { min: 40, max: 200 })).toBe(40);
  });

  it('leaves room for what sits under each tile', () => {
    expect(fitTileWidth(1, 800, 168, { min: 40, max: 300, gap: 0, extra: 28 })).toBe(100);
  });

  it('falls back to the maximum before the zone is measured', () => {
    expect(fitTileWidth(4, 0, 0, { min: 40, max: 120 })).toBe(120);
  });
});
