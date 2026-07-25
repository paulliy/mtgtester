/**
 * Oracle-text interpreter (brief §6). Turns an `OracleCard` into a `CardDefinition` by
 * accounting for EVERY line of rules text against the mechanics the engine implements:
 * keyword lists, mana abilities, enters-tapped clauses, a registry of spell-effect
 * sentence patterns, and a registry of trigger patterns.
 *
 * Any line (or cost symbol, or P/T value) that cannot be accounted for marks the card
 * `modeled: false` with a specific reason. The engine will halt loudly when that card's
 * behavior is needed — a visible failure is more useful than a wrong game (brief §6.3),
 * and the reasons form the backlog of mechanics to implement next.
 */

import type { Color, OracleCard } from '@mtg/shared';
import { parseManaCost } from '../mana/cost';
import type { ManaUnit } from '../mana/cost';
import type { AbilityCost, ActivatedAbility, SearchDestination } from './ability';
import { IMPLEMENTED_KEYWORDS, SELF_SUBJECT } from './ability';
import type {
  Ability,
  Effect,
  KeywordAbility,
  TargetKind,
  TargetSpec,
  TriggerHead,
  TriggerSpec,
  TriggerSubject,
} from './ability';
import type { Condition } from './condition';
import { countPermanents } from './condition';
import { CREATURE_TYPE_BY_LOWER } from './creature-types';
import type { StaticEffect } from './continuous-types';
import type { Selector } from './selector';
import {
  NONBASIC_LANDS,
  OPPONENTS,
  OTHER,
  SELF,
  YOURS,
  allOf,
  anyOf,
  ofColor,
  not,
  ofSubtype,
  ofSupertype,
  ofType,
  powerAtLeast,
  withKeyword,
} from './selector';
import type { Value } from './value';
import { applyOverride } from './overrides';
import type { CardDefinition, ManaAbilitySpec } from './definition';

/** Allocates a target slot of the given kind and returns its index (ADR 0004). */
type SlotAllocator = (kind: TargetKind) => number;

/** Basic land subtypes → intrinsic mana ability (CR 305.6). */
const BASIC_LAND_MANA: Record<string, ManaUnit> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: ['C'],
};

const NUMBER_WORDS: Record<string, number> = {
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
};

function parseAmount(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

/** Strip reminder text (parenthesized), collapse whitespace. */
function stripReminderText(text: string): string {
  return text.replace(/\([^)]*\)/g, '').replace(/[ \t]+/g, ' ');
}

/**
 * Ability words (CR 207.2c): italic words before an em dash that have NO rules meaning — they
 * only tie a group of cards together thematically. Dropping the prefix lets the real ability
 * behind it parse.
 *
 * This is an explicit allowlist rather than a general "strip anything before an em dash",
 * because plenty of em-dash prefixes DO carry meaning — Saga chapter markers ("I —", "II —")
 * and the flavor-name headers on Vehicles among them. Stripping those would change behavior.
 */
const ABILITY_WORDS = [
  'adamant', 'addendum', 'alliance', 'battalion', 'bloodrush', 'celebration', 'channel',
  'chroma', 'cohort', 'constellation', 'converge', 'corrupted', 'coven', 'delirium',
  'descend', 'domain', 'eminence', 'enrage', 'fateful hour', 'ferocious', 'formidable',
  'grandeur', 'hellbent', 'heroic', 'imprint', 'inspired', 'join forces', 'kinship',
  'landfall', 'lieutenant', 'magecraft', 'metalcraft', 'morbid', 'pack tactics', 'parade',
  'paradox', 'raid', 'rally', 'revolt', 'secret council', 'spell mastery', 'strive',
  'sweep', 'tempting offer', 'threshold', 'undergrowth', 'valiant', 'will of the council',
];
const ABILITY_WORD_RE = new RegExp(`^(?:${ABILITY_WORDS.join('|')})\\s+—\\s+`, 'i');

/** Drop a leading ability word so the ability it labels can be parsed (CR 207.2c). */
function stripAbilityWord(line: string): string {
  return line.replace(ABILITY_WORD_RE, '');
}

/**
 * Modern self-reference templating: "This creature deals 2 damage to any target". Cards
 * printed (or errata'd) since ~2021 say "this <type>" instead of repeating the card name, so
 * without this every `^~ …` pattern misses them — thousands of oracle lines.
 *
 * Case-sensitive on the capital `This`, which is how the templating always renders it; a
 * lowercase "this creature" is a mid-sentence back-reference to some *other* object
 * ("exile target creature, then return this creature") and must not be rewritten.
 *
 * "this card" and "this spell" are deliberately excluded: they refer to the object in a zone
 * where it is not a permanent, which `~` (a battlefield self-reference) would misrepresent.
 */
const SELF_REFERENCE_RE =
  /\bThis (?:creature|artifact|enchantment|land|permanent|token|Vehicle|Equipment|Saga|planeswalker)\b/g;

/**
 * Replace the card's own name — and the short name its rules text actually uses — with `~`.
 *
 * Legendary cards are referred to by a short form: "Ryusei, the Falling Star" writes "Ryusei",
 * and "Ureni of the Unwritten" writes "Ureni". Both are the text before the first comma or the
 * first " of ". The short form is matched on word boundaries so a name that happens to be a
 * common word cannot rewrite unrelated text.
 */
function substituteSelfName(text: string, name: string): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(escape(name), 'g'), '~');
  for (const separator of [',', ' of ']) {
    const at = name.indexOf(separator);
    if (at <= 0) continue;
    const short = name.slice(0, at);
    out = out.replace(new RegExp(`\\b${escape(short)}\\b`, 'g'), '~');
  }
  return out.replace(SELF_REFERENCE_RE, '~');
}

/** Split a line into sentences, dropping the terminal period of each. */
function splitSentences(line: string): string[] {
  return line
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 0);
}

const KEYWORD_SET = new Set<string>(IMPLEMENTED_KEYWORDS);

/** "flying and vigilance" / "flying, first strike" → keywords, or null if any is unimplemented. */
function parseKeywordList(text: string): KeywordAbility[] | null {
  const parts = text
    .split(/,| and /)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0 || parts.some((p) => !KEYWORD_SET.has(p))) return null;
  return parts as KeywordAbility[];
}

/** Color adjectives a subject can carry ("Black creatures get +1/+1" — Bad Moon). */
const COLOR_WORDS: Record<string, Color> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
};

/** Plural card types that can head a subject noun phrase. */
const CARD_TYPE_PLURALS: Record<string, string> = {
  creatures: 'Creature',
  artifacts: 'Artifact',
  enchantments: 'Enchantment',
  lands: 'Land',
  planeswalkers: 'Planeswalker',
};

