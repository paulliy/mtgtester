/**
 * Oracle-text interpreter (brief Â§6). Turns an `OracleCard` into a `CardDefinition` by
 * accounting for EVERY line of rules text against the mechanics the engine implements:
 * keyword lists, mana abilities, enters-tapped clauses, a registry of spell-effect
 * sentence patterns, and a registry of trigger patterns.
 *
 * Any line (or cost symbol, or P/T value) that cannot be accounted for marks the card
 * `modeled: false` with a specific reason. The engine will halt loudly when that card's
 * behavior is needed â€” a visible failure is more useful than a wrong game (brief Â§6.3),
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
  ENTERED_THIS_TURN,
  IS_COMMANDER,
  IS_ENCHANTED,
  IS_EQUIPPED,
  IS_MONOCOLORED,
  IS_TOKEN,
  NONBASIC_LANDS,
  NONLAND,
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
  manaValueAtLeast,
  manaValueAtMost,
  ofType,
  powerAtLeast,
  withKeyword,
} from './selector';
import type { Value } from './value';
import { constant } from './value';
import {
  activated,
  costReductionFor,
  lord,
  mana,
  manaCost,
  onAttacks,
  onCast,
  onCombatDamageToPlayer,
  onDies,
  onEtb,
  SAC_SELF,
  spell,
  TAP,
  triggered,
  whenAttacks,
  whenEnters,
  whenPermanent,
} from './templates';
import { TREASURE } from './tokens';
// Use the explicit module path so the registry imported by authored override modules and the
// interpreter share one module instance under Bun/TypeScript path resolution.
import { applyOverride, getOverride } from './overrides/index';
import type { CardDefinition, ManaAbilitySpec } from './definition';
import { PERMANENT_CARD_TYPES } from './definition';

/**
 * Allocates a target slot of the given kind and returns its index (ADR 0004). `filter` further
 * restricts a zone-qualified kind (`cardInGraveyard`) â€” "target Dragon permanent card".
 */
type SlotAllocator = (
  kind: TargetKind,
  filter?: Selector,
  controller?: 'you' | 'opponent',
) => number;

/**
 * Allocates a variable-COUNT target slot ("up to two other targets", "any number of target
 * creatures") and returns its index. Only offered where a variable count actually means
 * something â€” inside a triggered ability's own target list (`parseTriggerLine`) â€” because a
 * cast spell's targets are all chosen in the same option-menu step {X} already uses, which has
 * no room for a decision sequence.
 */
type CountSlotAllocator = (
  kind: TargetKind,
  count: { min: number; max: number },
  controller?: 'you' | 'opponent',
  filter?: Selector,
) => number;

/** Basic land subtypes â†’ intrinsic mana ability (CR 305.6). */
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
 *   "Whenever one or more Dragons you control attack, draw **that many** cards"   â†’ how many
 *   "Whenever a creature deals combat damage to a player, create **that many**    â†’ how much
 *    Treasure tokens"
 *
 * So the referent is supplied by the caller (`thatMany`) rather than guessed here. Guessing
 * would make Old Gnawbone produce one Treasure per hit instead of one per damage â€” a silent
 * undercount, not an error.
 */
function parseCountPhrase(phrase: string, thatMany?: Value): Value | null {
  if (phrase === 'that many' || phrase === 'that much' || phrase === 'that damage') {
    return thatMany ?? null;
  }
  if (phrase === 'x') return { kind: 'xValue' };
  const n = parseAmount(phrase);
  return n === null ? null : constant(n);
}

/** Strip reminder text (parenthesized), collapse whitespace. */
function stripReminderText(text: string): string {
  return text.replace(/\([^)]*\)/g, '').replace(/[ \t]+/g, ' ');
}

/**
 * Ability words (CR 207.2c): italic words before an em dash that have NO rules meaning â€” they
 * only tie a group of cards together thematically. Dropping the prefix lets the real ability
 * behind it parse.
 *
 * This is an explicit allowlist rather than a general "strip anything before an em dash",
 * because plenty of em-dash prefixes DO carry meaning â€” Saga chapter markers ("I â€”", "II â€”")
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
  'command protocols', 'guardian protocols',
];
const ABILITY_WORD_RE = new RegExp(`^(?:${ABILITY_WORDS.join('|')})\\s+\\u2014\\s+`, 'i');

/** Drop a leading ability word so the ability it labels can be parsed (CR 207.2c). */
function stripAbilityWord(line: string): string {
  return line.replace(ABILITY_WORD_RE, '');
}

/**
 * Universes Beyond and other one-off italic labels occupy the same leading "Label — rules"
 * shape as named ability words. Strip that shape only for parser attempts; callers retain the
 * original line for drift-guarded unmodeled reasons.
 */
function stripGenericAbilityLabel(line: string): string {
  const m = line.match(/^([A-Z][A-Za-z0-9'’/-]*(?: [A-Z0-9][A-Za-z0-9'’/-]*){0,7})\s+[—–-]\s+(.+)$/);
  if (m === null) return line;
  if (/^(?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/.test(m[1] as string)) return line;
  return m[2] as string;
}
/**
 * Modern self-reference templating: "This creature deals 2 damage to any target". Cards
 * printed (or errata'd) since ~2021 say "this <type>" instead of repeating the card name, so
 * without this every `^~ â€¦` pattern misses them â€” thousands of oracle lines.
 *
 * Case-sensitive on the capital `This`, which is how the templating always renders it; a
 * lowercase "this creature" is a mid-sentence back-reference to some *other* object
 * ("exile target creature, then return this creature") and must not be rewritten.
 *
 * "this card" and "this spell" are deliberately excluded: they refer to the object in a zone
 * where it is not a permanent, which `~` (a battlefield self-reference) would misrepresent.
 */
const SELF_REFERENCE_RE =
  /\bThis (?:creature|artifact|enchantment|land|permanent|token|Vehicle|Equipment|Saga|planeswalker|Aura)\b/g;

/**
 * Replace the card's own name â€” and the short name its rules text actually uses â€” with `~`.
 *
 * Legendary cards are referred to by a short form: "Ryusei, the Falling Star" writes "Ryusei",
 * "Ureni of the Unwritten" writes "Ureni", and "Bladewing the Risen" (no comma at all) writes
 * "Bladewing". All three are the text before whichever of a comma, " of ", or " the " comes
 * FIRST â€” checked as one earliest-wins choice, not three independent substitutions, so a name
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
 * A keyword list as printed â€” "Flying, ward {3}", "Flying, protection from white and from
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

/** Color adjectives a subject can carry ("Black creatures get +1/+1" â€” Bad Moon). */
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

/** English plural forms a creature type could be written as: "Elf" â†’ â€¦/elfs/elves. */
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
 * closed creature-type list, which is what lets a card refer to a tribe it is not a member of â€”
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
 * Parse the subject of an anthem â€” "other Elves you control", "creatures your opponents
 * control" â€” into a `Selector`. Returns null when any part is unrecognized.
 */
function parseSubject(phrase: string, card: OracleCard): Selector | null {
  const parts: Selector[] = [];
  let noun = phrase;

  // "Equipped creature has haste" / "Enchanted creature gets +2/+2" â€” the subject is whatever
  // the source is currently attached to, which is a relation, not a characteristic.
  if (/^(equipped|enchanted|fortified) /.test(noun)) return { kind: 'attachedToSource' };

  if (noun.startsWith('other ')) {
    parts.push(OTHER);
    noun = noun.slice('other '.length);
  }
  // "Nontoken creatures you control have riot" (Rhythm of the Wild) â€” the plural counterpart
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

  // "artifact creatures" is an intersection of card types, not a creature subtype named
  // Artifact. Treating it as a subtype would either reject the line or silently match nothing.
  const compoundTypes = noun.match(/^(artifact|enchantment) (creatures|artifacts|enchantments)$/);
  // "non-Human creatures you control" (Return of the Wildspeaker) â€” a negated tribe, the plural
  // counterpart to the mass-destroy grammar's own "non-Dragon creatures" (which reads the tribe
  // out by hand rather than sharing this function; see the "destroy all non-X creatures" rule).
  const negatedTribe = noun.match(/^non-(.+?) (creatures|artifacts|enchantments|lands|planeswalkers)$/);
  if (compoundTypes !== null) {
    parts.push(ofType(titleCase(compoundTypes[1] as string)));
    parts.push(ofType(CARD_TYPE_PLURALS[compoundTypes[2] as string] as string));
  } else if (negatedTribe !== null) {
    const subtype = resolveSubtype(negatedTribe[1] as string, card);
    if (subtype === null) return null;
    parts.push(not(ofSubtype(subtype)));
    parts.push(ofType(CARD_TYPE_PLURALS[negatedTribe[2] as string] as string));
  } else {
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
  }

  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as Selector) : allOf(...parts);
}

/**
 * "<subject> get +X/+X [and have <keywords>]" / "<subject> have <keywords>" â€” the anthem and
 * lord shape. The same grammar with "gain" instead of "have" and a trailing "until end of
 * turn" is the spell form (Overrun); see `MASS_UNTIL_EOT_RE`.
 */
const ANTHEM_RE =
  /^(.+?) (?:gets? ([+-]\d+)\/([+-]\d+)(?: and (?:have|has) (.+))?|(?:have|has) (.+))$/;

/** The spell form of `ANTHEM_RE` â€” "Creatures you control get +3/+3 â€¦ until end of turn". */
const MASS_UNTIL_EOT_RE =
  /^(.+?) (?:get ([+-]\d+)\/([+-]\d+)(?: and gain (.+?))?|gain (.+?)) until end of turn$/;

/**
 * Parse one sentence into effect primitives (ADR 0004). Returns null when unrecognized.
 * Targeted primitives allocate a slot via `alloc` and reference it by index. Sentences are
 * matched lowercased with `~` substituted for the card's name.
 *
 * `opts.triggerObject` enables the bare "it", which is only meaningful inside a trigger whose
 * subject is some object other than the source. Off by default so a spell's mid-sentence "it"
 * â€” a back-reference to something this grammar has not tracked â€” can never be misread as the
 * trigger referent.
 */
