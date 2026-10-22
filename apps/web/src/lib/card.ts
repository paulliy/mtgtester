/** Scryfall type lines for tokens/emblems always contain "Token" (e.g. "Token Creature — Goblin"). */
export function isTokenTypeLine(typeLine: string): boolean {
  return typeLine.includes('Token');
}

/**
 * Scryfall CDN image for a printing. `art_crop` is the illustration alone (no frame or text),
 * which is what the battlefield shows; the other versions are the whole card.
 */
export function scryfallImageUrl(
  scryfallId: string,
  version: 'small' | 'normal' | 'large' | 'art_crop',
  face: 'front' | 'back' = 'front',
): string {
  return `https://cards.scryfall.io/${version}/${face}/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}
