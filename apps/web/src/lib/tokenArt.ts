/**
 * Finding a printed token to borrow art from. The engine makes tokens from its own catalog, with no
 * Scryfall printing, so the battlefield matches each one to a printed token by name, card types,
 * colors and P/T through Scryfall's search API. Art is cosmetic: a miss just leaves the plain tile.
 */

export interface TokenArtKey {
  name: string;
  typeLine: string;
  colors: readonly string[];
  power: number | null;
  toughness: number | null;
}

export interface TokenArt {
  scryfallId: string;
  face: 'front' | 'back';
  /**
   * True when the printing matched on P/T as well. Only then is the printed card a faithful
   * picture of the token, fit to show whole in the hover preview; a looser match lends art only.
   */
  exact: boolean;
}

/** The fields of a Scryfall search result this module reads. */
export interface ScryfallSearchCard {
  id: string;
  name: string;
  image_uris?: unknown;
  card_faces?: { name: string; image_uris?: unknown }[];
}

export function tokenArtCacheKey(key: TokenArtKey): string {
  return [key.name, key.typeLine, [...key.colors].sort().join(''), key.power, key.toughness].join(
    '|',
  );
}

/** "Legendary Artifact Creature — Thopter" → ["legendary", "artifact", "creature"]. */
function cardTypes(typeLine: string): string[] {
  const [types = ''] = typeLine.split('—');
  return types
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== '' && word !== 'token');
}

/**
 * Search queries from strictest to loosest: name, types and colors always; P/T first, then
 * without it, since a printing with other numbers still shows the right creature. Never by name
 * alone, which would happily lend a white Soldier's art to a red one.
 */
export function tokenSearchQueries(key: TokenArtKey): { query: string; exact: boolean }[] {
  const name = key.name.replace(/"/g, '');
  const colors = key.colors.length === 0 ? 'c' : key.colors.join('').toLowerCase();
  const base = [
    't:token',
    `!"${name}"`,
    ...cardTypes(key.typeLine).map((type) => `t:${type}`),
    `c=${colors}`,
    'game:paper',
  ];
  const queries = [];
  if (key.power !== null && key.toughness !== null) {
    queries.push({
      query: [...base, `pow=${key.power}`, `tou=${key.toughness}`].join(' '),
      exact: true,
    });
  }
  queries.push({ query: base.join(' '), exact: key.power === null });
  return queries;
}

/**
 * The first result with art for this name: a single-faced printing if there is one, else the
 * matching face of a double-faced token.
 */
export function pickTokenPrinting(
  cards: readonly ScryfallSearchCard[],
  name: string,
): Omit<TokenArt, 'exact'> | null {
  for (const card of cards) {
    if (card.image_uris !== undefined) return { scryfallId: card.id, face: 'front' };
  }
  for (const card of cards) {
    const index = card.card_faces?.findIndex((face) => face.name === name) ?? -1;
    if (index === 0 || index === 1) {
      if (card.card_faces?.[index]?.image_uris !== undefined) {
        return { scryfallId: card.id, face: index === 0 ? 'front' : 'back' };
      }
    }
  }
  return null;
}
