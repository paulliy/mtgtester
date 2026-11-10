/**
 * Only a legendary card refers to itself by a short name (CR 201.5). The interpreter used to
 * shorten every "X of Y" name, so Wall of Mulch's "Sacrifice a Wall" read as "Sacrifice ~"
 * (this card only) and Noggle the Mind's "is a colorless Noggle" lost its creature type.
 * Found by the XMage pilot's meaning check.
 */
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('self-name short form', () => {
  it('a nonlegendary "X of Y" name keeps X as an ordinary word (Wall of Mulch)', () => {
    const def = interpretCard(
      oracle({
        name: 'Wall of Mulch',
        typeLine: 'Creature — Wall',
        manaCost: '{1}{G}',
        power: '0',
        toughness: '4',
        oracleText: "Defender (This creature can't attack.)\n{G}, Sacrifice a Wall: Draw a card.",
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities[0]?.costs).toContainEqual({
      kind: 'sacrificeOther',
      selector: {
        kind: 'allOf',
        of: [
          { kind: 'controller', who: 'you' },
          { kind: 'subtype', value: 'Wall' },
        ],
      },
      allowSelf: true,
    });
  });

  it('a legendary card still uses its short name (Ureni of the Unwritten)', () => {
    const def = interpretCard(
      oracle({
        name: 'Lab Ureni of the Deep',
        typeLine: 'Legendary Creature — Spirit Dragon',
        power: '8',
        toughness: '8',
        oracleText: 'Whenever Lab Ureni attacks, draw a card.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.trigger).toMatchObject({ when: 'attacks', subject: { kind: 'self' } });
  });
});
