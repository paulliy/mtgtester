import { describe, expect, it } from 'vitest';
import { makeEngine, oracle, seat } from './fixtures';

describe('Riot (CR 702.136)', () => {
  it('prompts choice between +1/+1 counter and haste on creature ETB', () => {
    const rhythm = oracle({
      name: 'Rhythm of the Wild',
      typeLine: 'Enchantment',
      manaCost: '{1}{R}{G}',
      oracleText: "Creature spells you control can't be countered. Nontoken creatures you control have riot.",
    });
    const dromoka = oracle({
      name: 'Dragonlord Dromoka',
      typeLine: 'Legendary Creature — Dragon',
      manaCost: '{4}{G}{W}',
      power: '5',
      toughness: '7',
    });

    const engine = makeEngine([
      seat({ cards: [rhythm, dromoka] }, 0),
      seat({ cards: [] }, 1),
      seat({ cards: [] }, 2),
      seat({ cards: [] }, 3),
    ]);

    expect(engine.getState().players[0]?.id).toBe('P1');
  });
});
