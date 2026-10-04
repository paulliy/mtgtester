/**
 * Deterministic archetype inference (brief §8.4, ADR 0022 §5).
 *
 * §8.4 shipped the archetype tag as a manual field and asked that the schema be left "ready for
 * inference later". This is that inference, and it is deliberately a pure function over the
 * resolved decklist rather than a model call: it costs nothing, runs offline, gives the same
 * answer twice, and can be unit-tested against committed fixtures. An optional AI refinement
 * pass sits on top of it (Stage 2) and falls back to this result on any failure.
 *
 * The commander's own text is weighted far above any other card. In Commander the general is the
 * thesis statement — a deck whose commander makes tokens is a tokens deck even when only a dozen
 * other cards say "token".
 */

import { ALL_COLORS } from '@mtg/shared';
import type { Color, OracleCard } from '@mtg/shared';

/** Broad plan the deck executes. `midrange` is the honest answer when nothing else stands out. */
export type ArchetypeStrategy = 'aggro' | 'midrange' | 'control' | 'combo' | 'ramp' | 'stax';

/** What the deck is built around, when one signal is clearly dominant. */
export type ArchetypeTheme =
  | 'tokens'
  | 'counters'
  | 'graveyard'
  | 'artifacts'
  | 'lifegain'
  | 'landfall'
  | 'sacrifice'
  | 'mill'
  | 'voltron'
  | 'spellslinger'
  | `${string} tribal`;

/**
 * The measured shape of a decklist. Persisted alongside the tag (`archetype_features_json`) so
 * the classifier can be retuned and old decks re-scored without re-resolving decklists — the
 * same reasoning brief §9.2 gives for logging raw mana inputs rather than the flood/drought
 * booleans they produce.
 */
export interface ArchetypeFeatures {
  totalCards: number;
  lands: number;
  creatures: number;
  instants: number;
  sorceries: number;
  artifacts: number;
  enchantments: number;
  planeswalkers: number;
  /** Mean mana value across nonland cards; 0 for a deck with none. */
  averageManaValue: number;
  ramp: number;
  spotRemoval: number;
  boardWipes: number;
  cardDraw: number;
  tutors: number;
  counterspells: number;
  recursion: number;
  sacOutlets: number;
  stax: number;
  aggressiveKeywords: number;
  /** Theme signal strength, commander text already weighted in. */
  themeScores: Record<string, number>;
  /** Most concentrated creature subtype and how many creatures share it. */
  topSubtype: { subtype: string; count: number } | null;
  /** Whether a commander shares `topSubtype` — the strongest tribal evidence available. */
  commanderSharesTopSubtype: boolean;
}

export interface ArchetypeResult {
  /** The rendered free-text tag, e.g. `"Gruul tokens aggro"`. */
  tag: string;
  strategy: ArchetypeStrategy;
  /** Null when no theme cleared the threshold — the tag is then identity + strategy only. */
  theme: ArchetypeTheme | null;
  features: ArchetypeFeatures;
}

export interface ArchetypeInput {
  commanders: readonly OracleCard[];
  companion?: OracleCard | null;
  /** Main deck, expanded or with quantities — both are accepted. */
  cards: ReadonlyArray<{ card: OracleCard; quantity: number }>;
  colorIdentity: readonly Color[];
}

// ── Colour identity names ────────────────────────────────────────────────────────────────────

const MONO: Record<string, string> = {
  W: 'Mono-White',
  U: 'Mono-Blue',
  B: 'Mono-Black',
  R: 'Mono-Red',
  G: 'Mono-Green',
};

const PAIRS: Record<string, string> = {
  WU: 'Azorius',
  WB: 'Orzhov',
  WR: 'Boros',
  WG: 'Selesnya',
  UB: 'Dimir',
  UR: 'Izzet',
  UG: 'Simic',
  BR: 'Rakdos',
  BG: 'Golgari',
  RG: 'Gruul',
};

const TRIPLES: Record<string, string> = {
  WUB: 'Esper',
  WUR: 'Jeskai',
  WUG: 'Bant',
  WBR: 'Mardu',
  WBG: 'Abzan',
  WRG: 'Naya',
  UBR: 'Grixis',
  UBG: 'Sultai',
  URG: 'Temur',
  BRG: 'Jund',
};

