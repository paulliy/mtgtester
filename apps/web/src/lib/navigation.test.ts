import { describe, expect, it } from 'vitest';
import { currentPlaceIndex, navPlaces, startsGroup } from './navigation';

describe('navigation places', () => {
  it('lists the production places in group order', () => {
    const labels = navPlaces({ dev: false, gameRunning: false }).map((p) => p.label);
    expect(labels).toEqual(['New game', 'Stats', 'Batch runs', 'Card lab', 'Debug']);
  });

  it('adds the dev-only places and the way back to a running game', () => {
    const labels = navPlaces({ dev: true, gameRunning: true }).map((p) => p.label);
    expect(labels).toEqual([
      'New game',
      'Return to game',
      'Stats',
      'Batch runs',
      'Card lab',
      'Deals',
      'Debug',
    ]);
  });

  it('finds the current place by route name, including batch results', () => {
    const places = navPlaces({ dev: false, gameRunning: false });
    expect(currentPlaceIndex(places, 'stats')).toBe(1);
    expect(currentPlaceIndex(places, 'batch-results')).toBe(2);
    expect(currentPlaceIndex(places, 'batch-new')).toBe(2);
    expect(currentPlaceIndex(places, 'batch')).toBe(2);
    expect(currentPlaceIndex(places, 'game')).toBe(-1);
    expect(currentPlaceIndex(places, undefined)).toBe(-1);
  });

  it('lights the Card lab on the Import report, which is its page in a production build', () => {
    const production = navPlaces({ dev: false, gameRunning: false });
    const here = currentPlaceIndex(production, 'import-report');
    expect(production[here]).toMatchObject({ label: 'Card lab', to: '/workshop/import-report' });
    const dev = navPlaces({ dev: true, gameRunning: false });
    expect(dev[currentPlaceIndex(dev, 'import-report')]).toMatchObject({
      label: 'Card lab',
      to: '/card-test-lab',
    });
  });

  it('marks the first place of each group', () => {
    const places = navPlaces({ dev: true, gameRunning: false });
    const starts = places.map((_, i) => startsGroup(places, i));
    // New game | Stats, Batch runs | Card lab, Deals, Debug
    expect(starts).toEqual([true, true, false, true, false, false]);
  });
});
