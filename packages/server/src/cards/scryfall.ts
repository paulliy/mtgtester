/**
 * Parsing of raw Scryfall `oracle-cards` bulk entries into `OracleCard` (brief §3, §8.2).
 * We keep only the fields the engine and validator need, so the retained card index stays small
 * relative to the ~180 MB source. Color identity is trusted verbatim (see `cards.ts`).
 */

import type { Color, OracleCard } from '@mtg/shared';

/** The subset of Scryfall card fields we read. Everything else in the bulk entry is ignored. */
export interface RawScryfallCard {
  object?: string;
  id: string;
  oracle_id?: string;
  name: string;
  lang?: string;
  layout?: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  keywords?: string[];
  legalities?: Record<string, string>;
  /** Present on multi-face cards (transform, MDFC, split, adventure). */
  card_faces?: RawCardFace[];
  /** Non-card bulk entries (tokens for `all_parts`) — filtered out on load. */
  set_type?: string;
}

interface RawCardFace {
  name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors?: string[];
}

const SUPERTYPES = new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Host', 'Elite']);
const COLOR_SET = new Set<Color>(['W', 'U', 'B', 'R', 'G']);

function toColors(raw: string[] | undefined): Color[] {
  if (!raw) return [];
  return raw.filter((c): c is Color => COLOR_SET.has(c as Color));
}

/** A commander legality that isn't one of the four known strings falls back to `not_legal`. */
function toCommanderLegality(
  legalities: Record<string, string> | undefined,
): OracleCard['commanderLegality'] {
  const value = legalities?.['commander'];
  return value === 'legal' || value === 'banned' || value === 'restricted' ? value : 'not_legal';
}

/**
 * Split a type line (`"Legendary Creature — Elf Druid"`) into supertypes, types, and subtypes.
 * For a multi-face `A // B` line we parse the front face only; validation that needs the full
 * card (color identity) uses Scryfall's card-level fields instead.
 */
export function parseTypeLine(typeLine: string): {
  supertypes: string[];
  types: string[];
  subtypes: string[];
} {
  const front = typeLine.split('//')[0]?.trim() ?? '';
  const [leftRaw, rightRaw] = front.split('—');
  const left = (leftRaw ?? '').trim().split(/\s+/).filter(Boolean);
  const subtypes = (rightRaw ?? '').trim().split(/\s+/).filter(Boolean);
  const supertypes: string[] = [];
  const types: string[] = [];
  for (const word of left) {
    if (SUPERTYPES.has(word)) supertypes.push(word);
    else types.push(word);
  }
  return { supertypes, types, subtypes };
}

/** First non-empty value across the top-level field and any card face (front first). */
function faceFallback<K extends keyof RawCardFace>(
  card: RawScryfallCard,
  topLevel: string | undefined,
  key: K,
): string | undefined {
  if (topLevel !== undefined && topLevel !== '') return topLevel;
  for (const face of card.card_faces ?? []) {
    const v = face[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return topLevel;
}

/**
 * Convert a raw bulk entry to an `OracleCard`, or `null` if it isn't a resolvable game card
 * (missing oracle id, or a token/emblem/art-series entry).
 */
export function toOracleCard(card: RawScryfallCard): OracleCard | null {
  if (!card.oracle_id || !card.name) return null;
  if (card.layout && NON_GAME_LAYOUTS.has(card.layout)) return null;

  const typeLine = card.type_line ?? faceFallback(card, undefined, 'type_line') ?? '';
  const { supertypes, types, subtypes } = parseTypeLine(typeLine);
  const manaCost = faceFallback(card, card.mana_cost, 'mana_cost') ?? null;
  const oracleText = card.oracle_text ?? faceFallback(card, undefined, 'oracle_text') ?? '';

  return {
    oracleId: card.oracle_id,
    scryfallId: card.id,
    name: card.name,
    manaCost: manaCost === '' ? null : manaCost,
    cmc: card.cmc ?? 0,
    colors: toColors(card.colors ?? card.card_faces?.[0]?.colors),
    colorIdentity: toColors(card.color_identity),
    typeLine,
    supertypes,
    types,
    subtypes,
    oracleText,
    power: card.power ?? card.card_faces?.[0]?.power ?? null,
    toughness: card.toughness ?? card.card_faces?.[0]?.toughness ?? null,
    loyalty: card.loyalty ?? card.card_faces?.[0]?.loyalty ?? null,
    defense: card.defense ?? card.card_faces?.[0]?.defense ?? null,
    keywords: card.keywords ?? [],
    layout: card.layout ?? 'normal',
    commanderLegality: toCommanderLegality(card.legalities),
    isBasicLand: supertypes.includes('Basic') && types.includes('Land'),
  };
}

/** Layouts that are not playable cards and must never enter the pool. */
const NON_GAME_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'scheme',
  'planar',
]);
