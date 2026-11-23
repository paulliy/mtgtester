import { describe, expect, it } from 'vitest';
import {
  bearing,
  needleLean,
  needleTarget,
  plateTarget,
  ringLanding,
  shortestTurn,
  wrap,
} from './compass';

describe('compass maths', () => {
  it('wraps angles into one turn', () => {
    expect(wrap(0)).toBe(0);
    expect(wrap(360)).toBe(0);
    expect(wrap(-90)).toBe(270);
    expect(wrap(725)).toBe(5);
  });

  it('turns the short way', () => {
    expect(shortestTurn(0, 90)).toBe(90);
    expect(shortestTurn(0, 270)).toBe(-90);
    expect(shortestTurn(350, 10)).toBe(20);
    expect(shortestTurn(10, 350)).toBe(-20);
    expect(shortestTurn(0, 180)).toBe(180);
  });

  it('brings a stop to north cumulatively', () => {
    // East (90°) to north: the plate turns a quarter anticlockwise.
    expect(plateTarget(0, 90)).toBe(-90);
    // Back to north from there.
    expect(plateTarget(-90, 0)).toBe(0);
    // After a full extra turn, a choice keeps the accumulated turns.
    expect(plateTarget(-360, 90)).toBe(-450);
  });

  it('lands rings on quarters about a turn away', () => {
    expect(ringLanding(0, 1)).toBe(360);
    expect(ringLanding(0, -1)).toBe(-360);
    expect(ringLanding(45, 1)).toBe(450);
    expect(ringLanding(360, 1) % 90).toBe(0);
  });

  it('reads the pointer bearing clockwise from north', () => {
    expect(bearing(0, -1)).toBeCloseTo(0);
    expect(bearing(1, 0)).toBeCloseTo(90);
    expect(bearing(0, 1)).toBeCloseTo(180);
    expect(bearing(-1, 0)).toBeCloseTo(270);
  });

  it('snaps on within 12° and releases past 17°', () => {
    const stops = [0, 90, 180, 270];
    expect(needleLean(80, stops, null)).toEqual({ angle: 90, held: 90 });
    expect(needleLean(70, stops, null)).toEqual({ angle: 70, held: null });
    // Held at 90: 75° is 15° away, inside the release distance.
    expect(needleLean(75, stops, 90)).toEqual({ angle: 90, held: 90 });
    // 72° is 18° away: released.
    expect(needleLean(72, stops, 90)).toEqual({ angle: 72, held: null });
    // Snapping works across north.
    expect(needleLean(355, stops, null)).toEqual({ angle: 0, held: 0 });
  });

  it('moves the needle the short way from its cumulative angle', () => {
    expect(needleTarget(0, 350)).toBe(-10);
    expect(needleTarget(720, 90)).toBe(810);
  });
});