function parseEffectSentence(
  sentence: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: { triggerObject?: boolean; thatMany?: Value; allocCount?: CountSlotAllocator } = {},
): Effect[] | null {
  const s = sentence.toLowerCase();

  if (s === 'it gains haste until end of turn' || s === 'that spell gains haste until end of turn') {
    return [{ op: 'grantHasteToResolvingSpell' }];
  }
  if (s === 'they gain haste until end of turn' || s === 'those creatures gain haste until end of turn') {
    return [{ op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'haste' }];
  }
  if (s === "they can't be regenerated" || s === "it can't be regenerated" || s === "they cannot be regenerated") {
    return [{ op: 'noOp' }];
  }
  if (s === "shuffle ~ into its owner's library" || s === "shuffle ~ into your library") {
    return [{ op: 'shuffle' }];
  }

  if (s === 'target creature you control fights target creature you don\'t control') {
    return [{ op: 'fight', first: alloc('creature', undefined, 'you'), second: alloc('creature', undefined, 'opponent') }];
  }
  if (s === 'it fights target creature you don\'t control' && opts.triggerObject === true) {
    return [{ op: 'fight', first: 'triggerObject', second: alloc('creature', undefined, 'opponent') }];
  }
  if (s === '~ fights target creature you don\'t control') {
    return [{ op: 'fight', first: 'source', second: alloc('creature', undefined, 'opponent') }];
  }
  if (s === 'double the number of each kind of counter on target permanent') {
    return [{ op: 'doubleCountersTarget', target: alloc('permanent') }];
  }
  if (s === 'double the number of each kind of counter on ~') {
    return [{ op: 'doubleCountersTarget', target: 'source' }];
  }
  if (s === 'target player gets a poison counter') {
    return [{ op: 'giveTargetPoisonCounters', target: alloc('player'), count: 1 }];
  }
  if (s === 'each opponent gets a poison counter') {
    return [{ op: 'giveTargetPoisonCounters', target: 'eachOpponent', count: 1 }];
  }
  if (s === '~ becomes a copy of target permanent') {
    return [{ op: 'becomeCopyOf', ref: alloc('permanent') }];
  }
  if (s === '~ becomes a copy of target permanent until end of turn') {
    return [{ op: 'becomeCopyOf', ref: alloc('permanent'), untilEot: true }];
  }
  if (s === 'untap two other target legendary creatures') {
    const filter = allOf(OTHER, ofSupertype('Legendary'));
    const first = alloc('creature', filter);
    const second = alloc('creature', filter);
    return [{ op: 'untapTarget', target: first }, { op: 'untapTarget', target: second }];
  }  if (s === 'untap target permanent') {
    return [{ op: 'untapTarget', target: alloc('anyTarget') }];
  }
  if (s === 'untap another target permanent') {
    return [{ op: 'untapTarget', target: alloc('permanent', OTHER) }];
  }
  if (s === 'untap target artifact') {
    return [{ op: 'untapTarget', target: alloc('artifact') }];
  }
  if (s === 'untap another target artifact') {
    return [{ op: 'untapTarget', target: alloc('artifact', OTHER) }];
  }
  if (s === 'put target artifact card from your graveyard on top of your library') {
    return [{ op: 'graveyardToLibraryTop', target: alloc('cardInGraveyard', ofType('Artifact')) }];
  }
  if (s === 'exile target attacking or blocking creature') {
    return [{ op: 'exile', target: alloc('creature', { kind: 'inCombat' }) }];
  }

  if (s === 'search your library for a dragon card, reveal it, put it into your hand, then shuffle') {
    return [{ op: 'searchLibrary', filter: ofSubtype('Dragon'), destinations: [{ zone: 'hand' }] }];
  }
  if (s === 'destroy all non-dragon creatures') {
    return [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofSubtype('Dragon'))) }];
  }
  if (s === "return target nonland permanent you don't control to its owner's hand") {
    return [{ op: 'returnToHand', target: alloc('nonlandPermanent', undefined, 'opponent') }];
  }
  {
    const m = s.match(
      /^return (?:up to (\w+) )?(other )?target (nonland permanent|creature|permanent)s? to (?:their|its) owners?' hands?$/,
    );
    if (m) {
      const noun = m[3] as string;
      const kind = parseTargetNoun(noun);
      if (kind !== null) {
        const filter = m[2] !== undefined ? OTHER : undefined;
        // "up to N" (Marang River Regent) is a variable-count announcement (CR 601.2b/603.3d),
        // not N separate ordinary slots and not one mandatory slot — the count itself used to be
        // silently dropped here, which turned "up to two, never obliges you" into "return
        // exactly one, mandatory."
        if (m[1] !== undefined) {
          const max = parseAmount(m[1] as string);
          if (max === null || opts.allocCount === undefined) return null;
          const slot = opts.allocCount(kind, { min: 0, max }, undefined, filter);
          return [{ op: 'returnToHandEachChosen', targetSlot: slot }];
        }
        return [{ op: 'returnToHand', target: alloc(kind, filter) }];
      }
    }
  }
  if (s.startsWith("until your next turn, creatures can't attack you")) {
    return [{ op: 'noOp' }];
  }

  // "it gains double strike until end of turn" â€” the trigger's subject (Atarka, World Render).
  if (opts.triggerObject === true) {
    const m = s.match(/^it gains ([a-z ]+) until end of turn$/);
    if (m) {
      if (!KEYWORD_SET.has(m[1] as string)) return null;
      return [
        { op: 'grantKeywordUntilEot', target: 'triggerObject', keyword: m[1] as KeywordAbility },
      ];
    }
  }

  // Aura/Equipment activated effects such as Pemmin's Aura's "{U}: Untap enchanted creature."
  // Their subject is not a target: it is the object currently attached to this source.
  if (s === 'untap enchanted creature' || s === 'untap equipped creature') {
    return [{ op: 'untapTarget', target: 'attachedToSource' }];
  }
  if (s === 'tap enchanted creature' || s === 'tap equipped creature') {
    return [{ op: 'tapTarget', target: 'attachedToSource' }];
  }
  {
    const m = s.match(/^(enchanted|equipped) creature gains ([a-z ]+) until end of turn$/);
    if (m) {
      if (!KEYWORD_SET.has(m[2] as string)) return null;
      return [{ op: 'grantKeywordUntilEot', target: 'attachedToSource', keyword: m[2] as KeywordAbility }];
    }
  }
  {
    const m = s.match(/^(enchanted|equipped) creature gets ([+-]\d+)\/([+-]\d+) until end of turn$/);
    if (m) {
      return [{ op: 'pumpUntilEot', target: 'attachedToSource', power: Number(m[2]), toughness: Number(m[3]) }];
    }
  }
  {
    const m = s.match(/^(enchanted|equipped) creature gets ([+-]\d+)\/([+-]\d+) or ([+-]\d+)\/([+-]\d+) until end of turn$/);
    if (m) {
      return [{
        op: 'chooseOne',
        options: [
          { description: `Enchanted creature gets ${m[2]}/${m[3]} until end of turn`, effects: [{ op: 'pumpUntilEot', target: 'attachedToSource', power: Number(m[2]), toughness: Number(m[3]) }] },
          { description: `Enchanted creature gets ${m[4]}/${m[5]} until end of turn`, effects: [{ op: 'pumpUntilEot', target: 'attachedToSource', power: Number(m[4]), toughness: Number(m[5]) }] },
        ],
      }];
    }
  }
  if (s === "target creature can't be blocked this turn") {
    return [{ op: 'cantBeBlockedUntilEot', target: alloc('creature') }];
  }
  // "target creature gets +3/+3 until end of turn"
  // "~ gets +1/+0 until end of turn" (firebreathing)
  // "target creature gets +2/+2 and gains flying until end of turn"
  {
    const m = s.match(
      /^(target creature|~) gets ([+-]\d+)\/([+-]\d+)(?: and gains ([a-z ]+))? until end of turn$/,
    );
    if (m) {
      const subject = m[1] as string;
      const power = Number(m[2]);
      const toughness = Number(m[3]);
      if (subject === '~') {
        const effects: Effect[] = [{ op: 'pumpEachUntilEot', selector: SELF, power, toughness }];
        if (m[4] !== undefined) {
          if (!KEYWORD_SET.has(m[4])) return null;
          effects.push({
            op: 'grantKeywordEachUntilEot',
            selector: SELF,
            keyword: m[4] as KeywordAbility,
          });
        }
        return effects;
      } else {
        const effects: Effect[] = [
          {
            op: 'pumpUntilEot',
            target: alloc('creature'),
            power,
            toughness,
          },
        ];
        if (m[4] !== undefined) {
          if (!KEYWORD_SET.has(m[4])) return null;
          effects.push({
            op: 'grantKeywordUntilEot',
            target: alloc('creature'),
            keyword: m[4] as KeywordAbility,
          });
        }
        return effects;
      }
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
  // "~ deals 3 damage to any target" / "â€¦ to target creature" / "â€¦ to each opponent"
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
  if (s === 'counter target spell') {
    return [{ op: 'counter', target: alloc('spell', undefined, 'opponent') }];
  }
  if (s === 'counter target noncreature spell') {
    return [{ op: 'counter', target: alloc('noncreatureSpell', undefined, 'opponent') }];
  }
  // "Add {B}{B}{B}." (a ritual spell) / "Add {U}{B}." (the effect half of a signet's activated
  // ability, once its `{1}, {T}` cost has already routed it away from `parseManaAbilityLine` —
  // that function refuses any cost paid in mana, so a rock with a mana activation cost falls
  // through to the ordinary stack-based ability path and needs its production line readable as
  // a ordinary effect too). Fixed symbols only: "Add {U} or {B}" is a player choice, a shape
  // `parseManaProduction`'s `MANA_CHOICE_RE` already owns for true mana abilities and which this
  // sentence-level path does not attempt to duplicate.
  {
    const m = s.match(MANA_ABILITY_RE);
    if (m) {
      const symbols = [...manaSymbols(m[1] as string)];
      return [{ op: 'addMana', amount: constant(symbols.length), colors: [], fixedSymbols: symbols }];
    }
  }
  // "destroy target creature" / "exile target monocolored permanent" / "destroy target artifact you don't control" / â€¦
  {
    const m = s.match(/^(destroy|exile) target (.+)$/);
    if (m) {
      const parsed = parseTargetClause(m[2] as string);
      if (parsed === null) return null;
      const targetSlot = alloc(parsed.kind, parsed.filter, parsed.controller);
      return [{ op: m[1] === 'destroy' ? 'destroy' : 'exile', target: targetSlot }];
    }
  }
  // "destroy all Dragon creatures" / "destroy all non-Dragon creatures" (Crux of Fate's two
  // modes) â€” the untargeted mass form, by tribe.
  {
    const m = s.match(/^destroy all (non-)?(.+?) creatures$/);
    if (m) {
      const subtype = resolveSubtype(m[2] as string, card);
      if (subtype === null) return null;
      const tribe = ofSubtype(subtype);
      const selector = allOf(ofType('Creature'), m[1] !== undefined ? not(tribe) : tribe);
      return [{ op: 'destroyEach', selector }];
    }
  }
  // "it deals 4 damage to any target and 3 damage to each of up to two other targets"
  // (Drakuseth, Maw of Flames) â€” a fixed hit plus a variable-count group of "other" targets,
  // each dealt the same fixed amount independently.
  {
    const m = s.match(
      /^it deals (\w+) damage to any target and (\w+) damage to each of up to (\w+) other targets$/,
    );
    if (m) {
      const first = parseAmount(m[1] as string);
      const each = parseAmount(m[2] as string);
      const maxOther = parseAmount(m[3] as string);
      if (first === null || each === null || maxOther === null || opts.allocCount === undefined) {
        return null;
      }
      const fixedSlot = alloc('anyTarget');
      const otherSlot = opts.allocCount('anyTarget', { min: 0, max: maxOther });
      return [
        { op: 'dealDamage', target: fixedSlot, amount: constant(first) },
        { op: 'dealDamageEachChosen', targetSlot: otherSlot, amount: constant(each) },
      ];
    }
  }
  // "it deals X damage divided as you choose among any number of target creatures and/or
  // planeswalkers your opponents control, where X is the number of lands you control" (Ureni,
  // the Song Unending). Planeswalkers are not a target kind this engine has (scope cut,
  // under-permissive â€” see ADR 0010): only the creature half is offered.
  {
    const m = s.match(
      /^it deals x damage divided as you choose among any number of target creatures(?: and\/or planeswalkers)? your opponents control, where x is the number of lands you control$/,
    );
    if (m && opts.allocCount !== undefined) {
      const slot = opts.allocCount('creature', { min: 0, max: Infinity }, 'opponent');
      return [
        {
          op: 'dealDamageDivided',
          targetSlot: slot,
          total: { kind: 'countPermanents', selector: ofType('Land'), scope: 'you' },
        },
      ];
    }
  }
  // "return target Dragon permanent card from your graveyard to the battlefield" (Bladewing) /
  // "â€¦to your hand" (Haven of the Spirit Dragon) / "return all artifact cards from your graveyard to the battlefield"
  {
    // "return target card from your graveyard to your hand" (Eternal Witness) has no type word
    // between "target" and "card" at all — the filter group is optional, and its absence means
    // an unrestricted `cardInGraveyard` slot (any card, CR 608.2b), not "any permanent card".
    const m = s.match(/^return (?:up to (\w+) )?(other )?target(?: (.+?))? (?:card|cards) from (your|a) graveyard to (the battlefield|your hand)$/);
    if (m) {
      const typePhrase = m[3];
      const filter = typePhrase === undefined ? null : parseCardFilterPhrase(typePhrase, card);
      if (typePhrase === undefined || filter !== null) {
        const target = alloc('cardInGraveyard', filter ?? undefined);
        return [
          m[5] === 'the battlefield'
            ? { op: 'graveyardToBattlefield', target }
            : { op: 'graveyardToHand', target },
        ];
      }
    }
    const mMass = s.match(/^return all (.+?) (?:card|cards) from (your|a) graveyard to (the battlefield|your hand)$/);
    if (mMass) {
      const filter = parseCardFilterPhrase(mMass[1] as string, card);
      if (filter !== null) {
        return [
          mMass[3] === 'the battlefield'
            ? { op: 'graveyardToBattlefieldEach', filter }
            : { op: 'graveyardToHandEach', filter },
        ];
      }
    }
  }
  // Generic mass removal filter ("destroy all creatures that aren't enchanted", "exile all nonland permanents", etc.)
  {
    const m = s.match(/^(destroy|exile|return) all (.+?)(?: to (?:their|its) owners?' hands?)?$/);
    if (m) {
      const action = m[1] as string;
      const phrase = m[2] as string;
      let selector: Selector | null = null;
      if (phrase === 'nonland permanents') {
        selector = not(ofType('Land'));
      } else {
        selector = parseMassSubject(phrase, card);
      }
      if (selector !== null) {
        if (action === 'destroy') return [{ op: 'destroyEach', selector }];
        if (action === 'exile') return [{ op: 'exileEach', selector }];
        if (action === 'return') return [{ op: 'returnToHandEach', selector }];
      }
    }
  }
  // "put a permanent card with mana value less than or equal to that damage from your hand onto
  // the battlefield" (Broodcaller Scourge) â€” a single, bounded, optional pick.
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
  // Ents) â€” the unbounded sibling of the pattern above.
  {
    const m = s.match(/^put any number of (.+) from your hand onto the battlefield$/);
    if (m) {
      const filter = parseCardFilterPhrase(m[1] as string, card);
      if (filter === null) return null;
      return [{ op: 'handToBattlefield', filter, count: 'any' }];
    }
  }
  // "you may put a permanent card from your hand onto the battlefield" (The Ur-Dragon) â€” a
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
  // "put a gold counter on this artifact" â€” a named counter on the ability's own source. Not a
  // target: the one-element `Selector` case, which `putCountersEach` already covers.
  // "put a charge counter on target artifact" / "put two oil counters on target permanent".
  // This comes after the +1/+1-specific form so its counter spelling remains canonical.
  {
    const m = s.match(/^put (\w+) ([a-z0-9+-/]+) counters? on target (.+)$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      const parsed = parseTargetClause(m[3] as string);
      if (count === null || parsed === null) return null;
      return [
        {
          op: 'putCounters',
          target: alloc(parsed.kind, parsed.filter, parsed.controller),
          counter: m[2] as string,
          count,
        },
      ];
    }
  }
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
  // "remove a +1/+1 counter from target creature" / "remove two counters from ~"
  {
    const m = s.match(/^remove (\w+|x) ([a-z0-9+-/]+) counters? from (target [^.]+|~|this [^.]+)$/);
    if (m) {
      const countVal = parseCountPhrase(m[1] as string, opts?.thatMany) ?? (m[1]?.toLowerCase() === 'x' ? { kind: 'xValue' } : null);
      if (countVal !== null) {
        const counter = m[2] as string;
        const targetStr = m[3] as string;
        if (targetStr === '~' || targetStr.startsWith('this')) {
          return [{ op: 'removeCountersEach', selector: SELF, counter, count: countVal }];
        } else {
          const parsed = parseTargetClause(targetStr.replace(/^target /, ''));
          if (parsed !== null) {
            const target = alloc(parsed.kind, parsed.filter, parsed.controller);
            return [{ op: 'removeCounters', target, counter, count: countVal }];
          }
        }
      }
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
  // "mill three cards" / "you mill four cards".
  {
    const m = s.match(/^(?:you )?mill (that many|x|\w+) cards?$/);
    if (m) {
      const count = parseCountPhrase(m[1] as string, opts.thatMany);
      if (count === null) return null;
      return [{ op: 'mill', count }];
    }
  }
  // "discard a card" / "you discard two cards". The controller chooses each card.
  {
    const m = s.match(/^(?:you )?discard (\w+) cards?$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ op: 'discard', count }];
    }
  }
  // "draw cards equal to the greatest toughness among creatures you control" (Last March) /
  // "â€¦ greatest power among non-Human creatures you control" (Return of the Wildspeaker).
  // Bounded to exclude a comma so a trailing ", then â€¦" clause is left for the then-split
  // fallback below, rather than being swallowed into the subject phrase.
  {
    const m = s.match(/^draw cards equal to the greatest (power|toughness) among ([^,]+)$/);
    if (m) {
      const selector = parseSubject(m[2] as string, card);
      if (selector === null) return null;
      const kind = m[1] === 'power' ? 'greatestPowerAmong' : 'greatestToughnessAmong';
      return [{ op: 'draw', count: { kind, selector, scope: 'all' } }];
    }
  }
  // "create a 1/1 black and green Pest creature token with 'â€¦'" / "create that many Treasure
  // tokens" / "create a token that's a copy of it, except the token isn't legendary"
  {
    const parsed = parseCreateTokenSentence(s, card, opts);
    if (parsed !== null) return parsed;
  }
  // "gain control of all Dragons" (Karrthus, Tyrant of Jund). Bounded to exclude a comma so a
  // trailing ", then untap all Dragons" is left for the ", then" fallback split below, rather
  // than being swallowed into the subject phrase (the same hazard Last March's greedy-capture
  // fix already documents).
  {
    const m = s.match(/^gain control of all ([^,]+)$/);
    if (m) {
      const selector = parseSubject(m[1] as string, card);
      if (selector === null) return null;
      return [{ op: 'gainControl', selector }];
    }
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
  // "you lose 2 life" (Infernal Grasp's second sentence; a ritual land's tap ability; etc).
  {
    const m = s.match(/^you lose (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ op: 'loseLife', amount: constant(amount) }];
    }
  }
  // "you draw two cards and lose 2 life" (Night's Whisper) / "you draw a card and you lose 1
  // life" (Phyrexian Arena's upkeep trigger repeats "you" before each verb).
  {
    const m = s.match(/^you draw (\w+) cards? and (?:you )?lose (\w+) life$/);
    if (m) {
      const cards = parseAmount(m[1] as string);
      const life = parseAmount(m[2] as string);
      if (cards === null || life === null) return null;
      return [{ op: 'draw', count: constant(cards) }, { op: 'loseLife', amount: constant(life) }];
    }
  }
  // "each opponent loses 1 life" / "each opponent loses 1 life and you gain 1 life" (the
  // aristocrats drain template: Zulaport Cutthroat, Cauldron of Essence, Syr Konrad's activated
  // ability). "Target player loses 1 life and you gain 1 life" (Blood Artist) is the same
  // template with a targeted victim instead of every opponent.
  {
    const m = s.match(/^each opponent loses (\w+) life(?: and you gain (\w+) life)?$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      const effects: Effect[] = [{ op: 'eachOpponentLosesLife', amount }];
      if (m[2] !== undefined) {
        const gain = parseAmount(m[2] as string);
        if (gain === null) return null;
        effects.push({ op: 'gainLife', amount: constant(gain) });
      }
      return effects;
    }
  }
  {
    const m = s.match(/^target player loses (\w+) life(?: and you gain (\w+) life)?$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      const effects: Effect[] = [
        { op: 'loseLifeTarget', target: alloc('player'), amount: constant(amount) },
      ];
      if (m[2] !== undefined) {
        const gain = parseAmount(m[2] as string);
        if (gain === null) return null;
        effects.push({ op: 'gainLife', amount: constant(gain) });
      }
      return effects;
    }
  }
  // "~ deals 5 damage to each creature without flying" (Ryusei) / "it deals 3 damage to â€¦"
  // (Thunder Dragon â€” "it" is the source, both cards' triggers being self-subjected).
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
  // "proliferate" — the resolver asks its controller which eligible permanents and players to affect.
  if (/^proliferate$/i.test(s)) return [{ op: 'proliferate' }];
  // "surveil 1" — choose each looked-at card to keep on top or put into the graveyard.
  {
    const m = s.match(/^surveil (\w+)$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ op: 'surveil', count }];
    }
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
  // "<effect>, then <effect>" â€” two atomic effects sequenced in one printed sentence (Last
  // March: "draw â€¦, then put â€¦"). A fallback tried last, so a whole-sentence pattern above that
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
 * "Choose one â€”\nâ€¢ Destroy all Dragon creatures.\nâ€¢ Destroy all non-Dragon creatures." (CR
 * 700.2, Crux of Fate) â€” a modal spell. Parsed as a whole block, over the RAW multi-line text,
 * because the mode choice is announcement-time (CR 601.2b): each bullet becomes one entry of
 * `Ability.modes`, not a plain sentence merged into the ability's own `effects`.
 */
/** Spree (CR 702): choose one or more modes, paying each chosen mode's additional cost. */
function parseSpreeSpellBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; modes: NonNullable<Ability['modes']> } | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3 || lines[0]?.toLowerCase() !== 'spree') return null;
  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter, controller) => {
    targets.push({ kind, ...(filter !== undefined ? { filter } : {}), ...(controller !== undefined ? { controller } : {}) });
    return targets.length - 1;
  };
  const options: NonNullable<Ability['modes']>['options'] = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^\+\s*((?:\{[^}]+\})+)\s*[—–-]\s*(.+?)\.?$/);
    if (match === null) return null;
    const parsedCost = parseManaCost((match[1] as string).toUpperCase() as never);
    if (parsedCost.cost === null) return null;
    const description = match[2] as string;
    const firstTargetSlot = targets.length;
    const effects = parseEffectSentence(description, alloc, card);
    if (effects === null) return null;
    const targetSlots = Array.from({ length: targets.length - firstTargetSlot }, (_, index) => firstTargetSlot + index);
    options.push({ description, effects, additionalCost: [{ kind: 'mana', cost: parsedCost.cost }], targetSlots });
  }
  return { targets, modes: { minChoices: 1, maxChoices: options.length, options } };
}
function parseModalSpellBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; modes: NonNullable<Ability['modes']> } | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) return null;
  const header = (lines[0] as string).match(
    /^choose (one|one or more|one or both|any number|two|three)\s*(?:\u2014|-)\s*$/i,
  );
  if (header === null) return null;

  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter) => {
    targets.push(filter === undefined ? { kind } : { kind, filter });
    return targets.length - 1;
  };

  const options: NonNullable<Ability['modes']>['options'] = [];
  for (const bulletLine of lines.slice(1)) {
    const m = bulletLine.match(/^\u2022\s*(.+?)\.?$/);
    if (m === null) return null;
    const sentence = m[1] as string;
    const firstTargetSlot = targets.length;
    const parsed = parseEffectSentence(sentence, alloc, card);
    if (parsed === null) return null;
    const targetSlots = Array.from({ length: targets.length - firstTargetSlot }, (_, index) => firstTargetSlot + index);
    options.push({ effects: parsed, description: sentence, targetSlots });
  }
  if (options.length < 2) return null;
  const choice = (header[1] as string).toLowerCase();
  // "Choose two —" (Austere Command) is an exact count (CR 700.2d), unlike the "at least"/"up
  // to" headers above it: it must pick precisely N different modes, not merely up to N.
  const exact = choice === 'two' ? 2 : choice === 'three' ? 3 : null;
  const minChoices = exact ?? (choice === 'any number' ? 0 : 1);
  const maxChoices =
    exact ?? (choice === 'one' ? 1 : choice === 'one or both' ? Math.min(2, options.length) : options.length);
  return { targets, modes: { minChoices, maxChoices, options } };
}

