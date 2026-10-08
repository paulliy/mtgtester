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
  color_indicator?: string[];
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

/**
 * Convert a raw bulk entry to an `OracleCard`, or `null` if it isn't a resolvable game card
 * (missing oracle id, or a token/emblem/art-series entry).
 */
export function toOracleCard(card: RawScryfallCard): OracleCard | null {
  if (!card.oracle_id || !card.name) return null;
  if (card.layout && NON_GAME_LAYOUTS.has(card.layout)) return null;

  const front = card.card_faces?.[0];
  const typeLine = front?.type_line ?? card.type_line ?? '';
  const printedCost = front?.mana_cost ?? card.mana_cost;
  const costColors = (cost: string | undefined): string[] =>
    [...COLOR_SET].filter((color) =>
      (cost?.match(/\{[^}]+\}/g) ?? []).some((symbol) => symbol.includes(color)),
    );
  const { supertypes, types, subtypes } = parseTypeLine(typeLine);
  const manaCost = printedCost ?? null;
  const oracleText = front?.oracle_text ?? card.oracle_text ?? '';

  const back = card.card_faces?.[1];

  return {
    oracleId: card.oracle_id,
    scryfallId: card.id,
    name: card.name,
    manaCost: manaCost === '' ? null : manaCost,
    cmc: card.cmc ?? 0,
    colors: toColors(
      front?.colors ?? front?.color_indicator ?? card.colors ?? costColors(printedCost),
    ),
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
    // Each face keeps its own cost, text and colors; top-level split strings are display data.
    ...(back !== undefined
      ? {
          backFace: {
            name: back.name ?? '',
            typeLine: back.type_line ?? '',
            oracleText: back.oracle_text ?? '',
            manaCost:
              back.mana_cost === undefined || back.mana_cost === ''
                ? null
                : (back.mana_cost as OracleCard['manaCost']),
            colors: toColors(back.colors ?? back.color_indicator ?? costColors(back.mana_cost)),
            power: back.power ?? null,
            toughness: back.toughness ?? null,
            loyalty: back.loyalty ?? null,
            defense: back.defense ?? null,
          },
        }
      : {}),
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