/** English plural forms a creature type could be written as: "Elf" → …/elfs/elves. */
function pluralForms(word: string): string[] {
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
 * Two vocabularies, in order. The card's OWN subtypes come first, so a non-creature subtype the
 * card actually has ("Equipment", "Aura", a land type) still resolves. Then CR 205.3m's closed
 * creature-type list, which is what lets a card refer to a tribe it is not a member of —
 * Dragon's Hoard is an Artifact that watches Dragons.
 *
 * Anything in neither list returns null and leaves the card unmodeled, which halts loudly.
 * Guessing a singular from a plural would silently produce a selector matching nothing.
 */
function resolveSubtype(word: string, card: OracleCard): string | null {
  const own = card.subtypes.find((s) => pluralForms(s).includes(word));
  if (own !== undefined) return own;
  const lower = word.toLowerCase();
  for (const [key, type] of CREATURE_TYPE_BY_LOWER) {
    if (pluralForms(key).includes(lower)) return type;
  }
  return null;
}

/**
 * Parse the subject of an anthem — "other Elves you control", "creatures your opponents
 * control" — into a `Selector`. Returns null when any part is unrecognized.
 */
function parseSubject(phrase: string, card: OracleCard): Selector | null {
  const parts: Selector[] = [];
  let noun = phrase;

  if (noun.startsWith('other ')) {
    parts.push(OTHER);
    noun = noun.slice('other '.length);
  }
  for (const [suffix, who] of [
    [' you control', YOURS],
    [' your opponents control', OPPONENTS],
  ] as const) {
    if (noun.endsWith(suffix)) {
      parts.push(who);
      noun = noun.slice(0, -suffix.length);
      break;
    }
  }

  const colorMatch = noun.match(/^(white|blue|black|red|green) (.+)$/);
  if (colorMatch !== null) {
    parts.push(ofColor(COLOR_WORDS[colorMatch[1] as string] as Color));
    noun = colorMatch[2] as string;
  }

  const bareType = CARD_TYPE_PLURALS[noun];
  if (bareType !== undefined) {
    parts.push(ofType(bareType));
  } else if (noun !== 'permanents') {
    // Either a bare tribe ("elves") or a tribe plus a card type ("elf creatures").
    const m = noun.match(/^(.+) (creatures|artifacts|enchantments|lands|planeswalkers)$/);
    const subtype = resolveSubtype(m?.[1] ?? noun, card);
    if (subtype === null) return null;
    parts.push(ofSubtype(subtype));
    if (m !== null) parts.push(ofType(CARD_TYPE_PLURALS[m[2] as string] as string));
  }

  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as Selector) : allOf(...parts);
}

/**
 * "<subject> get +X/+X [and have <keywords>]" / "<subject> have <keywords>" — the anthem and
 * lord shape. The same grammar with "gain" instead of "have" and a trailing "until end of
 * turn" is the spell form (Overrun); see `MASS_UNTIL_EOT_RE`.
 */
const ANTHEM_RE = /^(.+?) (?:get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?|have (.+))$/;

/** The spell form of `ANTHEM_RE` — "Creatures you control get +3/+3 … until end of turn". */
const MASS_UNTIL_EOT_RE =
  /^(.+?) (?:get ([+-]\d+)\/([+-]\d+)(?: and gain (.+?))?|gain (.+?)) until end of turn$/;

/**
 * Parse one sentence into effect primitives (ADR 0004). Returns null when unrecognized.
 * Targeted primitives allocate a slot via `alloc` and reference it by index. Sentences are
 * matched lowercased with `~` substituted for the card's name.
 *
 * `opts.triggerObject` enables the bare "it", which is only meaningful inside a trigger whose
 * subject is some object other than the source. Off by default so a spell's mid-sentence "it"
 * — a back-reference to something this grammar has not tracked — can never be misread as the
 * trigger referent.
 */
function parseEffectSentence(
  sentence: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: { triggerObject?: boolean } = {},
): Effect[] | null {
  const s = sentence.toLowerCase();

  // "it gains double strike until end of turn" — the trigger's subject (Atarka, World Render).
  if (opts.triggerObject === true) {
    const m = s.match(/^it gains ([a-z ]+) until end of turn$/);
    if (m) {
      if (!KEYWORD_SET.has(m[1] as string)) return null;
      return [
        { op: 'grantKeywordUntilEot', target: 'triggerObject', keyword: m[1] as KeywordAbility },
      ];
    }
  }

  // "target creature gets +3/+3 until end of turn"
  // "target creature gets +2/+2 and gains flying until end of turn"
  {
    const m = s.match(
      /^target creature gets ([+-]\d+)\/([+-]\d+)(?: and gains ([a-z ]+))? until end of turn$/,
    );
    if (m) {
      const effects: Effect[] = [
        {
          op: 'pumpUntilEot',
          target: alloc('creature'),
          power: Number(m[1]),
          toughness: Number(m[2]),
        },
      ];
      if (m[3] !== undefined) {
        if (!KEYWORD_SET.has(m[3])) return null;
        effects.push({
          op: 'grantKeywordUntilEot',
          target: alloc('creature'),
          keyword: m[3] as KeywordAbility,
        });
      }
      return effects;
    }
  }
  // "target creature gains flying until end of turn"
  {
    const m = s.match(/^target creature gains ([a-z ]+) until end of turn$/);
    if (m) {
      if (!KEYWORD_SET.has(m[1] as string)) return null;
      return [
        { op: 'grantKeywordUntilEot', target: alloc('creature'), keyword: m[1] as KeywordAbility },
      ];
    }
  }
  // "Creatures you control get +3/+3 and gain trample until end of turn" (Overrun). Untargeted:
  // the subject is a selector, evaluated once at resolution (CR 611.2c).
  {
    const m = s.match(MASS_UNTIL_EOT_RE);
    if (m) {
      const selector = parseSubject(m[1] as string, card);
      if (selector === null) return null;
      const effects: Effect[] = [];
      if (m[2] !== undefined) {
        effects.push({
          op: 'pumpEachUntilEot',
          selector,
          power: Number(m[2]),
          toughness: Number(m[3]),
        });
      }
      const keywordText = m[4] ?? m[5];
      if (keywordText !== undefined) {
        const keywords = parseKeywordList(keywordText);
        if (keywords === null) return null;
        for (const keyword of keywords) {
          effects.push({ op: 'grantKeywordEachUntilEot', selector, keyword });
        }
      }
      if (effects.length > 0) return effects;
    }
  }
  // "~ deals 3 damage to any target" / "… to target creature" / "… to each opponent"
  {
    const m = s.match(/^~ deals (\w+) damage to (any target|target creature|each opponent)$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      if (m[2] === 'any target') return [{ op: 'dealDamage', target: alloc('anyTarget'), amount }];
      if (m[2] === 'target creature')
        return [{ op: 'dealDamage', target: alloc('creature'), amount }];
      return [{ op: 'eachOpponentDamage', amount }];
    }
  }
  if (s === 'counter target spell') return [{ op: 'counter', target: alloc('spell') }];
  // "destroy target creature" / "exile target artifact or enchantment" / …
  {
    const m = s.match(/^(destroy|exile) target (.+)$/);
    if (m) {
      const kind = parseTargetNoun(m[2] as string);
      if (kind === null) return null;
      return [{ op: m[1] === 'destroy' ? 'destroy' : 'exile', target: alloc(kind) }];
    }
  }
  // "put a +1/+1 counter on target creature" / "put two -1/-1 counters on ~"
  {
    const m = s.match(/^put (\w+) ([+-]\d+\/[+-]\d+) counters? on (target creature|~)$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      const counter = m[2] as string;
      return m[3] === '~'
        ? [{ op: 'putCountersEach', selector: SELF, counter, count }]
        : [{ op: 'putCounters', target: alloc('creature'), counter, count }];
    }
  }
  // "put a gold counter on this artifact" — a named counter on the ability's own source. Not a
  // target: the one-element `Selector` case, which `putCountersEach` already covers.
  {
    const m = s.match(/^put (\w+) (\w+) counters? on (.+)$/);
    if (m !== null && SELF_OBJECT_RE.test(m[3] as string)) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ op: 'putCountersEach', selector: SELF, counter: m[2] as string, count }];
    }
  }
  // "put a +1/+1 counter on each creature you control"
  {
    const m = s.match(/^put (\w+) ([+-]\d+\/[+-]\d+) counters? on each (.+)$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      const selector = parseSubject(m[3] as string, card);
      if (count === null || selector === null) return null;
      return [{ op: 'putCountersEach', selector, counter: m[2] as string, count }];
    }
  }
  // "draw a card" / "draw two cards" / "you draw a card"
  {
    const m = s.match(/^(?:you )?draw (\w+) cards?$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ op: 'draw', count }];
    }
  }
  // "you gain 3 life"
  {
    const m = s.match(/^you gain (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ op: 'gainLife', amount }];
    }
  }
  // "each opponent loses 1 life"
  {
    const m = s.match(/^each opponent loses (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ op: 'eachOpponentLosesLife', amount }];
    }
  }
  // "~ deals 5 damage to each creature without flying" (Ryusei) / "it deals 3 damage to …"
  // (Thunder Dragon — "it" is the source, both cards' triggers being self-subjected).
  {
    const m = s.match(/^(?:~|it) deals (\w+) damage to each (.+)$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      const selector = parseMassSubject(m[2] as string, card);
      if (amount === null || selector === null) return null;
      return [{ op: 'damageEach', selector, amount }];
    }
  }
  // "search your library for a Forest card, put it onto the battlefield, then shuffle"
  {
    const parsed = parseSearchSentence(s, card);
    if (parsed !== null) return parsed;
  }
  // "scry 1"
  {
    const m = s.match(/^scry (\w+)$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ op: 'scry', count }];
    }
  }
  return null;
}

