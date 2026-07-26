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
import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type {
  AbilityCost,
  ActivatedAbility,
  ManaRestriction,
  SearchDestination,
} from './ability';
import { IMPLEMENTED_KEYWORDS, SELF_SUBJECT } from './ability';
import type {
  Ability,
  Effect,
  KeywordAbility,
  TargetKind,
  TargetSpec,
  ObjectTriggerWhen,
  TokenSpec,
  TriggerHead,
  TriggerSpec,
  TriggerSubject,
} from './ability';
import type { Condition } from './condition';
import { countPermanents } from './condition';
import { CREATURE_TYPE_BY_LOWER, NONCREATURE_SUBTYPE_BY_LOWER } from './creature-types';
import type { StaticEffect } from './continuous-types';
import type { RuleStatic } from './rule-statics';
import type { Selector } from './selector';
import {
  IS_TOKEN,
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
import { constant } from './value';
import { applyOverride } from './overrides';
import type { CardDefinition, ManaAbilitySpec } from './definition';
import { PERMANENT_CARD_TYPES } from './definition';

/**
 * Allocates a target slot of the given kind and returns its index (ADR 0004). `filter` further
 * restricts a zone-qualified kind (`cardInGraveyard`) — "target Dragon permanent card".
 */
type SlotAllocator = (kind: TargetKind, filter?: Selector) => number;

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

/**
 * A count as rules text writes it, including the back-references only an event can answer.
 *
 * **"That many" is not one thing.** It refers back to the most recent quantity in the trigger
 * head, and which quantity that is depends on the head:
 *
 *   "Whenever one or more Dragons you control attack, draw **that many** cards"   → how many
 *   "Whenever a creature deals combat damage to a player, create **that many**    → how much
 *    Treasure tokens"
 *
 * So the referent is supplied by the caller (`thatMany`) rather than guessed here. Guessing
 * would make Old Gnawbone produce one Treasure per hit instead of one per damage — a silent
 * undercount, not an error.
 */
function parseCountPhrase(phrase: string, thatMany?: Value): Value | null {
  if (phrase === 'that many' || phrase === 'that much' || phrase === 'that damage') {
    return thatMany ?? null;
  }
  const n = parseAmount(phrase);
  return n === null ? null : constant(n);
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
 * "Ureni of the Unwritten" writes "Ureni", and "Bladewing the Risen" (no comma at all) writes
 * "Bladewing". All three are the text before whichever of a comma, " of ", or " the " comes
 * FIRST — checked as one earliest-wins choice, not three independent substitutions, so a name
 * like "Haven of the Spirit Dragon" (both " of " and, three characters later, " the ") derives
 * "Haven" and not the nonsensical "Haven of". The short form is matched on word boundaries so a
 * name that happens to be a common word cannot rewrite unrelated text.
 */
function substituteSelfName(text: string, name: string): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(escape(name), 'g'), '~');
  let shortAt = -1;
  for (const separator of [',', ' of ', ' the ']) {
    const at = name.indexOf(separator);
    if (at > 0 && (shortAt === -1 || at < shortAt)) shortAt = at;
  }
  if (shortAt > 0) {
    const short = name.slice(0, shortAt);
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

/**
 * A keyword list as printed — "Flying, ward {3}", "Flying, protection from white and from
 * black", "Other Dragons you control have ward {2}".
 *
 * Ward and protection carry an argument, so they come back as their own fields rather than as
 * members of `keywords`; see `Characteristics.ward`. Returns null if ANY element is a keyword
 * the engine does not implement, so a card is never modeled with a keyword silently dropped.
 */
interface ParsedKeywordLine {
  keywords: KeywordAbility[];
  ward?: ParsedManaCost;
  protectionFrom?: Color[];
}

const WARD_RE = /^ward ((?:\{[^}]+\})+)$/;
const PROTECTION_RE = /^protection from (.+)$/;

function parseKeywordLine(text: string): ParsedKeywordLine | null {
  const out: ParsedKeywordLine = { keywords: [] };
  // Split on commas only at the top level: " and " is ambiguous, because it also joins the
  // colors inside "protection from white and from black".
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (part.length === 0) continue;

    const protection = part.match(PROTECTION_RE);
    if (protection !== null) {
      const colors: Color[] = [];
      for (const word of (protection[1] as string).split(/ and (?:from )?/)) {
        const color = COLOR_WORDS[word.trim()];
        if (color === undefined) return null;
        colors.push(color);
      }
      out.protectionFrom = [...(out.protectionFrom ?? []), ...colors];
      continue;
    }

    const ward = part.match(WARD_RE);
    if (ward !== null) {
      const cost = parseManaCost((ward[1] as string).toUpperCase() as never);
      if (cost.cost === null) return null;
      out.ward = cost.cost;
      continue;
    }

    for (const keyword of part.split(' and ').map((k) => k.trim())) {
      if (keyword.length === 0) continue;
      if (!KEYWORD_SET.has(keyword)) return null;
      out.keywords.push(keyword as KeywordAbility);
    }
  }
  const empty =
    out.keywords.length === 0 && out.ward === undefined && out.protectionFrom === undefined;
  return empty ? null : out;
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
function resolveSubtype(word: string, card: OracleCard): string | null {
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
 * Parse the subject of an anthem — "other Elves you control", "creatures your opponents
 * control" — into a `Selector`. Returns null when any part is unrecognized.
 */
function parseSubject(phrase: string, card: OracleCard): Selector | null {
  const parts: Selector[] = [];
  let noun = phrase;

  // "Equipped creature has haste" / "Enchanted creature gets +2/+2" — the subject is whatever
  // the source is currently attached to, which is a relation, not a characteristic.
  if (/^(equipped|enchanted|fortified) /.test(noun)) return { kind: 'attachedToSource' };

  if (noun.startsWith('other ')) {
    parts.push(OTHER);
    noun = noun.slice('other '.length);
  }
  // "Nontoken creatures you control have riot" (Rhythm of the Wild) — the plural counterpart
  // to `parseTriggerSubject`'s "another nontoken Dragon you control" (Miirym).
  if (noun.startsWith('nontoken ')) {
    parts.push(not(IS_TOKEN));
    noun = noun.slice('nontoken '.length);
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
const ANTHEM_RE =
  /^(.+?) (?:gets? ([+-]\d+)\/([+-]\d+)(?: and (?:have|has) (.+))?|(?:have|has) (.+))$/;

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
  opts: { triggerObject?: boolean; thatMany?: Value } = {},
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
        const parsed = parseKeywordLine(keywordText);
        // Only plain keywords can be granted until end of turn: `UntilEotEffect` carries a
        // single keyword name, and a ward/protection grant would need a shape it does not have.
        if (parsed === null || parsed.ward !== undefined || parsed.protectionFrom !== undefined) {
          return null;
        }
        for (const keyword of parsed.keywords) {
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
      if (m[2] === 'any target') {
        return [{ op: 'dealDamage', target: alloc('anyTarget'), amount: constant(amount) }];
      }
      if (m[2] === 'target creature') {
        return [{ op: 'dealDamage', target: alloc('creature'), amount: constant(amount) }];
      }
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
  // "return target Dragon permanent card from your graveyard to the battlefield" (Bladewing) /
  // "…to your hand" (Haven of the Spirit Dragon).
  {
    const m = s.match(/^return target (.+) from your graveyard to (the battlefield|your hand)$/);
    if (m) {
      const filter = parseCardFilterPhrase(m[1] as string, card);
      if (filter === null) return null;
      const target = alloc('cardInGraveyard', filter);
      return [
        m[2] === 'the battlefield'
          ? { op: 'graveyardToBattlefield', target }
          : { op: 'graveyardToHand', target },
      ];
    }
  }
  // "put a permanent card with mana value less than or equal to that damage from your hand onto
  // the battlefield" (Broodcaller Scourge) — a single, bounded, optional pick.
  {
    const m = s.match(
      /^put (?:a|an) (.+?) with mana value less than or equal to (that damage|that many|\w+) from your hand onto the battlefield$/,
    );
    if (m) {
      const filter = parseCardFilterPhrase(m[1] as string, card);
      const maxManaValue = parseCountPhrase(m[2] as string, opts.thatMany);
      if (filter === null || maxManaValue === null) return null;
      return [{ op: 'handToBattlefield', filter, maxManaValue, count: 'one' }];
    }
  }
  // "put any number of creature cards from your hand onto the battlefield" (Last March of the
  // Ents) — the unbounded sibling of the pattern above.
  {
    const m = s.match(/^put any number of (.+) from your hand onto the battlefield$/);
    if (m) {
      const filter = parseCardFilterPhrase(m[1] as string, card);
      if (filter === null) return null;
      return [{ op: 'handToBattlefield', filter, count: 'any' }];
    }
  }
  // "you may put a permanent card from your hand onto the battlefield" (The Ur-Dragon) — a
  // single optional pick with no mana-value bound. `handToBattlefield`'s own executor already
  // offers a decline option, so the "you may" needs no ability-level `optional` flag; it is
  // read here only so the sentence is not rejected as unrecognized.
  {
    const m = s.match(/^(?:you may )?put (?:a|an) (.+) from your hand onto the battlefield$/);
    if (m) {
      const filter = parseCardFilterPhrase(m[1] as string, card);
      if (filter === null) return null;
      return [{ op: 'handToBattlefield', filter, count: 'one' }];
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
  // "draw a card" / "draw two cards" / "you draw a card" / "draw that many cards"
  {
    const m = s.match(/^(?:you )?draw (that many|\w+) cards?$/);
    if (m) {
      const count = parseCountPhrase(m[1] as string, opts.thatMany);
      if (count === null) return null;
      return [{ op: 'draw', count }];
    }
  }
  // "draw cards equal to the greatest toughness among creatures you control" (Last March).
  // Bounded to exclude a comma so a trailing ", then …" clause is left for the then-split
  // fallback below, rather than being swallowed into the subject phrase.
  {
    const m = s.match(/^draw cards equal to the greatest toughness among ([^,]+)$/);
    if (m) {
      const selector = parseSubject(m[1] as string, card);
      if (selector === null) return null;
      return [
        { op: 'draw', count: { kind: 'greatestToughnessAmong', selector, scope: 'all' } },
      ];
    }
  }
  // "create a 1/1 black and green Pest creature token with '…'" / "create that many Treasure
  // tokens" / "create a token that's a copy of it, except the token isn't legendary"
  {
    const parsed = parseCreateTokenSentence(s, card, opts);
    if (parsed !== null) return parsed;
  }
  // "untap all lands you control"
  {
    const m = s.match(/^untap all (.+)$/);
    if (m) {
      const selector = parseSubject(m[1] as string, card);
      if (selector === null) return null;
      return [{ op: 'untapEach', selector }];
    }
  }
  // "you gain 3 life"
  {
    const m = s.match(/^you gain (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ op: 'gainLife', amount: constant(amount) }];
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
  // "~ deals X damage to each creature without flying and each player" (Earthquake).
  {
    const m = s.match(/^(?:~|it) deals (\w+) damage to each (.+?)( and each player)?$/);
    if (m) {
      const amount = parseDamageAmount(m[1] as string, card);
      const selector = parseMassSubject(m[2] as string, card);
      if (amount === null || selector === null) return null;
      const effects: Effect[] = [{ op: 'damageEach', selector, amount }];
      if (m[3] !== undefined) effects.push({ op: 'damageEachPlayer', amount });
      return effects;
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
  // "<effect>, then <effect>" — two atomic effects sequenced in one printed sentence (Last
  // March: "draw …, then put …"). A fallback tried last, so a whole-sentence pattern above that
  // happens to contain its own ", then " (the search-then-shuffle block) is matched first.
  {
    const i = s.indexOf(', then ');
    if (i > 0) {
      const first = parseEffectSentence(s.slice(0, i), alloc, card, opts);
      const second = parseEffectSentence(s.slice(i + ', then '.length), alloc, card, opts);
      if (first !== null && second !== null) return [...first, ...second];
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
 * A damage amount as printed: a number word, or `X` (the announced value, CR 601.2b).
 *
 * Returns a `Value` rather than a number so "X damage" and "3 damage" take the same executor
 * path — the alternative is a parallel set of ops that differ only in how the number arrives.
 */
function parseDamageAmount(word: string, card: OracleCard): Value | null {
  if (word === 'x') {
    // Only meaningful on a card whose own cost contains {X}; anything else is a different X
    // (an ability's X, a counted quantity) that this grammar has not read.
    return (card.manaCost ?? '').includes('{X}') ? { kind: 'xValue' } : null;
  }
  const amount = parseAmount(word);
  return amount === null ? null : constant(amount);
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
 * "Dragon permanent card" / "creature card" / "permanent card" → a `Selector` matching cards in
 * a non-battlefield zone by their PRINTED characteristics (`state/queries.ts::cardZoneCandidate`).
 *
 * Distinct from `parseTriggerSubject`: "permanent" is not a real card type (CR 110), so a bare
 * "permanent card" means "any of the six permanent card types", not a single `ofType`.
 */
function parseCardFilterPhrase(phrase: string, card: OracleCard): Selector | null {
  // "a Dragon creature card or Ugin planeswalker card" / "a Dragon spell or an Omen spell" —
  // alternatives, any of which qualifies. Split before anything else so each side is read whole.
  if (/ or /.test(phrase)) {
    const parts: Selector[] = [];
    for (const alternative of phrase.split(/ or /)) {
      const parsed = parseCardFilterPhrase(alternative.replace(/^(?:an?) /, '').trim(), card);
      if (parsed === null) return null;
      parts.push(parsed);
    }
    return parts.length === 1 ? (parts[0] as Selector) : anyOf(...parts);
  }

  const noun = phrase.replace(/ (?:cards?|spells?)$/, '').replace(/^(?:an?) /, '');
  const anyPermanentType = (): Selector => anyOf(...PERMANENT_CARD_TYPES.map((t) => ofType(t)));
  if (noun === 'permanent') return anyPermanentType();
  const m = noun.match(/^(.+) permanent$/);
  if (m !== null) {
    const subtype = resolveSubtype(m[1] as string, card);
    return subtype === null ? null : allOf(ofSubtype(subtype), anyPermanentType());
  }
  return parseTriggerSubject(noun, card);
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
  /^when(?:ever)? (.+?) (enters(?: the battlefield)?(?: or attacks)?|dies|attacks|deals combat damage to a player), (.*)$/;
const STEP_TRIGGER_HEAD_RE =
  /^at the beginning of (your|each(?: player's)?) (upkeep|end step), (.*)$/;
/**
 * "Whenever **one or more** Dragons you control attack" — the aggregate form (CR 603.2c). The
 * plural subject is stripped back to its singular here so `parseTriggerSubject` sees the same
 * phrase it would in the ordinary form; the aggregation is a flag on the head, not a different
 * selector.
 */
const AGGREGATE_TRIGGER_HEAD_RE =
  /^whenever one or more (.+?) (attack|deal combat damage to a player), (.*)$/;
/** "Whenever you cast a Dragon spell" (CR 603.2). */
const CAST_TRIGGER_HEAD_RE = /^whenever (you|an opponent) casts? (.+?), (.*)$/;
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

  // "another **nontoken** Dragon you control" (Miirym). Sits between "another" and the tribe.
  if (noun.startsWith('nontoken ')) {
    parts.push(not(IS_TOKEN));
    noun = noun.slice('nontoken '.length);
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
 * Predefined token faces that rules text names rather than describes (CR 111.10). "Create a
 * Treasure token" says nothing about what a Treasure *is* — the face is defined by the rules,
 * so it has to be spelled out here or the token would enter as a blank artifact.
 */
const PREDEFINED_TOKENS: Record<string, TokenSpec> = {
  treasure: {
    name: 'Treasure',
    typeLine: 'Token Artifact — Treasure',
    types: ['Artifact'],
    subtypes: ['Treasure'],
    colors: [],
    power: null,
    toughness: null,
    manaAbilities: [
      {
        units: [['W', 'U', 'B', 'R', 'G']],
        costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }],
      },
    ],
  },
};

/** "1/1 black and green Pest creature token" → a `TokenSpec`, or null if any part is unread. */
function parseTokenFace(phrase: string, card: OracleCard): TokenSpec | null {
  const predefined = PREDEFINED_TOKENS[phrase.replace(/ tokens?$/, '').trim()];
  if (predefined !== undefined) return predefined;

  const m = phrase.match(/^(\d+)\/(\d+) (.+?) (creature )?tokens?$/);
  if (m === null) return null;

  let rest = m[3] as string;
  const colors: Color[] = [];
  for (;;) {
    const colorMatch = rest.match(/^(white|blue|black|red|green)(?: and )?(.*)$/);
    if (colorMatch === null) break;
    colors.push(COLOR_WORDS[colorMatch[1] as string] as Color);
    rest = (colorMatch[2] as string).trim();
  }
  // What remains is the creature type. A token naming a type we cannot resolve stays unmodeled
  // rather than entering typeless — its tribe is exactly what other cards key off.
  const subtype = resolveSubtype(rest, card);
  if (subtype === null) return null;

  return {
    name: subtype,
    typeLine: `Token Creature — ${subtype}`,
    types: ['Creature'],
    subtypes: [subtype],
    colors,
    power: Number(m[1]),
    toughness: Number(m[2]),
  };
}

/**
 * "Create a 1/1 black and green Pest creature token with 'When this token dies, you gain 1
 * life.'" / "create that many Treasure tokens" / "create a token that's a copy of it, except
 * the token isn't legendary".
 */
function parseCreateTokenSentence(
  s: string,
  card: OracleCard,
  opts: { triggerObject?: boolean; thatMany?: Value },
): Effect[] | null {
  // The copy form first: it shares the "create a token" prefix but nothing else.
  const copy = s.match(/^create (a|that many|\w+) tokens? that's a copy of it(, except .+)?$/);
  if (copy !== null) {
    // The copy form is only meaningful for a trigger that watches another object — "a copy of
    // IT". Without a referent there is nothing to copy.
    if (opts.triggerObject !== true) return null;
    const except = copy[2] ?? '';
    // Any exception other than the legendary one changes what the copy is; refuse rather than
    // silently produce a copy that ignores it.
    if (except !== '' && !/except the token isn't legendary/.test(except)) return null;
    const count = parseCountPhrase(copy[1] as string, opts.thatMany);
    if (count === null) return null;
    return [
      {
        op: 'createTokenCopyOf',
        ref: 'triggerObject',
        count,
        ...(except === '' ? {} : { exceptNonLegendary: true }),
      },
    ];
  }

  const m = s.match(/^create (a|an|that many|\w+) (.+?)(?: with "(.+)")?$/);
  if (m === null) return null;
  const count = parseCountPhrase(m[1] as string, opts.thatMany);
  if (count === null) return null;

  const spec = parseTokenFace(m[2] as string, card);
  if (spec === null) return null;

  // "with 'When this token dies, you gain 1 life.'" — the token's OWN ability, parsed with the
  // same trigger grammar as a printed line so it behaves identically once on the battlefield.
  const granted = m[3];
  if (granted !== undefined) {
    const triggers = parseTriggerLine(granted.replace(/^this token /, 'this creature '), card);
    if (triggers === null) return null;
    return [{ op: 'createToken', spec: { ...spec, triggers }, count }];
  }
  return [{ op: 'createToken', spec, count }];
}

/** Sentinel for "whenever you cast **a spell**" — no filter at all, which is not the same as an
 * unparseable one. Compared by identity, never matched against anything. */
const ANY_SPELL: Selector = { kind: 'type', value: '*any spell*' };

/**
 * The spell a `castsSpell` trigger watches — "a Dragon spell", "a creature spell", "a Dragon
 * creature spell".
 *
 * A spell is matched on card characteristics, so this reuses `parseTriggerSubject` after
 * stripping the trailing "spell": "a Dragon spell" and "a Dragon" describe the same
 * characteristics, and only the zone differs.
 */
function parseSpellFilter(phrase: string, card: OracleCard): Selector | null {
  const noun = phrase.replace(/ spells?$/, '');
  if (noun === 'a' || noun === 'an' || noun === '') return ANY_SPELL;
  return parseTriggerSubject(noun, card);
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
  const step = lower.match(STEP_TRIGGER_HEAD_RE);
  const aggregate = lower.match(AGGREGATE_TRIGGER_HEAD_RE);
  const cast = lower.match(CAST_TRIGGER_HEAD_RE);
  if (step !== null) {
    heads = [
      {
        when: step[2] === 'upkeep' ? 'upkeep' : 'endStep',
        player: step[1] === 'your' ? 'you' : 'each',
      },
    ];
    body = step[3] as string;
  } else if (aggregate !== null) {
    // The subject is plural here ("Dragons you control"), so it reads through `parseSubject`
    // rather than `parseTriggerSubject`.
    const selector = parseSubject(aggregate[1] as string, card);
    if (selector === null) return null;
    heads = [
      {
        when: aggregate[2] === 'attack' ? 'attacks' : 'dealsCombatDamageToPlayer',
        subject: { kind: 'permanent', selector },
        aggregate: true,
      },
    ];
    body = aggregate[3] as string;
  } else if (cast !== null) {
    const filter = parseSpellFilter(cast[2] as string, card);
    if (filter === null) return null;
    heads = [
      {
        when: 'castsSpell',
        caster: cast[1] === 'you' ? 'you' : 'opponent',
        ...(filter === ANY_SPELL ? {} : { filter }),
      },
    ];
    body = cast[3] as string;
  } else {
    const m = lower.match(OBJECT_TRIGGER_HEAD_RE);
    if (m === null) return null;
    const subjectPhrase = m[1] as string;
    const event = m[2] as string;
    const events: ObjectTriggerWhen[] = event.startsWith('enters')
      ? event.endsWith('or attacks')
        ? ['enters', 'attacks']
        : ['enters']
      : event === 'dies'
        ? ['dies']
        : event === 'attacks'
          ? ['attacks']
          : ['dealsCombatDamageToPlayer'];
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
  const alloc: SlotAllocator = (kind, filter) => {
    targets.push(filter === undefined ? { kind } : { kind, filter });
    return targets.length - 1;
  };

  // "it" is only meaningful when the trigger watches an object other than its own source.
  const firstHead = heads[0] as TriggerHead;
  const opts = {
    triggerObject: 'subject' in firstHead && firstHead.subject.kind === 'permanent',
    // What "that many" refers back to. A combat-damage head makes it the damage; an aggregate
    // head makes it the number of objects. See `parseCountPhrase`.
    ...(firstHead.when === 'dealsCombatDamageToPlayer'
      ? { thatMany: { kind: 'damageDealt' } as Value }
      : 'aggregate' in firstHead && firstHead.aggregate === true
        ? { thatMany: { kind: 'triggerCount' } as Value }
        : {}),
  };

  // A whole-body pattern first: some effects span several sentences that only mean anything
  // together ("look at the top eight … put the rest …", Klauth's mana-then-restriction-then-
  // persistence).
  let effects = parseLookAtTopBlock(body, card) ?? parseAddManaTriggerBlock(body, card);
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
 * "Add one mana of any color. If you control a creature with power 4 or greater, add two mana
 * of any one color instead." (Ilysian Caryatid) — a conditional AMOUNT: when the condition
 * holds, the whole production is REPLACED, not added to. Written as one narrow pattern (a
 * single-card template, ADR 0010's grammar-vs-override policy) rather than a general
 * "instead" combinator.
 */
const MANA_CONDITIONAL_AMOUNT_RE =
  /^add one mana of any color\. if you control a creature with power (\d+) or greater, add (\w+) mana of any one color instead$/;

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
 * "…Spend this mana only to cast a Dragon creature spell." (Haven of the Spirit Dragon) — a
 * CR 106.6 restriction riding on the mana produced.
 */
const MANA_SPEND_ONLY_RE = /^(add [^.]+)\. spend this mana only to (.+)$/;

/**
 * "…When you spend this mana to cast a Dragon creature spell, you gain 2 life." (Scaled
 * Nurturer) / "…When that mana is spent to cast a creature spell that shares a creature type
 * with your commander, scry 1." (Path of Ancestry) — a reflexive trigger on the mana, NOT on the
 * ability that made it: it fires when the mana is consumed, which may be much later.
 */
const MANA_SPEND_TRIGGER_RE =
  /^(add [^.]+)\. when (?:you spend this mana|that mana is spent) to (.+?), (.+)$/;

/**
 * The object clause of a spend restriction or spend trigger — "cast a Dragon creature spell",
 * "cast spells", "cast a creature spell that shares a creature type with your commander".
 *
 * Returns null for anything unread, which leaves the whole card unmodeled. That is the only safe
 * direction: a restriction the engine drops silently becomes mana spendable on anything.
 */
function parseManaSpendClause(clause: string, card: OracleCard): ManaRestriction | null {
  const description = clause;
  let rest = clause;

  // "…that shares a creature type with your commander" (Path of Ancestry) is the outermost
  // clause, so it comes off before the noun phrase it qualifies.
  let sharesWithCommander = false;
  const shares = rest.match(/^(.+) that shares a creature type with your commander$/);
  if (shares !== null) {
    sharesWithCommander = true;
    rest = shares[1] as string;
  }

  const m = rest.match(/^cast (.+)$/);
  if (m === null) return null;
  const noun = m[1] as string;

  // "cast spells" with no filter at all — Klauth's blanket restriction.
  const filter =
    noun === 'spells' || noun === 'a spell' || noun === 'spell'
      ? null
      : parseCardFilterPhrase(noun, card);
  if (filter === null && noun !== 'spells' && noun !== 'a spell' && noun !== 'spell') return null;

  return {
    purposes: ['castSpell'],
    ...(filter !== null ? { filter } : {}),
    ...(sharesWithCommander ? { sharesCreatureTypeWithCommander: true } : {}),
    description,
  };
}

/**
 * "Add X mana in any combination of colors, where X is the total power of attacking creatures.
 * Spend this mana only to `<clause>`. Until end of turn, you don't lose this mana as steps and
 * phases end." (Klauth) — three sentences that only mean anything together: the restriction and
 * the persistence both ride on the SAME mana the first sentence produces, not on separate
 * effects. A single-card template (ADR 0010's grammar-vs-override policy), like
 * `parseLookAtTopBlock`.
 */
const ADD_X_MANA_ANY_COLORS_RE =
  /^add x mana in any combination of colors, where x is the total power of attacking creatures\. spend this mana only to (.+?)\. until end of turn, you don't lose this mana as steps and phases end$/;

function parseAddManaTriggerBlock(lower: string, card: OracleCard): Effect[] | null {
  const m = lower.replace(/\.$/, '').match(ADD_X_MANA_ANY_COLORS_RE);
  if (m === null) return null;
  const restriction = parseManaSpendClause(m[1] as string, card);
  if (restriction === null) return null;
  return [
    {
      op: 'addMana',
      amount: { kind: 'totalPowerOfAttackers' },
      colors: 'any',
      restriction,
      persistent: true,
    },
  ];
}

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
    const payLife = part.match(/^pay (\d+) life$/);
    if (payLife !== null) {
      costs.push({ kind: 'payLife', amount: Number(payLife[1]) });
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
  // "… Spend this mana only to cast a Dragon creature spell." (CR 106.6) — rides on the mana.
  {
    const m = effectText.match(MANA_SPEND_ONLY_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      const restriction = parseManaSpendClause(m[2] as string, card);
      if (base === null || restriction === null) return null;
      return { ...base, restriction };
    }
  }
  // "… When you spend this mana to cast a Dragon creature spell, you gain 2 life." — a reflexive
  // trigger on the MANA, fired when it is consumed rather than when it is produced.
  {
    const m = effectText.match(MANA_SPEND_TRIGGER_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      const when = parseManaSpendClause(m[2] as string, card);
      if (base === null || when === null) return null;
      // A mana spend trigger is queued by `payManaCost`, which has no target-choosing machinery,
      // so an effect that wants a target leaves the card unmodeled rather than resolving at
      // nothing. Slots are counted into a scratch list purely to detect that.
      const wantedTargets: TargetSpec[] = [];
      const alloc: SlotAllocator = (kind, filter) => {
        wantedTargets.push(filter === undefined ? { kind } : { kind, filter });
        return wantedTargets.length - 1;
      };
      const effects: Effect[] = [];
      for (const sentence of splitSentences(m[3] as string)) {
        const parsed = parseEffectSentence(sentence, alloc, card);
        if (parsed === null) return null;
        effects.push(...parsed);
      }
      if (effects.length === 0 || wantedTargets.length > 0) return null;
      return {
        ...base,
        spendTrigger: {
          when,
          ability: { kind: 'triggered', targets: [], effects, description: m[3] as string },
        },
      };
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
  {
    const m = effectText.match(MANA_CONDITIONAL_AMOUNT_RE);
    if (m) {
      const n = Number(m[1]);
      const count = parseAmount(m[2] as string);
      if (count !== null && count > 0) {
        return {
          units: [ALL_COLORS],
          conditionalUnits: {
            condition: countPermanents(allOf(ofType('Creature'), powerAtLeast(n)), 'you', '>=', 1),
            units: Array.from({ length: count }, () => ALL_COLORS),
            linked: true,
          },
        };
      }
    }
  }
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
  let oncePerTurn = false;
  // The two "Activate only …" restrictions are independent and can both appear, so they are
  // stripped in sequence rather than as alternatives of one pattern.
  const onceOnly = lower.match(/^(.+)\. activate only once each turn$/);
  if (onceOnly !== null) {
    oncePerTurn = true;
    lower = onceOnly[1] as string;
  }
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
  const alloc: SlotAllocator = (kind, filter) => {
    targets.push(filter === undefined ? { kind } : { kind, filter });
    return targets.length - 1;
  };
  const effects: Effect[] = [];
  for (const sentence of splitSentences(split.effectText)) {
    const parsed = parseEffectSentence(sentence, alloc, card);
    if (parsed === null) return null;
    effects.push(...parsed);
  }
  if (effects.length === 0) return null;

  return {
    costs,
    timing,
    ...(oncePerTurn ? { oncePerTurn: true } : {}),
    ability: { kind: 'activated', targets, effects, description: line },
  };
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
        const parsed = parseKeywordLine(keywordText);
        if (parsed === null) return null;
        for (const keyword of parsed.keywords) {
          out.push({ affects, op: { layer: 6, addKeyword: keyword } });
        }
        if (parsed.ward !== undefined) out.push({ affects, op: { layer: 6, addWard: parsed.ward } });
        if (parsed.protectionFrom !== undefined) {
          out.push({ affects, op: { layer: 6, addProtection: parsed.protectionFrom } });
        }
      }
      if (out.length > 0) return out;
    }
  }
  return null;
}

/**
 * "Other Dragon spells you cast cost {1} less to cast" (Eminence, The Ur-Dragon) — as long as
 * the source is in the command zone OR on the battlefield.
 */
const EMINENCE_COST_REDUCTION_RE =
  /^as long as ~ is in the command zone or on the battlefield, other (.+ spells?) you cast cost \{(\d+)\} less to cast$/;

/**
 * "During your turn, spells you cast cost {1} less to cast for each creature you control with
 * power 4 or greater" (Temur Battlecrier) — a dynamic amount, not a fixed one.
 */
const DYNAMIC_COST_REDUCTION_RE =
  /^during your turn, spells you cast cost \{(\d+)\} less to cast for each (.+)$/;

/** "Creature spells you control can't be countered" (Rhythm of the Wild). */
const CANT_BE_COUNTERED_RE = /^(.+ spells?) you control can't be countered$/;

/** "Your opponents can't cast spells during your turn" (Dragonlord Dromoka). */
const CANT_CAST_SPELLS_RE = /^your opponents can't cast spells during your turn$/;

/** "You may cast Dragon spells from the top of your library" (Korlessa, Scale Singer). */
const CAST_FROM_LIBRARY_TOP_RE = /^you may cast (.+ spells?) from the top of your library$/;

/**
 * "You may look at the top card of your library any time" (Korlessa) — a `PlayerView` reveal
 * flag, not an engine mechanic (ADR 0010): no legal action is created or withheld by knowing the
 * top card, so this is accepted as a recognized no-op rather than built as a peek subsystem.
 */
const LOOK_AT_TOP_ANY_TIME_RE = /^you may look at the top card of your library any time$/;

/**
 * Rule-modifying statics (ADR 0010, Inc 13) — cost reduction, "can't be countered", "opponents
 * can't cast spells", casting from a non-hand zone. These have no permanent to apply a layer op
 * to (`rule-statics.ts`), so they are collected separately from `parseStaticLine`.
 */
function parseRuleStaticLine(lower: string, card: OracleCard): RuleStatic[] | null {
  if (LOOK_AT_TOP_ANY_TIME_RE.test(lower)) return [];

  {
    const m = lower.match(EMINENCE_COST_REDUCTION_RE);
    if (m) {
      const filter = parseSpellFilter(m[1] as string, card);
      if (filter === null || filter === ANY_SPELL) return null;
      return [
        {
          kind: 'costReduction',
          amount: constant(Number(m[2])),
          filter,
          excludesSelf: true,
          alsoFromCommandZone: true,
        },
      ];
    }
  }
  {
    const m = lower.match(DYNAMIC_COST_REDUCTION_RE);
    if (m) {
      const selector = parseTriggerSubject(m[2] as string, card);
      if (selector === null) return null;
      return [
        {
          kind: 'costReduction',
          amount: { kind: 'countPermanents', selector, scope: 'all' },
          yourTurnOnly: true,
        },
      ];
    }
  }
  {
    const m = lower.match(CANT_BE_COUNTERED_RE);
    if (m) {
      const filter = parseSpellFilter(m[1] as string, card);
      if (filter === null) return null;
      return [{ kind: 'cantBeCountered', ...(filter !== ANY_SPELL ? { filter } : {}) }];
    }
  }
  if (CANT_CAST_SPELLS_RE.test(lower)) {
    return [{ kind: 'cantCastSpells', who: 'opponents', yourTurnOnly: true }];
  }
  {
    const m = lower.match(CAST_FROM_LIBRARY_TOP_RE);
    if (m) {
      const filter = parseSpellFilter(m[1] as string, card);
      if (filter === null) return null;
      return [
        {
          kind: 'castFromZone',
          zone: 'libraryTop',
          ...(filter !== ANY_SPELL ? { filter } : {}),
        },
      ];
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
  const ruleStatics: RuleStatic[] = [];
  const entersWithCounters: Record<string, number> = {};
  let entersTapped = false;
  let entersTappedUnless: Condition | undefined;
  let ward: ParsedManaCost | undefined;
  let protectionFrom: Color[] | undefined;
  let spellCantBeCountered = false;

  const isSpell = card.types.includes('Instant') || card.types.includes('Sorcery');
  const text = substituteSelfName(stripReminderText(card.oracleText), card.name);

  for (const rawLine of text.split('\n')) {
    const line = stripAbilityWord(rawLine.trim());
    if (line.length === 0) continue;
    const lower = line.toLowerCase().replace(/\.$/, '');

    // 1. A pure keyword list ("Flying, vigilance", "Flying, ward {3}").
    {
      const parsed = parseKeywordLine(lower.replace(/;/g, ','));
      if (parsed !== null) {
        keywords.push(...parsed.keywords);
        if (parsed.ward !== undefined) ward = parsed.ward;
        if (parsed.protectionFrom !== undefined) {
          protectionFrom = [...(protectionFrom ?? []), ...parsed.protectionFrom];
        }
        continue;
      }
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
    // 4b1. Rule-modifying statics (ADR 0010, Inc 13) — cost reduction, "can't be countered",
    //      "opponents can't cast spells", casting from a non-hand zone. Tried after the
    //      permanent-shaped statics above: none of these patterns overlap, but the ordering
    //      keeps the "which category owns this line" story linear.
    {
      const rule = parseRuleStaticLine(lower, card);
      if (rule !== null) {
        ruleStatics.push(...rule);
        continue;
      }
    }
    // 4b2. Equip (CR 702.6) — "Equip {2}" is a sorcery-speed activated ability that attaches
    //      the Equipment to target creature you control. Printed as a keyword with a cost, so
    //      it never reaches the generic activated-ability parse.
    {
      const m = lower.match(/^equip ((?:\{[^}]+\})+)$/);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          activatedAbilities.push({
            costs: [{ kind: 'mana', cost: cost.cost }],
            timing: 'sorcery',
            ability: {
              kind: 'activated',
              targets: [{ kind: 'creature', controller: 'you' }],
              effects: [{ op: 'attachSelfTo', target: 0 }],
              description: line,
            },
          });
          continue;
        }
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
    // 4d. "This spell can't be countered." — a property of the spell object itself (CR 601),
    //     not an effect it does at resolution: it changes what the `counter` executor and
    //     `counterUnlessPays` may do. Not gated on `isSpell`: Dragonlord Dromoka prints this on
    //     a CREATURE card, where it means "the spell that becomes this permanent" — there is no
    //     `spellAbility` to hang the flag on, so it is also surfaced as a top-level field (see
    //     `CardDefinition.spellCantBeCountered`).
    if (lower === "this spell can't be countered") {
      spellCantBeCountered = true;
      continue;
    }
    // 5. Spell effect sentences (instants/sorceries only). Parse into a scratch slot list
    //    (based at the current spell slot count) so a partially-parsing line allocates no
    //    slots; merge only when the whole line parses.
    if (isSpell) {
      const sentences = splitSentences(line);
      const lineEffects: Effect[] = [];
      const lineTargets: TargetSpec[] = [];
      const base = spellTargets.length;
      const lineAlloc: SlotAllocator = (kind, filter) => {
        lineTargets.push(filter === undefined ? { kind } : { kind, filter });
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

  // Changeling (CR 702.73) is a characteristic-defining ability, not a combat keyword: it puts
  // every creature type on the card in layer 4, which is what makes Morophon a Dragon.
  if (keywords.includes('changeling')) {
    staticEffects.push({ affects: SELF, op: { layer: 4, addAllCreatureTypes: true } });
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
    scryfallId: card.scryfallId,
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
    ...(ward !== undefined ? { ward } : {}),
    ...(protectionFrom !== undefined ? { protectionFrom } : {}),
    manaAbilities,
    activatedAbilities,
    entersTapped,
    ...(entersTappedUnless !== undefined ? { entersTappedUnless } : {}),
    ...(Object.keys(entersWithCounters).length > 0 ? { entersWithCounters } : {}),
    spellAbility:
      isSpell && spellEffects.length > 0
        ? {
            kind: 'spell',
            targets: spellTargets,
            effects: spellEffects,
            ...(spellCantBeCountered ? { cantBeCountered: true } : {}),
          }
        : null,
    ...(spellCantBeCountered ? { spellCantBeCountered: true } : {}),
    triggers,
    staticEffects,
    ruleStatics,
    modeled: reasons.length === 0,
    unmodeledReasons: reasons,
  });
}
