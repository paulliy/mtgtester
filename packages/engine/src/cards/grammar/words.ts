/**
 * Word-level vocabulary for the card grammar (ADR 0038): number words, ordinals, color words,
 * card-type nouns, keyword and land-type sets, and subtype resolution. The leaf of the grammar
 * modules: nothing here parses a phrase, so every other slot parser may depend on it.
 */

import type { Color, OracleCard } from '@mtg/shared';
import { IMPLEMENTED_KEYWORDS } from '../ability';
import { CREATURE_TYPE_BY_LOWER, NONCREATURE_SUBTYPE_BY_LOWER } from '../creature-types';

export const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

export function parseAmount(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

export const ORDINAL_TIMES: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
};

export const ORDINALS_FROM_TOP: Record<string, number> = {
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
};

/** CR 105.1 — the five colors. Distinct from the mana-side `ALL_COLORS` in `interpret.ts`, which is a
 * `ManaUnit` and is about production, not about what "each color" means. */
export const FIVE_COLORS: readonly Color[] = ['W', 'U', 'B', 'R', 'G'];

/** Color adjectives a subject can carry ("Black creatures get +1/+1" — Bad Moon). */
export const COLOR_WORDS: Record<string, Color> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
};

/** Plural card types that can head a subject noun phrase. */
export const CARD_TYPE_PLURALS: Record<string, string> = {
  creatures: 'Creature',
  artifacts: 'Artifact',
  enchantments: 'Enchantment',
  lands: 'Land',
  planeswalkers: 'Planeswalker',
};

/** Singular card types that can head a trigger subject ("a creature you control"). */
export const CARD_TYPE_SINGULARS: Record<string, string> = {
  creature: 'Creature',
  instant: 'Instant',
  sorcery: 'Sorcery',
  artifact: 'Artifact',
  enchantment: 'Enchantment',
  land: 'Land',
  planeswalker: 'Planeswalker',
};

export const KEYWORD_SET = new Set<string>(IMPLEMENTED_KEYWORDS);

/** Basic land types (CR 305.6) — the vocabulary a checkland's "unless you control a …" uses. */
export const LAND_SUBTYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];

/** "dragon" → "Dragon". Subtypes are printed capitalized; the parser lowercases lines. */
export function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** English plural forms a creature type could be written as: "Elf" → …/elfs/elves. */
export function pluralForms(word: string): string[] {
  const w = word.toLowerCase();
  const forms = [w, `${w}s`, `${w}es`];
  if (w.endsWith('fe')) forms.push(`${w.slice(0, -2)}ves`);
  else if (w.endsWith('f')) forms.push(`${w.slice(0, -1)}ves`);
  if (w.endsWith('y')) forms.push(`${w.slice(0, -1)}ies`);
  return forms;
}

/**
 * Resolve a tribe as rules text writes it ("elves") back to the printed subtype ("Elf").
 *
 * Three vocabularies, in order. The card's OWN subtypes come first, so a non-creature subtype
 * the card actually has ("Equipment", "Aura", a land type) still resolves. Then CR 205.3m's
 * closed creature-type list, which is what lets a card refer to a tribe it is not a member of —
 * Dragon's Hoard is an Artifact that watches Dragons. Finally the planeswalker (205.3j) and
 * spell (205.3k) types, which is how "Ugin planeswalker card" and "an Omen spell" resolve as
 * ordinary subtype filters rather than needing card-name matching.
 *
 * Anything in none of them returns null and leaves the card unmodeled, which halts loudly.
 * Guessing a singular from a plural would silently produce a selector matching nothing.
 */
export function resolveSubtype(word: string, card: OracleCard): string | null {
  const own = card.subtypes.find((s) => pluralForms(s).includes(word));
  if (own !== undefined) return own;
  const lower = word.toLowerCase();
  for (const [key, type] of CREATURE_TYPE_BY_LOWER) {
    if (pluralForms(key).includes(lower)) return type;
  }
  for (const [key, type] of NONCREATURE_SUBTYPE_BY_LOWER) {
    if (pluralForms(key).includes(lower)) return type;
  }
  return null;
}

/**
 * How a card refers to itself mid-sentence. `~` is the substituted card name; the lowercase
 * "this <type>" forms survive `substituteSelfName` (which is case-sensitive by design — see
 * `SELF_REFERENCE_RE`) and are accepted only in positions where nothing else can be meant.
 */
export const SELF_OBJECT_RE =
  /^(?:~|this (?:artifact|creature|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker))$/;