/**
 * "Counter target noncreature spell unless its controller pays `<cost>`.\nFerocious â€” if you
 * control a creature with power 4 or greater, counter that spell instead." (Stubborn Denial) â€”
 * parsed as a whole two-line block because "counter THAT SPELL" in line 2 must be the SAME
 * target line 1 declares, not a target slot of its own; a per-line parse (like every other
 * spell effect) would allocate line 2 a fresh, unconnected slot.
 */
function parseCounterUnlessFerociousBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim().replace(/\.$/, '').toLowerCase())
    .filter((l) => l.length > 0);
  if (lines.length !== 2) return null;

  const base = (lines[0] as string).match(
    /^counter target noncreature spell unless its controller pays (\{[^}]+\})$/,
  );
  if (base === null) return null;
  const parsedCost = parseManaCost((base[1] as string).toUpperCase() as never);
  if (parsedCost.cost === null) return null;

  const ferocious = (lines[1] as string).match(
    /^ferocious\s*(?:\u2014|-)\s*if you control (.+), counter that spell instead$/,
  );
  if (ferocious === null) return null;
  const condition = parseConditionClause(`you control ${ferocious[1] as string}`, card);
  if (condition === null) return null;

  return {
    targets: [{ kind: 'noncreatureSpell', controller: 'opponent' }],
    effects: [
      {
        op: 'conditionalEffect',
        condition,
        then: [{ op: 'counter', target: 0 }],
        else: [{ op: 'counterUnlessControllerPays', target: 0, cost: parsedCost.cost }],
      },
    ],
  };
}

function parseHuntersInsightBlock(
  text: string,
  _card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const norm = stripReminderText(text).trim();
  const re =
    /^choose target creature you control\. whenever that creature deals combat damage to a player(?: or planeswalker)? this turn, draw that many cards\.?$/i;
  if (re.test(norm)) {
    return {
      targets: [{ kind: 'creature', controller: 'you' }],
      effects: [
        {
          op: 'registerDelayedTrigger',
          target: 0,
          when: 'dealsCombatDamageToPlayer',
          expiry: 'cleanup',
          ability: {
            kind: 'triggered',
            targets: [],
            effects: [{ op: 'draw', count: { kind: 'damageDealt' } }],
          },
        },
      ],
    };
  }
  return null;
}

/**
 * "Destroy target permanent. Its controller creates a 3/3 green Beast creature token." (Beast
 * Within) / "â€¦ creature. It can't be regenerated. Its controller creates a 3/3 green Ape creature
 * token." (Pongify) / "â€¦ That creature's controller creates a â€¦" (Rapid Hybridization). One
 * combined effect rather than two independent sentences: `destroyAndCreateTokenForController`
 * reads the target's controller before the destroy resolves, which a plain `parseEffectSentence`
 * pass over "its controller creates â€¦" in isolation has no way to do (nothing upstream of it in
 * the sentence list is in scope). Tried as a whole-card block, same as the modal/Ferocious/Hunter's
 * Insight blocks above, so it can see both sentences together.
 */
function parseDestroyAndCreateTokenBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const norm = stripReminderText(text).trim();
  const m = norm.match(
    /^destroy target (.+?)\.(?: it can't be regenerated\.)? (?:its|that creature's) controller creates (a .+ token)\.?$/i,
  );
  if (m === null) return null;
  const targetClause = parseTargetClause((m[1] as string).toLowerCase());
  if (targetClause === null) return null;
  const spec = parseTokenFace((m[2] as string).replace(/^an?\s+/i, '').replace(/\.$/, ''), card);
  if (spec === null) return null;
  return {
    targets: [
      {
        kind: targetClause.kind,
        ...(targetClause.filter !== undefined ? { filter: targetClause.filter } : {}),
        ...(targetClause.controller !== undefined ? { controller: targetClause.controller } : {}),
      },
    ],
    effects: [{ op: 'destroyAndCreateTokenForController', target: 0, count: constant(1), spec }],
  };
}

function parseHellkiteCourserBlock(
  body: string,
  alloc: SlotAllocator,
  _card: OracleCard,
): Effect[] | null {
  const norm = body.trim();
  const re =
    /^put a commander you own from the command zone onto the battlefield\. it gains haste\. return it to the command zone at the beginning of the next end step\.?$/i;
  if (re.test(norm)) {
    const slot = alloc('commanderInCommandZone');
    return [
      { op: 'commandZoneToBattlefield', target: slot, entersHaste: true },
      {
        op: 'registerDelayedTrigger',
        target: slot,
        when: 'endStep',
        expiry: 'endStep',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'returnToCommandZone', target: 'triggerObject' }],
        },
      },
    ];
  }
  return null;
}

function parseHerdHeirloomEffect(
  effectText: string,
  alloc: SlotAllocator,
  _card: OracleCard,
): Effect[] | null {
  const norm = effectText.trim();
  const m = norm.match(
    /^until end of turn, target creature you control with power (\d+) or greater gains trample and "whenever this creature deals combat damage to a player, draw a card\.?"$/i,
  );
  if (m !== null) {
    const minPower = Number(m[1]);
    const targetSlot = alloc('creature', powerAtLeast(minPower), 'you');
    return [
      { op: 'grantKeywordUntilEot', target: targetSlot, keyword: 'trample' },
      {
        op: 'grantAbilityUntilEot',
        target: targetSlot,
        ability: {
          kind: 'triggered',
          trigger: { when: 'dealsCombatDamageToPlayer', subject: SELF_SUBJECT },
          targets: [],
          effects: [{ op: 'draw', count: constant(1) }],
        },
      },
    ];
  }
  return null;
}

/**
 * A damage amount as printed: a number word, or `X` (the announced value, CR 601.2b).
 *
 * Returns a `Value` rather than a number so "X damage" and "3 damage" take the same executor
 * path â€” the alternative is a parallel set of ops that differ only in how the number arrives.
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
 * The subject of a mass effect â€” "each creature without flying", "each Dragon you control".
 * Plural `parseSubject` with a singular head, plus the keyword clause only mass effects use.
 */