/**
 * "Look at the top eight cards of your library. You may put a Dragon creature card from among
 * them onto the battlefield. Put the rest on the bottom of your library in a random order."
 *
 * Matched as a whole THREE-sentence block rather than sentence by sentence: the later sentences
 * refer to "them" and "the rest", which only mean anything relative to the first. Parsing them
 * independently would need the IR to carry a revealed set between ops, which it does not.
 */
function parseLookAtTopBlock(lower: string, card: OracleCard): Effect[] | null {
  const m = lower.replace(/\.$/, '').match(
    /^look at the top (\w+) cards of your library\. you may put (?:a|an) (.+?) from among them (onto the battlefield( tapped)?|into your hand)\. put the rest on the bottom of your library in a random order$/,
  );
  if (m === null) return null;

  const count = parseAmount(m[1] as string);
  if (count === null) return null;
  const filter = parseSearchFilter(m[2] as string, card);
  if (filter === null) return null;
  const where = m[3] as string;
  const destination: SearchDestination = where.startsWith('onto the battlefield')
    ? m[4] === undefined
      ? { zone: 'battlefield' }
      : { zone: 'battlefield', tapped: true }
    : { zone: 'hand' };

  return [{ op: 'lookAtTopN', count, mayPut: { filter, destination }, rest: 'bottomRandom' }];
}

/**
 * The subject of a mass effect — "each creature without flying", "each Dragon you control".
 * Plural `parseSubject` with a singular head, plus the keyword clause only mass effects use.
 */
function parseMassSubject(phrase: string, card: OracleCard): Selector | null {
  let noun = phrase;
  const parts: Selector[] = [];

  // "…without flying" / "…with flying". Event-only (see `cards/selector.ts`): safe here because
  // a resolving spell reads keywords once, after the layer pass has produced them.
  const keywordClause = noun.match(/^(.+) with(out)? ([a-z ]+)$/);
  if (keywordClause !== null) {
    const keyword = keywordClause[3] as string;
    if (!KEYWORD_SET.has(keyword)) return null;
    const leaf = withKeyword(keyword);
    parts.push(keywordClause[2] === undefined ? leaf : not(leaf));
    noun = keywordClause[1] as string;
  }

  const subject = parseTriggerSubject(noun, card);
  if (subject === null) return null;
  parts.push(subject);
  return parts.length === 1 ? (parts[0] as Selector) : allOf(...parts);
}

/**
 * "Search your library for <what>, put <them> <where>, then shuffle" (CR 701.19) — the
 * basic-land tutor template, which recurs on four cards in the coverage fixtures.
 *
 * Returns the search AND the shuffle: they are printed as one sentence, and a search whose
 * shuffle got lost would leave the searcher's library ordered by what they looked at.
 */
function parseSearchSentence(s: string, card: OracleCard): Effect[] | null {
  const m = s.match(/^search your library for (.+?), (?:reveal .+?, )?(put .+?), then shuffle$/);
  if (m === null) return null;

  const filter = parseSearchFilter(m[1] as string, card);
  if (filter === null) return null;
  const destinations = parseSearchDestinations(m[2] as string);
  if (destinations === null) return null;
  return [{ op: 'searchLibrary', filter, destinations }, { op: 'shuffle' }];
}

/** "a Plains, Island, Swamp, or Mountain card" / "up to two basic land cards" → a `Selector`. */
function parseSearchFilter(phrase: string, card: OracleCard): Selector | null {
  const noun = phrase.replace(/^(?:up to \w+|a|an) /, '').replace(/ cards?$/, '');

  // "basic land" — a supertype plus a type, not a subtype.
  if (noun === 'basic land') return allOf(ofSupertype('Basic'), ofType('Land'));

  // "Plains, Island, Swamp, or Mountain" — a list of land subtypes, any of which qualifies.
  const alternatives = noun.split(/,? or |, /).map((n) => n.trim());
  const selectors: Selector[] = [];
  for (const alternative of alternatives) {
    const subtype = LAND_SUBTYPES.find((t) => t.toLowerCase() === alternative);
    if (subtype !== undefined) {
      selectors.push(ofSubtype(subtype));
      continue;
    }
    const parsed = parseTriggerSubject(alternative, card);
    if (parsed === null) return null;
    selectors.push(parsed);
  }
  if (selectors.length === 0) return null;
  return selectors.length === 1 ? (selectors[0] as Selector) : anyOf(...selectors);
}