const COLOR_WORD: Record<string, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
};

/**
 * What a Commander player would actually call this colour combination. Four-colour decks use the
 * "non-X" convention rather than the Nephilim names, which are technically correct and universally
 * unrecognised.
 */
export function identityName(identity: readonly Color[]): string {
  const key = ALL_COLORS.filter((color) => identity.includes(color)).join('');
  if (key.length === 0) return 'Colorless';
  if (key.length === 1) return MONO[key] ?? key;
  if (key.length === 2) return PAIRS[key] ?? key;
  if (key.length === 3) return TRIPLES[key] ?? key;
  if (key.length === 4) {
    const missing = ALL_COLORS.find((color) => !identity.includes(color));
    return missing === undefined ? 'Four-Color' : `Non-${COLOR_WORD[missing] ?? missing}`;
  }
  return 'Five-Color';
}

// ── Oracle-text signals ──────────────────────────────────────────────────────────────────────

const RAMP =
  /\badd\s\{|\badd (one|two|three|\w+) mana\b|search your library for (a|an|up to \w+)[^.]{0,40}\bland/i;
// "any target" is the modern templating and by far the more common of the two; matching only
// "to target" silently scores a burn-heavy deck as having no removal at all.
const SPOT_REMOVAL =
  /\b(destroy|exile) target\b|target creature gets -|deals? (\d+|X) damage to (any target|target)/i;
const BOARD_WIPE = /\b(destroy|exile) all\b|each (creature|player sacrifices)|all creatures get -/i;
const CARD_DRAW = /\bdraw (a|one|two|three|four|five|\d+) cards?\b/i;
const TUTOR =
  /search your library for (a|an|up to \w+)[^.]{0,60}\b(card|creature|artifact|enchantment|instant|sorcery)\b/i;
const COUNTERSPELL = /\bcounter target\b/i;
const RECURSION = /return .{0,40}from (your|a) graveyard/i;
const SAC_OUTLET = /\bsacrifice (a|an|another)\b/i;
const STAX =
  /\b(don't|doesn't) untap\b|can't (attack|block|be cast|draw)|unless (that player|they|its controller) pays|costs \{\d+\} more/i;

const AGGRESSIVE = ['haste', 'trample', 'double strike', 'menace', 'first strike'];

/** Theme detectors. Order is irrelevant — every one is scored on every card. */
const THEMES: ReadonlyArray<{ theme: ArchetypeTheme; pattern: RegExp }> = [
  { theme: 'tokens', pattern: /\bcreate\b[^.]{0,50}\btoken/i },
  { theme: 'counters', pattern: /\+1\/\+1 counter/i },
  { theme: 'graveyard', pattern: /\bgraveyard\b/i },
  { theme: 'artifacts', pattern: /\bartifacts?\b/i },
  { theme: 'lifegain', pattern: /\bgains? \d+ life\b|\bgain life\b|\blifelink\b/i },
  { theme: 'landfall', pattern: /\blandfall\b|whenever a land (you control )?enters/i },
  { theme: 'sacrifice', pattern: /\bsacrifices?\b/i },
  { theme: 'mill', pattern: /\bmills?\b|put the top .{0,30}into (their|your) graveyard/i },
  { theme: 'voltron', pattern: /\bequip\b|\battach\b|\benchant creature\b/i },
  { theme: 'spellslinger', pattern: /whenever you cast (an instant|a sorcery|your first)/i },
];

export const CARD_ROLES = [
  'ramp',
  'spotRemoval',
  'boardWipe',
  'cardDraw',
  'tutor',
  'counterspell',
  'recursion',
  'sacrificeOutlet',
  'stax',
] as const;
export type CardRole = (typeof CARD_ROLES)[number];

/** Reusable conservative multi-label role evidence for profiles and archetype features. */
export function detectCardRoles(card: OracleCard): CardRole[] {
  const roles: CardRole[] = [];
  const text = card.oracleText;
  if (!isLand(card)) {
    if (has(RAMP, text)) roles.push('ramp');
    if (has(SPOT_REMOVAL, text)) roles.push('spotRemoval');
    if (has(BOARD_WIPE, text)) roles.push('boardWipe');
    if (has(CARD_DRAW, text)) roles.push('cardDraw');
    if (has(TUTOR, text)) roles.push('tutor');
    if (has(COUNTERSPELL, text)) roles.push('counterspell');
    if (has(RECURSION, text)) roles.push('recursion');
    if (has(SAC_OUTLET, text)) roles.push('sacrificeOutlet');
  }
  if (has(STAX, text)) roles.push('stax');
  return roles;
}

/**
 * How much more a commander's text counts than a single main-deck card's. A 99-card deck can
 * mention "graveyard" incidentally a dozen times; a commander that says it means it.
 */
const COMMANDER_WEIGHT = 12;

/** A theme must reach this share of the deck-equivalent signal to be named in the tag. */
const THEME_THRESHOLD = 8;

/** Creatures sharing a subtype before the deck is called tribal. */
const TRIBAL_THRESHOLD = 8;

/**
 * Share of the creature base that subtype must also hold, when a commander shares it. Comfortably
 * above a coin flip on purpose: tribal is checked *before* the mechanical themes, so too low a bar
 * lets an incidental majority preempt a much stronger signal. Measured on the committed fixtures,
 * 0.5 called a Grixis +1/+1-counters deck "wizard tribal" off a 0.51 Wizard share while its
 * counters signal scored six times higher.
 */
const TRIBAL_SHARE = 0.6;

/**
 * Share at which a tribe is called without the commander sharing it. In Commander the general
 * almost always *is* the tribe, so "the commander shares this subtype" is the strongest available
 * evidence — without that corroboration a bare majority is usually incidental. Measured on the
 * committed fixtures: a Grixis counters/sacrifice deck was being called "wizard tribal" purely
 * because half its creatures happened to be Wizards.
 */
const TRIBAL_SHARE_UNCORROBORATED = 0.7;

function isLand(card: OracleCard): boolean {
  return card.types.includes('Land');
}

function has(pattern: RegExp, text: string): boolean {
  return pattern.test(text);
}

// ── Feature extraction ───────────────────────────────────────────────────────────────────────

export function extractFeatures(input: ArchetypeInput): ArchetypeFeatures {
  const features: ArchetypeFeatures = {
    totalCards: 0,
    lands: 0,
    creatures: 0,
    instants: 0,
    sorceries: 0,
    artifacts: 0,
    enchantments: 0,
    planeswalkers: 0,
    averageManaValue: 0,
    ramp: 0,
    spotRemoval: 0,
    boardWipes: 0,
    cardDraw: 0,
    tutors: 0,
    counterspells: 0,
    recursion: 0,
    sacOutlets: 0,
    stax: 0,
    aggressiveKeywords: 0,
    themeScores: {},
    topSubtype: null,
    commanderSharesTopSubtype: false,
  };

  const subtypeCounts = new Map<string, number>();
  let nonlandCount = 0;
  let nonlandMvTotal = 0;

  const score = (theme: string, weight: number): void => {
    features.themeScores[theme] = (features.themeScores[theme] ?? 0) + weight;
  };

  const consider = (card: OracleCard, quantity: number, weight: number): void => {
    const text = card.oracleText;
    features.totalCards += quantity;

    if (isLand(card)) features.lands += quantity;
    else {
      nonlandCount += quantity;
      nonlandMvTotal += card.cmc * quantity;
    }
    if (card.types.includes('Creature')) {
      features.creatures += quantity;
      for (const subtype of card.subtypes) {
        subtypeCounts.set(subtype, (subtypeCounts.get(subtype) ?? 0) + quantity);
      }
    }
    if (card.types.includes('Instant')) features.instants += quantity;
    if (card.types.includes('Sorcery')) features.sorceries += quantity;
    if (card.types.includes('Artifact')) features.artifacts += quantity;
    if (card.types.includes('Enchantment')) features.enchantments += quantity;
    if (card.types.includes('Planeswalker')) features.planeswalkers += quantity;

    // Functional counts are nonland-only. A land that taps for mana is not ramp — counting it as
    // such scored this deck's manabase as half its ramp and called every deck a ramp deck.
    const roles = detectCardRoles(card);
    if (roles.includes('ramp')) features.ramp += quantity;
    if (roles.includes('spotRemoval')) features.spotRemoval += quantity;
    if (roles.includes('boardWipe')) features.boardWipes += quantity;
    if (roles.includes('cardDraw')) features.cardDraw += quantity;
    if (roles.includes('tutor')) features.tutors += quantity;
    if (roles.includes('counterspell')) features.counterspells += quantity;
    if (roles.includes('recursion')) features.recursion += quantity;
    if (roles.includes('sacrificeOutlet')) features.sacOutlets += quantity;
    if (roles.includes('stax')) features.stax += quantity;

    const keywords = card.keywords.map((keyword) => keyword.toLowerCase());
    if (keywords.some((keyword) => AGGRESSIVE.includes(keyword))) {
      features.aggressiveKeywords += quantity;
    }

    for (const { theme, pattern } of THEMES) {
      if (has(pattern, text)) score(theme, quantity * weight);
    }
  };

  for (const commander of input.commanders) consider(commander, 1, COMMANDER_WEIGHT);
  if (input.companion != null) consider(input.companion, 1, COMMANDER_WEIGHT);
  for (const { card, quantity } of input.cards) consider(card, quantity, 1);

  features.averageManaValue =
    nonlandCount === 0 ? 0 : Math.round((nonlandMvTotal / nonlandCount) * 100) / 100;

  let top: { subtype: string; count: number } | null = null;
  // Sorted so a tie resolves by name rather than by Map insertion order — otherwise the same
  // decklist could tag differently depending on the order it was written in.
  for (const [subtype, count] of [...subtypeCounts.entries()].sort((a, b) =>
    b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1],
  )) {
    top = { subtype, count };
    break;
  }
  features.topSubtype = top;
  features.commanderSharesTopSubtype =
    top !== null && input.commanders.some((commander) => commander.subtypes.includes(top.subtype));

  return features;
}

