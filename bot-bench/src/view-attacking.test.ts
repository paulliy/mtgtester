import { describe, expect, it } from 'vitest';
import { loadCases } from './case';
import { openCase } from './play';

describe('PermanentView attacking', () => {
  it('names the defending player on each attacking creature', () => {
    const benchCase = loadCases().find((c) => c.id === 'removal-on-the-lethal-attacker');
    if (benchCase === undefined) throw new Error('no case removal-on-the-lethal-attacker');
    const { view } = openCase(benchCase);
    const named = (name: string) => view.battlefield.find((p) => p.name === name);
    for (const name of ['Shivan Dragon', 'Grizzly Bears']) {
      const attacker = named(name);
      expect(attacker?.attacking).toBe('P1');
      expect(attacker?.attackingPlaneswalker).toBeUndefined();
    }
    const idle = view.battlefield.filter((p) => p.attacking === undefined);
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every((p) => p.attackingPlaneswalker === undefined)).toBe(true);
  });
});
