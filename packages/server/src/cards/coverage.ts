/**
 * Real-deck model-coverage measurement.
 *
 * The engine halts loudly on any card it cannot model (brief §6.3), so model coverage is the
 * hard ceiling on which decks can be simulated at all. This module turns
 * `interpretCard(...).unmodeledReasons` — a pile of free-text strings — into a ranked backlog
 * of *mechanics*, which is the only form in which the data answers "what should we build next".
 *
 * Why classify at all: the dominant reason string is `unrecognized rules text: "<line>"`,
 * emitted once per unparsed line (`interpret.ts`). Generalizing it by masking the quoted text
 * collapses ~700 distinct reasons into one bucket that says only "the parser does not know most
 * cards". Bucketing by mechanic instead tells you that activated abilities alone block ~30% of
 * a real deck's cards.
 *
 * Why the families are NON-EXCLUSIVE: a card blocked by three mechanics is counted in all
 * three. Each family's count therefore answers "how many cards would implementing this one
 * mechanic unblock, at most" — an upper bound that is exactly what you want to rank work by.
 * The counts deliberately overlap and do not sum to the unmodeled total.
 */

import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';

export const MECHANIC_FAMILIES = [
  'activated ability (non-mana)',
  'token creation',
  'combat trigger',
  'draw/discard',
  'aura statics',
  'counter manipulation',
  'unimplemented keyword',
  'keyword with cost',
  'ability word prefix',
  'anthem / static buff',
  'targeted spell effect',
  'phase/step trigger',
  'ETB trigger (another permanent)',
  'targeted trigger',
  'choice-of-color mana',
  'conditional enters-tapped',
  'cost reduction',
  'cast trigger',
  'tutor',
  'graveyard recursion',
  'mass removal',
  'sacrifice outlet',
  'unsupported mana cost',
  'unsupported layout',
  'unsupported card type',
  'non-numeric characteristic',
  'other',
] as const;
export type MechanicFamily = (typeof MECHANIC_FAMILIES)[number];

export interface CardCoverage {
  oracleId: string;
  name: string;
  modeled: boolean;
  reasons: string[];
  /** Every family blocking this card, de-duplicated. Empty when modeled. */
  families: MechanicFamily[];
  /** Names of the input decks this card appeared in. */
  deckNames: string[];
}

export interface DeckCoverage {
  name: string;
  /** Unique cards in this deck (not counting quantities). */
  uniqueCards: number;
  modeled: number;
}

export interface CoverageReport {
  decks: DeckCoverage[];
  uniqueCards: number;
  modeledCards: number;
  /** Cards blocked per family, descending. Overlapping — see the module comment. */
  byFamily: { family: MechanicFamily; cards: number }[];
  /** Verbatim reason strings by frequency, descending. */
  topReasons: { reason: string; count: number }[];
  cards: CardCoverage[];
}

export interface DeckCards {
  name: string;
  cards: OracleCard[];
}

/**
 * The rules-text body of an `unrecognized rules text: "…"` reason, or null for any other
 * (structured) reason. `s` flag: a reason can span lines when the card's text does.
 */
const UNRECOGNIZED_RE = /^unrecognized rules text: "(.*)"$/s;

/**
 * Ordered, non-exclusive: EVERY matching family is recorded, not just the first.
 *
 * These patterns run against a lowercased rules line in which the card's own name has already
 * been replaced by `~` (the interpreter does that before it reports the line).
 */
