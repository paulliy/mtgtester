import { describe, expect, it } from 'vitest';
import { pickTokenPrinting, tokenArtCacheKey, tokenSearchQueries } from './tokenArt';

const thopter = {
  name: 'Thopter',
  typeLine: 'Artifact Creature — Thopter',
  colors: [],
  power: 1,
  toughness: 1,
};

describe('tokenSearchQueries', () => {
  it('searches by name, card types, colors and P/T, then without P/T', () => {
    expect(tokenSearchQueries(thopter)).toEqual([
      {
        query: 't:token !"Thopter" t:artifact t:creature c=c game:paper pow=1 tou=1',
        exact: true,
      },
      { query: 't:token !"Thopter" t:artifact t:creature c=c game:paper', exact: false },
    ]);
  });

  it('keeps colors in every query, so a token never borrows another color’s art', () => {
    const soldier = { ...thopter, name: 'Soldier', typeLine: 'Creature — Soldier', colors: ['W'] };
    for (const { query } of tokenSearchQueries(soldier)) expect(query).toContain('c=w');
  });

  it('searches a noncreature token once, and that match is exact', () => {
    const treasure = {
      name: 'Treasure',
      typeLine: 'Artifact — Treasure',
      colors: [],
      power: null,
      toughness: null,
    };
    expect(tokenSearchQueries(treasure)).toEqual([
      { query: 't:token !"Treasure" t:artifact c=c game:paper', exact: true },
    ]);
  });

  it('drops a "Token" type word and quotes in the name', () => {
    const [first] = tokenSearchQueries({
      ...thopter,
      name: 'A "Quoted" Token',
      typeLine: 'Token Legendary Creature — Spirit',
    });
    expect(first?.query).toContain('!"A Quoted Token" t:legendary t:creature c=c');
  });
});

describe('pickTokenPrinting', () => {
  it('prefers a single-faced printing', () => {
    expect(
      pickTokenPrinting(
        [
          { id: 'dfc', name: 'Servo // Thopter', card_faces: [{ name: 'Servo', image_uris: {} }] },
          { id: 'single', name: 'Thopter', image_uris: {} },
        ],
        'Thopter',
      ),
    ).toEqual({ scryfallId: 'single', face: 'front' });
  });

  it('falls back to the matching face of a double-faced token', () => {
    expect(
      pickTokenPrinting(
        [
          {
            id: 'dfc',
            name: 'Servo // Thopter',
            card_faces: [
              { name: 'Servo', image_uris: {} },
              { name: 'Thopter', image_uris: {} },
            ],
          },
        ],
        'Thopter',
      ),
    ).toEqual({ scryfallId: 'dfc', face: 'back' });
  });

  it('returns null when no result has art for the name', () => {
    expect(
      pickTokenPrinting([{ id: 'x', name: 'Other // Thing', card_faces: [] }], 'Thopter'),
    ).toBe(null);
  });
});

describe('tokenArtCacheKey', () => {
  it('ignores color order', () => {
    expect(tokenArtCacheKey({ ...thopter, colors: ['W', 'G'] })).toBe(
      tokenArtCacheKey({ ...thopter, colors: ['G', 'W'] }),
    );
  });
});