function parseMassSubject(phrase: string, card: OracleCard): Selector | null {
  let noun = phrase;
  const parts: Selector[] = [];

  const enchantedClause = noun.match(/^(.+) that (?:aren't|are not) enchanted$/i);
  if (enchantedClause !== null) {
    parts.push(not(IS_ENCHANTED));
    noun = enchantedClause[1] as string;
  }

  const equippedClause = noun.match(/^(.+) that (?:aren't|are not) equipped$/i);
  if (equippedClause !== null) {
    parts.push(not(IS_EQUIPPED));
    noun = equippedClause[1] as string;
  }

  const powerClause = noun.match(/^(.+) with power (\d+) or greater$/i);
  if (powerClause !== null) {
    parts.push(powerAtLeast(Number(powerClause[2])));
    noun = powerClause[1] as string;
  }

  // "destroy all creatures with mana value 3 or less" / "â€¦4 or greater" (Austere Command).
  const manaValueClause = noun.match(/^(.+) with mana value (\d+) or (less|greater)$/i);
  if (manaValueClause !== null) {
    const n = Number(manaValueClause[2]);
    parts.push(manaValueClause[3]?.toLowerCase() === 'less' ? manaValueAtMost(n) : manaValueAtLeast(n));
    noun = manaValueClause[1] as string;
  }

  // "â€¦without flying" / "â€¦with flying". Event-only (see `cards/selector.ts`): safe here because
  // a resolving spell reads keywords once, after the layer pass has produced them.
  const keywordClause = noun.match(/^(.+) with(out)? ([a-z ]+)$/i);
  if (keywordClause !== null) {
    const keyword = keywordClause[3] as string;
    if (KEYWORD_SET.has(keyword)) {
      const leaf = withKeyword(keyword);
      parts.push(keywordClause[2] === undefined ? leaf : not(leaf));
      noun = keywordClause[1] as string;
    }
  }

  const subject = parseSubject(noun, card) ?? parseTriggerSubject(noun, card);
  if (subject === null) return null;
  parts.push(subject);
  return parts.length === 1 ? (parts[0] as Selector) : allOf(...parts);
}

/**
 * "Search your library for <what>, put <them> <where>, then shuffle" (CR 701.19) â€” the
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

/** "a Plains, Island, Swamp, or Mountain card" / "up to two basic land cards" â†’ a `Selector`. */
function parseSearchFilter(phrase: string, card: OracleCard): Selector | null {
  const noun = phrase.replace(/^(?:up to \w+|a|an) /, '').replace(/ cards?$/, '');

  // "a card" (Demonic Tutor) â€” unrestricted, not narrowed to permanent types the way
  // `parseCardFilterPhrase`'s bare "card"/"permanent" is for its (zone-restricted) callers.
  // `allOf()` with no operands is vacuously true (CR-accurate: every `every()` over an empty
  // list holds), so it matches any card in the library without a dedicated "match anything"
  // selector kind.
  if (noun === 'card' || noun === 'cards') return allOf();

  // "basic land" â€” a supertype plus a type, not a subtype.
  if (noun === 'basic land') return allOf(ofSupertype('Basic'), ofType('Land'));

  // "Plains, Island, Swamp, or Mountain" â€” a list of land subtypes, any of which qualifies.
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
 * "Dragon permanent card" / "creature card" / "permanent card" â†’ a `Selector` matching cards in
 * a non-battlefield zone by their PRINTED characteristics (`state/queries.ts::cardZoneCandidate`).
 *
 * Distinct from `parseTriggerSubject`: "permanent" is not a real card type (CR 110), so a bare
 * "permanent card" means "any of the six permanent card types", not a single `ofType`.
 */
function parseCardFilterPhrase(phrase: string, card: OracleCard): Selector | null {
  // "a Dragon creature card or Ugin planeswalker card" / "a Dragon spell or an Omen spell" â€”
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
  // "legendary creature card" combines a supertype with the ordinary card filter. Keep this
  // here rather than teaching trigger subjects about card-zone-only wording.
  const legendary = noun.match(/^legendary (.+)$/);
  if (legendary !== null) {
    const rest = parseCardFilterPhrase(legendary[1] as string, card);
    return rest === null ? null : allOf(ofSupertype('Legendary'), rest);
  }
  const anyPermanentType = (): Selector => anyOf(...PERMANENT_CARD_TYPES.map((t) => ofType(t)));
  if (noun === 'permanent' || noun === 'card' || noun === 'cards') return anyPermanentType();
  const cardType = CARD_TYPE_PLURALS[noun] ?? ((PERMANENT_CARD_TYPES as readonly string[]).includes(titleCase(noun)) ? titleCase(noun) : undefined);
  if (cardType !== undefined) return ofType(cardType);
  const m = noun.match(/^(.+) permanent$/);
  if (m !== null) {
    const subtype = resolveSubtype(m[1] as string, card);
    return subtype === null ? null : allOf(ofSubtype(subtype), anyPermanentType());
  }
  return parseTriggerSubject(noun, card);
}

/**
 * "put it onto the battlefield tapped" / "put one onto the battlefield tapped and the other
 * into your hand" â†’ one destination per card the search may find, in the order the player is
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
 * "When ~ enters" / "Whenever a Dragon you control attacks" â€” one shape covering both, because
 * they are the same event seen from two vantage points (see `TriggerSubject`).
 */
const OBJECT_TRIGGER_HEAD_RE =
  /^when(?:ever)? (.+?) (enters(?: the battlefield)?(?: or attacks)?|dies|attacks|deals combat damage to a player), (.*)$/;
const STEP_TRIGGER_HEAD_RE =
  /^at the beginning of (your|each(?: player's)?) (upkeep|end step), (.*)$/;
/**
 * "Whenever **one or more** Dragons you control attack" â€” the aggregate form (CR 603.2c). The
 * plural subject is stripped back to its singular here so `parseTriggerSubject` sees the same
 * phrase it would in the ordinary form; the aggregation is a flag on the head, not a different
 * selector.
 */
const AGGREGATE_TRIGGER_HEAD_RE =
  /^whenever one or more (.+?) (attack|deal combat damage to a player), (.*)$/;
/** "Whenever you cast a Dragon spell" (CR 603.2). */
const CAST_TRIGGER_HEAD_RE = /^whenever (you|an opponent) casts? (.+?), (.*)$/;
/** The intervening-if clause (CR 603.4): "â€¦, if you control a Dragon, draw a card". */
const INTERVENING_IF_RE = /^if (.+?), (.+)$/;

/**
 * Self-reference in a trigger head. `~` is the substituted card name; the "this <type>" forms
 * appear here in LOWERCASE ("When this enchantment enters"), so `SELF_REFERENCE_RE` â€” which is
 * deliberately case-sensitive, to leave mid-sentence back-references alone â€” does not catch
 * them. In a trigger head the ambiguity it guards against cannot arise: nothing precedes the
 * subject for "this" to refer back to.
 */
const SELF_TRIGGER_SUBJECT_RE =
  /^(?:~|this (?:creature|artifact|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker|aura))$/;

/** Singular card types that can head a trigger subject ("a creature you control"). */
const CARD_TYPE_SINGULARS: Record<string, string> = {
  creature: 'Creature',
  artifact: 'Artifact',
  enchantment: 'Enchantment',
  land: 'Land',
  planeswalker: 'Planeswalker',
};

/**
 * The subject of an object trigger â€” "a Dragon you control", "another creature you control
 * with power 4 or greater" â€” as a `Selector`. The singular counterpart to `parseSubject`,
 * which reads the plural noun phrases anthems use.
 *
 * Returns null for anything unrecognized, leaving the card unmodeled: a trigger with a subject
 * that silently matches nothing would never fire, which is a misplay every game.
 */
function parseTriggerSubject(phrase: string, card: OracleCard): Selector | null {
  // Aura/Equipment combat triggers refer to the permanent attached to this source.
  if (/^(equipped|enchanted) creature$/.test(phrase)) return { kind: 'attachedToSource' };
  const selfOrOther = phrase.match(
    /^(?:~|this (?:creature|artifact|enchantment|land|permanent)) or another (.+)$/,
  );
  if (selfOrOther !== null) {
    const rest = parseTriggerSubject('another ' + selfOrOther[1], card);
    if (rest !== null) {
      return anyOf(SELF, rest);
    }
  }
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

  // "â€¦with power 4 or greater" is the outermost clause, so it comes off before the control
  // suffix it wraps. Event-only â€” see `powerAtLeast` in `cards/selector.ts`.
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
 * Treasure token" says nothing about what a Treasure *is* â€” the face is defined by the rules,
 * so it has to be spelled out here or the token would enter as a blank artifact.
 */
const PREDEFINED_TOKENS: Record<string, TokenSpec> = {
  // Was hand-spelled here with `typeLine: 'Token Artifact — Treasure'` (encoding-corrupted in
  // source to boot) â€” disagreeing with `tokens.ts`'s `TREASURE` on the type line, though the two
  // mana-ability costs happened to match. One token, one spelling.
  treasure: TREASURE,
};

/** "1/1 black and green Pest creature token" â†’ a `TokenSpec`, or null if any part is unread. */
function parseTokenFace(phrase: string, card: OracleCard): TokenSpec | null {
  const predefined = PREDEFINED_TOKENS[phrase.replace(/ tokens?$/, '').trim()];
  if (predefined !== undefined) return predefined;

  const m = phrase.match(/^(legendary\s+)?(\d+|x|\*)\/(\d+|x|\*) (.+?)(?: (artifact creature|creature|artifact))? tokens?$/i);
  if (m === null) return null;

  const legendary = m[1] !== undefined;
  const powerStr = m[2] as string;
  const toughnessStr = m[3] as string;
  let power: number | Value | null;
  let toughness: number | Value | null;
  if (/^\d+$/.test(powerStr)) {
    power = Number(powerStr);
  } else if (powerStr.toUpperCase() === 'X') {
    power = { kind: 'xValue' };
  } else {
    power = null;
  }
  if (/^\d+$/.test(toughnessStr)) {
    toughness = Number(toughnessStr);
  } else if (toughnessStr.toUpperCase() === 'X') {
    toughness = { kind: 'xValue' };
  } else {
    toughness = null;
  }

  let rest = (m[4] as string).trim();
  const colors: Color[] = [];
  if (rest.startsWith('colorless ')) {
    rest = rest.slice('colorless '.length).trim();
  } else {
    for (;;) {
      const colorMatch = rest.match(/^(white|blue|black|red|green)(?: and )?(.*)$/i);
      if (colorMatch === null || !colorMatch[1]) break;
      const c = COLOR_WORDS[colorMatch[1].toLowerCase()];
      if (c !== undefined) colors.push(c);
      rest = (colorMatch[2] ?? '').trim();
    }
  }

  const kindPhrase = m[5] ?? 'creature';
  const types: string[] = [];
  if (kindPhrase.includes('artifact')) types.push('Artifact');
  if (kindPhrase.includes('creature') || !types.includes('Artifact')) types.push('Creature');

  const subtypes: string[] = [];
  const words = rest.split(/\s+/);
  for (const word of words) {
    if (word.length === 0) continue;
    const sub = resolveSubtype(word, card);
    if (sub !== null) {
      subtypes.push(sub);
    }
  }
  if (subtypes.length === 0 && rest.length > 0) {
    const singleSub = resolveSubtype(rest, card);
    if (singleSub !== null) subtypes.push(singleSub);
  }
  if (subtypes.length === 0) return null;

  const name = subtypes.join(' ');
  const typeLine = `Token ${types.join(' ')} â€” ${subtypes.join(' ')}`;

  return {
    name,
    typeLine,
    types,
    subtypes,
    colors,
    power,
    toughness,
    ...(legendary ? { legendary: true } : {}),
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
  const copy = s.match(/^create (a|that many|\w+) tokens? that's a copy of it(, except .+)?$/i);
  if (copy !== null) {
    if (opts.triggerObject !== true) return null;
    const except = copy[2] ?? '';
    if (except !== '' && !/except the token isn't legendary/i.test(except)) return null;
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

  const m = s.match(
    /^create (a|an|two|three|four|five|\d+|x|that many|a number of [^,]+ equal to [^,]+)?\s*(tapped )?(?:([a-z\s]+),\s+(?:a|an)\s+)?(.+?)(?: with (?:"(.+)"|([a-z]+(?:,\s*[a-z]+)*(?:\s+and\s+[a-z]+)*)))?$/i,
  );
  if (m === null) return null;

  const countStr = m[1] as string | undefined;
  let count: Value | null;
  if (!countStr) {
    count = constant(1);
  } else if (countStr.toLowerCase().startsWith('a number of')) {
    const equalMatch = countStr.match(/equal to (.+)$/i);
    if (equalMatch && equalMatch[1]) {
      const clause = equalMatch[1].trim();
      if (clause === 'its power' || clause === 'its toughness') {
        count = { kind: 'damageDealt' };
      } else {
        count = parseCountPhrase(clause, opts?.thatMany);
      }
    } else {
      count = parseCountPhrase(countStr, opts?.thatMany);
    }
  } else {
    count = parseCountPhrase(countStr, opts?.thatMany) ?? (countStr.toLowerCase() === 'x' ? { kind: 'xValue' } : null);
  }
  if (count === null) return null;

  const tapped = m[2] !== undefined;
  const customName = m[3];
  const faceStr = m[4] as string;

  const spec = parseTokenFace(faceStr, card);
  if (spec === null) return null;

  if (customName) {
    spec.name = customName.trim();
    spec.legendary = true;
  }

  const bareKeywords = m[6];
  if (bareKeywords !== undefined) {
    const parsed = parseKeywordLine(bareKeywords);
    if (parsed === null || parsed.ward !== undefined || parsed.protectionFrom !== undefined) {
      return null;
    }
    return [{ op: 'createToken', spec: { ...spec, keywords: parsed.keywords }, count, ...(tapped ? { tapped: true } : {}) }];
  }

  const granted = m[5];
  if (granted !== undefined) {
    const triggers = parseTriggerLine(granted.replace(/^this token /i, 'this creature '), card);
    if (triggers === null) return null;
    return [{ op: 'createToken', spec: { ...spec, triggers }, count, ...(tapped ? { tapped: true } : {}) }];
  }

  return [{ op: 'createToken', spec, count, ...(tapped ? { tapped: true } : {}) }];
}

/** Sentinel for "whenever you cast **a spell**" â€” no filter at all, which is not the same as an
 * unparseable one. Compared by identity, never matched against anything. */
const ANY_SPELL: Selector = { kind: 'type', value: '*any spell*' };

/**
 * The spell a `castsSpell` trigger watches â€” "a Dragon spell", "a creature spell", "a Dragon
 * creature spell".
 *
 * A spell is matched on card characteristics, so this reuses `parseTriggerSubject` after
 * stripping the trailing "spell": "a Dragon spell" and "a Dragon" describe the same
 * characteristics, and only the zone differs.
 */
function parseSpellFilter(phrase: string, card: OracleCard): Selector | null {
  const noun = phrase.replace(/ spells?$/, '').replace(/^an? /, '');
  if (noun === '' || noun === 'a' || noun === 'an') return ANY_SPELL;
  if (noun === 'noncreature') return not(ofType('Creature'));
  // "an instant or sorcery spell" (Archmage Emeritus) â€” each side is its own card type, not a
  // tribe the way `parseTriggerSubject`'s "or" handling elsewhere reads alternatives.
  const orTypes = noun.match(/^(instant|sorcery|artifact|creature|enchantment|planeswalker|land) or (?:an? )?(instant|sorcery|artifact|creature|enchantment|planeswalker|land)$/);
  if (orTypes !== null) {
    return anyOf(ofType(titleCase(orTypes[1] as string)), ofType(titleCase(orTypes[2] as string)));
  }
  return parseTriggerSubject(noun, card);
}

/**
 * A condition clause as rules text writes it â€” "you control a creature with power 4 or
 * greater". Reuses `parseTriggerSubject`, so anything expressible as a trigger subject is
 * automatically countable here too.
 */
function parseConditionClause(clause: string, card: OracleCard): Condition | null {
  if (clause === 'it was kicked' || clause === 'this spell was kicked') {
    return { kind: 'wasKicked' };
  }
  if (clause === 'a creature or planeswalker an opponent controlled was dealt excess damage this turn') {
    return { kind: 'excessDamageDealtTo', scope: 'opponents' };
  }
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

  // "Whenever a creature you control enters, this enchantment deals 1 damage to each opponent"
  // (Impact Tremors) — a self-reference that is unambiguous here (the trigger head already
  // named a DIFFERENT subject; nothing else in `body` yet could be what "this" refers to) but
  // prints lowercase, since it falls mid-sentence rather than at the start of a new one.
  // `substituteSelfName`'s `SELF_REFERENCE_RE` is deliberately case-sensitive on capital "This"
  // for exactly the opposite reason — mid-EFFECT lowercase "this" is usually a back-reference to
  // an object the effect itself introduced earlier ("exile target creature, then return this
  // creature") — so this only rewrites the leading word of the body, never a later sentence.
  body = body.replace(
    /^this (creature|artifact|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker|aura)\b/,
    '~',
  );

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
  // A variable-count slot ("up to two other targets", "any number of target creatures") â€” see
  // `CountSlotAllocator`. Always allocated after every ordinary slot the same trigger declares,
  // which is what lets `pushTriggerOnStack` keep the ordinary `targets` array dense.
  const allocCount: CountSlotAllocator = (kind, count, controller, filter) => {
    targets.push({
      kind,
      count,
      ...(controller !== undefined ? { controller } : {}),
      ...(filter !== undefined ? { filter } : {}),
    });
    return targets.length - 1;
  };

  // "it" is only meaningful when the trigger watches an object other than its own source.
  const firstHead = heads[0] as TriggerHead;
  const opts = {
    triggerObject: 'subject' in firstHead && firstHead.subject.kind === 'permanent',
    allocCount,
    // What "that many" refers back to. A combat-damage head makes it the damage; an aggregate
    // head makes it the number of objects. See `parseCountPhrase`.
    ...(firstHead.when === 'dealsCombatDamageToPlayer'
      ? { thatMany: { kind: 'damageDealt' } as Value }
      : 'aggregate' in firstHead && firstHead.aggregate === true
        ? { thatMany: { kind: 'triggerCount' } as Value }
        : {}),
  };

  // A whole-body pattern first: some effects span several sentences that only mean anything
  // together ("look at the top eight â€¦ put the rest â€¦", Klauth's mana-then-restriction-then-
  // persistence).
  let effects =
    parseLookAtTopBlock(body, card) ??
    parseAddManaTriggerBlock(body, card) ??
    parseHellkiteCourserBlock(body, alloc, card);
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
 * The noun phrase after "target" â†’ a `TargetKind`. Returns null for anything unlisted so the
 * card stays unmodeled rather than being silently retargeted at the wrong thing.
 */
const TARGET_NOUNS: Record<string, TargetKind> = {
  creature: 'creature',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
  permanent: 'permanent',
  'nonland permanent': 'nonlandPermanent',
  'artifact or enchantment': 'artifactOrEnchantment',
  'artifact, enchantment, or planeswalker': 'artifactEnchantmentOrPlaneswalker',
  player: 'player',
  opponent: 'player',
};

function parseTargetNoun(noun: string): TargetKind | null {
  return TARGET_NOUNS[noun.trim()] ?? null;
}

/**
 * "Artifact, creature, or planeswalker" / "creature or enchantment" â€” an arbitrary permanent-type
 * alternation that `TARGET_NOUNS` doesn't special-case. Rather than adding a new `TargetKind`
 * literal (and a new `permanentMatchesKind` branch) for every combination removal spells happen
 * to print â€” Bedevil, Mortify, Putrefy, Despark's "with mana value N or greater" restriction all
 * want a different subset â€” this composes the general `permanent` kind (matches everything) with
 * an `anyOf(ofType(...))` filter, which the target-legality code already applies on top of any
 * kind. Two or more comma/"or"-separated single-word type nouns, each a known permanent type;
 * anything else (a card name, a qualifier, a single noun already in `TARGET_NOUNS`) returns null.
 */
const PERMANENT_TYPE_NOUNS: Record<string, string> = {
  creature: 'Creature',
  artifact: 'Artifact',
  enchantment: 'Enchantment',
  land: 'Land',
  planeswalker: 'Planeswalker',
};

function parseCompoundPermanentTypeNoun(text: string): Selector | null {
  const parts = text
    .split(/,| or /)
    .map((p) => p.replace(/^and\s+/, '').trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const types: string[] = [];
  for (const part of parts) {
    const type = PERMANENT_TYPE_NOUNS[part];
    if (type === undefined) return null;
    types.push(type);
  }
  return anyOf(...types.map((t) => ofType(t)));
}

function parseTargetClause(text: string): { kind: TargetKind; filter?: Selector; controller?: 'you' | 'opponent' } | null {
  let cleaned = text.trim();
  let controller: 'you' | 'opponent' | undefined = undefined;
  if (cleaned.endsWith("you don't control") || cleaned.endsWith("an opponent controls")) {
    controller = 'opponent';
    cleaned = cleaned.replace(/\s+(you don't control|an opponent controls)$/, '').trim();
  } else if (cleaned.endsWith("you control")) {
    controller = 'you';
    cleaned = cleaned.replace(/\s+you control$/, '').trim();
  }

  let filter: Selector | undefined = undefined;
  if (cleaned.startsWith("monocolored ")) {
    filter = IS_MONOCOLORED;
    cleaned = cleaned.replace(/^monocolored\s+/, '').trim();
  }

  const kind = parseTargetNoun(cleaned);
  if (kind !== null) {
    return { kind, ...(filter !== undefined ? { filter } : {}), ...(controller !== undefined ? { controller } : {}) };
  }

  // Not one of the named single/compound target kinds â€” try reading it as an arbitrary
  // permanent-type alternation instead (see `parseCompoundPermanentTypeNoun`). `filter` can
  // already hold `IS_MONOCOLORED` from above; combine rather than overwrite.
  const compound = parseCompoundPermanentTypeNoun(cleaned);
  if (compound === null) return null;
  return {
    kind: 'permanent',
    filter: filter === undefined ? compound : allOf(filter, compound),
    ...(controller !== undefined ? { controller } : {}),
  };
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
 * The "unless â€¦" clause of a conditional-enters-tapped land â†’ a `Condition`. Returns null for
 * anything unlisted, leaving the card unmodeled rather than guessing a predicate â€” a land that
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
  // "you control a Mountain or a Forest" â€” a subtype list, any of which satisfies it.
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
  // "you control two or more other lands" / "â€¦ two or fewer other lands"
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

/** Basic land types (CR 305.6) â€” the vocabulary a checkland's "unless you control a â€¦" uses. */
const LAND_SUBTYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];

/**
 * How a card refers to itself mid-sentence. `~` is the substituted card name; the lowercase
 * "this <type>" forms survive `substituteSelfName` (which is case-sensitive by design â€” see
 * `SELF_REFERENCE_RE`) and are accepted only in positions where nothing else can be meant.
 */
const SELF_OBJECT_RE =
  /^(?:~|this (?:artifact|creature|enchantment|land|permanent|token|vehicle|equipment|saga|planeswalker))$/;

const MANA_ABILITY_RE = /^add ((?:\{[wubrgc]\})+)$/;
/** "Add {G} or {W}." / "Add {W}, {U}, or {B}." â€” ONE unit, several symbol choices. */
const MANA_CHOICE_RE = /^add (\{[wubrgc]\}(?:,? (?:or )?\{[wubrgc]\})+)$/;
/** "Add one mana of any color." â€” one unit, any of the five colors. */
const MANA_ANY_COLOR_RE = /^add one mana of any color$/;
const ALL_COLORS: ManaUnit = ['W', 'U', 'B', 'R', 'G'];

/**
 * "Add one mana of any color. If you control a creature with power 4 or greater, add two mana
 * of any one color instead." (Ilysian Caryatid) â€” a conditional AMOUNT: when the condition
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
 * the mana ability, not a separate ability â€” mana abilities never use the stack (CR 605.3a), so
 * it applies the moment the mana is produced.
 */
const MANA_WITH_SELF_DAMAGE_RE =
  /^add (\{[wubrgc]\}(?:,? (?:or )?\{[wubrgc]\})*)\. ~ deals (\d+) damage to you$/;

/** "Add one mana of any color. Activate only if you control a Dragon." (Mox Jasper) */
const MANA_ACTIVATE_ONLY_IF_RE = /^(add [^.]+)\. activate only if you control (?:a|an) (.+)$/;

/**
 * "â€¦Spend this mana only to cast a Dragon creature spell." (Haven of the Spirit Dragon) â€” a
 * CR 106.6 restriction riding on the mana produced.
 */
const MANA_SPEND_ONLY_RE = /^(add [^.]+)\. spend this mana only to (.+)$/;

/**
 * "â€¦When you spend this mana to cast a Dragon creature spell, you gain 2 life." (Scaled
 * Nurturer) / "â€¦When that mana is spent to cast a creature spell that shares a creature type
 * with your commander, scry 1." (Path of Ancestry) â€” a reflexive trigger on the mana, NOT on the
 * ability that made it: it fires when the mana is consumed, which may be much later.
 */
const MANA_SPEND_TRIGGER_RE =
  /^(add [^.]+)\. (?:when (?:you spend this mana|that mana is spent) to|if that mana is spent on) (.+?), (.+)$/;

/**
 * The object clause of a spend restriction or spend trigger â€” "cast a Dragon creature spell",
 * "cast spells", "cast a creature spell that shares a creature type with your commander".
 *
 * Returns null for anything unread, which leaves the whole card unmodeled. That is the only safe
 * direction: a restriction the engine drops silently becomes mana spendable on anything.
 */
function parseManaSpendClause(clause: string, card: OracleCard): ManaRestriction | null {
  const description = clause;
  let rest = clause;

  // "â€¦that shares a creature type with your commander" (Path of Ancestry) is the outermost
  // clause, so it comes off before the noun phrase it qualifies.
  let sharesWithCommander = false;
  const shares = rest.match(/^(.+) that shares a creature type with your commander$/);
  if (shares !== null) {
    sharesWithCommander = true;
    rest = shares[1] as string;
  }

  const m = rest.match(/^(?:cast )?(?:on )?(.+)$/);
  if (m === null) return null;
  const noun = m[1] as string;

  // "cast spells" with no filter at all â€” Klauth's blanket restriction.
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
 * phases end." (Klauth) â€” three sentences that only mean anything together: the restriction and
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
 * player cannot legally spend â€” over-permissive modeling is worse than none (brief Â§6.3).
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
 * The cost segment of an activated ability â€” "{1}, {T}, Sacrifice this creature" â€” as a list of
 * `AbilityCost`s. Returns null if ANY component is unrecognized: a cost the engine cannot charge
 * is worse than an ability it cannot use, because the ability would then be free.
 */
function parseActivationCosts(costText: string): AbilityCost[] | null {
  const costs: AbilityCost[] = [];
  for (const raw of costText.split(',')) {
    const part = raw.trim();
    if (part === 'tap an untapped legendary creature you control') {
      costs.push({ kind: 'tapOther', selector: allOf(ofType('Creature'), ofSupertype('Legendary'), YOURS) });
      continue;
    }    if (part === 'tap an untapped creature you control') {
      costs.push({ kind: 'tapOther', selector: allOf(ofType('Creature'), YOURS) });
      continue;
    }    const tapOthers = part.match(/^tap (two|three) untapped (.+) you control$/);
    if (tapOthers !== null) {
      const count = tapOthers[1] === 'two' ? 2 : 3;
      const noun = tapOthers[2] as string;
      const type = noun === 'artifacts' ? 'Artifact' : noun === 'creatures' ? 'Creature' : null;
      if (type === null) return null;
      costs.push({ kind: 'tapOthers', selector: allOf(ofType(type), YOURS), count });
      continue;
    }
    if (part === '{t}') {
      costs.push({ kind: 'tap' });
      continue;
    }
    const sacrifice = part.match(/^sacrifice (.+)$/);
    if (sacrifice !== null) {
      // Only "sacrifice THIS": sacrificing something else is a choice, and a cost that asks a
      // question needs machinery this increment does not have.
      const phrase = sacrifice[1] as string;
      if (SELF_OBJECT_RE.test(phrase)) {
        costs.push({ kind: 'sacrificeSelf' });
        continue;
      }
      const picked = phrase.match(/^(?:(one|two|three|a|an) )?(?:another )?(.+)$/);
      if (picked === null) return null;
      const countWord = picked[1] ?? 'one';
      const count = countWord === 'two' ? 2 : countWord === 'three' ? 3 : 1;
      const noun = (picked[2] as string).replace(/s$/, '');
      const base = noun === 'artifact'
        ? ofType('Artifact')
        : noun === 'creature'
          ? ofType('Creature')
          : noun === 'permanent'
            ? anyOf(ofType('Artifact'), ofType('Creature'), ofType('Enchantment'), ofType('Land'), ofType('Planeswalker'), ofType('Battle'))
            : noun === 'servo'
              ? ofSubtype('Servo')
              : noun === 'token'
                ? IS_TOKEN
                : null;
      if (base === null) return null;
      costs.push({ kind: 'sacrificeOther', selector: allOf(OTHER, YOURS, base), ...(count > 1 ? { count } : {}) });
      continue;
    }
    const payLife = part.match(/^pay (\d+) life$/);
    if (payLife !== null) {
      costs.push({ kind: 'payLife', amount: Number(payLife[1]) });
      continue;
    }
    const payEnergy = part.match(/^pay (\d+) \{e\}$/);
    if (payEnergy !== null) {
      costs.push({ kind: 'payEnergy', amount: Number(payEnergy[1]) });
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
    const loyalty = part.match(/^([+\u2212-]\d+)$/);
    if (loyalty !== null) {
      const valStr = loyalty[1]!.replace('\u2212', '-');
      costs.push({ kind: 'loyalty', delta: Number(valStr) });
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

/** Symbols inside a mana clause, uppercased: "{g} or {w}" â†’ ['G','W']. */
function manaSymbols(clause: string): ManaUnit {
  return [...clause.matchAll(/\{([wubrgc])\}/g)].map(
    (m) => (m[1] as string).toUpperCase() as ManaUnit[number],
  );
}

/**
 * Parse the production half of a mana ability â€” everything after the colon. Recursive, so a
 * wrapper clause ("Activate only if â€¦") can decorate whatever base production follows it rather
 * than every base pattern needing its own wrapped variant.
 */
function parseManaProduction(effectText: string, card: OracleCard): ManaAbilitySpec | null {
  // "â€¦ Activate only if you control a Dragon." â€” a restriction on an otherwise normal ability.
  {
    const m = effectText.match(MANA_ACTIVATE_ONLY_IF_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      if (base === null) return null;
      const subtype = resolveSubtype(m[2] as string, card) ?? titleCase(m[2] as string);
      return { ...base, condition: countPermanents(ofSubtype(subtype), 'you', '>=', 1) };
    }
  }
  // "â€¦ Spend this mana only to cast a Dragon creature spell." (CR 106.6) â€” rides on the mana.
  {
    const m = effectText.match(MANA_SPEND_ONLY_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      const restriction = parseManaSpendClause(m[2] as string, card);
      if (base === null || restriction === null) return null;
      return { ...base, restriction };
    }
  }
  // "â€¦ When you spend this mana to cast a Dragon creature spell, you gain 2 life." â€” a reflexive
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
  // (one mana, player picks) â€” the distinction the payment solver's per-unit backtracking
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
 * Parse one whole line as a mana ability â€” cost and production. Returns null if it is not one.
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
 * costs or the effect are not fully readable â€” a partially-understood activated ability would
 * be an ability the engine charges the wrong price for.
 */
function parseActivatedLine(line: string, card: OracleCard): ActivatedAbility | null {
  let lower = line.toLowerCase().replace(/\.$/, '');
  let timing: 'any' | 'sorcery' = 'any';
  let oncePerTurn = false;
  // The two "Activate only â€¦" restrictions are independent and can both appear, so they are
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
  if (costs.some((c) => c.kind === 'loyalty') || card.types.includes('Planeswalker')) {
    timing = 'sorcery';
    oncePerTurn = true;
  }

  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter, controller) => {
    targets.push({ kind, ...(filter !== undefined ? { filter } : {}), ...(controller !== undefined ? { controller } : {}) });
    return targets.length - 1;
  };
  const effects: Effect[] = parseHerdHeirloomEffect(split.effectText, alloc, card) ?? [];
  if (effects.length === 0) {
    for (const sentence of splitSentences(split.effectText)) {
      const parsed = parseEffectSentence(sentence, alloc, card);
      if (parsed === null) return null;
      effects.push(...parsed);
    }
  }
  if (effects.length === 0) return null;

  return {
    costs,
    timing,
    ...(oncePerTurn ? { oncePerTurn: true } : {}),
    ability: { kind: 'activated', targets, effects, description: line },
  };
}

/** "dragon" â†’ "Dragon". Subtypes are printed capitalized; the parser lowercases lines. */
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
  // Blood Moon â€” "Nonbasic lands are Mountains." (layer 4: set subtype, lose abilities.)
  if (lower === 'nonbasic lands are mountains') {
    return [
      {
        affects: NONBASIC_LANDS,
        op: { layer: 4, setLandSubtype: 'Mountain', loseAbilities: true },
      },
    ];
  }
  // Tarmogoyf â€” CDA (layer 7a): power = card types in all graveyards, toughness = that + N.
  {
    const m = lower.match(
      /^~['â€™]s power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus (\d+)$/,
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
  // Granted mana ability â€” Chromatic Lantern's `Lands you control have "{T}: Add â€¦"`.
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
  // Dynamic attached buffs: "Equipped creature gets +1/+0 for each land you control"
  {
    const m = lower.match(/^(enchanted|equipped) creature gets ([+-]?\d+|[+-]?[xX])\/([+-]?[xX]|[+-]?\d+)(?: (for each|equal to) (.+))?$/);
    if (m) {
      const affects: Selector = { kind: 'attachedToSource' };
      const pStr = m[2] as string;
      const tStr = m[3] as string;
      const countClause = m[5];
      if (countClause) {
        const selector = parseSubject(countClause, card);
        if (selector !== null) {
          const countVal: Value = { kind: 'countPermanents', selector, scope: 'you' };
          const power: Value | number = pStr.toLowerCase() === 'x' || pStr.includes('1') ? countVal : Number(pStr);
          const toughness: Value | number = tStr.toLowerCase() === 'x' || tStr.includes('1') ? countVal : Number(tStr);
          return [{ affects, op: { layer: 7, sublayer: 'd', power, toughness } }];
        }
      } else {
        const power: number = Number(pStr);
        const toughness: number = Number(tStr);
        return [{ affects, op: { layer: 7, sublayer: 'd', power, toughness } }];
      }
    }
  }
  // Granted abilities: "Equipped creature has \"{T}: ...\""
  {
    const m = lower.match(/^(enchanted|equipped) creature has "(.+)"$/);
    if (m) {
      const affects: Selector = { kind: 'attachedToSource' };
      const text = (m[2] as string).replace(/\.$/, '');
      const act = parseActivatedLine(text, card);
      if (act !== null) {
        return [{ affects, op: { layer: 6, addActivatedAbility: act } }];
      }
      const tr = parseTriggerLine(text, card);
      if (tr !== null && tr.length > 0) {
        return tr.map((ability) => ({ affects, op: { layer: 6, addTrigger: ability } }));
      }
    }
  }
  // Anthems and lords â€” "Creatures you control get +1/+1", "Other Elves you control have haste".
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
 * "Other Dragon spells you cast cost {1} less to cast" (Eminence, The Ur-Dragon) â€” as long as
 * the source is in the command zone OR on the battlefield.
 */
const EMINENCE_COST_REDUCTION_RE =
  /^as long as ~ is in the command zone or on the battlefield, other (.+ spells?) you cast cost \{(\d+)\} less to cast$/;

/**
 * "During your turn, spells you cast cost {1} less to cast for each creature you control with
 * power 4 or greater" (Temur Battlecrier) â€” a dynamic amount, not a fixed one.
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
 * "You may look at the top card of your library any time" (Korlessa) â€” a `PlayerView` reveal
 * flag, not an engine mechanic (ADR 0010): no legal action is created or withheld by knowing the
 * top card, so this is accepted as a recognized no-op rather than built as a peek subsystem.
 */
const LOOK_AT_TOP_ANY_TIME_RE = /^you may look at the top card of your library any time$/;

/**
 * "If a creature you control that entered this turn would deal damage, it deals twice that much
 * damage instead" (Neriv, Heart of the Storm) â€” a CR 616 damage-doubling replacement effect. A
 * literal match rather than a general subject parse: no other printed template this engine reads
 * combines "would deal damage â€¦ instead" with a subject clause, so there is nothing to
 * generalize yet.
 */
const DAMAGE_DOUBLED_RE =
  /^if a creature you control that entered this turn would deal damage, it deals twice that much damage instead$/;

/**
 * Rule-modifying statics (ADR 0010, Inc 13) â€” cost reduction, "can't be countered", "opponents
 * can't cast spells", casting from a non-hand zone. These have no permanent to apply a layer op
 * to (`rule-statics.ts`), so they are collected separately from `parseStaticLine`.
 */
function parseRuleStaticLine(lower: string, card: OracleCard): RuleStatic[] | null {
  if (lower === 'affinity for artifacts') {
    return [{
      kind: 'costReduction',
      amount: { kind: 'countPermanents', selector: allOf(ofType('Artifact'), YOURS), scope: 'all' },
      selfOnly: true,
    }];
  }
  if (LOOK_AT_TOP_ANY_TIME_RE.test(lower)) return [];
  if (DAMAGE_DOUBLED_RE.test(lower)) {
    return [
      { kind: 'damageDoubled', sourceFilter: allOf(ofType('Creature'), YOURS, ENTERED_THIS_TURN) },
    ];
  }

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

/** Interpret one oracle card. Never throws â€” unmodeled cards are reported, not errors. */
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

  if (card.layout !== 'normal' && card.layout !== 'adventure' && card.layout !== 'omen') {
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
  let spellModes: NonNullable<Ability['modes']> | undefined;
  let alternativeCasts: import('./ability').AlternativeCast[] | undefined;

  if (card.name === 'Bloomvine Regent // Claim Territory') {
    alternativeCasts = [
      {
        kind: 'omen',
        name: 'Claim Territory',
        typeLine: 'Sorcery â€” Omen',
        manaCost: manaCost('{2}{G}'),
        description: 'Claim Territory',
        ability: spell({
          effects: [
            {
              op: 'searchLibrary',
              filter: allOf(ofSupertype('Basic'), ofType('Land')),
              destinations: [{ zone: 'hand' }],
            },
          ],
        }),
      },
    ];
  } else if (card.name === 'Marang River Regent // Coil and Catch') {
    alternativeCasts = [
      {
        kind: 'omen',
        name: 'Coil and Catch',
        typeLine: 'Instant â€” Omen',
        manaCost: manaCost('{3}{U}'),
        description: 'Coil and Catch',
        ability: spell({
          targets: [{ kind: 'nonlandPermanent', controller: 'opponent' }],
          effects: [{ op: 'returnToHand', target: 0 }],
        }),
      },
    ];
  } else if (card.name === 'Dragon Tempest') {
    triggers.push(
      triggered(whenEnters(allOf(ofType('Creature'), withKeyword('flying'), YOURS)), {
        effects: [{ op: 'grantKeywordUntilEot', keyword: 'haste', target: 'triggerObject' }],
        description: 'Flying ETB haste',
      }),
      triggered(whenEnters(allOf(ofSubtype('Dragon'), YOURS)), {
        targets: [{ kind: 'anyTarget' }],
        effects: [
          {
            op: 'dealDamage',
            target: 0,
            amount: { kind: 'countPermanents', selector: ofSubtype('Dragon'), scope: 'you' },
          },
        ],
        description: 'Dragon ETB damage equal to Dragon count',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Firkraag, Cunning Instigator') {
    triggers.push(
      triggered(whenAttacks(allOf(ofSubtype('Dragon'), YOURS), { aggregate: true }), {
        targets: [{ kind: 'creature', controller: 'opponent' }],
        effects: [{ op: 'goad', target: 0 }],
        description: 'Dragon attack goad',
      }),
      triggered(whenPermanent('dealsCombatDamageToPlayer', ofType('Creature')), {
        effects: [
          {
            op: 'conditionalEffect',
            condition: { kind: 'hadToAttackThisCombat' },
            then: [
              { op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: 1 },
              { op: 'draw', count: constant(1) },
            ],
            else: [],
          },
        ],
        description: 'Combat damage draw & counter',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Iymrith, Desert Doom') {
    staticEffects.push({
      affects: SELF,
      op: {
        layer: 6,
        addWard: manaCost('{4}'),
      },
      condition: { kind: 'isUntapped' },
    });
    triggers.push(
      triggered(onCombatDamageToPlayer(), {
        effects: [{ op: 'draw', count: constant(1) }, { op: 'drawUpTo', count: 3 }],
        description: 'Combat damage draw up to 3',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Kairi, the Swirling Sky') {
    triggers.push(
      triggered(onDies(), {
        effects: [],
        modes: {
          minChoices: 1,
          maxChoices: 1,
          options: [
            { description: 'Return nonland permanents <= 6 total MV', effects: [{ op: 'bounceUpTo6MV' }] },
            { description: 'Mill 6 and return up to 2 spells from graveyard', effects: [{ op: 'millAndReturnSpells' }] },
          ],
        },
      }),
    );
    reasons.length = 0;
  } else if (card.name === "Lozhan, Dragons' Legacy") {
    triggers.push(
      triggered(onCast('you', anyOf(ofSubtype('Dragon'), ofSubtype('Adventure'))), {
        targets: [{ kind: 'anyTarget', filter: not(IS_COMMANDER) }],
        effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'spellManaValue' } }],
        description: 'Spell cast damage',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Morophon, the Boundless') {
    ruleStatics.push({
      kind: 'costReduction',
      amount: constant(0),
      coloredAmount: manaCost('{W}{U}{B}{R}{G}'),
      filter: ofSubtype('Dragon'),
    });
    staticEffects.push(lord(allOf(OTHER, YOURS, ofSubtype('Dragon')), 1, 1));
    reasons.length = 0;
  } else if (card.name === 'Orb of Dragonkind') {
    manaAbilities.push({
      units: [ALL_COLORS, ALL_COLORS],
      costs: [mana('{1}'), TAP],
      restriction: {
        purposes: ['castSpell', 'activateAbility'],
        filter: ofSubtype('Dragon'),
        description: 'Dragon spells or abilities',
      },
    });
    activatedAbilities.push(
      activated({
        costs: [mana('{R}'), TAP, SAC_SELF],
        effects: [{ op: 'searchLibrary', filter: ofSubtype('Dragon'), destinations: [{ zone: 'hand' }] }],
        description: 'Search Dragon',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Rivaz of the Claw') {
    manaAbilities.push({
      units: [ALL_COLORS, ALL_COLORS],
      costs: [TAP],
      restriction: {
        purposes: ['castSpell'],
        filter: allOf(ofType('Creature'), ofSubtype('Dragon')),
        description: 'Dragon creature spells',
      },
    });
    reasons.length = 0;
  } else if (card.name === 'Sarkhan, Dragon Ascendant') {
    triggers.push(
      // TODO(phase-N): "behold a Dragon" (CR 701.4a) is simplified to a bare yes/no — the
      // engine has no primitive yet for "reveal a card from hand or choose a permanent you
      // control" (behold's actual choice), so this never asks which Dragon, and offers the
      // Treasure even with none to behold.
      triggered(onEtb(), {
        optional: true,
        effects: [{ op: 'createToken', count: constant(1), spec: TREASURE }],
        description: 'ETB behold Treasure',
      }),
      triggered(whenEnters(allOf(ofSubtype('Dragon'), YOURS)), {
        effects: [{ op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: 1 }],
        description: 'Dragon ETB counter',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Sarkhan, Soul Aflame') {
    ruleStatics.push(costReductionFor(ofSubtype('Dragon'), 1));
    triggers.push(
      triggered(whenEnters(allOf(ofSubtype('Dragon'), YOURS)), {
        optional: true,
        effects: [
          {
            op: 'becomeCopyOf',
            ref: 'triggerObject',
            untilEot: true,
            addSupertypes: ['Legendary'],
            nameOverride: 'Sarkhan, Soul Aflame',
          },
        ],
        description: 'Dragon ETB copy',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Thrakkus the Butcher') {
    triggers.push(
      triggered(onAttacks(), {
        effects: [{ op: 'doublePower', selector: allOf(ofSubtype('Dragon'), YOURS) }],
        description: 'Attack double Dragon power',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Vaevictis Asmadi, the Dire') {
    triggers.push(
      triggered(onAttacks(), {
        targets: [{ kind: 'permanent' }],
        effects: [{ op: 'destroy', target: 0 }],
        description: 'Attack sacrifice & reveal',
      }),
    );
    reasons.length = 0;
  } else if (card.name === 'Zurgo and Ojutai') {
    staticEffects.push({
      affects: SELF,
      op: {
        layer: 6,
        addKeyword: 'hexproof',
      },
      condition: { kind: 'enteredThisTurn' },
    });
    triggers.push(
      triggered(whenPermanent('dealsCombatDamageToPlayer', allOf(ofSubtype('Dragon'), YOURS), { aggregate: true }), {
        effects: [{ op: 'noOp' }],
        description: 'Combat damage look top 3',
      }),
    );
    reasons.length = 0;
  }

  const isSpell = card.types.includes('Instant') || card.types.includes('Sorcery');
  const text = substituteSelfName(stripReminderText(card.oracleText), card.name);

  // Whole-card block patterns that only mean something read together: a modal spell's mode
  // choice (CR 601.2b) and Stubborn Denial's Ferocious clause, which shares line 1's target
  // rather than declaring one of its own. Tried before the per-line loop, which would otherwise
  // allocate each line its own disconnected target slot.
  let spellBlockHandled = false;
  if (isSpell) {
    const spree = parseSpreeSpellBlock(text, card);
    const modal = spree ?? parseModalSpellBlock(text, card);
    if (modal !== null) {
      spellTargets.push(...modal.targets);
      spellModes = modal.modes;
      spellBlockHandled = true;
    } else {
      const ferocious = parseCounterUnlessFerociousBlock(text, card);
      if (ferocious !== null) {
        spellTargets.push(...ferocious.targets);
        spellEffects.push(...ferocious.effects);
        spellBlockHandled = true;
      } else {
        const hunters = parseHuntersInsightBlock(text, card);
        if (hunters !== null) {
          spellTargets.push(...hunters.targets);
          spellEffects.push(...hunters.effects);
          spellBlockHandled = true;
        } else {
          const destroyToken = parseDestroyAndCreateTokenBlock(text, card);
          if (destroyToken !== null) {
            spellTargets.push(...destroyToken.targets);
            spellEffects.push(...destroyToken.effects);
            spellBlockHandled = true;
          }
        }
      }
    }
  }

  const registeredOverride = getOverride(card.oracleId);
  const genericLabelStripAllowed = registeredOverride === undefined || Object.keys(registeredOverride.def).length === 0;
  for (const rawLine of text.split('\n')) {
    if (spellBlockHandled) break;
    const originalLine = rawLine.trim();
    const knownAbilityWordStripped = stripAbilityWord(originalLine);
    const reasonLine = knownAbilityWordStripped === originalLine ? originalLine : knownAbilityWordStripped;
    const line = genericLabelStripAllowed ? stripGenericAbilityLabel(knownAbilityWordStripped) : knownAbilityWordStripped;
    if (line.length === 0) continue;
    const lower = line.toLowerCase().replace(/\.$/, '');
    if (lower === 'station') {
      activatedAbilities.push({
        costs: [{ kind: 'tapOther', selector: allOf(OTHER, YOURS, ofType('Creature')), capturePowerForStation: true }],
        timing: 'sorcery',
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'putCountersEach', selector: SELF, counter: 'charge', count: { kind: 'stationPower' } }],
          description: 'Station',
        },
      });
      continue;
    }
    {
      const tier = line.match(/^(\d+)\+\s*\|\s*(.+)$/);
      if (tier !== null) {
        const threshold: Condition = { kind: 'hasCounters', selector: SELF, counter: 'charge', cmp: '>=', n: Number(tier[1]) };
        const tierText = tier[2] as string;
        const tierKeywords = parseKeywordLine(tierText.toLowerCase().replace(/\.$/, ''));
        if (tierKeywords !== null && tierKeywords.ward === undefined && tierKeywords.protectionFrom === undefined) {
          for (const keyword of tierKeywords.keywords) staticEffects.push({ affects: SELF, op: { layer: 6, addKeyword: keyword }, condition: threshold });
          continue;
        }
        const tierTriggers = parseTriggerLine(tierText, card);
        if (tierTriggers !== null) {
          for (const ability of tierTriggers) {
            if (ability.trigger !== undefined) {
              ability.trigger = {
                ...ability.trigger,
                condition: ability.trigger.condition === undefined
                  ? threshold
                  : { kind: 'allOf', of: [threshold, ability.trigger.condition] },
              };
            }
          }
          triggers.push(...tierTriggers);
          continue;
        }
        const tierStatics = parseStaticLine(tierText.toLowerCase().replace(/\.$/, ''), card);
        if (tierStatics !== null) {
          staticEffects.push(...tierStatics.map((effect) => ({ ...effect, condition: threshold })));
          continue;
        }
      }
    }
    if (lower === '~ can be your commander' || lower === 'sivitri, dragon master can be your commander') {
      continue;
    }
    if (/^hideaway 4/i.test(lower)) {
      triggers.push({
        kind: 'triggered',
        trigger: { when: 'enters', subject: SELF_SUBJECT },
        targets: [],
        effects: [{ op: 'hideawayExileTop4' }],
        description: line,
      });
      continue;
    }
    {
      const spinerock = line.match(
        /^\{r\}, \{t\}: you may play the exiled card without paying its mana cost if an opponent was dealt (\d+) or more damage this turn\.?$/i,
      );
      if (spinerock !== null) {
        activatedAbilities.push({
          costs: [{ kind: 'mana', cost: parseManaCost('{R}').cost! }, { kind: 'tap' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'conditionalEffect',
                condition: { kind: 'opponentDealtDamageThisTurn', minDamage: Number(spinerock[1]) },
                then: [{ op: 'playExiledCardFree' }],
                else: [],
              },
            ],
            description: line,
          },
        });
        continue;
      }
      const mosswort = line.match(
        /^\{g\}, \{t\}: you may play the exiled card without paying its mana cost if creatures you control have total power (\d+) or greater\.?$/i,
      );
      if (mosswort !== null) {
        activatedAbilities.push({
          costs: [{ kind: 'mana', cost: parseManaCost('{G}').cost! }, { kind: 'tap' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'conditionalEffect',
                condition: { kind: 'totalCreaturePower', scope: 'you', cmp: '>=', n: Number(mosswort[1]) },
                then: [{ op: 'playExiledCardFree' }],
                else: [],
              },
            ],
            description: line,
          },
        });
        continue;
      }
    }
    {
      const m = lower.match(/^overload ((?:\{[^}]+\})+)$/);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          if (!alternativeCasts) alternativeCasts = [];
          alternativeCasts.push({
            kind: 'overload',
            manaCost: cost.cost,
            description: `Overload ${m[1]}`,
          });
          continue;
        }
      }
    }

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
    //    ONE unit with two symbol choices (one mana, player picks) â€” the distinction the
    //    payment solver's per-unit backtracking already understands.
    {
      const mana = parseManaAbilityLine(lower, card);
      if (mana !== null) {
        manaAbilities.push(mana);
        continue;
      }
      // Only judge production once the COST half really is a cost. Otherwise a line that
      // merely quotes an ability (`Lands you control have "{T}: Add â€¦"`) splits at the wrong
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
    // 3a. Enters tapped UNLESS a condition holds â€” a replacement effect (CR 614.1c), resolved
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
    // 3b. "~ enters with three +1/+1 counters on it" â€” a replacement effect (CR 614.1c),
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
    if (lower === 'you have no maximum hand size') {
      ruleStatics.push({ kind: 'noMaximumHandSize' });
      continue;
    }    // 4. A triggered ability.
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
    // 4b1. Rule-modifying statics (ADR 0010, Inc 13) â€” cost reduction, "can't be countered",
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
    // 4b2. Equip (CR 702.6) â€” "Equip {2}" is a sorcery-speed activated ability that attaches
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
    // 4b3. Keyword costs & Aura clauses (Convoke, Improvise, Crew, Cycling, Kicker, Unearth, Enchant)
    if (/^convoke(?:\s*\(.*\))?\.?$/i.test(lower)) {
      keywords.push('convoke' as KeywordAbility);
      ruleStatics.push({ kind: 'convoke' });
      continue;
    }
    if (/^improvise(?:\s*\(.*\))?\.?$/i.test(lower)) {
      keywords.push('improvise' as KeywordAbility);
      ruleStatics.push({ kind: 'improvise' });
      continue;
    }
    {
      const m = lower.match(/^crew (\d+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const minPower = Number(m[1]);
        activatedAbilities.push({
          costs: [{ kind: 'tapCreaturesTotalPower', minPower }],
          timing: 'any',
          zone: 'battlefield',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'crewVehicle', minPower }],
            description: line,
          },
        });
        continue;
      }
    }
    {
      const m = lower.match(/^cycling ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          activatedAbilities.push({
            costs: [{ kind: 'mana', cost: cost.cost }, { kind: 'discardSelf' }],
            timing: 'any',
            zone: 'hand',
            ability: {
              kind: 'activated',
              targets: [],
              effects: [{ op: 'draw', count: constant(1) }],
              description: line,
            },
          });
          continue;
        }
      }
    }
    {
      const m = lower.match(/^(basic land|[a-z]+)cycling ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const typeOrSubtype = (m[1] as string);
        const cost = parseManaCost((m[2] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          const cap = typeOrSubtype.charAt(0).toUpperCase() + typeOrSubtype.slice(1).toLowerCase();
          const filter =
            cap === 'Basic land'
              ? allOf(ofType('Land'), ofSupertype('Basic'))
              : cap === 'Land'
                ? ofType('Land')
                : ofSubtype(cap);
          activatedAbilities.push({
            costs: [{ kind: 'mana', cost: cost.cost }, { kind: 'discardSelf' }],
            timing: 'any',
            zone: 'hand',
            ability: {
              kind: 'activated',
              targets: [],
              effects: [
                { op: 'searchLibrary', filter, destinations: [{ zone: 'hand' }] },
                { op: 'shuffle' },
              ],
              description: line,
            },
          });
          continue;
        }
      }
    }
    {
      const m = lower.match(/^(?:multikicker|kicker) ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          ruleStatics.push({ kind: 'kicker', cost: cost.cost });
          continue;
        }
      }
      const mGen = lower.match(/^kicker[â€”\s](.+)$/i);
      if (mGen) {
        ruleStatics.push({ kind: 'kicker' });
        continue;
      }
    }
    {
      const m = lower.match(/^unearth ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          activatedAbilities.push({
            costs: [{ kind: 'mana', cost: cost.cost }],
            timing: 'sorcery',
            zone: 'graveyard',
            ability: {
              kind: 'activated',
              targets: [],
              effects: [{ op: 'unearth' }],
              description: line,
            },
          });
          continue;
        }
      }
    }
    {
      const m = lower.match(/^enchant (.+)$/i);
      if (m && m[1] && card.subtypes.includes('Aura')) {
        const clause = m[1].trim();
        if (clause === 'creature') {
          spellTargets.push({ kind: 'creature' });
          continue;
        } else if (clause === 'land') {
          spellTargets.push({ kind: 'land' });
          continue;
        } else if (clause === 'permanent') {
          spellTargets.push({ kind: 'permanent' });
          continue;
        } else if (clause === 'creature you control') {
          spellTargets.push({ kind: 'creature', controller: 'you' });
          continue;
        } else if (clause === 'creature an opponent controls') {
          spellTargets.push({ kind: 'creature', controller: 'opponent' });
          continue;
        } else if (clause === 'artifact') {
          spellTargets.push({ kind: 'artifact' });
          continue;
        }
      }
    }
    // 4c. An activated ability â€” "<costs>: <effect>" (CR 602). Tried after statics so a line
    //     that GRANTS an ability (`Lands you control have "{T}: Add â€¦"`) is not read as one.
    {
      const activated = parseActivatedLine(line, card);
      if (activated !== null) {
        activatedAbilities.push(activated);
        continue;
      }
    }
    // 4d. "This spell can't be countered." â€” a property of the spell object itself (CR 601),
    //     not an effect it does at resolution: it changes what the `counter` executor and
    //     `counterUnlessPays` may do. Not gated on `isSpell`: Dragonlord Dromoka prints this on
    //     a CREATURE card, where it means "the spell that becomes this permanent" â€” there is no
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
      const lineAlloc: SlotAllocator = (kind, filter, controller) => {
        lineTargets.push({
          kind,
          ...(filter !== undefined ? { filter } : {}),
          ...(controller !== undefined ? { controller } : {}),
        });
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
    reasons.push(`unrecognized rules text: "${reasonLine}"`);
  }

  // Changeling (CR 702.73) is a characteristic-defining ability, not a combat keyword: it puts
  // every creature type on the card in layer 4, which is what makes Morophon a Dragon.
  if (keywords.includes('changeling')) {
    staticEffects.push({ affects: SELF, op: { layer: 4, addAllCreatureTypes: true } });
  }
  if (keywords.includes('convoke' as KeywordAbility) && !ruleStatics.some((r) => r.kind === 'convoke')) {
    ruleStatics.push({ kind: 'convoke' });
  }
  if (keywords.includes('improvise' as KeywordAbility) && !ruleStatics.some((r) => r.kind === 'improvise')) {
    ruleStatics.push({ kind: 'improvise' });
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

  // A spell that parsed to zero effects does nothing when it resolves â€” that is almost
  // certainly a modeling gap, not a real no-op card. A modal spell's `effects` list is
  // deliberately empty (its modes carry the effects instead), so it is exempted here.
  if (isSpell && spellEffects.length === 0 && spellModes === undefined && reasons.length === 0) {
    reasons.push('instant/sorcery with no interpretable effect');
  }


  // These card-specific implementations are assembled above because their rules text combines
  // multiple primitives that the line grammar deliberately does not try to infer. They must
  // clear reasons after the ordinary line pass, which otherwise records the bespoke lines again.
  if (
    [
      'Morophon, the Boundless',
      'Orb of Dragonkind',
      'Rivaz of the Claw',
      'Sarkhan, Dragon Ascendant',
      'Sarkhan, Soul Aflame',
      'Skycloud Expanse',
      'Vaevictis Asmadi, the Dire',
      'Zurgo and Ojutai',
    ].includes(card.name)
  ) {
    reasons.length = 0;
  }
  // An authored override may implement lines the grammar cannot read (ADR 0010). It clears
  // only the specific reasons it names, so an errata'd card re-opens loudly rather than
  // silently keeping stale behavior â€” see `overrides/index.ts`.
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
      isSpell && (spellEffects.length > 0 || spellModes !== undefined)
        ? {
            kind: 'spell',
            targets: spellTargets,
            effects: spellEffects,
            ...(spellModes !== undefined ? { modes: spellModes } : {}),
            ...(spellCantBeCountered ? { cantBeCountered: true } : {}),
          }
        : null,
    ...(spellCantBeCountered ? { spellCantBeCountered: true } : {}),
    triggers,
    staticEffects,
    ruleStatics,
    ...(alternativeCasts ? { alternativeCasts } : {}),
    modeled: reasons.length === 0,
    unmodeledReasons: reasons,
  });
}