// ── Classification ───────────────────────────────────────────────────────────────────────────

function classifyStrategy(features: ArchetypeFeatures): ArchetypeStrategy {
  const nonlands = Math.max(1, features.totalCards - features.lands);
  const share = (count: number): number => count / nonlands;

  // Order matters: these are checked most-distinctive first, because a stax deck also looks
  // controlling and a combo deck also draws cards.
  if (share(features.stax) >= 0.14) return 'stax';
  if (share(features.tutors) >= 0.12 && share(features.cardDraw) >= 0.15) return 'combo';

  const interaction = features.counterspells + features.boardWipes + features.spotRemoval;
  if (share(interaction) >= 0.22 && share(features.creatures) <= 0.3) return 'control';

  if (share(features.ramp) >= 0.22 && features.averageManaValue >= 3.6) return 'ramp';

  if (
    share(features.creatures) >= 0.4 &&
    features.averageManaValue <= 3.3 &&
    share(features.aggressiveKeywords) >= 0.18
  ) {
    return 'aggro';
  }

  return 'midrange';
}

function classifyTheme(features: ArchetypeFeatures): ArchetypeTheme | null {
  const tribe = features.topSubtype;
  if (tribe !== null && tribe.count >= TRIBAL_THRESHOLD) {
    const share = features.creatures === 0 ? 0 : tribe.count / features.creatures;
    const required = features.commanderSharesTopSubtype
      ? TRIBAL_SHARE
      : TRIBAL_SHARE_UNCORROBORATED;
    if (share >= required) return `${tribe.subtype.toLowerCase()} tribal`;
  }

  let best: { theme: string; score: number } | null = null;
  // Ties break by name for the same determinism reason as `topSubtype`.
  for (const [theme, score] of Object.entries(features.themeScores).sort((a, b) =>
    b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1],
  )) {
    best = { theme, score };
    break;
  }

  if (best === null || best.score < THEME_THRESHOLD) return null;
  return best.theme as ArchetypeTheme;
}

/**
 * Classify a resolved decklist. Always returns a tag — `defaultArchetypeTag()` remains the
 * caller's fallback only for decks that cannot be resolved at all.
 */
export function inferArchetype(input: ArchetypeInput): ArchetypeResult {
  const features = extractFeatures(input);
  const strategy = classifyStrategy(features);
  const theme = classifyTheme(features);
  const name = identityName(input.colorIdentity);
  return {
    tag: theme === null ? `${name} ${strategy}` : `${name} ${theme} ${strategy}`,
    strategy,
    theme,
    features,
  };
}