/**
 * "put it onto the battlefield tapped" / "put one onto the battlefield tapped and the other
 * into your hand" → one destination per card the search may find, in the order the player is
 * asked about them.
 */
function parseSearchDestinations(phrase: string): SearchDestination[] | null {
  const out: SearchDestination[] = [];
  for (const clause of phrase.split(' and ')) {
    const m = clause.match(
      /^(?:put )?(?:it|that card|them|those cards|one|the other) (onto the battlefield( tapped)?|into your hand|into your graveyard)$/,
    );
    if (m === null) return null;
    const where = m[1] as string;
    if (where.startsWith('onto the battlefield')) {
      out.push(m[2] === undefined ? { zone: 'battlefield' } : { zone: 'battlefield', tapped: true });
    } else if (where === 'into your hand') {
      out.push({ zone: 'hand' });
    } else {
      out.push({ zone: 'graveyard' });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * "When ~ enters" / "Whenever a Dragon you control attacks" — one shape covering both, because
 * they are the same event seen from two vantage points (see `TriggerSubject`).
 */
const OBJECT_TRIGGER_HEAD_RE =
  /^when(?:ever)? (.+?) (enters(?: the battlefield)?(?: or attacks)?|dies|attacks), (.*)$/;
const UPKEEP_TRIGGER_HEAD_RE = /^at the beginning of (your|each(?: player's)?) upkeep, (.*)$/;
/** The intervening-if clause (CR 603.4): "…, if you control a Dragon, draw a card". */
const INTERVENING_IF_RE = /^if (.+?), (.+)$/;

/**
 * Self-reference in a trigger head. `~` is the substituted card name; the "this <type>" forms
 * appear here in LOWERCASE ("When this enchantment enters"), so `SELF_REFERENCE_RE` — which is
 * deliberately case-sensitive, to leave mid-sentence back-references alone — does not catch
 * them. In a trigger head the ambiguity it guards against cannot arise: nothing precedes the
 * subject for "this" to refer back to.
 */
const SELF_TRIGGER_SUBJECT_RE =
  /^(?:~|this (?:creature|artifact|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker))$/;

/** Singular card types that can head a trigger subject ("a creature you control"). */
const CARD_TYPE_SINGULARS: Record<string, string> = {
  creature: 'Creature',
  artifact: 'Artifact',
  enchantment: 'Enchantment',
  land: 'Land',
  planeswalker: 'Planeswalker',
};

/**
 * The subject of an object trigger — "a Dragon you control", "another creature you control
 * with power 4 or greater" — as a `Selector`. The singular counterpart to `parseSubject`,
 * which reads the plural noun phrases anthems use.
 *
 * Returns null for anything unrecognized, leaving the card unmodeled: a trigger with a subject
 * that silently matches nothing would never fire, which is a misplay every game.
 */
function parseTriggerSubject(phrase: string, card: OracleCard): Selector | null {
  const parts: Selector[] = [];
  let noun = phrase;

  if (noun.startsWith('another ')) {
    parts.push(OTHER);
    noun = noun.slice('another '.length);
  } else {
    noun = noun.replace(/^an? /, '');
  }

  // "…with power 4 or greater" is the outermost clause, so it comes off before the control
  // suffix it wraps. Event-only — see `powerAtLeast` in `cards/selector.ts`.
  const powerMatch = noun.match(/^(.+) with power (\d+) or greater$/);
  if (powerMatch !== null) {
    parts.push(powerAtLeast(Number(powerMatch[2])));
    noun = powerMatch[1] as string;
  }

  for (const [suffix, who] of [
    [' you control', YOURS],
    [' an opponent controls', OPPONENTS],
    [' your opponents control', OPPONENTS],
  ] as const) {
    if (noun.endsWith(suffix)) {
      parts.push(who);
      noun = noun.slice(0, -suffix.length);
      break;
    }
  }

  const bareType = CARD_TYPE_SINGULARS[noun];
  if (bareType !== undefined) {
    parts.push(ofType(bareType));
  } else if (noun !== 'permanent') {
    // Either a bare tribe ("a Dragon") or a tribe plus a card type ("a Dragon creature").
    const m = noun.match(/^(.+) (creature|artifact|enchantment|land|planeswalker)$/);
    const subtype = resolveSubtype(m?.[1] ?? noun, card);
    if (subtype === null) return null;
    parts.push(ofSubtype(subtype));
    if (m !== null) parts.push(ofType(CARD_TYPE_SINGULARS[m[2] as string] as string));
  }

  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as Selector) : allOf(...parts);
}

/**
 * A condition clause as rules text writes it — "you control a creature with power 4 or
 * greater". Reuses `parseTriggerSubject`, so anything expressible as a trigger subject is
 * automatically countable here too.
 */
function parseConditionClause(clause: string, card: OracleCard): Condition | null {
  const m = clause.match(/^you control (.+)$/);
  if (m === null) return null;
  const selector = parseTriggerSubject(m[1] as string, card);
  if (selector === null) return null;
  return countPermanents(selector, 'you', '>=', 1);
}

/**
 * Parse a full line as one or more triggered abilities. Returns null when unrecognized.
 *
 * A list, not a single ability, because one printed line can be two triggers: "Whenever Ureni
 * enters **or attacks**" is two separate triggered abilities with the same effect (CR 603.1),
 * and modeling it as one would make it fire once when it should fire twice.
 */
function parseTriggerLine(line: string, card: OracleCard): Ability[] | null {
  const lower = line.toLowerCase();

  // The head decides the event; the rest of the line is the effect (after an optional
  // intervening-if and an optional "you may").
  let heads: TriggerHead[];
  let body: string;
  const upkeep = lower.match(UPKEEP_TRIGGER_HEAD_RE);
  if (upkeep !== null) {
    heads = [{ when: 'upkeep', player: upkeep[1] === 'your' ? 'you' : 'each' }];
    body = upkeep[2] as string;
  } else {
    const m = lower.match(OBJECT_TRIGGER_HEAD_RE);
    if (m === null) return null;
    const subjectPhrase = m[1] as string;
    const event = m[2] as string;
    const events: ('enters' | 'dies' | 'attacks')[] = event.startsWith('enters')
      ? event.endsWith('or attacks')
        ? ['enters', 'attacks']
        : ['enters']
      : event === 'dies'
        ? ['dies']
        : ['attacks'];
    body = m[3] as string;

    let subject: TriggerSubject;
    if (SELF_TRIGGER_SUBJECT_RE.test(subjectPhrase)) {
      subject = SELF_SUBJECT;
    } else {
      const selector = parseTriggerSubject(subjectPhrase, card);
      if (selector === null) return null;
      subject = { kind: 'permanent', selector };
    }
    heads = events.map((when) => ({ when, subject }));
  }

  // Intervening-if (CR 603.4) sits between the head and the effect.
  let condition: Condition | undefined;
  const iff = body.match(INTERVENING_IF_RE);
  if (iff !== null) {
    const parsed = parseConditionClause(iff[1] as string, card);
    if (parsed === null) return null;
    condition = parsed;
    body = iff[2] as string;
  }
  const optional = body.startsWith('you may ');
  if (optional) body = body.slice('you may '.length);

  // A trigger may declare targets: its controller chooses them as the ability goes on the
  // stack (CR 603.3d), which `placePendingTriggers` surfaces as a decision.
  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind) => {
    targets.push({ kind });
    return targets.length - 1;
  };

  // "it" is only meaningful when the trigger watches an object other than its own source.
  const firstHead = heads[0] as TriggerHead;
  const opts = {
    triggerObject: firstHead.when !== 'upkeep' && firstHead.subject.kind === 'permanent',
  };

  // A whole-body pattern first: some effects span several sentences that only mean anything
  // together ("look at the top eight … put the rest …").
  let effects = parseLookAtTopBlock(body, card);
  if (effects === null) {
    effects = [];
    for (const sentence of splitSentences(body)) {
      const parsed = parseEffectSentence(sentence, alloc, card, opts);
      if (parsed === null) return null;
      effects.push(...parsed);
    }
  }
  if (effects.length === 0) return null;

  return heads.map((head) => ({
    kind: 'triggered' as const,
    trigger: { ...head, ...(condition !== undefined ? { condition } : {}) } as TriggerSpec,
    optional,
    targets,
    effects,
    description: line,
  }));
}

/**
 * The noun phrase after "target" → a `TargetKind`. Returns null for anything unlisted so the
 * card stays unmodeled rather than being silently retargeted at the wrong thing.
 */
const TARGET_NOUNS: Record<string, TargetKind> = {
  creature: 'creature',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  permanent: 'permanent',
  'nonland permanent': 'nonlandPermanent',
  'artifact or enchantment': 'artifactOrEnchantment',
  player: 'player',
  opponent: 'player',
};

function parseTargetNoun(noun: string): TargetKind | null {
  return TARGET_NOUNS[noun.trim()] ?? null;
}

/**
 * As-enters tapped-ness (CR 614.1c). Two printed templates, one meaning: the permanent enters
 * tapped exactly when the condition is false.
 *
 *   "~ enters tapped unless you control two or more other lands."   (check/fast/slow lands)
 *   "As this land enters, you may pay 2 life. If you don't, it enters tapped."  (shocklands)
 *
 * Modeled as a replacement rather than a trigger deliberately: as a trigger the land would
 * enter untapped and be tapped afterwards, which is both wrong and observably different (it
 * could be tapped for mana in response).
 */
const ENTERS_TAPPED_UNLESS_RE =
  /^(?:~|this land) enters (?:the battlefield )?tapped unless (.+)$/;
const ENTERS_PAY_LIFE_RE =
  /^as (?:~|this land) enters, you may pay (\d+) life\. if you don't, it enters tapped$/;

/**
 * The "unless …" clause of a conditional-enters-tapped land → a `Condition`. Returns null for
 * anything unlisted, leaving the card unmodeled rather than guessing a predicate — a land that
 * silently entered untapped would be a real (if small) misplay every game.
 */
function parseEntersUnlessClause(clause: string, card: OracleCard): Condition | null {
  // "you have two or more opponents"
  {
    const m = clause.match(/^you have (\w+) or (more|fewer) opponents$/);
    if (m) {
      const n = parseAmount(m[1] as string);
      if (n === null) return null;
      return { kind: 'opponentCount', cmp: m[2] === 'more' ? '>=' : '<=', n };
    }
  }
  // "you control a Mountain or a Forest" — a subtype list, any of which satisfies it.
  {
    const m = clause.match(/^you control (a|an) (.+)$/);
    if (m) {
      const nouns = (m[2] as string).split(/,? or (?:a |an )?/).map((s) => s.trim());
      const selectors: Selector[] = [];
      for (const noun of nouns) {
        // Printed capitalized on the card ("a Mountain"), but `clause` is lowercased; match
        // against the land subtypes this card itself can check for.
        const subtype = LAND_SUBTYPES.find((s) => s.toLowerCase() === noun);
        if (subtype === undefined) return null;
        selectors.push(ofSubtype(subtype));
      }
      if (selectors.length === 0) return null;
      return countPermanents(
        selectors.length === 1 ? (selectors[0] as Selector) : anyOf(...selectors),
        'you',
        '>=',
        1,
      );
    }
  }
  // "you control two or more other lands" / "… two or fewer other lands"
  // "you control two or more basic lands"
  // "your opponents control eight or more lands"
  {
    const m = clause.match(
      /^(you|your opponents) controls? (\w+) or (more|fewer) (other |basic )?lands$/,
    );
    if (m) {
      const n = parseAmount(m[2] as string);
      if (n === null) return null;
      const parts: Selector[] = [ofType('Land')];
      if ((m[4] ?? '').trim() === 'other') parts.push(OTHER);
      if ((m[4] ?? '').trim() === 'basic') parts.push(ofSupertype('Basic'));
      return countPermanents(
        parts.length === 1 ? (parts[0] as Selector) : allOf(...parts),
        m[1] === 'you' ? 'you' : 'opponents',
        m[3] === 'more' ? '>=' : '<=',
        n,
      );
    }
  }
  void card;
  return null;
}

/** Basic land types (CR 305.6) — the vocabulary a checkland's "unless you control a …" uses. */
const LAND_SUBTYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];

/**
 * How a card refers to itself mid-sentence. `~` is the substituted card name; the lowercase
 * "this <type>" forms survive `substituteSelfName` (which is case-sensitive by design — see
 * `SELF_REFERENCE_RE`) and are accepted only in positions where nothing else can be meant.
 */
const SELF_OBJECT_RE =
  /^(?:~|this (?:artifact|creature|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker))$/;

const MANA_ABILITY_RE = /^add ((?:\{[wubrgc]\})+)$/;
/** "Add {G} or {W}." / "Add {W}, {U}, or {B}." — ONE unit, several symbol choices. */
const MANA_CHOICE_RE = /^add (\{[wubrgc]\}(?:,? (?:or )?\{[wubrgc]\})+)$/;
/** "Add one mana of any color." — one unit, any of the five colors. */
const MANA_ANY_COLOR_RE = /^add one mana of any color$/;
const ALL_COLORS: ManaUnit = ['W', 'U', 'B', 'R', 'G'];

/**
 * Mana whose symbol set is not printed but read off the board. The symbols are derived at
 * query time (`manaSourcesFor`), because the answer changes as the board does.
 */
const MANA_COMMANDER_IDENTITY_RE = /^add one mana of any color in your commander's color identity$/;
const MANA_OPPONENT_LANDS_RE =
  /^add one mana of any color that a land an opponent controls could produce$/;

/**
 * A painland: "{T}: Add {R} or {W}. This land deals 1 damage to you." The damage is a rider on
 * the mana ability, not a separate ability — mana abilities never use the stack (CR 605.3a), so
 * it applies the moment the mana is produced.
 */
const MANA_WITH_SELF_DAMAGE_RE =
  /^add (\{[wubrgc]\}(?:,? (?:or )?\{[wubrgc]\})*)\. ~ deals (\d+) damage to you$/;

/** "Add one mana of any color. Activate only if you control a Dragon." (Mox Jasper) */
const MANA_ACTIVATE_ONLY_IF_RE = /^(add [^.]+)\. activate only if you control (?:a|an) (.+)$/;

/**
 * Mana production this parser deliberately refuses, with a distinct reason so the coverage
 * report can rank it. Each of these looks cheap to support and would silently produce mana the
 * player cannot legally spend — over-permissive modeling is worse than none (brief §6.3).
 */
const UNSUPPORTED_MANA_RE =
  /^add (two|three|\w+) mana|^add one mana of any (?!color$)|spend this mana only/;

/**
 * Split "`<costs>`: `<effect>`" at the FIRST colon. Returns null for a line that is not an
 * activated ability at all.
 */
function splitActivation(lower: string): { costText: string; effectText: string } | null {
  const i = lower.indexOf(': ');
  if (i <= 0) return null;
  return { costText: lower.slice(0, i), effectText: lower.slice(i + 2) };
}

/**
 * The cost segment of an activated ability — "{1}, {T}, Sacrifice this creature" — as a list of
 * `AbilityCost`s. Returns null if ANY component is unrecognized: a cost the engine cannot charge
 * is worse than an ability it cannot use, because the ability would then be free.
 */
function parseActivationCosts(costText: string): AbilityCost[] | null {
  const costs: AbilityCost[] = [];
  for (const raw of costText.split(',')) {
    const part = raw.trim();
    if (part === '{t}') {
      costs.push({ kind: 'tap' });
      continue;
    }
    const sacrifice = part.match(/^sacrifice (.+)$/);
    if (sacrifice !== null) {
      // Only "sacrifice THIS": sacrificing something else is a choice, and a cost that asks a
      // question needs machinery this increment does not have.
      if (!SELF_OBJECT_RE.test(sacrifice[1] as string)) return null;
      costs.push({ kind: 'sacrificeSelf' });
      continue;
    }
    const counters = part.match(/^remove (\w+) (\w+) counters? from (.+)$/);
    if (counters !== null) {
      if (!SELF_OBJECT_RE.test(counters[3] as string)) return null;
      const count = parseAmount(counters[1] as string);
      if (count === null) return null;
      costs.push({ kind: 'removeCounters', counter: counters[2] as string, count });
      continue;
    }
    if (/^(?:\{[^}]+\})+$/.test(part)) {
      const parsed = parseManaCost(part.toUpperCase() as never);
      if (parsed.cost === null) return null;
      costs.push({ kind: 'mana', cost: parsed.cost });
      continue;
    }
    return null;
  }
  return costs.length > 0 ? costs : null;
}

/** Symbols inside a mana clause, uppercased: "{g} or {w}" → ['G','W']. */
function manaSymbols(clause: string): ManaUnit {
  return [...clause.matchAll(/\{([wubrgc])\}/g)].map(
    (m) => (m[1] as string).toUpperCase() as ManaUnit[number],
  );
}

/**
 * Parse the production half of a mana ability — everything after the colon. Recursive, so a
 * wrapper clause ("Activate only if …") can decorate whatever base production follows it rather
 * than every base pattern needing its own wrapped variant.
 */
function parseManaProduction(effectText: string, card: OracleCard): ManaAbilitySpec | null {
  // "… Activate only if you control a Dragon." — a restriction on an otherwise normal ability.
  {
    const m = effectText.match(MANA_ACTIVATE_ONLY_IF_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      if (base === null) return null;
      const subtype = resolveSubtype(m[2] as string, card) ?? titleCase(m[2] as string);
      return { ...base, condition: countPermanents(ofSubtype(subtype), 'you', '>=', 1) };
    }
  }
  // "Add {G}{W}" is TWO units (two mana); "Add {G} or {W}" is ONE unit with two symbol choices
  // (one mana, player picks) — the distinction the payment solver's per-unit backtracking
  // already understands.
  {
    const m = effectText.match(MANA_ABILITY_RE);
    if (m) return { units: manaSymbols(m[1] as string).map((sym) => [sym]) };
  }
  {
    const m = effectText.match(MANA_CHOICE_RE);
    if (m) return { units: [manaSymbols(m[1] as string)] };
  }
  if (MANA_ANY_COLOR_RE.test(effectText)) return { units: [ALL_COLORS] };
  if (MANA_COMMANDER_IDENTITY_RE.test(effectText)) {
    return { units: [], dynamic: 'commanderIdentity' };
  }
  if (MANA_OPPONENT_LANDS_RE.test(effectText)) return { units: [], dynamic: 'opponentLandColors' };
  // A painland: the self-damage rider applies as the mana is produced.
  {
    const m = effectText.match(MANA_WITH_SELF_DAMAGE_RE);
    if (m) {
      return {
        units: [manaSymbols(m[1] as string)],
        onActivate: [{ op: 'damageController', amount: Number(m[2]) }],
      };
    }
  }
  return null;
}

/**
 * Parse one whole line as a mana ability — cost and production. Returns null if it is not one.
 *
 * A mana ability whose cost includes mana is refused outright: paying mana to make mana would
 * make `planPayment` recursive, and the card is better left unmodeled (halting loudly) than
 * offered with a cost the payment solver would ignore.
 */
function parseManaAbilityLine(lower: string, card: OracleCard): ManaAbilitySpec | null {
  const split = splitActivation(lower);
  if (split === null) return null;
  const costs = parseActivationCosts(split.costText);
  if (costs === null || costs.some((c) => c.kind === 'mana')) return null;
  const production = parseManaProduction(split.effectText, card);
  if (production === null) return null;
  // Omit the default so every land and mana rock's spec stays byte-identical to before.
  const tapOnly = costs.length === 1 && costs[0]?.kind === 'tap';
  return tapOnly ? production : { ...production, costs };
}

/**
 * Parse one line as an activated ability that uses the stack (CR 602). Returns null when the
 * costs or the effect are not fully readable — a partially-understood activated ability would
 * be an ability the engine charges the wrong price for.
 */
function parseActivatedLine(line: string, card: OracleCard): ActivatedAbility | null {
  let lower = line.toLowerCase().replace(/\.$/, '');
  let timing: 'any' | 'sorcery' = 'any';
  const sorceryOnly = lower.match(/^(.+)\. activate only as a sorcery$/);
  if (sorceryOnly !== null) {
    timing = 'sorcery';
    lower = sorceryOnly[1] as string;
  }

  const split = splitActivation(lower);
  if (split === null) return null;
  const costs = parseActivationCosts(split.costText);
  if (costs === null) return null;

  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind) => {
    targets.push({ kind });
    return targets.length - 1;
  };
  const effects: Effect[] = [];
  for (const sentence of splitSentences(split.effectText)) {
    const parsed = parseEffectSentence(sentence, alloc, card);
    if (parsed === null) return null;
    effects.push(...parsed);
  }
  if (effects.length === 0) return null;

  return { costs, timing, ability: { kind: 'activated', targets, effects, description: line } };
}

