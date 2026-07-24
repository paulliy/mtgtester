/**
 * Card-name normalization for Scryfall resolution (brief §8.2). Import sources spell names
 * inconsistently — curly vs straight apostrophes, missing diacritics, front-face-only names for
 * double-faced cards. We resolve on normalized keys but always report the *original* spelling
 * back to the user on failure, and never guess between two different cards.
 */

/** Collapse the Unicode apostrophe/quote variants Scryfall and paste sources disagree on. */
export function normalizeApostrophes(name: string): string {
  return name.replace(/[‘’ʼ′`´]/g, "'").replace(/[“”]/g, '"');
}

/**
 * The strict resolution key: apostrophe-normalized, lowercased, whitespace-collapsed. Two names
 * that differ only in apostrophe style or casing share this key.
 */
export function strictKey(name: string): string {
  return normalizeApostrophes(name).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The loose fallback key: also strips diacritics (Nazgûl → nazgul), drops the trailing half of
 * a `A // B` double-faced name, and removes punctuation other than internal spaces. Only used
 * when the strict key misses and the loose key is unambiguous.
 */
export function looseKey(name: string): string {
  const front = normalizeApostrophes(name).split('//')[0] ?? name;
  return front
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