const TEXT_FAMILIES: [MechanicFamily, RegExp][] = [
  // "{2}{B}, {T}: Draw a card" — a cost, then a colon. A plain `{T}: Add …` is subtracted
  // afterwards in `classifyReason`: it is a mana ability, which needs no cost machinery.
  ['activated ability (non-mana)', /^[^:\n]{1,60}:\s/],
  // "Cycling {2}", "Equip {1}", "Bestow {2}{W}{W}", "Crew 2" — a keyword parameterized by a
  // cost. Distinct from a bare unimplemented keyword because supporting it needs cost parsing.
  ['keyword with cost', /^[a-z][a-z' ]*(\{[^}]+\}|\d+)$/],
  // "Metalcraft — If you control three or more artifacts, …". An ability word (CR 207.2c) is
  // pure flavor, but the em dash blocks the whole line from parsing — a cheap win.
  ['ability word prefix', /^[a-z][a-z' -]*\s—\s/],
  ['token creation', /\bcreates?\b[^.]*\btokens?\b/],
  ['combat trigger', /\bwhenever\b[^.]*\b(attacks|blocks|deals combat damage)\b/],
  ['draw/discard', /\b(draws?|discards?|mills?)\b/],
  ['aura statics', /^(enchanted|enchant) /],
  [
    'counter manipulation',
    /\bproliferate\b|\bput\b[^.]*\bcounters?\b|\bcounters?\b[^.]*\bon\b/,
  ],
  // "Creatures you control get +1/+1", "Other Dragons you control have flying" — a static
  // buff whose subject or amount the anthem grammar cannot resolve.
  ['anthem / static buff', /\b(get|gets|have|has)\b[^.]*([+-]\d+\/[+-]\d+|\b(flying|haste|hexproof|trample|vigilance|lifelink|deathtouch|shroud|indestructible)\b)/],
  // "Destroy target artifact, enchantment, or planeswalker", "Tap target creature" — a
  // one-shot targeted effect whose verb or target phrase the sentence grammar misses.
  ['targeted spell effect', /\btarget\b/],
  ['phase/step trigger', /\bat the beginning of\b/],
  ['ETB trigger (another permanent)', /\bwhenever\b[^.]*\b(another|a|one or more)\b[^.]*\benters\b/],
  ['targeted trigger', /^when(ever)? ~ (enters|dies)\b[^.]*\btarget\b/],
  ['choice-of-color mana', /^\{t\}[^:]*: add\b[^.]*(\bor\b|one mana of any)/],
  ['conditional enters-tapped', /\benters\b[^.]*\btapped unless\b/],
  ['cost reduction', /\bcosts? \{[^}]*\} less to cast\b/],
  ['cast trigger', /\bwhenever\b[^.]*\byou cast\b/],
  ['tutor', /\bsearch your library\b/],
  ['graveyard recursion', /\bgraveyard\b/],
  ['mass removal', /^destroy all\b|^exile all\b/],
  ['sacrifice outlet', /\bsacrifices?\b/],
];

/** A tap-only mana ability — already a modeled shape, so not an "activated ability" problem. */
const PLAIN_MANA_ABILITY_RE = /^\{t\}: add /;

/** Structured (non-rules-text) reasons map straight to a family. */
const STRUCTURED_FAMILIES: [MechanicFamily, RegExp][] = [
  ['unsupported mana cost', /^unsupported mana cost symbols:/],
  ['unsupported layout', /^unsupported layout /],
  ['unsupported card type', /^unsupported card type /],
  ['non-numeric characteristic', /^non-numeric /],
];

/**
 * Every mechanic family implicated by one reason string. Non-exclusive: a line reading
 * "{T}, Sacrifice this creature: Create a 1/1 token" yields three families.
 */
export function classifyReason(reason: string): MechanicFamily[] {
  const structured = STRUCTURED_FAMILIES.filter(([, re]) => re.test(reason));
  if (structured.length > 0) return structured.map(([family]) => family);

  const match = UNRECOGNIZED_RE.exec(reason);
  if (match === null) return ['other'];
  const text = (match[1] ?? '').toLowerCase();

  const families = TEXT_FAMILIES.filter(([, re]) => re.test(text))
    .map(([family]) => family)
    .filter(
      (family) =>
        !(family === 'activated ability (non-mana)' && PLAIN_MANA_ABILITY_RE.test(text)),
    );
  if (families.length > 0) return families;

  // Only once nothing else matched: a line that is nothing but words is an unknown keyword.
  // This must come AFTER the family scan, not before — "Enchant creature" is a bare two-word
  // line and is the single most common reason in a real deck, but it is an aura problem, and
  // filing it as a keyword would mis-rank the backlog.
  if (/^[a-z][a-z' ]*(,\s*[a-z][a-z' ]*)*$/.test(text.trim())) {
    return ['unimplemented keyword'];
  }
  return ['other'];
}

/**
 * Measure coverage over a set of decks. Cards are de-duplicated by `oracleId` across the whole
 * input for the union figures, and per deck for the per-deck figures.
 *
 * Callers must union commanders and the companion into `cards` themselves — `ResolvedDeck`
 * keeps them outside `.cards`, and forgetting that silently leaves the commander unmeasured.
 */
export function measureCoverage(decks: DeckCards[]): CoverageReport {
  const byOracleId = new Map<string, CardCoverage>();
  const deckSummaries: DeckCoverage[] = [];

  for (const deck of decks) {
    const seenInDeck = new Set<string>();
    let deckModeled = 0;

    for (const card of deck.cards) {
      if (seenInDeck.has(card.oracleId)) continue;
      seenInDeck.add(card.oracleId);

      let entry = byOracleId.get(card.oracleId);
      if (entry === undefined) {
        const def = interpretCard(card);
        const families = def.modeled
          ? []
          : [...new Set(def.unmodeledReasons.flatMap(classifyReason))];
        entry = {
          oracleId: card.oracleId,
          name: card.name,
          modeled: def.modeled,
          reasons: def.unmodeledReasons,
          families,
          deckNames: [],
        };
        byOracleId.set(card.oracleId, entry);
      }
      entry.deckNames.push(deck.name);
      if (entry.modeled) deckModeled++;
    }

    deckSummaries.push({
      name: deck.name,
      uniqueCards: seenInDeck.size,
      modeled: deckModeled,
    });
  }

  const cards = [...byOracleId.values()];

  const familyCounts = new Map<MechanicFamily, number>();
  const reasonCounts = new Map<string, number>();
  for (const card of cards) {
    for (const family of card.families) {
      familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }
    for (const reason of card.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  return {
    decks: deckSummaries,
    uniqueCards: cards.length,
    modeledCards: cards.filter((c) => c.modeled).length,
    byFamily: [...familyCounts.entries()]
      .map(([family, count]) => ({ family, cards: count }))
      .sort((a, b) => b.cards - a.cards || a.family.localeCompare(b.family)),
    topReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    cards: cards.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