/** "dragon" → "Dragon". Subtypes are printed capitalized; the parser lowercases lines. */
function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Parse a continuous static ability or CDA into `StaticEffect`s (ADR 0005). `lower` is the
 * lowercased, period-stripped line with `~` substituted for the card name. Returns null when
 * unrecognized. One line can yield several effects: "Other Elves you control get +1/+1 and
 * have haste" is one layer-7d effect and one layer-6 effect over the same subject.
 */
function parseStaticLine(lower: string, card: OracleCard): StaticEffect[] | null {
  // Blood Moon — "Nonbasic lands are Mountains." (layer 4: set subtype, lose abilities.)
  if (lower === 'nonbasic lands are mountains') {
    return [
      {
        affects: NONBASIC_LANDS,
        op: { layer: 4, setLandSubtype: 'Mountain', loseAbilities: true },
      },
    ];
  }
  // Tarmogoyf — CDA (layer 7a): power = card types in all graveyards, toughness = that + N.
  {
    const m = lower.match(
      /^~['’]s power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus (\d+)$/,
    );
    if (m) {
      const types: Value = { kind: 'cardTypesInAllGraveyards' };
      return [
        {
          affects: { kind: 'self' },
          op: {
            layer: 7,
            sublayer: 'a',
            power: types,
            toughness: { kind: 'plus', of: types, n: Number(m[1]) },
          },
        },
      ];
    }
  }
  // Granted mana ability — Chromatic Lantern's `Lands you control have "{T}: Add …"`.
  // Checked before ANTHEM_RE, whose "<subject> have <keywords>" arm would otherwise match this
  // line and reject it as an unimplemented keyword.
  {
    const m = lower.match(/^(.+?) have "(.+)"$/);
    if (m) {
      // The granted ability's own terminal period sits INSIDE the quotes, so the line-level
      // strip in the main loop never reaches it.
      const granted = parseManaAbilityLine((m[2] as string).replace(/\.$/, ''), card);
      const affects = parseSubject(m[1] as string, card);
      if (granted !== null && affects !== null) {
        return [{ affects, op: { layer: 6, addManaAbility: granted } }];
      }
    }
  }
  // Anthems and lords — "Creatures you control get +1/+1", "Other Elves you control have haste".
  {
    const m = lower.match(ANTHEM_RE);
    if (m) {
      const affects = parseSubject(m[1] as string, card);
      if (affects === null) return null;
      const out: StaticEffect[] = [];
      if (m[2] !== undefined) {
        out.push({
          affects,
          op: { layer: 7, sublayer: 'd', power: Number(m[2]), toughness: Number(m[3]) },
        });
      }
      const keywordText = m[4] ?? m[5];
      if (keywordText !== undefined) {
        const keywords = parseKeywordList(keywordText);
        if (keywords === null) return null;
        for (const keyword of keywords)
          out.push({ affects, op: { layer: 6, addKeyword: keyword } });
      }
      if (out.length > 0) return out;
    }
  }
  return null;
}

/** Interpret one oracle card. Never throws — unmodeled cards are reported, not errors. */
export function interpretCard(card: OracleCard): CardDefinition {
  const reasons: string[] = [];

  const isLandCard = card.types.includes('Land');
  const costResult = parseManaCost(card.manaCost);
  if (costResult.unsupportedSymbols.length > 0) {
    reasons.push(`unsupported mana cost symbols: ${costResult.unsupportedSymbols.join(' ')}`);
  }

  const parseNumeric = (value: string | null, label: string): number | null => {
    if (value === null) return null;
    if (!/^[+-]?\d+$/.test(value)) {
      reasons.push(`non-numeric ${label} "${value}"`);
      return null;
    }
    return Number(value);
  };
  // P/T may be non-numeric ("*") when a CDA defines it; defer the reason until after the
  // text is parsed (checked below once we know whether a layer-7a CDA was found).
  const parseIntOrNull = (value: string | null): number | null =>
    value !== null && /^[+-]?\d+$/.test(value) ? Number(value) : null;
  const power = parseIntOrNull(card.power);
  const toughness = parseIntOrNull(card.toughness);
  const loyalty = parseNumeric(card.loyalty, 'loyalty');
  const defense = parseNumeric(card.defense, 'defense');

  if (card.layout !== 'normal') {
    reasons.push(`unsupported layout "${card.layout}"`);
  }
  const KNOWN_TYPES = [
    'Creature',
    'Artifact',
    'Enchantment',
    'Land',
    'Instant',
    'Sorcery',
    'Planeswalker',
    'Battle',
  ];
  for (const t of card.types) {
    if (!KNOWN_TYPES.includes(t)) {
      reasons.push(`unsupported card type "${t}"`);
    }
  }
  // A planeswalker/battle must know its starting loyalty/defense to enter correctly
  // (CR 306.5b / 310.6). Real cards of these types are double-faced and already unmodeled;
  // this guards a single-faced or fixture-injected one from entering at 0 and dying.
  if (card.types.includes('Planeswalker') && loyalty === null) {
    reasons.push('planeswalker with no readable starting loyalty');
  }
  if (card.types.includes('Battle') && defense === null) {
    reasons.push('battle with no readable starting defense');
  }

  const keywords: KeywordAbility[] = [];
  const manaAbilities: ManaAbilitySpec[] = [];
  const activatedAbilities: ActivatedAbility[] = [];
  const spellTargets: TargetSpec[] = [];
  const spellEffects: Effect[] = [];
  const triggers: Ability[] = [];
  const staticEffects: StaticEffect[] = [];
  const entersWithCounters: Record<string, number> = {};
  let entersTapped = false;
  let entersTappedUnless: Condition | undefined;

  const isSpell = card.types.includes('Instant') || card.types.includes('Sorcery');
  const text = substituteSelfName(stripReminderText(card.oracleText), card.name);

  for (const rawLine of text.split('\n')) {
    const line = stripAbilityWord(rawLine.trim());
    if (line.length === 0) continue;
    const lower = line.toLowerCase().replace(/\.$/, '');

    // 1. A pure keyword list ("Flying, vigilance").
    const parts = lower.split(/[,;]/).map((p) => p.trim());
    if (parts.every((p) => KEYWORD_SET.has(p))) {
      for (const p of parts) keywords.push(p as KeywordAbility);
      continue;
    }
    // 2. A mana ability. "{T}: Add {G}{W}" is TWO units (two mana); "{T}: Add {G} or {W}" is
    //    ONE unit with two symbol choices (one mana, player picks) — the distinction the
    //    payment solver's per-unit backtracking already understands.
    {
      const mana = parseManaAbilityLine(lower, card);
      if (mana !== null) {
        manaAbilities.push(mana);
        continue;
      }
      // Only judge production once the COST half really is a cost. Otherwise a line that
      // merely quotes an ability (`Lands you control have "{T}: Add …"`) splits at the wrong
      // colon and gets rejected here before the static-ability parse ever sees it.
      const split = splitActivation(lower);
      if (
        split !== null &&
        parseActivationCosts(split.costText) !== null &&
        UNSUPPORTED_MANA_RE.test(split.effectText)
      ) {
        reasons.push(`unsupported mana production: "${line}"`);
        continue;
      }
    }
    // 3. Enters tapped.
    if (/^(?:~|this land) enters (?:the battlefield )?tapped$/.test(lower)) {
      entersTapped = true;
      continue;
    }
    // 3a. Enters tapped UNLESS a condition holds — a replacement effect (CR 614.1c), resolved
    //     in `moveObject` before the permanent exists. See `entersTappedUnless`.
    {
      const m = lower.match(ENTERS_TAPPED_UNLESS_RE);
      if (m) {
        const condition = parseEntersUnlessClause(m[1] as string, card);
        if (condition !== null) {
          entersTappedUnless = condition;
          continue;
        }
      }
      // The shockland template. "You may pay 2 life" is a choice, not a state predicate, so it
      // is a `mayPayLife` condition the engine asks the controller about as the land enters.
      const pay = lower.match(ENTERS_PAY_LIFE_RE);
      if (pay) {
        entersTappedUnless = { kind: 'mayPayLife', n: Number(pay[1]) };
        continue;
      }
    }
    // 3b. "~ enters with three +1/+1 counters on it" — a replacement effect (CR 614.1c),
    //     applied in `makePermanent`, never a trigger. See `CardDefinition.entersWithCounters`.
    {
      const m = lower.match(
        /^~ enters (?:the battlefield )?with (\w+) ([+-]\d+\/[+-]\d+) counters? on it$/,
      );
      if (m) {
        const count = parseAmount(m[1] as string);
        if (count !== null) {
          const counter = m[2] as string;
          entersWithCounters[counter] = (entersWithCounters[counter] ?? 0) + count;
          continue;
        }
      }
    }
    // 4. A triggered ability.
    {
      const parsed = parseTriggerLine(line, card);
      if (parsed !== null) {
        triggers.push(...parsed);
        continue;
      }
    }
    // 4b. A continuous static ability / CDA (ADR 0005). These specific patterns will move to
    //     the authored-override registry; here they prove the layer engine end-to-end.
    {
      const stat = parseStaticLine(lower, card);
      if (stat !== null) {
        staticEffects.push(...stat);
        continue;
      }
    }
    // 4c. An activated ability — "<costs>: <effect>" (CR 602). Tried after statics so a line
    //     that GRANTS an ability (`Lands you control have "{T}: Add …"`) is not read as one.
    {
      const activated = parseActivatedLine(line, card);
      if (activated !== null) {
        activatedAbilities.push(activated);
        continue;
      }
    }
    // 5. Spell effect sentences (instants/sorceries only). Parse into a scratch slot list
    //    (based at the current spell slot count) so a partially-parsing line allocates no
    //    slots; merge only when the whole line parses.
    if (isSpell) {
      const sentences = splitSentences(line);
      const lineEffects: Effect[] = [];
      const lineTargets: TargetSpec[] = [];
      const base = spellTargets.length;
      const lineAlloc: SlotAllocator = (kind) => {
        lineTargets.push({ kind });
        return base + lineTargets.length - 1;
      };
      let allParsed = sentences.length > 0;
      for (const sentence of sentences) {
        const parsed = parseEffectSentence(sentence, lineAlloc, card);
        if (parsed === null) {
          allParsed = false;
          break;
        }
        lineEffects.push(...parsed);
      }
      if (allParsed) {
        spellTargets.push(...lineTargets);
        spellEffects.push(...lineEffects);
        continue;
      }
    }
    reasons.push(`unrecognized rules text: "${line}"`);
  }

  // Intrinsic basic-land mana abilities (CR 305.6).
  for (const subtype of card.subtypes) {
    const unit = BASIC_LAND_MANA[subtype];
    if (unit !== undefined && isLandCard) {
      manaAbilities.push({ units: [unit] });
    }
  }

  // Non-numeric printed P/T ("*") is only OK if a CDA (layer 7a) defines it; otherwise it's
  // an unmodeled characteristic-defining ability.
  const hasCdaPT = staticEffects.some((s) => s.op.layer === 7 && s.op.sublayer === 'a');
  if (!hasCdaPT) {
    if (card.power !== null && power === null)
      reasons.push(`non-numeric power/toughness "${card.power}"`);
    if (card.toughness !== null && toughness === null)
      reasons.push(`non-numeric power/toughness "${card.toughness}"`);
  }

  // A spell that parsed to zero effects does nothing when it resolves — that is almost
  // certainly a modeling gap, not a real no-op card.
  if (isSpell && spellEffects.length === 0 && reasons.length === 0) {
    reasons.push('instant/sorcery with no interpretable effect');
  }

  // An authored override may implement lines the grammar cannot read (ADR 0010). It clears
  // only the specific reasons it names, so an errata'd card re-opens loudly rather than
  // silently keeping stale behavior — see `overrides/index.ts`.
  return applyOverride({
    oracleId: card.oracleId,
    name: card.name,
    typeLine: card.typeLine,
    supertypes: card.supertypes,
    types: card.types,
    subtypes: card.subtypes,
    colors: card.colors,
    colorIdentity: card.colorIdentity,
    manaCost: isLandCard ? null : costResult.cost,
    hasUnsupportedCost: costResult.unsupportedSymbols.length > 0,
    power,
    toughness,
    loyalty,
    defense,
    keywords,
    manaAbilities,
    activatedAbilities,
    entersTapped,
    ...(entersTappedUnless !== undefined ? { entersTappedUnless } : {}),
    ...(Object.keys(entersWithCounters).length > 0 ? { entersWithCounters } : {}),
    spellAbility:
      isSpell && spellEffects.length > 0
        ? { kind: 'spell', targets: spellTargets, effects: spellEffects }
        : null,
    triggers,
    staticEffects,
    modeled: reasons.length === 0,
    unmodeledReasons: reasons,
  });
}
