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
import { counterSpellTarget, graveyardCardTarget } from './target-builders';
import { searchLibraryCards, graveyardAlternativeCost } from './effect-builders';
import type { Color, OracleCard } from '@mtg/shared';
import { enforceInterpretedDefinition } from './overload';
import { emptyCost, parseManaCost } from '../mana/cost';
import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type {
  AbilityCost,
  ActivatedAbility,
  AlternativeCast,
  MdfcLandFace,
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
  CHOSEN_SUBTYPE,
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
  hasCounter,
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
  mana,
  manaCost,
  onAttacks,
  onCast,
  onCombatDamageToPlayer,
  onDies,
  onEtb,
  SAC_SELF,
  TAP,
  triggered,
  whenAttacks,
  whenEnters,
  whenPermanent,
} from './templates';
import { canonicalizeToken, FOOD, MUTAGEN, SOLDIER_1_1, TREASURE } from './tokens';
// Use the explicit module path so the registry imported by authored override modules and the
// interpreter share one module instance under Bun/TypeScript path resolution.
import { applyOverride, getOverride } from './overrides/index';
import type { BackFace, CardDefinition, ManaAbilitySpec } from './definition';
import { PERMANENT_CARD_TYPES } from './definition';

/**
 * Allocates a target slot of the given kind and returns its index (ADR 0004). `filter` further
 * restricts a zone-qualified kind (`cardInGraveyard`) â€” "target Dragon permanent card".
 */
type SlotAllocator = (
  kind: TargetKind,
  filter?: Selector,
  controller?: TargetSpec['controller'],
  graveyardOwnerScope?: TargetSpec['graveyardOwnerScope'],
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
  controller?: TargetSpec['controller'],
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

/** Parse count clauses that depend on the source, trigger object, or current battlefield. */
function parseDynamicCountValue(
  clause: string,
  card: OracleCard,
  opts: { triggerObject?: boolean } = {},
): Value | null {
  // Scryfall prints the typographic apostrophe; every literal below is written with the
  // straight one, and "~’s power" would otherwise miss.
  const text = clause.trim().toLowerCase().replace(/’/g, "'");
  const totalPower = text.match(/^the total power of (.+)$/);
  if (totalPower !== null) {
    const selector = parseSubject(totalPower[1] as string, card);
    if (selector !== null) return { kind: 'totalPowerAmong', selector, scope: 'all' };
  }
  const devotion = text.match(/^your devotion to (white|blue|black|red|green)$/);
  if (devotion !== null)
    return { kind: 'devotionTo', color: COLOR_WORDS[devotion[1] as string] as Color };
  // The singular reaches here from the "gets +1/+1 **for each color** among permanents you
  // control" buff parse (Faeburrow Elder), which prefixes its clause with "the number of ".
  if (/^the number of colou?rs? among permanents you control$/.test(text)) {
    return { kind: 'colorsAmongPermanents' };
  }
  const opponents = text.match(/^(?:the )?number of opponents$/);
  if (opponents !== null) return { kind: 'countOpponents' };
  const cardsInYourZone = text.match(
    /^the number of (.+ cards?) in your (graveyard|hand|library)$/,
  );
  if (cardsInYourZone !== null) {
    const selector = parseCardFilterPhrase(cardsInYourZone[1] as string, card);
    if (selector !== null) {
      return {
        kind: 'countCardsInZone',
        zone: cardsInYourZone[2] as 'graveyard' | 'hand' | 'library',
        selector,
        owner: 'you',
      };
    }
  }
  const entered = text.match(
    /^(?:the )?number of (.+) that entered the battlefield under your control this turn$/,
  );
  if (entered !== null) {
    const selector = parseSubject(entered[1] as string, card);
    if (selector !== null)
      return {
        kind: 'countPermanents',
        selector: allOf(selector, YOURS, ENTERED_THIS_TURN),
        scope: 'all',
      };
  }
  const plus = text.match(/^one plus the number of (.+)$/);
  if (plus !== null) {
    const base = parseDynamicCountValue('the number of ' + (plus[1] as string), card, opts);
    return base === null ? null : { kind: 'plus', of: base, n: 1 };
  }
  const number = text.match(/^(?:the )?number of (.+)$/);
  if (number !== null) {
    const noun = number[1] as string;
    const selector = parseSubject(noun, card);
    if (selector !== null) {
      // The scope has to follow the subject. Defaulting to 'you' intersects an explicitly
      // opposing subject ("creatures your opponents control") with a you-only filter and counts
      // a constant 0 — silently, with the card still reporting modeled.
      const scope: 'you' | 'opponents' | 'all' =
        /\byour opponents control\b|\ban opponent controls\b/.test(noun)
          ? 'opponents'
          : /\byou control\b/.test(noun)
            ? 'you'
            : 'all';
      return { kind: 'countPermanents', selector, scope };
    }
  }
  if (text === "~'s power" || text === "this creature's power") return { kind: 'powerOfSource' };
  if (text === "~'s toughness" || text === "this creature's toughness")
    return { kind: 'toughnessOfSource' };
  if (opts.triggerObject === true && (text === 'its power' || text === "that creature's power")) {
    return { kind: 'powerOfTriggerObject' };
  }
  const counters = text.match(
    /^(?:the number of )?([+-][0-9]+[/][+-][0-9]+|[a-z]+) counters? on (?:~|this (?:creature|artifact|enchantment|land|permanent)|it)$/,
  );
  if (counters !== null) {
    return opts.triggerObject === true && text.endsWith('on it')
      ? { kind: 'countersOnTriggerObject', counter: counters[1] as string }
      : { kind: 'countersOnSelf', counter: counters[1] as string };
  }
  if (text === 'the number of opponents who lost life this turn')
    return { kind: 'opponentsLostLifeThisTurn' };
  return null;
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
  'adamant',
  'addendum',
  'alliance',
  'battalion',
  'bloodrush',
  'celebration',
  'channel',
  'chroma',
  'cohort',
  'constellation',
  'converge',
  'corrupted',
  'coven',
  'delirium',
  'descend',
  'domain',
  'eminence',
  'enrage',
  'fateful hour',
  'ferocious',
  'formidable',
  'grandeur',
  'hellbent',
  'heroic',
  'imprint',
  'inspired',
  'join forces',
  'kinship',
  'landfall',
  'lieutenant',
  'magecraft',
  'metalcraft',
  'morbid',
  'pack tactics',
  'parade',
  'paradox',
  'raid',
  'rally',
  'revolt',
  'secret council',
  'spell mastery',
  'strive',
  'sweep',
  'tempting offer',
  'threshold',
  'undergrowth',
  'valiant',
  'will of the council',
  'command protocols',
  'guardian protocols',
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
  // Capitalized words, with lowercase connectors allowed between them ("Lord of the Pyrrhian
  // Legions"), never first or last.
  const m = line.match(
    /^([A-Z][A-Za-z0-9'’/-]*(?: (?:(?:of|the|and|to|in|for|on|a|an) )*[A-Z0-9][A-Za-z0-9'’/-]*){0,7})\s+[—–-]\s+(.+)$/,
  );
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

/** CR 105.1 — the five colors. Distinct from the mana-side `ALL_COLORS` below, which is a
 * `ManaUnit` and is about production, not about what "each color" means. */
const FIVE_COLORS: readonly Color[] = ['W', 'U', 'B', 'R', 'G'];

function parseKeywordLine(text: string): ParsedKeywordLine | null {
  const out: ParsedKeywordLine = { keywords: [] };
  // Split on commas only at the top level: " and " is ambiguous, because it also joins the
  // colors inside "protection from white and from black".
  for (const raw of text.split(',')) {
    // An Oxford list ("flying, vigilance, and double strike") leaves a leading "and" on the last
    // part. Stripped here rather than by pre-normalizing the whole string, so the " and " INSIDE
    // "protection from white and from black" — which is a conjunction of arguments, not of
    // keywords — is left alone.
    const part = raw.trim().replace(/^and /, '');
    if (part.length === 0) continue;

    const protection = part.match(PROTECTION_RE);
    if (protection !== null) {
      const argument = (protection[1] as string).trim();
      // "protection from each color" (Akroma's Will) — the five colors of CR 105.1, which is
      // what "each color" means; colorless is not a color and is correctly excluded.
      if (argument === 'each color' || argument === 'all colors') {
        out.protectionFrom = [...(out.protectionFrom ?? []), ...FIVE_COLORS];
        continue;
      }
      const colors: Color[] = [];
      for (const word of argument.split(/ and (?:from )?/)) {
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

function appendSentenceEffects(effects: Effect[], sentence: string, parsed: Effect[]): void {
  const normalized = sentence.toLowerCase().replace(/\.$/, '');
  if (
    normalized === "they can't be regenerated" ||
    normalized === "it can't be regenerated" ||
    normalized === 'they cannot be regenerated' ||
    normalized === "a creature destroyed this way can't be regenerated"
  ) {
    for (let index = effects.length - 1; index >= 0; index--) {
      const previous = effects[index];
      if (previous?.op === 'destroy' || previous?.op === 'destroyEach') {
        effects[index] = { ...previous, cantRegenerate: true };
        return;
      }
    }
  }
  effects.push(...parsed);
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

  if (noun.startsWith('each ')) noun = noun.slice('each '.length);
  const combat = noun.match(/^(attacking|blocking) (.+)$/);
  if (combat !== null) {
    parts.push({ kind: 'combatRole', role: combat[1] as 'attacking' | 'blocking' });
    noun = combat[2] as string;
  }
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
  const attackingEventPlayer = noun.match(/^(.+) attacking that player$/);
  if (attackingEventPlayer !== null) {
    parts.push({ kind: 'attackingEventPlayer' });
    noun = attackingEventPlayer[1] as string;
  }
  const powerClause = noun.match(/^(.+) with power (\d+) or greater$/);
  if (powerClause !== null) {
    parts.push(powerAtLeast(Number(powerClause[2])));
    noun = powerClause[1] as string;
  }

  // "Creatures you control OF THE CHOSEN TYPE get +1/+1" (Patchwork Banner) - the type was named
  // as the source entered (`entersChoosingOption`). Stripped before the "you control" suffix
  // below, because it is printed AFTER it.
  const chosenTypeClause = noun.match(/^(.+) of the chosen type$/);
  if (chosenTypeClause !== null) {
    parts.push(CHOSEN_SUBTYPE);
    noun = chosenTypeClause[1] as string;
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

  // "legendary creatures you control" (Boseiju's discount, Kindred Discovery-style anthems) -
  // a SUPERTYPE adjective, read the same way as the color adjective above. CR 205.4a's list;
  // "World" is included for completeness even though nothing in the pool prints it.
  const supertypeMatch = noun.match(/^(basic|legendary|snow|world) (.+)$/);
  if (supertypeMatch !== null) {
    parts.push(ofSupertype(titleCase(supertypeMatch[1] as string)));
    noun = supertypeMatch[2] as string;
  }

  const counterClause = noun.match(/^(.+) with (?:a )?\+1\/\+1 counter on it$/);
  if (counterClause !== null) {
    // The printed subject names the counter KIND. "Any counter" would pull in -1/-1, stun and
    // charge counters, which is a different (and strictly larger) set of creatures.
    parts.push(hasCounter('+1/+1'));
    noun = counterClause[1] as string;
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
  }

  // "creature tokens" is an intersection too: the token status is not a subtype. Keep it in
  // the shared subject grammar so activated effects such as "Creature tokens you control gain
  // indestructible" compose with the same selector used by anthems and triggers.
  const tokenType = noun.match(/^(?:(creature|artifact|enchantment|land|planeswalker) )?tokens$/);
  if (tokenType !== null) {
    parts.push(IS_TOKEN);
    if (tokenType[1] !== undefined) parts.push(ofType(titleCase(tokenType[1] as string)));
    noun = 'permanents';
  }

  // "artifact creatures" is an intersection of card types, not a creature subtype named
  // Artifact. Treating it as a subtype would either reject the line or silently match nothing.
  const compoundTypes = noun.match(/^(artifact|enchantment) (creatures|artifacts|enchantments)$/);
  // "non-Human creatures you control" (Return of the Wildspeaker) â€” a negated tribe, the plural
  // counterpart to the mass-destroy grammar's own "non-Dragon creatures" (which reads the tribe
  // out by hand rather than sharing this function; see the "destroy all non-X creatures" rule).
  const negatedTribe = noun.match(
    /^non-(.+?) (creatures|artifacts|enchantments|lands|planeswalkers)$/,
  );
  if (compoundTypes !== null) {
    parts.push(ofType(titleCase(compoundTypes[1] as string)));
    parts.push(ofType(CARD_TYPE_PLURALS[compoundTypes[2] as string] as string));
  } else if (negatedTribe !== null) {
    const subtype = resolveSubtype(negatedTribe[1] as string, card);
    if (subtype === null) return null;
    parts.push(not(ofSubtype(subtype)));
    parts.push(ofType(CARD_TYPE_PLURALS[negatedTribe[2] as string] as string));
  } else if (noun === 'nonland permanents') {
    // "destroy all nonland permanents your opponents control" (Ruinous Ultimatum) â€” the plural
    // counterpart to `TARGET_NOUNS`'s singular `nonlandPermanent`. Not a tribe or a card type, so
    // it needs its own bare-noun case rather than falling through to `resolveSubtype`.
    parts.push(NONLAND);
  } else {
    const bareType = CARD_TYPE_PLURALS[noun];
    const singularType = Object.entries(CARD_TYPE_PLURALS).find(
      ([, type]) => type.toLowerCase() === noun,
    )?.[1];
    if (bareType !== undefined) {
      parts.push(ofType(bareType));
    } else if (singularType !== undefined) {
      parts.push(ofType(singularType));
    } else if (noun !== 'permanents') {
      // Either a bare tribe ("elves") or a tribe plus a card type ("elf creatures").
      const m = noun.match(
        /^(.+) (creature|creatures|artifact|artifacts|enchantment|enchantments|land|lands|planeswalker|planeswalkers)$/,
      );
      const subtype = resolveSubtype(m?.[1] ?? noun, card);
      if (subtype === null) return null;
      parts.push(ofSubtype(subtype));
      if (m !== null)
        parts.push(ofType(CARD_TYPE_PLURALS[m[2] as string] ?? titleCase(m[2] as string)));
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
  /^(.+?) (?:gets? ([+-]\d+)\/([+-]\d+)(?: and gains? (.+?))?|gains? (.+?)) until end of turn$/;

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
  // "transform this creature" is the modern templating; "transform ~" the older printing that
  // `substituteSelfName` produces. Both name the ability's own source (CR 701.28a).
  if (
    /^transform (?:it|~|this (?:artifact|creature|enchantment|land|permanent|planeswalker))$/.test(
      s,
    )
  ) {
    return [{ op: 'transformSelf' }];
  }
  // "Then if it has no ice counters on it, transform it." (Thing in the Ice) — a check made on
  // RESOLUTION, after the earlier sentences of the same ability have already run. Not CR 603.4's
  // intervening-if, which is checked when the ability would trigger; this one has to see the
  // counter the sentence before it just removed, which is why it is an effect and not a
  // `trigger.condition`.
  {
    const trailing = s.match(/^then (?:if|when) (.+?), (.+)$/);
    if (trailing !== null) {
      const condition = parseConditionClause(trailing[1] as string, card);
      const then =
        condition === null ? null : parseEffectSentence(trailing[2] as string, alloc, card, opts);
      if (condition !== null && then !== null) {
        return [{ op: 'conditionalEffect', condition, then, else: [] }];
      }
    }
  }
  // "Each opponent sacrifices a creature or planeswalker with the greatest mana value among
  // creatures and planeswalkers they control" (Flare of Malice). Ties are the sacrificer's choice.
  {
    const greatest = s.match(
      /^each opponent sacrifices a (creature|creature or planeswalker) with the greatest (power|mana value) among (creatures|creatures and planeswalkers) they control$/,
    );
    if (greatest !== null && (greatest[1] === 'creature') === (greatest[3] === 'creatures')) {
      return [
        {
          op: 'sacrificeGreatestEachOpponent',
          selector: greatest[1] === 'creature' ? 'creature' : 'creatureOrPlaneswalker',
          metric: greatest[2] === 'power' ? 'power' : 'manaValue',
          action: 'sacrifice',
        },
      ];
    }
  }
  {
    const sacrifice = s.match(/^each opponent sacrifices an? (.+?)(?: of their choice)?$/);
    // "each opponent sacrifices a nonland permanent of their choice" (Shard of the Void Dragon).
    if (sacrifice !== null && sacrifice[1] === 'nonland permanent') {
      return [{ op: 'sacrificeOneEachOpponent', filter: 'nonland' }];
    }
    if (sacrifice !== null) {
      const filter = parseMassSubject(sacrifice[1] as string, card);
      if (filter !== null) return [{ op: 'sacrificeOneEachOpponent', filter }];
    }
  }
  if (s === 'exile all graveyards') return [{ op: 'exileAllGraveyards' }];
  // "Exile target nonland permanent an opponent controls until this enchantment leaves the
  // battlefield" (Conclave Tribunal): it returns when the source leaves (CR 610.3).
  {
    const until = s.match(
      /^exile target (.+) until (?:~|this (?:enchantment|artifact|creature|permanent)) leaves the battlefield$/,
    );
    const clause = until === null ? null : parseTargetClause(until[1] as string);
    if (clause !== null) {
      const slot = alloc(clause.kind, clause.filter, clause.controller);
      if (typeof slot === 'number') return [{ op: 'exileUntilSourceLeaves', targetSlot: slot }];
    }
  }
  // "You may cast an artifact spell from your hand or graveyard by paying life equal to its mana
  // value rather than paying its mana cost" (Anrakyr the Traveller). Inside a trigger the "you
  // may" has already become the trigger's optional flag; the effect also offers to cast nothing.
  {
    const forLife = s.match(
      /^(?:you may )?cast an? (.+?) spell from your (hand|graveyard|hand or graveyard) by paying life equal to its mana value rather than paying its mana cost$/,
    );
    const selector = forLife === null ? null : parseSubject(forLife[1] as string, card);
    if (forLife !== null && selector !== null) {
      const zones: ('hand' | 'graveyard')[] =
        forLife[2] === 'hand'
          ? ['hand']
          : forLife[2] === 'graveyard'
            ? ['graveyard']
            : ['hand', 'graveyard'];
      return [{ op: 'castForLifeFromZones', selector, zones }];
    }
  }
  // "Each player sacrifices thirteen creatures of their choice" (Blasphemous Edict).
  {
    const many = s.match(/^each player sacrifices (\w+) creatures(?: of their choice)?$/);
    const count = many === null ? null : parseAmount(many[1] as string);
    if (count !== null && count > 1)
      return [{ op: 'sacrificeEachPlayer', count, filter: 'creature' }];
  }
  // Ghost Ark: "each artifact creature card in your graveyard gains unearth {3} until end of
  // turn". The grant ends at cleanup or when that card leaves the graveyard (CR 400.7).
  {
    const unearth = s.match(
      /^each artifact creature card in your graveyard gains unearth ((?:\{[^}]+\})+) until end of turn$/,
    );
    if (unearth !== null) {
      const cost = parseManaCost((unearth[1] as string).toUpperCase() as never);
      if (cost.cost !== null) {
        return [{ op: 'grantUnearthToArtifactCreaturesInGraveyard', cost: cost.cost }];
      }
    }
  }
  if (
    /^return (?:~|this (?:creature|artifact|enchantment|permanent)) to its owner's hand$/.test(s)
  ) {
    return [{ op: 'returnToHand', target: 'source' }];
  }
  // Sensei's Divining Top's second ability. "its owner's library", not "your library" — the
  // distinction matters for a Top someone else has taken control of.
  if (
    /^put (?:~|this (?:creature|artifact|enchantment|permanent|land)) on top of its owner's library$/.test(
      s,
    )
  ) {
    return [{ op: 'selfToLibraryTop' }];
  }
  if (
    s ===
    'after this main phase, there is an additional combat phase followed by an additional main phase'
  ) {
    return [{ op: 'extraCombatPhase' }];
  }
  {
    const copy = s.match(
      /^create a token that's a copy of target creature you control, except it isn't legendary$/,
    );
    if (copy !== null) {
      const target = alloc('creature', undefined, 'you');
      return [
        { op: 'createTokenCopyOf', ref: target, count: constant(1), exceptNonLegendary: true },
      ];
    }
  }
  // An explicit two-target clause is not two independent sentences: both targets are announced
  // together, as in Hull Breach's "destroy target artifact and target enchantment" mode.
  {
    const pair = s.match(/^destroy target (.+?) and target (.+)$/);
    if (pair !== null) {
      const first = parseTargetClause(pair[1] as string);
      const second = parseTargetClause(pair[2] as string);
      if (first !== null && second !== null) {
        const firstTarget = alloc(first.kind, first.filter, first.controller);
        const secondTarget = alloc(second.kind, second.filter, second.controller);
        return [
          { op: 'destroy', target: firstTarget },
          { op: 'destroy', target: secondTarget },
        ];
      }
    }
  }
  // "<effect> and <effect>" — two independent clauses joined by "and" rather than a comma (a
  // removal spell that also draws a card). This has to run BEFORE the specific handlers, not
  // after: several of them hard-`return null` on a partial match ("destroy target <filter>"
  // rejects the filter "artifact and draw a card"), which would strand the split half of every
  // such sentence.
  //
  // Running first is only safe because both halves are parsed against a throwaway allocator
  // first. The trial run is what bounds it. `alloc` mutates the caller's target list, so a half
  // that allocates a slot and THEN fails would leave a phantom target behind; and a half that
  // acquires a target its own text never announces ("gains trample until end of turn") is
  // reading a "target" that belongs to the other half — "target creature gets +3/+3 and gains
  // trample until end of turn" is ONE effect on ONE target (CR 601.2c), and the whole-sentence
  // handler below is the one that reads it correctly.
  for (const match of s.matchAll(/\s+and\s+/g)) {
    const i = match.index ?? -1;
    if (i <= 0) continue;
    const halves = [s.slice(0, i), s.slice(i + match[0].length)] as const;
    let trialSlots = 0;
    const trial: SlotAllocator = () => trialSlots++;
    const splittable = halves.every((half) => {
      const before = trialSlots;
      if (parseEffectSentence(half, trial, card, opts) === null) return false;
      return trialSlots === before || half.includes('target');
    });
    if (!splittable) continue;
    const first = parseEffectSentence(halves[0], alloc, card, opts);
    const second = parseEffectSentence(halves[1], alloc, card, opts);
    if (first !== null && second !== null) return [...first, ...second];
  }
  if (s === "goad all creatures you don't control") return [{ op: 'goadEachOpponent' }];
  if (s === 'target creature attacks this turn if able') {
    return [{ op: 'forceAttack', target: alloc('creature') }];
  }
  {
    const m = s.match(
      /^put (a|one|two|three|four|five|\d+) cards? from your hand on top of your library(?: in any order)?$/,
    );
    if (m !== null) {
      const count = parseAmount(m[1] as string);
      if (count !== null)
        return [
          {
            op: 'putFromHandOnLibraryTop',
            count: constant(count),
            anyOrder: s.endsWith(' in any order'),
          },
        ];
    }
  }
  if (s === 'discard a card at random') return [{ op: 'discardAtRandom', count: constant(1) }];
  if (s === 'each creature attacks this turn if able') {
    return [{ op: 'forceAttackEach', selector: { kind: 'type', value: 'Creature' } }];
  }
  {
    const m = s.match(/^attach (?:this equipment|~) to target creature an opponent controls$/);
    if (m !== null)
      return [{ op: 'attachSelfTo', target: alloc('creature', undefined, 'opponent') }];
  }
  if (s === 'it gains haste until end of turn') {
    return opts.triggerObject === true
      ? [{ op: 'grantKeywordUntilEot', target: 'triggerObject', keyword: 'haste' }]
      : [{ op: 'grantHasteToResolvingSpell' }];
  }
  if (s === 'that spell gains haste until end of turn') {
    return [{ op: 'grantHasteToResolvingSpell' }];
  }
  if (
    s === 'they gain haste until end of turn' ||
    s === 'those creatures gain haste until end of turn'
  ) {
    return [{ op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'haste' }];
  }
  if (
    s === "they can't be regenerated" ||
    s === "it can't be regenerated" ||
    s === 'they cannot be regenerated' ||
    // "Destroy target creature. A creature destroyed this way can't be regenerated." (Damn) —
    // the same no-op rider on the same effect, worded to read naturally after a fresh "destroy"
    // sentence rather than a bare pronoun.
    s === "a creature destroyed this way can't be regenerated"
  ) {
    return [{ op: 'noOp' }];
  }
  // "Exile Their Number Is Legion." on an instant or sorcery: the resolving spell exiles itself.
  if (s === 'exile ~' && /\b(?:Instant|Sorcery)\b/.test(card.typeLine)) {
    return [{ op: 'resolvingSpellExile' }];
  }
  // "You gain life equal to the number of artifacts you control."
  {
    const life = s.match(/^you gain life equal to the number of (.+) you control$/);
    const selector = life === null ? null : parseSubject(life[1] as string, card);
    if (selector !== null) {
      return [{ op: 'gainLife', amount: { kind: 'countPermanents', selector, scope: 'you' } }];
    }
  }
  if (s === "shuffle ~ into its owner's library" || s === 'shuffle ~ into your library') {
    return [{ op: 'shuffle' }];
  }

  if (s === "target creature you control fights target creature you don't control") {
    return [
      {
        op: 'fight',
        first: alloc('creature', undefined, 'you'),
        second: alloc('creature', undefined, 'opponent'),
      },
    ];
  }
  if (
    s ===
    'target creature you control deals damage equal to its power to target creature an opponent controls'
  ) {
    const damageSource = alloc('creature', undefined, 'you');
    const target = alloc('creature', undefined, 'opponent');
    return [
      {
        op: 'dealDamage',
        target,
        amount: { kind: 'powerOfTarget', target: damageSource },
        source: damageSource,
      },
    ];
  }
  if (s === "it fights target creature you don't control" && opts.triggerObject === true) {
    return [
      { op: 'fight', first: 'triggerObject', second: alloc('creature', undefined, 'opponent') },
    ];
  }
  if (s === "~ fights target creature you don't control") {
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
  // "that player loses 2 life and you gain 2 life" (Kambal, Consul of Allocation): the player
  // the trigger's event names — the caster of the spell, for a cast trigger.
  {
    const m = s.match(/^that player loses (\w+) life(?: and you gain (\w+) life)?$/);
    if (m) {
      const loss = parseAmount(m[1] as string);
      const gain = m[2] === undefined ? null : parseAmount(m[2]);
      if (loss !== null && (m[2] === undefined || gain !== null)) {
        return [
          { op: 'loseLifeTarget', target: 'eventPlayer', amount: constant(loss) },
          ...(gain === null ? [] : [{ op: 'gainLife' as const, amount: constant(gain) }]),
        ];
      }
    }
  }
  if (s === 'they get that many poison counters') {
    return [
      {
        op: 'giveTargetPoisonCounters',
        target: 'eventPlayer',
        count: { kind: 'damageDealt' },
      },
    ];
  }
  // "Target player draws two cards." / "Target player draws two cards and loses 2 life." (Sign
  // in Blood) â€” the target draws, not the caster (contrast the untargeted "you draw N cards and
  // lose N life" sentence above).
  {
    const m = s.match(/^target player draws (\w+) cards?(?: and loses (\w+) life)?$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      const target = alloc('player');
      const effects: Effect[] = [{ op: 'drawTarget', target, count: constant(count) }];
      if (m[2] !== undefined) {
        const life = parseAmount(m[2] as string);
        if (life === null) return null;
        effects.push({ op: 'loseLifeTarget', target, amount: constant(life) });
      }
      return effects;
    }
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
    return [
      { op: 'untapTarget', target: first },
      { op: 'untapTarget', target: second },
    ];
  }
  if (s === 'untap target creature') {
    return [{ op: 'untapTarget', target: alloc('creature') }];
  }
  if (s === 'untap target permanent') {
    return [{ op: 'untapTarget', target: alloc('permanent') }];
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
  // "…, then untap it" (Westvale Abbey) — the ability's own source, not a target. Reached via
  // `parseEffectSentence`'s ", then " split, so the "it" is whatever the first half acted on,
  // which for every printing of this shape is the source itself.
  if (/^untap (?:it|~|this (?:artifact|creature|enchantment|land|permanent))$/.test(s)) {
    // A bare spell pronoun needs an explicit preceding referent; its source is on the stack.
    if (card.types.includes('Instant') || card.types.includes('Sorcery')) return null;
    return [{ op: 'untapTarget', target: 'source' }];
  }
  if (s === 'put target artifact card from your graveyard on top of your library') {
    return [{ op: 'graveyardToLibraryTop', target: alloc('cardInGraveyard', ofType('Artifact')) }];
  }
  // "Put target card from your graveyard on the bottom of your library" (Mistveil Plains): any
  // card, so the graveyard target carries no filter.
  // "Return any number of artifact creature cards with total mana value 6 or less from your
  // graveyard to the battlefield" (Technomancer): chosen on resolution, not targeted.
  {
    const m = s.match(
      /^return any number of artifact creature cards with total mana value (\d+) or less from your graveyard to the battlefield$/,
    );
    if (m !== null)
      return [{ op: 'returnArtifactCreaturesUpToManaValue', maxManaValue: Number(m[1]) }];
  }
  // "This creature connives" (Body Launderer, CR 701.50).
  if (s === '~ connives') return [{ op: 'connive' }];
  // "Return another target non-Rogue creature card with equal or lesser power from your
  // graveyard to the battlefield" (Body Launderer): the power bound is the source's, last-known
  // once it has died (CR 608.2h).
  {
    const m = s.match(
      /^return another target (.+?) card with equal or lesser power from your graveyard to the battlefield$/,
    );
    const filter = m === null ? null : parseCardFilterPhrase(m[1] as string, card);
    if (filter !== null) {
      const target = alloc('cardInGraveyard', allOf(OTHER, filter, { kind: 'powerAtMostSource' }));
      return [{ op: 'graveyardToBattlefield', target }];
    }
  }
  if (s === 'put target card from your graveyard on the bottom of your library') {
    return [{ op: 'graveyardToLibraryBottom', target: alloc('cardInGraveyard') }];
  }
  // "Exile target card from a graveyard" (The Ooze): any card in any graveyard, moved through a
  // real zone change so leave-graveyard abilities see it.
  if (s === 'exile target card from a graveyard') {
    return [{ op: 'exileCard', target: alloc('cardInGraveyard', undefined, undefined, 'any') }];
  }
  if (s === 'exile target attacking or blocking creature') {
    return [{ op: 'exile', target: alloc('creature', { kind: 'inCombat' }) }];
  }

  if (
    s === 'search your library for a dragon card, reveal it, put it into your hand, then shuffle'
  ) {
    return [{ op: 'searchLibrary', filter: ofSubtype('Dragon'), destinations: [{ zone: 'hand' }] }];
  }
  if (s === 'destroy all non-dragon creatures') {
    return [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofSubtype('Dragon'))) }];
  }
  if (s === "return target spell or nonland permanent an opponent controls to its owner's hand") {
    return [
      { op: 'returnToHand', target: alloc('spellOrNonlandPermanent', undefined, 'opponent') },
    ];
  }
  if (s === "return target nonland permanent you don't control to its owner's hand") {
    return [{ op: 'returnToHand', target: alloc('nonlandPermanent', undefined, 'opponent') }];
  }
  // "Return target spell you don't control to its owner's hand" (Hullbreaker Horror). Bouncing a
  // spell off the stack is NOT countering it — the card goes to hand rather than the graveyard,
  // and a "can't be countered" spell is still returned this way. `returnToHand` already handles
  // a stack target; only the phrasing was missing.
  {
    const m = s.match(
      /^return target spell (?:you don't control|an opponent controls) to its owner's hand$/,
    );
    if (m !== null) {
      return [{ op: 'returnToHand', target: alloc('spell', undefined, 'opponent') }];
    }
  }
  {
    // The target noun is read by `parseTargetClause`, not a fixed list: Otawara bounces an
    // "artifact, creature, enchantment, or planeswalker", which is a compound alternation, and
    // the clause parser already composes those (and any "you control" / "an opponent controls"
    // suffix) into a kind plus a filter.
    const m = s.match(
      /^return (?:up to (\w+) )?(other )?target (.+?)s? to (?:its owner's hand|their owners' hands)$/,
    );
    if (m) {
      const clause = parseTargetClause(m[3] as string);
      if (clause !== null) {
        const kind = clause.kind;
        const filter =
          m[2] !== undefined
            ? clause.filter === undefined
              ? OTHER
              : allOf(OTHER, clause.filter)
            : clause.filter;
        // "up to N" (Marang River Regent) is a variable-count announcement (CR 601.2b/603.3d),
        // not N separate ordinary slots and not one mandatory slot — the count itself used to be
        // silently dropped here, which turned "up to two, never obliges you" into "return
        // exactly one, mandatory."
        if (m[1] !== undefined) {
          const max = parseAmount(m[1] as string);
          if (max === null || opts.allocCount === undefined) return null;
          const slot = opts.allocCount(kind, { min: 0, max }, clause.controller, filter);
          return [{ op: 'returnToHandEachChosen', targetSlot: slot }];
        }
        // `clause.controller` MUST be carried through: dropping it turns "target creature you
        // control" into "target creature", which is a strictly more permissive spell.
        return [{ op: 'returnToHand', target: alloc(kind, filter, clause.controller) }];
      }
    }
  }
  // "Each player discards their hand, then draws seven cards" (Dragon Mage) and Windfall's
  // "...draws cards equal to the greatest number of cards a player discarded this way."
  {
    const m = s.match(
      /^each player discards their hand, then draws (\\w+) cards$|^each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way$/,
    );
    if (m !== null) {
      if (m[1] === undefined)
        return [{ op: 'eachPlayerDiscardHandThenDraw', greatestDiscarded: true }];
      const n = parseAmount(m[1] as string);
      if (n === null) return null;
      return [{ op: 'eachPlayerDiscardHandThenDraw', count: constant(n) }];
    }
  }
  if (s === 'put your commander into your hand from the command zone') {
    return [{ op: 'commandZoneToHand' }];
  }
  if (s.startsWith("until your next turn, creatures can't attack you")) {
    return [{ op: 'noOp' }];
  }

  // "When enchanted creature dies, return it to the battlefield under your control" (Changing
  // Loyalty): "it" is the card the trigger's subject became, wherever it was put (CR 400.7).
  if (opts.triggerObject === true && s === 'return it to the battlefield under your control') {
    return [{ op: 'graveyardToBattlefield', target: 'triggerObject' }];
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
      return [
        { op: 'grantKeywordUntilEot', target: 'attachedToSource', keyword: m[2] as KeywordAbility },
      ];
    }
  }
  {
    const m = s.match(
      /^(enchanted|equipped) creature gets ([+-]\d+)\/([+-]\d+) until end of turn$/,
    );
    if (m) {
      return [
        {
          op: 'pumpUntilEot',
          target: 'attachedToSource',
          power: Number(m[2]),
          toughness: Number(m[3]),
        },
      ];
    }
  }
  {
    const m = s.match(
      /^(enchanted|equipped) creature gets ([+-]\d+)\/([+-]\d+) or ([+-]\d+)\/([+-]\d+) until end of turn$/,
    );
    if (m) {
      return [
        {
          op: 'chooseOne',
          options: [
            {
              description: `Enchanted creature gets ${m[2]}/${m[3]} until end of turn`,
              effects: [
                {
                  op: 'pumpUntilEot',
                  target: 'attachedToSource',
                  power: Number(m[2]),
                  toughness: Number(m[3]),
                },
              ],
            },
            {
              description: `Enchanted creature gets ${m[4]}/${m[5]} until end of turn`,
              effects: [
                {
                  op: 'pumpUntilEot',
                  target: 'attachedToSource',
                  power: Number(m[4]),
                  toughness: Number(m[5]),
                },
              ],
            },
          ],
        },
      ];
    }
  }
  // "You get an emblem with \"Whenever you cast a spell, exile target permanent.\"" (Venser, the
  // Sojourner): the quoted ability is parsed as a trigger line, in its printed casing.
  {
    const emblem = s.match(/^you get an emblem with "(.+)"$/);
    if (emblem !== null) {
      const quoted = (emblem[1] as string).replace(/\.$/, '');
      const at = card.oracleText.toLowerCase().indexOf(quoted);
      const abilities = parseTriggerLine(
        at < 0 ? quoted : card.oracleText.slice(at, at + quoted.length),
        card,
      );
      if (abilities === null || abilities.length === 0) return null;
      return [{ op: 'createEmblem', name: `${card.name} emblem`, abilities }];
    }
  }
  if (s === "creatures can't be blocked this turn") {
    return [{ op: 'creaturesCantBeBlockedThisTurn' }];
  }
  if (s === "target creature can't be blocked this turn") {
    return [{ op: 'cantBeBlockedUntilEot', target: alloc('creature') }];
  }
  // A pump may use the announced X and grant one or more keywords to the same target.
  {
    const m = s.match(
      /^(target creature|~) gets \+x\/\+0 and gains ([a-z]+(?: and [a-z]+)*) until end of turn$/,
    );
    if (m !== null) {
      const parsed = parseKeywordLine(m[2] as string);
      if (parsed === null || parsed.ward !== undefined || parsed.protectionFrom !== undefined) {
        return null;
      }
      const power: Value = { kind: 'xValue' };
      if (m[1] === '~') {
        return [
          { op: 'pumpEachUntilEot', selector: SELF, power, toughness: 0 },
          ...parsed.keywords.map((keyword): Effect => ({
            op: 'grantKeywordEachUntilEot',
            selector: SELF,
            keyword,
          })),
        ];
      }
      const target = alloc('creature');
      return [
        { op: 'pumpUntilEot', target, power, toughness: 0 },
        ...parsed.keywords.map((keyword): Effect => ({
          op: 'grantKeywordUntilEot',
          target,
          keyword,
        })),
      ];
    }
  }
  // A pump may grant a list of implemented keywords to the same target.
  {
    const m = s.match(
      /^(target creature|~) gets ([+-]\d+)\/([+-]\d+) and gains ([a-z]+(?: and [a-z]+)+) until end of turn$/,
    );
    if (m !== null) {
      const parsed = parseKeywordLine(m[4] as string);
      if (parsed === null || parsed.ward !== undefined || parsed.protectionFrom !== undefined) {
        return null;
      }
      const power = Number(m[2]);
      const toughness = Number(m[3]);
      if (m[1] === '~') {
        return [
          { op: 'pumpEachUntilEot', selector: SELF, power, toughness },
          ...parsed.keywords.map((keyword): Effect => ({
            op: 'grantKeywordEachUntilEot',
            selector: SELF,
            keyword,
          })),
        ];
      }
      const target = alloc('creature');
      return [
        { op: 'pumpUntilEot', target, power, toughness },
        ...parsed.keywords.map((keyword): Effect => ({
          op: 'grantKeywordUntilEot',
          target,
          keyword,
        })),
      ];
    }
  } // "target creature gets +3/+3 until end of turn"
  // "~ gets +1/+0 until end of turn" (firebreathing)
  // "target creature gets +2/+2 and gains flying until end of turn"
  {
    // Also "another target artifact creature you control gets +2/+2 and gains menace until end
    // of turn" (Imotekh the Stormlord): the same single slot, narrowed by the target clause.
    const m = s.match(
      /^(~|(?:another )?target (?:artifact )?creature(?: you control| you don't control| an opponent controls)?) gets ([+-]\d+)\/([+-]\d+)(?: and gains ([a-z ]+))? until end of turn$/,
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
        // ONE "target creature", so ONE target slot (CR 601.2c): the pump and the keyword grant
        // both apply to the creature the spell announced. Allocating a second slot here would
        // let the pump and the grant land on different creatures.
        const narrowing = [
          ...(subject.startsWith('another ') ? [OTHER] : []),
          ...(subject.includes('artifact creature') ? [ofType('Artifact')] : []),
        ];
        const controller =
          subject.endsWith("you don't control") || subject.endsWith('an opponent controls')
            ? ('opponent' as const)
            : subject.endsWith('you control')
              ? ('you' as const)
              : undefined;
        const target = alloc(
          'creature',
          narrowing.length === 0
            ? undefined
            : narrowing.length === 1
              ? narrowing[0]
              : allOf(...narrowing),
          controller,
        );
        const effects: Effect[] = [
          {
            op: 'pumpUntilEot',
            target,
            power,
            toughness,
          },
        ];
        if (m[4] !== undefined) {
          if (!KEYWORD_SET.has(m[4])) return null;
          effects.push({
            op: 'grantKeywordUntilEot',
            target,
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
    // "All creatures get -X/-X until end of turn" (Toxic Deluge): X is the announced value.
    const x = s.match(/^(.+?) gets? ([+-])x\/([+-])x until end of turn$/);
    // Only a card that announces X ({X} in its cost, or "pay X life") defines it here; any other
    // X is defined elsewhere ("where X is …") and is not this rule's.
    if (
      x !== null &&
      ((card.manaCost ?? '').includes('{X}') ||
        /additional cost to cast this spell, pay x life/i.test(card.oracleText ?? ''))
    ) {
      const subject = x[1] as string;
      const selector =
        subject === 'all creatures' ? ofType('Creature') : parseSubject(subject, card);
      if (selector === null) return null;
      const signed = (sign: string): Value =>
        sign === '-' ? { kind: 'negate', of: { kind: 'xValue' } } : { kind: 'xValue' };
      return [
        {
          op: 'pumpEachUntilEot',
          selector,
          power: signed(x[2] as string),
          toughness: signed(x[3] as string),
        },
      ];
    }
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
        // Ward is still refused: `UntilEotEffect` has no shape for a granted ward cost, and a
        // grant the engine drops silently would leave the card claiming to be modeled.
        // Protection IS supported here (Akroma's Will) via its own effect op — it carries an
        // argument, so it cannot ride on `keyword`.
        if (parsed === null || parsed.ward !== undefined) return null;
        for (const keyword of parsed.keywords) {
          effects.push({ op: 'grantKeywordEachUntilEot', selector, keyword });
        }
        if (parsed.protectionFrom !== undefined) {
          effects.push({
            op: 'grantProtectionEachUntilEot',
            selector,
            colors: [...parsed.protectionFrom],
          });
        }
      }
      if (effects.length > 0) return effects;
    }
  }
  // "~ deals 3 damage to any target" / "â€¦ to target creature" / "â€¦ to each opponent"
  {
    if (
      opts.triggerObject === true &&
      (s === 'it deals damage equal to its power to any target' ||
        s === 'that creature deals damage equal to its power to any target')
    ) {
      return [
        {
          op: 'dealDamage',
          target: alloc('anyTarget'),
          amount: { kind: 'powerOfTriggerObject' },
          source: 'triggerObject',
        },
      ];
    }
    {
      const targetHandDamage = s.match(
        /^~ deals damage to target player equal to the number of cards in that player's hand$/,
      );
      if (targetHandDamage !== null) {
        const target = alloc('player');
        return [{ op: 'dealDamage', target, amount: { kind: 'cardsInTargetHand', target } }];
      }
      // "this creature deals damage equal to its power to that player" (Gleeful Arsonist): the
      // event's player — the caster, for a cast trigger.
      // "this creature deals damage equal to that spell's mana value to target opponent" (Keeper of
      // Secrets): the triggering spell's mana value, kept on the trigger as it is cast.
      if (s === "~ deals damage equal to that spell's mana value to target opponent") {
        return [
          {
            op: 'dealDamage',
            target: alloc('player', undefined, 'opponent'),
            amount: { kind: 'spellManaValue' },
          },
        ];
      }
      if (s === '~ deals damage equal to its power to that player') {
        return [{ op: 'dealDamage', target: 'eventPlayer', amount: { kind: 'powerOfSource' } }];
      }
      if (s === "~ deals 2 damage to that creature's controller") {
        return [{ op: 'dealDamage', target: 'eventPlayer', amount: constant(2) }];
      }
      if (
        s === "~ deals damage equal to the number of spells you've cast this turn to any target" ||
        (opts.triggerObject !== true &&
          s === "it deals damage equal to the number of spells you've cast this turn to any target")
      ) {
        return [
          { op: 'dealDamage', target: alloc('anyTarget'), amount: { kind: 'spellsCastThisTurn' } },
        ];
      }
    }
    {
      // "This land deals 1 damage to you" (City of Brass) - damage from the source to its OWN
      // controller. `it` is the printed pronoun once the trigger head has already named the source.
      const m = s.match(/^(?:~|it) deals (\w+) damage to you$/);
      if (m !== null) {
        const amount = parseAmount(m[1] as string);
        if (amount === null) return null;
        return [{ op: 'damageController', amount }];
      }
    }
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
    return [{ op: 'counter', target: alloc('spell') }];
  }
  if (s === 'counter target noncreature spell') {
    return [{ op: 'counter', target: alloc('noncreatureSpell') }];
  }
  // "Counter target spell unless its controller pays {3}" (Mystic Confluence's first mode).
  // `counterUnlessControllerPays` already exists for Stubborn Denial, but only inside that
  // card's whole-block parser; this is the same effect as a plain sentence, so it also reaches
  // a modal bullet.
  {
    const m = s.match(
      /^counter target (noncreature )?spell unless its controller pays (\{[^}]+\})$/,
    );
    if (m !== null) {
      const parsedCost = parseManaCost((m[2] as string).toUpperCase() as never);
      if (parsedCost.cost !== null) {
        const target = alloc(m[1] === undefined ? 'spell' : 'noncreatureSpell');
        return [{ op: 'counterUnlessControllerPays', target, cost: parsedCost.cost }];
      }
    }
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
      return [
        { op: 'addMana', amount: constant(symbols.length), colors: [], fixedSymbols: symbols },
      ];
    }
  }
  // "exile up to one target nonland permanent" (Canoptek Tomb Sentinel) — a variable-count slot:
  // choosing no target is legal, and the ability still resolves (CR 115.1d, 601.2c).
  {
    const m = s.match(/^(destroy|exile) up to (\w+) target (.+)$/);
    if (m && opts.allocCount !== undefined) {
      const max = parseAmount(m[2] as string);
      const parsed = parseTargetClause(m[3] as string);
      if (max !== null && parsed !== null) {
        const targetSlot = opts.allocCount(
          parsed.kind,
          { min: 0, max },
          parsed.controller,
          parsed.filter,
        );
        return [{ op: m[1] === 'destroy' ? 'destroyEachChosen' : 'exileEachChosen', targetSlot }];
      }
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
    // Not a creature type ("destroy all nontoken creatures"): leave it to the generic mass form.
    const subtype = m === null ? null : resolveSubtype(m[2] as string, card);
    if (m !== null && subtype !== null) {
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
    const m = s.match(
      /^return (?:up to (\w+) )?(other )?target(?: (.+?))? (?:card|cards) from (your|a) graveyard to (the battlefield|your hand)$/,
    );
    if (m) {
      const typePhrase = m[3];
      const filter = typePhrase === undefined ? null : parseCardFilterPhrase(typePhrase, card);
      if (typePhrase === undefined || filter !== null) {
        const target = alloc(
          'cardInGraveyard',
          filter ?? undefined,
          undefined,
          m[4] === 'a' ? 'any' : undefined,
        );
        return [
          m[5] === 'the battlefield'
            ? { op: 'graveyardToBattlefield', target }
            : { op: 'graveyardToHand', target },
        ];
      }
    }
    const mMass = s.match(
      /^return all (.+?) (?:card|cards) from (your|a) graveyard to (the battlefield|your hand)$/,
    );
    if (mMass) {
      // This primitive only identifies the controller's graveyard. An unspecified graveyard
      // needs a separate owner choice rather than silently choosing the caster.
      if (mMass[2] !== 'your') return null;
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
    const m = s.match(
      /^(destroy|exile|return) all (.+?)(?: to (?:its owner's hand|their owners' hands))?$/,
    );
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
    const m = s.match(
      /^put (\w+) ([+-]\d+\/[+-]\d+) counters? on (target creature|~|this creature|it)$/,
    );
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      const counter = m[2] as string;
      return m[3] === 'it' && opts.triggerObject === true
        ? [{ op: 'putCounters', target: 'triggerObject', counter, count }]
        : m[3] === '~' || m[3] === 'this creature'
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
      const countVal =
        parseCountPhrase(m[1] as string, opts?.thatMany) ??
        (m[1]?.toLowerCase() === 'x' ? { kind: 'xValue' } : null);
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
  {
    const targetHand = s.match(
      /^draw cards equal to the number of cards in target opponent's hand$/,
    );
    if (targetHand !== null) {
      const target = alloc('player', undefined, 'opponent');
      return [{ op: 'draw', count: { kind: 'cardsInTargetHand', target } }];
    }
    if (s === 'draw a card for each tapped creature target opponent controls') {
      const target = alloc('player', undefined, 'opponent');
      return [{ op: 'draw', count: { kind: 'tappedCreaturesControlledByTarget', target } }];
    }
    if (s === 'draw a card for each attacking creature') {
      return [{ op: 'draw', count: { kind: 'attackingCreatures' } }];
    }
    // "Add {R} for each card in target opponent's hand" (Jeska's Will). A SPELL effect, not a
    // mana ability: it is one bullet of a modal sorcery, it targets, and it uses the stack.
    const addPerCard = s.match(/^add (\{[wubrgc]\}) for each card in target opponent's hand$/);
    if (addPerCard !== null) {
      const target = alloc('player', undefined, 'opponent');
      const symbol = manaSymbols(addPerCard[1] as string)[0];
      if (symbol === undefined) return null;
      return [
        {
          op: 'addMana',
          amount: { kind: 'cardsInTargetHand', target },
          colors: [symbol],
        },
      ];
    }
  }
  {
    const freeCast = s.match(
      /^you may cast a spell with mana value (\d+) or less from your hand without paying its mana cost$/,
    );
    if (freeCast !== null) {
      return [{ op: 'castOneFromHandFreeUpTo', maxManaValue: Number(freeCast[1]) }];
    }
  }
  // "draw a card" / "draw two cards" / "you draw a card" / "draw that many cards"
  // "draw a card unless that player pays {1}" (Rhystic Study). The payment belongs to the
  // player named by the triggering cast event, not to the controller of this ability.
  // "…unless that player pays {X}, where X is this creature's power" (Esper Sentinel). The
  // amount is a Value, so it cannot be folded into the printed-symbol branch below.
  {
    const m = s.match(/^(.+?) unless that player pays \{x\}, where x is (.+)$/);
    if (m !== null) {
      const genericValue = parseDynamicCountValue(m[2] as string, card);
      const then = parseEffectSentence(m[1] as string, alloc, card, opts);
      if (genericValue !== null && then !== null) {
        return [{ op: 'unlessPays', payer: 'eventPlayer', cost: emptyCost(), genericValue, then }];
      }
      return null;
    }
  }
  {
    const m = s.match(/^(.+?) unless that player pays ((?:\{[^}]+\})+)$/);
    if (m !== null) {
      const parsedCost = parseManaCost((m[2] as string).toUpperCase() as never);
      const then = parseEffectSentence(m[1] as string, alloc, card, opts);
      if (parsedCost.cost !== null && then !== null) {
        return [{ op: 'unlessPays', payer: 'eventPlayer', cost: parsedCost.cost, then }];
      }
      return null;
    }
  }
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
    const beneficiary = s.match(/^target (?:opponent|player) creates? (.+)$/);
    if (beneficiary !== null) {
      const parsed = parseCreateTokenSentence(`create ${beneficiary[1] as string}`, card, opts);
      const token = parsed?.length === 1 && parsed[0]?.op === 'createToken' ? parsed[0] : null;
      if (token !== null) {
        return [
          {
            op: 'createTokenForPlayer',
            target: alloc('player', undefined, 'opponent'),
            spec: token.spec,
            count: token.count,
          },
        ];
      }
    }
    const exceptTarget = s.match(/^each player other than target player creates (.+)$/);
    if (exceptTarget !== null) {
      const parsed = parseCreateTokenSentence(`create ${exceptTarget[1] as string}`, card, opts);
      const token = parsed?.length === 1 && parsed[0]?.op === 'createToken' ? parsed[0] : null;
      if (token !== null) {
        return [
          {
            op: 'createTokenForEachPlayerExceptTarget',
            target: alloc('player'),
            spec: token.spec,
            count: token.count,
          },
        ];
      }
    }
    const perToken = s.match(/^for each token you control, create (.+)$/);
    if (perToken !== null) {
      const parsed = parseCreateTokenSentence(`create ${perToken[1] as string}`, card, opts);
      const token = parsed?.length === 1 && parsed[0]?.op === 'createToken' ? parsed[0] : null;
      if (token !== null) {
        return [
          {
            op: 'createToken',
            spec: token.spec,
            count: { kind: 'countPermanents', selector: allOf(IS_TOKEN, YOURS), scope: 'all' },
          },
        ];
      }
    }
    if (s.startsWith('you create ')) {
      const parsed = parseCreateTokenSentence(s.slice('you '.length), card, opts);
      if (parsed !== null) return parsed;
    }
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
  {
    const m = s.match(/^untap up to (\w+) (.+)$/);
    if (m) {
      const max = parseAmount(m[1] as string);
      const selector = parseSubject(m[2] as string, card);
      if (max === null || selector === null) return null;
      return [{ op: 'untapUpTo', selector, max }];
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
      return [
        { op: 'draw', count: constant(cards) },
        { op: 'loseLife', amount: constant(life) },
      ];
    }
  }
  // "each opponent loses 1 life" / "each opponent loses 1 life and you gain 1 life" (the
  // aristocrats drain template: Zulaport Cutthroat, Cauldron of Essence, Syr Konrad's activated
  // ability). "Target player loses 1 life and you gain 1 life" (Blood Artist) is the same
  // template with a targeted victim instead of every opponent.
  // The Gray Merchant / Exsanguinate drain, whose amount is a Value rather than a number.
  // Its "you gain life equal to the life lost this way" half is a separate sentence and is
  // matched on its own below — the two communicate through the resolution-scoped total, not
  // through the IR.
  {
    const m = s.match(/^each opponent loses (?:x life, where x is (.+)|life equal to (.+))$/);
    if (m) {
      const amount = parseDynamicCountValue((m[1] ?? m[2]) as string, card);
      if (amount === null) return null;
      return [{ op: 'eachOpponentLosesLife', amount }];
    }
    // Bare "{X}" with no "where X is" gloss: the value announced for the spell's own {X}.
    if (s === 'each opponent loses x life') {
      return [{ op: 'eachOpponentLosesLife', amount: { kind: 'xValue' } }];
    }
  }
  // "put the exiled card into its owner's hand" (Watcher for Tomorrow): the card this permanent's
  // Hideaway exiled — a linked ability (CR 607.2a), so only a card with Hideaway can say it.
  if (s === "put the exiled card into its owner's hand" && /^Hideaway \d/m.test(card.oracleText)) {
    return [{ op: 'returnExiledAttachedCard' }];
  }
  if (s === 'target opponent loses half their life, rounded up') {
    return [{ op: 'loseHalfLifeTarget', target: alloc('player', undefined, 'opponent') }];
  }
  if (s === 'you gain life equal to the life lost this way') {
    return [{ op: 'gainLifeEqualToLifeLostThisWay' }];
  }
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
    // "target opponent loses 1 life and you gain 1 life" (Psychomancer) is the same drain with an
    // opponent-only slot.
    const m = s.match(/^target (player|opponent) loses (\w+) life(?: and you gain (\w+) life)?$/);
    if (m) {
      const amount = parseAmount(m[2] as string);
      if (amount === null) return null;
      const target = m[1] === 'opponent' ? alloc('player', undefined, 'opponent') : alloc('player');
      const effects: Effect[] = [{ op: 'loseLifeTarget', target, amount: constant(amount) }];
      if (m[3] !== undefined) {
        const gain = parseAmount(m[3] as string);
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
 * "Exile the top three cards of your library. You may play them this turn." (Jeska's Will)
 *
 * A whole-block parse for the same reason `parseLookAtTopBlock` is one: "them" in the second
 * sentence only means anything relative to the first, and the IR has no way to carry an exiled
 * set between two independently-parsed ops.
 */
const EXILE_TOP_PLAYABLE_RE =
  /^exile the top (\w+) cards? of your library\. you may play (?:them|it) this turn$/;

function parseExileTopPlayableBlock(lower: string): Effect[] | null {
  const m = lower.replace(/\.$/, '').match(EXILE_TOP_PLAYABLE_RE);
  if (m === null) return null;
  const count = parseAmount(m[1] as string);
  if (count === null || count <= 0) return null;
  return [{ op: 'exileTopNPlayableUntilEot', count: constant(count) }];
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
  const normalized = lower.replace(/\.$/, '');
  const reorder = normalized.match(
    /^look at the top (\w+) cards of your library, then put them back in any order(?:\. you may shuffle(?: your library)?)?(?:\. draw a card)?$/,
  );
  if (reorder !== null) {
    const count = parseAmount(reorder[1] as string);
    if (count === null) return null;
    const mayShuffle = /\. you may shuffle(?: your library)?(?:\.|$)/.test(normalized);
    const drawAfter = normalized.endsWith('. draw a card');
    return [
      {
        op: 'lookAtTopN',
        count,
        rest: 'topAnyOrder',
        ...(mayShuffle ? { mayShuffle: true as const } : {}),
      },
      ...(drawAfter ? [{ op: 'draw' as const, count: constant(1) }] : []),
    ];
  }

  // "Look at the top card of your library. If it's a creature card of the chosen type, you may
  // reveal it and put it into your hand." (Herald's Horn) - the SINGULAR form, with the filter
  // in an if-clause instead of on the "you may put" and no "put the rest": a card not taken
  // simply stays where it was, which is what `rest: 'topAnyOrder'` means for one card.
  const single = normalized.match(
    /^look at the top card of your library\. if it's (?:a|an) (.+?), you may reveal it and put it into your hand$/,
  );
  if (single !== null) {
    const filter = parseSearchFilter(single[1] as string, card);
    if (filter === null) return null;
    return [
      {
        op: 'lookAtTopN',
        count: 1,
        mayPut: { filter, destination: { zone: 'hand' } },
        rest: 'topAnyOrder',
      },
    ];
  }

  const m = normalized.match(
    /^look at the top (\w+) cards of your library\. you may put (?:a|an) (.+?) from among them (onto the battlefield( tapped)?|into your hand)\. put the rest (on the bottom of your library in a random order|on top of your library in any order)$/,
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

  return [
    {
      op: 'lookAtTopN',
      count,
      mayPut: { filter, destination },
      rest: (m[5] as string).startsWith('on top') ? 'topAnyOrder' : 'bottomRandom',
    },
  ];
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
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3 || lines[0]?.toLowerCase() !== 'spree') return null;
  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
    targets.push(
      kind === 'cardInGraveyard'
        ? graveyardCardTarget(
            graveyardOwnerScope ?? 'controller',
            filter === undefined ? {} : { filter },
          )
        : {
            kind,
            ...(filter !== undefined ? { filter } : {}),
            ...(controller !== undefined ? { controller } : {}),
          },
    );
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
    const targetSlots = Array.from(
      { length: targets.length - firstTargetSlot },
      (_, index) => firstTargetSlot + index,
    );
    options.push({
      description,
      effects,
      additionalCost: [{ kind: 'mana', cost: parsedCost.cost }],
      targetSlots,
    });
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
  // A header plus at least ONE bullet. One mode under an "up to one"/"one or more" header is a
  // real printing; whether the count is actually satisfiable is checked against `exact` below,
  // once the header has been read.
  if (lines.length < 2) return null;
  const header = (lines[0] as string).match(
    /^choose (up to one|one|one or more|one or both|any number|two|three)(?:\s*(?:\u2014|-)|\.)\s*(.*)$/i,
  );
  if (header === null) return null;

  const conditionalHeader = (header[2] as string).trim().toLowerCase();
  const repeatable = /^you may choose the same mode more than once\.?$/.test(conditionalHeader);
  const maxChoicesIf =
    conditionalHeader ===
    'if you control a commander as you cast this spell, you may choose both instead.'
      ? { condition: { kind: 'controlsACommander' as const }, maxChoices: 2 }
      : repeatable || conditionalHeader.length === 0
        ? undefined
        : null;
  if (maxChoicesIf === null) return null;

  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
    targets.push(
      kind === 'cardInGraveyard'
        ? graveyardCardTarget(
            graveyardOwnerScope ?? 'controller',
            filter === undefined ? {} : { filter },
          )
        : {
            kind,
            ...(filter !== undefined ? { filter } : {}),
            ...(controller !== undefined ? { controller } : {}),
          },
    );
    return targets.length - 1;
  };

  const options: NonNullable<Ability['modes']>['options'] = [];
  for (const bulletLine of lines.slice(1)) {
    const m = bulletLine.match(/^\u2022\s*(.+?)\.?$/);
    if (m === null) return null;
    const raw = m[1] as string;
    const labeled = raw.match(/^(.+?)\s*(?:\u2014|\s-\s)\s*(.+)$/);
    const label = labeled?.[1] as string | undefined;
    const text = (labeled?.[2] ?? raw) as string;
    const firstTargetSlot = targets.length;
    // Whole-bullet blocks first: a bullet whose second sentence refers back to the first
    // ("...you may play THEM this turn") cannot be parsed sentence by sentence.
    // The block parsers match lowercased text, the way `parseEffectSentence` does internally.
    const blockText = text.toLowerCase();
    const block = parseLookAtTopBlock(blockText, card) ?? parseExileTopPlayableBlock(blockText);
    const parsed: Effect[] = [];
    if (block !== null) {
      parsed.push(...block);
    } else {
      const parsedSentences = splitSentences(text);
      if (parsedSentences.length === 0) return null;
      for (const sentence of parsedSentences) {
        const sentenceEffects = parseEffectSentence(sentence, alloc, card);
        if (sentenceEffects === null) return null;
        appendSentenceEffects(parsed, sentence, sentenceEffects);
      }
    }
    const targetSlots = Array.from(
      { length: targets.length - firstTargetSlot },
      (_, index) => firstTargetSlot + index,
    );
    const description = label === undefined ? text : `${label}: ${text}`;
    options.push({ effects: parsed, description, targetSlots });
  }
  if (options.length === 0) return null;
  const choice = (header[1] as string).toLowerCase();
  // "Choose two —" (Austere Command) is an exact count (CR 700.2d), unlike the "at least"/"up
  // to" headers above it: it must pick precisely N different modes, not merely up to N.
  const exact = choice === 'two' ? 2 : choice === 'three' ? 3 : null;
  // An exact-count header needs at least that many DISTINCT modes to be satisfiable — unless
  // the block is repeatable (Mystic Confluence), where one mode can be chosen again. A single
  // bullet under an "up to"/"one or more" header is legal and was previously rejected.
  if (exact !== null && !repeatable && options.length < exact) return null;
  const minChoices = exact ?? (choice === 'any number' || choice === 'up to one' ? 0 : 1);
  const maxChoices =
    exact ??
    (choice === 'up to one'
      ? 1
      : choice === 'one'
        ? 1
        : choice === 'one or both'
          ? Math.min(2, options.length)
          : options.length);
  return {
    targets,
    modes: {
      minChoices,
      maxChoices,
      ...(repeatable ? { repeatable: true } : {}),
      ...(maxChoicesIf !== undefined ? { maxChoicesIf } : {}),
      options,
    },
  };
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
    targets: [counterSpellTarget('noncreatureSpell')],
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
/**
 * Counter a spell, then create tokens for that spell's controller. The combined primitive keeps
 * the beneficiary available after the countered spell has left the stack.
 */
/** Parse Path/Trophy-style removal whose target's controller receives a basic-land search. */
function parseRemoveAndControllerSearchBlock(
  text: string,
  _card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const norm = stripReminderText(text).trim();
  const m = norm.match(
    /^(destroy|exile) target (.+?)\. its controller may search their library for a basic land card, put (?:that card|it) onto the battlefield( tapped)?, then shuffle\.?$/i,
  );
  if (m === null) {
    const winds = norm.match(
      /^exile target (.+?)\. for each creature exiled this way, its controller searches their library for a basic land card\. those players put those cards onto the battlefield tapped, then shuffle\.?$/i,
    );
    if (winds === null) return null;
    const clause = parseTargetClause((winds[1] as string).toLowerCase());
    if (clause === null) return null;
    return {
      targets: [
        {
          kind: clause.kind,
          ...(clause.filter !== undefined ? { filter: clause.filter } : {}),
          ...(clause.controller !== undefined ? { controller: clause.controller } : {}),
        },
      ],
      effects: [
        {
          op: 'removeTargetAndControllerMaySearchBasicLand',
          target: 0,
          action: 'exile',
          entersTapped: true,
        },
      ],
    };
  }
  const clause = parseTargetClause((m[2] as string).toLowerCase());
  if (clause === null) return null;
  return {
    targets: [
      {
        kind: clause.kind,
        ...(clause.filter !== undefined ? { filter: clause.filter } : {}),
        ...(clause.controller !== undefined ? { controller: clause.controller } : {}),
      },
    ],
    effects: [
      {
        op: 'removeTargetAndControllerMaySearchBasicLand',
        target: 0,
        action: (m[1] as string).toLowerCase() as 'destroy' | 'exile',
        entersTapped: m[3] !== undefined,
      },
    ],
  };
}
function parseCounterAndCreateTokenBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const norm = stripReminderText(text).trim();
  const m = norm.match(
    /^counter target (?:(.+?) )?spell\. its controller creates (a|an|one|two|three|four|five|\d+) (.+? tokens?(?: with .+)?)\.?$/i,
  );
  if (m === null) return null;

  const qualifier = (m[1] ?? '').toLowerCase();
  let target: TargetSpec;
  if (qualifier === '') {
    target = counterSpellTarget();
  } else if (qualifier === 'noncreature') {
    target = counterSpellTarget('noncreatureSpell');
  } else {
    const parts = qualifier.split(/,\s*(?:or\s+)?|\s+or\s+/).filter(Boolean);
    const known = new Set([
      'artifact',
      'creature',
      'enchantment',
      'instant',
      'sorcery',
      'planeswalker',
    ]);
    if (parts.length === 0 || parts.some((part) => !known.has(part))) return null;
    target = counterSpellTarget('spell', {
      filter: anyOf(...parts.map((part) => ofType(titleCase(part)))),
    });
  }
  const count = parseAmount((m[2] as string).toLowerCase());
  const tokenPhrase = (m[3] as string).replace(/\.$/, '').replace(/ tokens$/i, ' token');
  const parsedToken = parseCreateTokenSentence(('create a ' + tokenPhrase).toLowerCase(), card, {});
  const tokenEffect =
    parsedToken?.length === 1 && parsedToken[0]?.op === 'createToken' ? parsedToken[0] : null;
  if (count === null || tokenEffect === null) return null;
  const spec = tokenEffect.spec;
  return {
    targets: [target],
    effects: [
      { op: 'counterAndCreateTokenForController', target: 0, spec, count: constant(count) },
    ],
  };
}
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

/**
 * "Put target creature card from a graveyard onto the battlefield under your control. You lose
 * life equal to that card's mana value." (Reanimate) — one combined effect
 * (`reanimateAndLoseLife`), not a `graveyardToBattlefield` followed by a `loseLife` reading the
 * card's mana value: mana value can only be read from a card actually located somewhere (its
 * printed characteristics), and by the time the card is on the battlefield to compute anything
 * from, `graveyardToBattlefield`'s zone-change already gave it a new object identity. See the
 * `reanimateAndLoseLife` op's own comment in ability.ts for the fuller version of this.
 */
function parseReanimateBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const norm = stripReminderText(text).trim();
  const m = norm.match(
    /^put target (.+?) card from a graveyard onto the battlefield under your control\.\s*you lose life equal to (?:that card's|its) mana value\.?$/i,
  );
  if (m === null) return null;
  const filter = parseCardFilterPhrase(m[1] as string, card);
  if (filter === null) return null;
  return {
    targets: [{ kind: 'cardInGraveyard', filter, graveyardOwnerScope: 'any' }],
    effects: [{ op: 'reanimateAndLoseLife', target: 0 }],
  };
}

/**
 * "Destroy target creature or enchantment an opponent controls. You lose life equal to that
 * permanent's mana value." (Feed the Swarm) â€” the life-loss effect has to come FIRST in the
 * emitted effects array, even though it's the second sentence: `manaValueOfTarget` reads the
 * battlefield, and `destroy` has already removed the target from it by the time a plain
 * sentence-by-sentence reading would get there (the same reordering Hoard Smelter Dragon's
 * hand-authored pump-then-destroy already does for the identical reason).
 */
function parseDestroyThenLoseLifeEqualToManaValueBlock(
  text: string,
  _card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const norm = stripReminderText(text).trim();
  const m = norm.match(
    /^destroy target (.+?)\.\s*you lose life equal to that (?:permanent|creature)'s mana value\.?$/i,
  );
  if (m === null) return null;
  const targetClause = parseTargetClause((m[1] as string).toLowerCase());
  if (targetClause === null) return null;
  return {
    targets: [
      {
        kind: targetClause.kind,
        ...(targetClause.filter !== undefined ? { filter: targetClause.filter } : {}),
        ...(targetClause.controller !== undefined ? { controller: targetClause.controller } : {}),
      },
    ],
    effects: [
      { op: 'loseLife', amount: { kind: 'manaValueOfTarget', target: 0 } },
      { op: 'destroy', target: 0 },
    ],
  };
}

/** One printed target occurrence; the second instruction refers to that same permanent. */
function parseTargetThenUntapBlock(
  text: string,
  card: OracleCard,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const match = text.trim().match(/^(.+?)(?:\.\s+| and |, then )untap it\.?$/i);
  if (match === null) return null;
  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
    targets.push(
      kind === 'cardInGraveyard'
        ? graveyardCardTarget(
            graveyardOwnerScope ?? 'controller',
            filter === undefined ? {} : { filter },
          )
        : {
            kind,
            ...(filter === undefined ? {} : { filter }),
            ...(controller === undefined ? {} : { controller }),
          },
    );
    return targets.length - 1;
  };
  const effects = parseEffectSentence(match[1]!, alloc, card);
  if (
    effects === null ||
    targets.length !== 1 ||
    ![
      'creature',
      'artifact',
      'enchantment',
      'land',
      'planeswalker',
      'permanent',
      'nonlandPermanent',
      'artifactOrEnchantment',
      'artifactEnchantmentOrPlaneswalker',
    ].includes(targets[0]!.kind)
  )
    return null;
  return { targets, effects: [...effects, { op: 'untapTarget', target: 0 }] };
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

/**
 * "Double the power of each other creature you control until end of turn. Those creatures gain
 * vigilance until end of turn." (God-Eternal Rhonas) — matched whole, because "those creatures"
 * is the set the first sentence doubled; nothing between the two changes which creatures match.
 */
function parseDoublePowerThoseGainBlock(body: string): Effect[] | null {
  const m = body
    .trim()
    .replace(/\.$/, '')
    .match(
      /^double the power of each (other )?creature you control until end of turn\. those creatures gain ([a-z]+) until end of turn$/,
    );
  if (m === null) return null;
  const parsed = parseKeywordLine(m[2] as string);
  const keyword = parsed?.keywords[0];
  if (parsed === null || parsed.keywords.length !== 1 || keyword === undefined) return null;
  if (parsed.ward !== undefined || parsed.protectionFrom !== undefined) return null;
  const selector = allOf(...(m[1] !== undefined ? [OTHER] : []), ofType('Creature'), YOURS);
  return [
    { op: 'doublePower', selector },
    { op: 'grantKeywordEachUntilEot', selector, keyword },
  ];
}

/**
 * "Exile another target permanent. Return that card to the battlefield under its owner's control
 * at the beginning of the next end step." (Flickerwisp) / "Exile target permanent you own. Return
 * it to the battlefield under your control at the beginning of the next end step." (Venser, the
 * Sojourner) — matched whole, because the return is a delayed trigger bound to the exiled card.
 */
function parseExileReturnAtNextEndStepBlock(body: string, alloc: SlotAllocator): Effect[] | null {
  const m = body
    .trim()
    .replace(/\.$/, '')
    .match(
      /^exile (another )?target (permanent|creature|nonland permanent)( you own| you control)?\. return (?:that card|it) to the battlefield under (its owner's|your) control at the beginning of the next end step$/,
    );
  if (m === null) return null;
  const parts: Selector[] = [];
  if (m[1] !== undefined) parts.push(OTHER);
  if (m[3] === ' you own') parts.push({ kind: 'owner', who: 'you' });
  const filter = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : allOf(...parts);
  const kind: TargetKind =
    m[2] === 'creature'
      ? 'creature'
      : m[2] === 'nonland permanent'
        ? 'nonlandPermanent'
        : 'permanent';
  const target = alloc(kind, filter, m[3] === ' you control' ? 'you' : undefined);
  return [
    {
      op: 'exileTargetReturnAtNextEndStep',
      target,
      returnUnder: m[4] === 'your' ? 'sourceController' : 'owner',
    },
  ];
}

/**
 * "Put target creature card from an opponent's graveyard onto the battlefield under your control.
 * It gains haste. At the beginning of your next end step, exile it." (Puppeteer Clique) — matched
 * whole: "it" in the last two sentences is the permanent the first one put onto the battlefield.
 */
function parseReanimateHasteExileAtEndStepBlock(
  body: string,
  alloc: SlotAllocator,
): Effect[] | null {
  const norm = body.trim().replace(/\.$/, '');
  if (
    norm !==
    "put target creature card from an opponent's graveyard onto the battlefield under your control. it gains haste. at the beginning of your next end step, exile it"
  )
    return null;
  const target = alloc('cardInGraveyard', ofType('Creature'), undefined, 'opponent');
  return [{ op: 'reanimateTargetHasteExileAtYourNextEndStep', target }];
}

/**
 * "Choose another target artifact creature you control. When that creature dies this turn,
 * return it to the battlefield tapped under your control." (Cryptek) — a delayed trigger that
 * remembers the chosen permanent itself (CR 400.7) and expires at cleanup; "it" is the card that
 * permanent became in the graveyard (CR 400.7e).
 */
function parseDiesThisTurnReturnTappedBlock(body: string, alloc: SlotAllocator): Effect[] | null {
  const m = body
    .trim()
    .replace(/\.$/, '')
    .match(
      /^choose (another )?target (artifact )?creature you control\. when that creature dies this turn, return it to the battlefield tapped under your control$/,
    );
  if (m === null) return null;
  const parts: Selector[] = [];
  if (m[1] !== undefined) parts.push(OTHER);
  if (m[2] !== undefined) parts.push(ofType('Artifact'));
  const filter = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : allOf(...parts);
  const target = alloc('creature', filter, 'you');
  return [
    {
      op: 'registerDelayedTrigger',
      when: 'dies',
      target,
      sameObject: true,
      expiry: 'cleanup',
      ability: {
        kind: 'triggered',
        targets: [],
        effects: [{ op: 'returnDiedTriggerObjectTapped' }],
        description: 'Return that creature to the battlefield tapped under your control',
      },
    },
  ];
}

const ORDINALS_FROM_TOP: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5 };

/**
 * "Put it into its owner's library third from the top" (God-Eternal Rhonas), on a trigger for the
 * source itself dying or being exiled: "it" is the card the source became (CR 400.7e).
 */
function parseDepartedSourceToLibraryBlock(
  body: string,
  heads: readonly TriggerHead[],
): Effect[] | null {
  const m = body
    .trim()
    .replace(/\.$/, '')
    .match(/^put (?:it|~) into its owner's library (second|third|fourth|fifth) from the top$/);
  if (m === null) return null;
  const sourceLeaves = heads.every(
    (head) =>
      (head.when === 'dies' || head.when === 'leavesBattlefield') &&
      'subject' in head &&
      head.subject.kind === 'self',
  );
  if (!sourceLeaves) return null;
  return [
    { op: 'putDepartedSourceIntoLibrary', fromTop: ORDINALS_FROM_TOP[m[1] as string] as number },
  ];
}

/**
 * "Exile target card from a graveyard. If it was a creature card, put a +1/+1 counter on this
 * creature and you gain 1 life." (Scavenging Ooze) — matched whole, because the second sentence
 * asks about the card the first one exiled (its characteristics in the graveyard). The exile is a
 * real zone change, so leave-graveyard abilities see it.
 */
function parseGraveyardExileCreatureRider(text: string, alloc: SlotAllocator): Effect[] | null {
  const body = text.toLowerCase().trim().replace(/\.$/, '');
  if (
    body !==
      'exile target card from a graveyard. if it was a creature card, put a +1/+1 counter on ~ and you gain 1 life' &&
    body !==
      'exile target card from a graveyard. if it was a creature card, put a +1/+1 counter on this creature and you gain 1 life'
  )
    return null;
  const targetSlot = alloc('cardInGraveyard', undefined, undefined, 'any');
  return [{ op: 'exileTargetGraveyardAndBuffIfCreature', targetSlot }];
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
    parts.push(
      manaValueClause[3]?.toLowerCase() === 'less' ? manaValueAtMost(n) : manaValueAtLeast(n),
    );
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

  // "destroy all nontoken creatures" (Hour of Reckoning): tokens are spared.
  const nontoken = noun.match(/^nontoken (.+)$/i);
  if (nontoken !== null) {
    parts.push(not(IS_TOKEN));
    noun = nontoken[1] as string;
  }

  // "artifacts and enchantments" is one mass-removal subject, not two independent effects.
  // Keep the alternation inside the selector so modal bullets such as Cleansing Nova remain
  // single modes and the conservative sentence splitter never sees this conjunction.
  const typeAlternation = noun.split(' and ');
  const typeNames: Record<string, string> = {
    creatures: 'Creature',
    artifacts: 'Artifact',
    enchantments: 'Enchantment',
    lands: 'Land',
    planeswalkers: 'Planeswalker',
  };
  let compoundTypeSelected = false;
  if (
    typeAlternation.length > 1 &&
    typeAlternation.every((type) => typeNames[type] !== undefined)
  ) {
    parts.push(anyOf(...typeAlternation.map((type) => ofType(typeNames[type] as string))));
    compoundTypeSelected = true;
    noun = 'permanents';
  }

  const subject = parseSubject(noun, card) ?? parseTriggerSubject(noun, card);
  if (subject === null && !compoundTypeSelected) return null;
  if (subject !== null) parts.push(subject);
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
  const top = s.match(
    /^search your library for (.+?), (?:reveal .+?, )?then shuffle and put (?:that card|the card|it) on top(?: of your library)?$/,
  );
  if (top !== null) {
    const filter = parseSearchFilter(top[1] as string, card);
    if (filter === null) return null;
    // Shuffle BEFORE the placement, which is the printed order ("...then shuffle and put the
    // card on top") and the one that matters: shuffling afterwards would bury the card the
    // whole spell exists to set up. Which card is chosen cannot depend on the shuffle, so
    // asking first and shuffling first are the same decision.
    return [{ op: 'shuffle' }, searchLibraryCards(filter, [{ zone: 'libraryTop' }])];
  }

  const m = s.match(
    /^search your library for (.+?), (reveal (?:it|them|that card|those cards), )?(put .+?), then shuffle$/,
  );
  if (m === null) return null;
  // "…, reveal it, …" (CR 701.16a): the found card is public even when it goes to the hand.
  const reveal = m[2] !== undefined;

  const differentNames = (m[1] as string).endsWith(' with different names');
  const filterText = differentNames
    ? (m[1] as string).slice(0, -' with different names'.length)
    : (m[1] as string);
  const filter = parseSearchFilter(filterText, card);
  if (filter === null) return null;
  const destinations = parseSearchDestinations(m[3] as string);
  if (destinations === null) return null;
  const countMatch = (m[1] as string).match(/^up to (\w+) /);
  const count = countMatch === null ? null : parseAmount(countMatch[1] as string);
  if (countMatch !== null && count === null) return null;
  return [
    searchLibraryCards(filter, destinations, {
      ...(count === null ? {} : { count }),
      ...(differentNames ? { differentNames: true } : {}),
      ...(reveal ? { reveal: true } : {}),
    }),
    { op: 'shuffle' },
  ];
}

/** "a Plains, Island, Swamp, or Mountain card" / "up to two basic land cards" â†’ a `Selector`. */
function parseSearchFilter(phrase: string, card: OracleCard): Selector | null {
  // "a creature card OF THE CHOSEN TYPE" (Herald's Horn) - stripped first, because it trails
  // the noun everything below reads. The chosen type is per-permanent state recorded as the
  // source entered (`entersChoosingOption`), so it is a selector, not a literal subtype.
  const chosen = phrase.match(/^(.+) of the chosen type$/);
  if (chosen !== null) {
    const rest = parseSearchFilter(chosen[1] as string, card);
    return rest === null ? null : allOf(rest, CHOSEN_SUBTYPE);
  }

  const noun = phrase.replace(/^(?:up to \w+|a|an) /, '').replace(/ cards?$/, '');

  // "basic land cards and/or Gate cards" is one search filter accepting either branch.
  if (noun.includes(' and/or ')) {
    const alternatives: Selector[] = [];
    for (const part of noun.split(' and/or ')) {
      const parsed = parseSearchFilter(part, card);
      if (parsed === null) return null;
      alternatives.push(parsed);
    }
    return anyOf(...alternatives);
  }
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

  // "a creature spell OF THE CHOSEN TYPE" (Cavern of Souls) / "a creature card of the chosen
  // type" (Herald's Horn) - the type named as the source entered. Stripped first, because it
  // trails the noun the rest of this function reads.
  const chosen = phrase.match(/^(.+) of the chosen type$/);
  if (chosen !== null) {
    const rest = parseCardFilterPhrase(chosen[1] as string, card);
    return rest === null ? null : allOf(rest, CHOSEN_SUBTYPE);
  }

  const noun = phrase.replace(/ (?:cards?|spells?)$/, '').replace(/^(?:an?) /, '');
  // "noncreature, nonland cards" (Flame On!) means the intersection of both negative
  // characteristics, not either one. Keep this in the card-zone filter grammar: the same
  // spelling on a battlefield subject is handled by `parseSubject` instead.
  const negativeTypeNames = noun.split(/,\s*/).map((part) => {
    const type = part.match(/^non(.+)$/)?.[1];
    if (type === undefined) return undefined;
    return (
      CARD_TYPE_PLURALS[`${type}s`] ??
      ({ instant: 'Instant', sorcery: 'Sorcery' } as Record<string, string>)[type]
    );
  });
  if (
    negativeTypeNames.length > 0 &&
    negativeTypeNames.every((type): type is string => type !== undefined)
  ) {
    return allOf(...negativeTypeNames.map((type) => not(ofType(type))));
  }
  // "legendary creature card" combines a supertype with the ordinary card filter. Keep this
  // here rather than teaching trigger subjects about card-zone-only wording.
  if (noun === 'legendary') return ofSupertype('Legendary');
  const legendary = noun.match(/^legendary (.+)$/);
  if (legendary !== null) {
    const rest = parseCardFilterPhrase(legendary[1] as string, card);
    return rest === null ? null : allOf(ofSupertype('Legendary'), rest);
  }
  // "non-Rogue creature card" (Body Launderer): a hyphenated negated subtype before the noun.
  const nonSubtype = noun.match(/^non-([a-z]+) (.+)$/);
  if (nonSubtype !== null) {
    const subtype = resolveSubtype(nonSubtype[1] as string, card);
    const rest = parseCardFilterPhrase(nonSubtype[2] as string, card);
    return subtype === null || rest === null ? null : allOf(not(ofSubtype(subtype)), rest);
  }
  const anyPermanentType = (): Selector => anyOf(...PERMANENT_CARD_TYPES.map((t) => ofType(t)));
  if (noun === 'permanent' || noun === 'card' || noun === 'cards') return anyPermanentType();
  const cardType =
    CARD_TYPE_PLURALS[noun] ??
    ((PERMANENT_CARD_TYPES as readonly string[]).includes(titleCase(noun))
      ? titleCase(noun)
      : undefined);
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
      /^(?:put )?(?:it|that card|them|those cards|one|the other) (onto the battlefield( tapped)?|into your hand|into your graveyard|on top of your library)$/,
    );
    if (m === null) return null;
    const where = m[1] as string;
    if (where.startsWith('onto the battlefield')) {
      out.push(
        m[2] === undefined ? { zone: 'battlefield' } : { zone: 'battlefield', tapped: true },
      );
    } else if (where === 'into your hand') {
      out.push({ zone: 'hand' });
    } else if (where === 'on top of your library') {
      out.push({ zone: 'libraryTop' });
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
  /^when(?:ever)? (.+?) (enters from (?:a|your) graveyard|enters or leaves the battlefield|enters(?: the battlefield)?(?: or attacks| or transforms into ~)?|transforms into ~|leaves the battlefield|is put into a graveyard from the battlefield or is put into exile from the battlefield|dies or is put into exile from the battlefield|dies|attacks|becomes tapped|becomes crewed|deals combat damage to a player), (.*)$/;
const STEP_TRIGGER_HEAD_RE =
  /^at the beginning of (your|each(?: player's)?) (upkeep|end step|combat|first main phase|precombat main phase), (.*)$/;
/**
 * "Whenever **one or more** Dragons you control attack" â€” the aggregate form (CR 603.2c). The
 * plural subject is stripped back to its singular here so `parseTriggerSubject` sees the same
 * phrase it would in the ordinary form; the aggregation is a flag on the head, not a different
 * selector.
 */
const AGGREGATE_TRIGGER_HEAD_RE =
  /^whenever (?:(~) and\/or )?one or more (.+?) (attack|enter|deal combat damage to a player), (.*)$/;
/**
 * "Whenever you cast a Dragon spell" (CR 603.2) / "Whenever you cast OR COPY an instant or
 * sorcery spell" (Archmage Emeritus, Storm-Kiln Artist) â€” the "or copy" half is read onto the
 * same `castsSpell` trigger head rather than added as a real copy-event (the engine has none),
 * an intentionally under-permissive reading (ADR 0010): the ability fires correctly whenever the
 * spell is actually CAST, only silently missing the strictly rarer copy case, rather than being
 * left unmodeled over one clause it cannot fully honor.
 */
const TOKEN_CREATED_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) create(?:s)? ((?:one or more |a )?(?:creature )?tokens?), (.*)$/;
// English verb agreement makes the second person a separate surface form: cards print
// "Whenever YOU DRAW YOUR second card" but "Whenever an opponent DRAWS THEIR second card".
// `draws?` plus an either-possessive keeps one regex over both rather than two that drift.
const DRAW_COUNT_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) draws? (?:their|your) (second|third|fourth|fifth|sixth) card each turn, (.*)$/;
/** "Whenever you foretell a card" (Dream Devourer): the foretell special action (CR 702.143c). */
const FORETELL_TRIGGER_HEAD_RE = /^whenever you foretell a card, (.*)$/;
const DRAW_TRIGGER_HEAD_RE = /^whenever (you|a player|an opponent) draws? (?:a|one) card, (.*)$/;
const DRAW_EXCEPT_FIRST_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) draws? a card except the first one they draw in each of their draw steps, (.*)$/;
const SACRIFICE_TRIGGER_HEAD_RE = /^whenever (you|a player|an opponent) sacrifices? (.+?), (.*)$/;
const TOKEN_OR_SACRIFICE_TRIGGER_HEAD_RE =
  /^whenever (you|a player|an opponent) create(?:s)? or sacrifice(?:s)? (?:a )?tokens?, (.*)$/;
const GRAVEYARD_CROSSING_TRIGGER_HEAD_RE =
  /^whenever another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard, (.*)$/;
const ORDINAL_CAST_TRIGGER_HEAD_RE =
  /^whenever (you|an opponent) casts? (?:your|their) (first|second|third|fourth|fifth|sixth) (.+?) each turn, (.*)$/;
const CAST_TRIGGER_HEAD_RE =
  /^whenever (you|an opponent|a player) casts?(?: or copy)? (.+?), (.*)$/;
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
  instant: 'Instant',
  sorcery: 'Sorcery',
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

  // "a creature you control with a +1/+1 counter on it" (The Ooze): the named counter kind, read
  // off the subject as the event saw it — a leaving creature's last-known counters (CR 603.10a).
  const counterMatch = noun.match(/^(.+) with an? ([+-]\d+\/[+-]\d+) counter on it$/);
  if (counterMatch !== null) {
    parts.push(hasCounter(counterMatch[2] as string));
    noun = counterMatch[1] as string;
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

  const tokenType = noun.match(/^(creature|artifact|enchantment|land|planeswalker)? ?tokens?$/);
  if (tokenType !== null) {
    parts.push(IS_TOKEN);
    if (tokenType[1] !== undefined)
      parts.push(ofType(CARD_TYPE_SINGULARS[tokenType[1] as string] as string));
  } else {
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
  food: FOOD,
  mutagen: MUTAGEN,
};

/** "1/1 black and green Pest creature token" â†’ a `TokenSpec`, or null if any part is unread. */
function parseTokenFace(phrase: string, card: OracleCard): TokenSpec | null {
  const predefined = PREDEFINED_TOKENS[phrase.replace(/ tokens?$/, '').trim()];
  if (predefined !== undefined) return predefined;

  const m = phrase.match(
    /^(legendary\s+)?(\d+|x|\*)\/(\d+|x|\*) (.+?)(?: (artifact creature|creature|artifact))? tokens?$/i,
  );
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
  const typeLine = `Token ${types.join(' ')} — ${subtypes.join(' ')}`;

  // The one legitimate raw TokenSpec literal in this file: this function IS the constructor for a
  // token read off a card's own printed phrase, so there is no named export to reference instead —
  // `creatureToken`/`artifactToken` also don't fit, since power/toughness here can be an X value or
  // unknown (`*`), which those builders don't accept. `canonicalizeToken` immediately below folds
  // this back onto the shared catalog whenever the parsed shape happens to match one exactly.
  // eslint-disable-next-line no-restricted-syntax
  return canonicalizeToken({
    name,
    typeLine,
    types,
    subtypes,
    colors,
    power,
    toughness,
    ...(legendary ? { legendary: true } : {}),
  });
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
  // Per-opponent attacking tokens (Adeline, Ainok Strike Leader, Endless Foot Assault).
  {
    const attacking = s.match(
      /^create (?:a|an) (.+?) token that(?:'s| is) tapped and attacking that player(?: or a planeswalker they control)?$/,
    );
    if (attacking !== null) {
      const spec = parseTokenFace((attacking[1] as string) + ' token', card);
      if (spec !== null) return [{ op: 'createTokenForEachOpponent', spec, attacking: true }];
    }
  }
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

  // "Create a Food token or a Treasure token" (Tireless Provisioner) — a resolution-time choice
  // between two whole token creations, which is exactly `chooseOne`. Matched before the general
  // form below, whose trailing group would otherwise read "food token or a treasure" as one
  // token face.
  {
    const either = s.match(/^create (?:a|an) (.+?) token or (?:a|an) (.+?) token$/);
    if (either !== null) {
      const first = parseTokenFace((either[1] as string) + ' token', card);
      const second = parseTokenFace((either[2] as string) + ' token', card);
      if (first !== null && second !== null) {
        return [
          {
            op: 'chooseOne',
            options: [
              {
                effects: [{ op: 'createToken', spec: first, count: constant(1) }],
                description: `Create a ${first.name} token`,
              },
              {
                effects: [{ op: 'createToken', spec: second, count: constant(1) }],
                description: `Create a ${second.name} token`,
              },
            ],
          },
        ];
      }
    }
  }

  {
    const byValue = s.match(/^create a number of (.+) tokens equal to (.+)$/);
    if (byValue !== null) {
      const count = parseDynamicCountValue(byValue[2] as string, card, opts);
      const spec = parseTokenFace((byValue[1] as string) + ' token', card);
      if (count !== null && spec !== null) return [{ op: 'createToken', spec, count }];
    }
    const forEach = s.match(/^create (?:a|an) (.+?) token for each (.+)$/);
    if (forEach !== null) {
      const count = parseDynamicCountValue('the number of ' + (forEach[2] as string), card, opts);
      const spec = parseTokenFace((forEach[1] as string) + ' token', card);
      if (count !== null && spec !== null) return [{ op: 'createToken', spec, count }];
    }
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
    count =
      parseCountPhrase(countStr, opts?.thatMany) ??
      (countStr.toLowerCase() === 'x' ? { kind: 'xValue' } : null);
  }
  if (count === null) return null;

  const tapped = m[2] !== undefined;
  const customName = m[3];
  const faceStr = m[4] as string;

  const parsedSpec = parseTokenFace(faceStr, card);
  if (parsedSpec === null) return null;

  // `parsedSpec` may be a reference to a shared catalog object (`canonicalizeToken`/
  // `PREDEFINED_TOKENS` can both return one by identity, not a copy — see their docstrings).
  // Naming the token overrides its identity for THIS card only, so it must produce a new object
  // rather than mutate `parsedSpec` in place; mutating it would corrupt the shared catalog const
  // for every other card that references the same token afterward in this process.
  const spec = customName
    ? { ...parsedSpec, name: customName.trim(), legendary: true }
    : parsedSpec;

  const bareKeywords = m[6];
  if (bareKeywords !== undefined) {
    const parsed = parseKeywordLine(bareKeywords);
    if (parsed === null || parsed.ward !== undefined || parsed.protectionFrom !== undefined) {
      return null;
    }
    return [
      {
        op: 'createToken',
        spec: canonicalizeToken({ ...spec, keywords: parsed.keywords }),
        count,
        ...(tapped ? { tapped: true } : {}),
      },
    ];
  }

  const granted = m[5];
  if (granted !== undefined) {
    const triggers = parseTriggerLine(granted.replace(/^this token /i, 'this creature '), card);
    if (triggers === null) return null;
    // A token with a granted trigger never matches the catalog (no cataloged token carries one),
    // so this is not canonicalized — spelled out for symmetry with the two branches above.
    return [
      {
        op: 'createToken',
        spec: { ...spec, triggers },
        count,
        ...(tapped ? { tapped: true } : {}),
      },
    ];
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
  // "Spells OF THE CHOSEN TYPE you cast..." (Morophon) - the qualifier sits on the subject here,
  // where Herald's Horn prints it after "you cast". Same selector either way.
  const chosen = phrase.match(/^(.+) of the chosen type$/);
  if (chosen !== null) {
    const rest = parseSpellFilter(chosen[1] as string, card);
    return rest === null ? null : rest === ANY_SPELL ? CHOSEN_SUBTYPE : allOf(rest, CHOSEN_SUBTYPE);
  }

  const noun = phrase.replace(/ spells?$/, '').replace(/^an? /, '');
  // "spells" reaches here bare when a qualifier was stripped off the front of it ("spells of the
  // chosen type" -> "spells"); the ` spells?$` strip above needs a leading space and leaves it.
  if (noun === '' || noun === 'a' || noun === 'an' || noun === 'spell' || noun === 'spells') {
    return ANY_SPELL;
  }
  const manaValue = noun.match(/^(?:(.+?) )?spell with mana value (\d+) or (less|greater)$/);
  if (manaValue !== null) {
    const bound =
      manaValue[3] === 'less'
        ? manaValueAtMost(Number(manaValue[2]))
        : manaValueAtLeast(Number(manaValue[2]));
    if (manaValue[1] === undefined) return bound;
    const base = parseTriggerSubject(manaValue[1] as string, card);
    return base === null ? null : allOf(base, bound);
  }
  if (noun === 'noncreature') return not(ofType('Creature'));
  // "an instant or sorcery spell" (Archmage Emeritus) / "Instant and sorcery spells" (Goblin
  // Electromancer) â€” each side is its own card type, not a tribe the way `parseTriggerSubject`'s
  // "or" handling elsewhere reads alternatives. "And" reads the same as "or" here: the predicate
  // is "matches either type", not an intersection no single spell could ever satisfy.
  const orTypes = noun.match(
    /^(instant|sorcery|artifact|creature|enchantment|planeswalker|land) (?:and|or) (?:an? )?(instant|sorcery|artifact|creature|enchantment|planeswalker|land)$/,
  );
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
  // "When this creature enters, if you cast it, …" (Shard of the Nightbringer): read from the
  // permanent's cast record, so reanimating or flickering it does not count.
  if (clause === 'you cast it') return { kind: 'sourceWasCast' };
  if (clause === 'it escaped' || clause === '~ escaped') {
    return { kind: 'escaped' };
  }
  if (
    clause === 'a creature or planeswalker an opponent controlled was dealt excess damage this turn'
  ) {
    return { kind: 'excessDamageDealtTo', scope: 'opponents' };
  }
  // "if you've cast a noncreature spell this turn" — the shared intervening-if of the Fantastic
  // Four cycle. A tally kept at cast time, not a board read, so it survives the spell resolving.
  {
    const cast = clause.match(/^you've cast (?:a|an) (noncreature )?spell this turn$/);
    if (cast !== null) {
      return {
        kind: 'castSpellThisTurn',
        category: cast[1] === undefined ? 'any' : 'noncreature',
        cmp: '>=',
        n: 1,
      };
    }
  }
  // "if there are thirteen or more creatures on the battlefield" (Blasphemous Edict) — every
  // player's permanents count.
  {
    const total = clause.match(/^there are (\w+) or more (.+) on the battlefield$/);
    if (total !== null) {
      const n = parseAmount(total[1] as string);
      const selector = parseSubject(total[2] as string, card);
      if (n === null || selector === null) return null;
      return countPermanents(selector, 'all', '>=', n);
    }
  }
  // "if you control four or more creatures" — a threshold rather than the bare "you control a
  // creature" below, which is the same condition with an implied n of 1. The subject is stripped
  // of its count before `parseTriggerSubject` sees it, so it reads the same singular grammar.
  {
    const counted = clause.match(/^you control (\w+) or more (.+)$/);
    if (counted !== null) {
      const n = parseAmount(counted[1] as string);
      const selector = parseSubject(counted[2] as string, card);
      if (n === null || selector === null) return null;
      return countPermanents(selector, 'you', '>=', n);
    }
  }
  // "if it has no ice counters on it" / "if ~ has three or more charge counters on it" — the
  // ability's own source, not a selector match.
  {
    const counters = clause.match(
      /^(?:it|~|this (?:artifact|creature|enchantment|land|permanent)) has (no|\w+ or more|\w+ or fewer) ([a-z]+) counters? on it$/,
    );
    if (counters !== null) {
      const quantifier = counters[1] as string;
      const counter = counters[2] as string;
      if (quantifier === 'no') return { kind: 'sourceHasCounters', counter, cmp: '<=', n: 0 };
      const [word, , direction] = quantifier.split(' ');
      const n = parseAmount(word as string);
      if (n === null) return null;
      return { kind: 'sourceHasCounters', counter, cmp: direction === 'more' ? '>=' : '<=', n };
    }
  }
  // "if you have seven or more cards in your graveyard" (Search for Azcanta).
  {
    const graveyard = clause.match(/^you have (\w+) or more cards in your graveyard$/);
    if (graveyard !== null) {
      const n = parseAmount(graveyard[1] as string);
      if (n === null) return null;
      return { kind: 'cardsInYourGraveyard', cmp: '>=', n };
    }
  }
  const m = clause.match(/^you control (.+)$/);
  if (m === null) return null;
  const selector = parseTriggerSubject(m[1] as string, card);
  if (selector === null) return null;
  return countPermanents(selector, 'you', '>=', 1);
}

/**
 * "Each player exiles all creature cards from their graveyard, then sacrifices all creatures they
 * control, then puts all cards they exiled this way onto the battlefield." (Living Death) — three
 * simultaneous events in order: one exile, one sacrifice, one return.
 */
function parseLivingDeathBlock(text: string): { targets: TargetSpec[]; effects: Effect[] } | null {
  const normalized = text.trim().toLowerCase().replace(/\.$/, '');
  if (
    normalized !==
    'each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield'
  )
    return null;
  return { targets: [], effects: [{ op: 'livingDeath' }] };
}

/**
 * "Choose two target creature cards in your graveyard. Sacrifice a creature. If you do, return
 * the chosen cards to the battlefield tapped." (Victimize): the targets are chosen on cast, the
 * sacrifice is mandatory when possible, and only a completed sacrifice returns the cards.
 */
function parseVictimizeBlock(text: string): { targets: TargetSpec[]; effects: Effect[] } | null {
  const match = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .match(
      /^choose (\w+) target creature cards in your graveyard\. sacrifice a creature\. if you do, return the chosen cards to the battlefield tapped$/,
    );
  if (match === null) return null;
  const count = parseAmount(match[1] as string);
  if (count === null || count < 2) return null;
  return {
    targets: [
      {
        kind: 'cardInGraveyard',
        filter: ofType('Creature'),
        count: { min: count, max: count },
      },
    ],
    effects: [
      {
        op: 'sacrificeOneThen',
        selector: allOf(ofType('Creature'), YOURS),
        then: [{ op: 'reanimateEachChosenTapped', targetSlot: 0 }],
      },
    ],
  };
}

function parseBlinkSpellBlock(text: string): { targets: TargetSpec[]; effects: Effect[] } | null {
  const normalized = text.trim().toLowerCase().replace(/\.$/, '');
  if (
    normalized !==
    'exile two target artifacts, creatures, and/or lands you control, then return those cards to the battlefield under your control'
  ) {
    return null;
  }
  return {
    targets: [
      {
        kind: 'permanent',
        controller: 'you',
        filter: anyOf(ofType('Artifact'), ofType('Creature'), ofType('Land')),
        count: { min: 2, max: 2 },
      },
    ],
    effects: [{ op: 'blinkEachChosen', targetSlot: 0, returnUnder: 'sourceController' }],
  };
}

function parseKeywordCountSpellBlock(
  text: string,
): { targets: TargetSpec[]; effects: Effect[] } | null {
  const match = text
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .match(
      /^up to (\w+) target (permanents?|creatures?|artifacts?|lands?) you control gain ([a-z ,]+) until end of turn$/,
    );
  if (match === null) return null;
  const max = parseAmount(match[1] as string);
  const singular = (match[2] as string).replace(/s$/, '');
  const clause = parseTargetClause(`${singular} you control`);
  const keywords = parseKeywordLine(match[3] as string);
  if (
    max === null ||
    clause === null ||
    keywords === null ||
    keywords.ward !== undefined ||
    keywords.protectionFrom !== undefined
  ) {
    return null;
  }
  return {
    targets: [
      {
        kind: clause.kind,
        ...(clause.controller !== undefined ? { controller: clause.controller } : {}),
        ...(clause.filter !== undefined ? { filter: clause.filter } : {}),
        count: { min: 0, max },
      },
    ],
    effects: keywords.keywords.map((keyword) => ({
      op: 'grantKeywordEachChosenUntilEot',
      targetSlot: 0,
      keyword,
    })),
  };
}

function parseBlinkChosenBlock(body: string, allocCount: CountSlotAllocator): Effect[] | null {
  const match = body.match(
    /^exile up to one target (.+?) you control, then return (?:it|that card) to the battlefield under its owner's control\.?$/,
  );
  if (match === null) return null;
  const clause = parseTargetClause(`${match[1] as string} you control`);
  if (clause === null) return null;
  const targetSlot = allocCount(clause.kind, { min: 0, max: 1 }, clause.controller, clause.filter);
  return [{ op: 'blinkEachChosen', targetSlot, returnUnder: 'owner' }];
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
  const firstLine = lower.split('\n')[0] as string;
  const continuation = lower.split('\n').slice(1).join('\n');

  // The head decides the event; the rest of the line is the effect (after an optional
  // intervening-if and an optional "you may").
  let heads: TriggerHead[];
  let body: string;
  let implicitCondition: Condition | undefined;
  const enterAndCast = firstLine.match(
    /^when (.+?) enters and whenever (you|an opponent|a player) casts? (.+?), (.*)$/,
  );
  const becomesTargeted = firstLine.match(
    /^whenever (.+?) becomes the target of a spell or ability an opponent controls, (.*)$/,
  );
  const attacksWhile = firstLine.match(/^whenever (.+?) attacks while (.+?), (.*)$/);
  const attacksPlayerWithMoreLife = firstLine.match(
    /^whenever (.+?) attacks a player who has more life than you, (.*)$/,
  );
  const step = firstLine.match(STEP_TRIGGER_HEAD_RE);
  const combatOnTurn = firstLine.match(
    /^at the beginning of combat on (your|each(?: player's)?) turn, (.*)$/,
  );
  const attackEachOpponent = firstLine.match(
    /^whenever you attack( with (?:this creature|~) and\/or your commander)?, for each opponent, (.*)$/,
  );
  const aggregate = firstLine.match(AGGREGATE_TRIGGER_HEAD_RE);
  const ordinalCast = firstLine.match(ORDINAL_CAST_TRIGGER_HEAD_RE);
  const cast = firstLine.match(CAST_TRIGGER_HEAD_RE);
  const tokenCreated = firstLine.match(TOKEN_CREATED_TRIGGER_HEAD_RE);
  const tokenOrSacrifice = firstLine.match(TOKEN_OR_SACRIFICE_TRIGGER_HEAD_RE);
  const sacrifice = firstLine.match(SACRIFICE_TRIGGER_HEAD_RE);
  const drawCount = firstLine.match(DRAW_COUNT_TRIGGER_HEAD_RE);
  const drawExceptFirst = firstLine.match(DRAW_EXCEPT_FIRST_TRIGGER_HEAD_RE);
  const draw = firstLine.match(DRAW_TRIGGER_HEAD_RE);
  const foretell = firstLine.match(FORETELL_TRIGGER_HEAD_RE);
  const graveyardCrossing = firstLine.match(GRAVEYARD_CROSSING_TRIGGER_HEAD_RE);
  // "Whenever one or more artifact cards leave your graveyard" (Imotekh the Stormlord): one
  // aggregate event per batch of cards leaving (CR 603.2c); a card is in its owner's graveyard,
  // so "your" is the card's owner.
  const leaveGraveyard = firstLine.match(
    /^whenever (one or more|an?) (artifact|creature|land|enchantment) cards? leaves? your graveyard, (.*)$/,
  );
  if (enterAndCast !== null) {
    const subjectPhrase = enterAndCast[1] as string;
    let subject: TriggerSubject;
    if (SELF_TRIGGER_SUBJECT_RE.test(subjectPhrase)) {
      subject = SELF_SUBJECT;
    } else {
      const selector = parseTriggerSubject(subjectPhrase, card);
      if (selector === null) return null;
      subject = { kind: 'permanent', selector };
    }
    const filter = parseSpellFilter(enterAndCast[3] as string, card);
    if (filter === null) return null;
    heads = [
      { when: 'enters', subject },
      {
        when: 'castsSpell',
        caster:
          enterAndCast[2] === 'you'
            ? 'you'
            : enterAndCast[2] === 'an opponent'
              ? 'opponent'
              : 'each',
        ...(filter === ANY_SPELL ? {} : { filter }),
      },
    ];
    body = enterAndCast[4] as string;
  } else if (
    becomesTargeted !== null ||
    attacksWhile !== null ||
    attacksPlayerWithMoreLife !== null
  ) {
    const match = becomesTargeted ?? attacksWhile ?? attacksPlayerWithMoreLife;
    if (match === null) return null;
    const subjectPhrase = match[1] as string;
    let subject: TriggerSubject;
    if (SELF_TRIGGER_SUBJECT_RE.test(subjectPhrase)) {
      subject = SELF_SUBJECT;
    } else {
      const selector = parseTriggerSubject(subjectPhrase, card);
      if (selector === null) return null;
      subject = { kind: 'permanent', selector };
    }
    heads = [
      {
        when: becomesTargeted !== null ? 'becomesTargeted' : 'attacks',
        subject,
      },
    ];
    if (attacksWhile !== null) {
      const parsed = parseConditionClause(attacksWhile[2] as string, card);
      if (parsed === null) return null;
      implicitCondition = parsed;
      body = attacksWhile[3] as string;
    } else if (attacksPlayerWithMoreLife !== null) {
      implicitCondition = { kind: 'attackingPlayerHasMoreLifeThanYou' };
      body = attacksPlayerWithMoreLife[2] as string;
    } else {
      body = match[2] as string;
    }
  } else if (leaveGraveyard !== null) {
    const type = CARD_TYPE_SINGULARS[leaveGraveyard[2] as string] as string;
    heads = [
      {
        when: 'leavesGraveyard',
        subject: { kind: 'permanent', selector: allOf(ofType(type), YOURS) },
        ...(leaveGraveyard[1] === 'one or more' ? { aggregate: true } : {}),
      },
    ];
    body = leaveGraveyard[3] as string;
  } else if (graveyardCrossing !== null) {
    heads = [
      {
        when: 'dies',
        subject: { kind: 'permanent', selector: allOf(ofType('Creature'), OTHER) },
      },
      {
        when: 'putIntoGraveyardFromAnywhere',
        subject: { kind: 'permanent', selector: allOf(ofType('Creature'), not(IS_TOKEN)) },
      },
      {
        when: 'leavesGraveyard',
        subject: {
          kind: 'permanent',
          selector: allOf(ofType('Creature'), not(IS_TOKEN), YOURS),
        },
      },
    ];
    body = graveyardCrossing[1] as string;
  } else if (tokenOrSacrifice !== null) {
    const relation =
      tokenOrSacrifice[1] === 'you'
        ? YOURS
        : tokenOrSacrifice[1] === 'an opponent'
          ? OPPONENTS
          : undefined;
    const selector = relation === undefined ? IS_TOKEN : allOf(IS_TOKEN, relation);
    heads = [
      { when: 'tokenCreated', subject: { kind: 'permanent', selector } },
      { when: 'sacrificed', subject: { kind: 'permanent', selector } },
    ];
    body = tokenOrSacrifice[2] as string;
  } else if (sacrifice !== null) {
    const relation =
      sacrifice[1] === 'you' ? YOURS : sacrifice[1] === 'an opponent' ? OPPONENTS : undefined;
    const phrase = sacrifice[2] as string;
    let selector =
      phrase === 'a permanent' || phrase === 'permanent'
        ? allOf()
        : parseTriggerSubject(phrase, card);
    if (selector === null) return null;
    if (relation !== undefined) selector = allOf(selector, relation);
    heads = [{ when: 'sacrificed', subject: { kind: 'permanent', selector } }];
    body = sacrifice[3] as string;
  } else if (drawExceptFirst !== null) {
    const playerPhrase = drawExceptFirst[1] as string;
    heads = [
      {
        when: 'drawsCard',
        player:
          playerPhrase === 'you' ? 'you' : playerPhrase === 'an opponent' ? 'opponent' : 'each',
      },
    ];
    implicitCondition = { kind: 'notFirstDrawInOwnDrawStep' };
    body = drawExceptFirst[2] as string;
  } else if (step !== null) {
    heads = [
      {
        when:
          step[2] === 'upkeep'
            ? 'upkeep'
            : step[2] === 'end step'
              ? 'endStep'
              : step[2] === 'combat'
                ? 'beginningOfCombat'
                : 'precombatMain',
        player: step[1] === 'your' ? 'you' : 'each',
      },
    ];
    body = step[3] as string;
  } else if (combatOnTurn !== null) {
    heads = [{ when: 'beginningOfCombat', player: combatOnTurn[1] === 'your' ? 'you' : 'each' }];
    body = combatOnTurn[2] as string;
  } else if (attackEachOpponent !== null) {
    // "Whenever you attack" is the AGGREGATE attack trigger (CR 603.2c over the CR 508.1
    // declaration): it fires once when you declare one or more attackers, whether or not this
    // creature is among them. Reading it as `subject: self` silently narrows Adeline to
    // "whenever Adeline attacks" — she still triggers with a tapped-out Adeline at home.
    // The longer form names its own attackers instead: Ainok Strike Leader fires on this
    // creature AND/OR your commander, so either one attacking is enough.
    const selector =
      attackEachOpponent[1] === undefined
        ? allOf(ofType('Creature'), YOURS)
        : anyOf(SELF, allOf(IS_COMMANDER, YOURS));
    heads = [{ when: 'attacks', subject: { kind: 'permanent', selector }, aggregate: true }];
    body = attackEachOpponent[2] as string;
  } else if (tokenCreated !== null) {
    const relation =
      tokenCreated[1] === 'you' ? YOURS : tokenCreated[1] === 'an opponent' ? OPPONENTS : undefined;
    const tokenSelector =
      tokenCreated[2]?.includes('creature') === true
        ? allOf(IS_TOKEN, ofType('Creature'))
        : IS_TOKEN;
    const selector = relation === undefined ? tokenSelector : allOf(tokenSelector, relation);
    heads = [
      {
        when: 'tokenCreated',
        subject: { kind: 'permanent', selector },
        aggregate: tokenCreated[2]?.startsWith('one or more') === true,
      },
    ];
    body = tokenCreated[3] as string;
  } else if (foretell !== null) {
    heads = [{ when: 'foretells', player: 'you' }];
    body = foretell[1] as string;
  } else if (drawCount !== null || draw !== null) {
    const match = drawCount ?? draw;
    if (match === null) return null;
    const playerPhrase = match[1] as string;
    heads = [
      {
        when: 'drawsCard',
        player:
          playerPhrase === 'you' ? 'you' : playerPhrase === 'an opponent' ? 'opponent' : 'each',
      },
    ];
    if (drawCount !== null) {
      const ordinal = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }[match[2] as string];
      if (ordinal === undefined) return null;
      // "your SECOND card each turn" fires once, on that draw — not on every draw from the
      // second onward, which is what a '>=' here would mean.
      implicitCondition = { kind: 'eventPlayerDrawCount', cmp: '==', n: ordinal };
      body = match[3] as string;
    } else {
      body = match[2] as string;
    }
  } else if (aggregate !== null) {
    // The subject is plural here ("Dragons you control"), so it reads through `parseSubject`
    // rather than `parseTriggerSubject`.
    const plural = parseSubject(aggregate[2] as string, card);
    if (plural === null) return null;
    // "Whenever Satoru and/or one or more other nontoken creatures you control enter" — the
    // source itself joins the same aggregate event.
    const selector = aggregate[1] === undefined ? plural : anyOf(SELF, plural);
    heads = [
      {
        when:
          aggregate[3] === 'attack'
            ? 'attacks'
            : aggregate[3] === 'enter'
              ? 'enters'
              : 'dealsCombatDamageToPlayer',
        subject: { kind: 'permanent', selector },
        aggregate: true,
      },
    ];
    body = aggregate[4] as string;
  } else if (ordinalCast !== null) {
    const filter = parseSpellFilter(ordinalCast[3] as string, card);
    const ordinal = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
    }[ordinalCast[2] as string];
    if (filter === null || ordinal === undefined) return null;
    heads = [
      {
        when: 'castsSpell',
        caster: ordinalCast[1] === 'you' ? 'you' : 'opponent',
        ...(filter === ANY_SPELL ? {} : { filter }),
        ordinal,
      },
    ];
    body = ordinalCast[4] as string;
  } else if (cast !== null) {
    // "… casts a spell from a graveyard" / "from anywhere other than your hand": the origin is a
    // restriction on the cast event, not part of the spell's characteristics.
    const origin = (cast[2] as string).match(
      /^(.+?) from (a graveyard|anywhere other than your hand)$/,
    );
    const filter = parseSpellFilter(
      origin === null ? (cast[2] as string) : (origin[1] as string),
      card,
    );
    if (filter === null) return null;
    heads = [
      {
        when: 'castsSpell',
        caster: cast[1] === 'you' ? 'you' : cast[1] === 'an opponent' ? 'opponent' : 'each',
        ...(filter === ANY_SPELL ? {} : { filter }),
        ...(origin === null
          ? {}
          : {
              castFrom: origin[2] === 'a graveyard' ? ('graveyard' as const) : ('notHand' as const),
            }),
      },
    ];
    body = cast[3] as string;
  } else {
    const m = firstLine.match(OBJECT_TRIGGER_HEAD_RE);
    if (m === null) return null;
    const subjectPhrase = m[1] as string;
    const event = m[2] as string;
    const events: ObjectTriggerWhen[] = event.startsWith('enters')
      ? event === 'enters or leaves the battlefield'
        ? ['enters', 'leavesBattlefield']
        : event.endsWith('or attacks')
          ? ['enters', 'attacks']
          : event.includes('transforms into')
            ? ['enters', 'transformsInto']
            : ['enters']
      : // A BACK face prints the bare form ("When this creature transforms into Awoken Horror"):
        // it only ever exists after the flip, so unlike the front face's "enters or transforms
        // into ~" there is no entry event to pair it with.
        event === 'transforms into ~'
        ? ['transformsInto']
        : event === 'leaves the battlefield' || event.endsWith('into exile from the battlefield')
          ? ['leavesBattlefield']
          : event === 'dies'
            ? ['dies']
            : event === 'attacks'
              ? ['attacks']
              : event === 'becomes tapped'
                ? // City of Brass. `becomesTapped` is queued from every tap path already, including
                  // `payAbilityCosts(..., 'tapForMana')` - so tapping the land for mana fires it.
                  ['becomesTapped']
                : event === 'becomes crewed'
                  ? // Ghost Ark. Queued only when a crew ability resolves (CR 702.122e), never
                    // from another "becomes an artifact creature" effect.
                    ['becomesCrewed']
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
    // "enters from a graveyard" / "enters from your graveyard" (CR 603.6a): the origin zone is
    // part of the enters event, read off the permanent as it arrives.
    const origin = event.match(/^enters from (a|your) graveyard$/);
    // "is put into a graveyard … or … into exile from the battlefield" / "dies or is put into
    // exile from the battlefield": a leave event narrowed to those destinations.
    const leavesTo = event.endsWith('into exile from the battlefield')
      ? (['graveyard', 'exile'] as ('graveyard' | 'exile')[])
      : undefined;
    heads = events.map((when) =>
      leavesTo !== undefined
        ? { when, subject, leavesTo }
        : origin === null
          ? { when, subject }
          : {
              when,
              subject,
              entersFrom: {
                zone: 'graveyard' as const,
                ...(origin[1] === 'your' ? { graveyardOwner: 'you' as const } : {}),
              },
            },
    );
  }

  if (continuation.length > 0) body += '\n' + continuation;

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
  let condition: Condition | undefined = implicitCondition;
  const iff = body.match(INTERVENING_IF_RE);
  if (iff !== null && iff[1] === 'none of them were cast or no mana was spent to cast them') {
    // Satoru: a fact about each entering permanent's cast record, read by the enters dispatcher
    // over the whole firing rather than as a board condition.
    if (heads.some((head) => head.when !== 'enters')) return null;
    heads = heads.map((head) => ({ ...head, entersWithoutManaSpentToCast: true as const }));
    body = iff[2] as string;
  } else if (iff !== null) {
    const parsed = parseConditionClause(iff[1] as string, card);
    if (parsed === null) return null;
    condition = parsed;
    body = iff[2] as string;
  }
  let paidTransform: Effect[] | null = null;
  const paidTransformMatch = body.match(
    /^you may pay ((?:\{[^}]+\})+)\. if you do, transform ~\.?$/,
  );
  if (paidTransformMatch !== null) {
    const parsed = parseManaCost((paidTransformMatch[1] as string).toUpperCase() as never);
    if (parsed.cost === null || parsed.unsupportedSymbols.length > 0) return null;
    paidTransform = [
      {
        op: 'conditionalEffect',
        condition: { kind: 'mayPayMana', cost: parsed.cost },
        then: [{ op: 'transformSelf' }],
        else: [],
      },
    ];
  }
  let optional = paidTransform === null && body.startsWith('you may ');
  if (body.startsWith('you may have ')) {
    optional = true;
    body = body
      .slice('you may have '.length)
      .replace(/^this (creature|artifact|enchantment|land|permanent)\b/, '~')
      .replace(/^~ deal\b/, '~ deals');
  } else if (optional) {
    body = body.slice('you may '.length);
  }
  const modalBlock = parseModalSpellBlock(body, card);

  // A trigger may declare targets: its controller chooses them as the ability goes on the
  // stack (CR 603.3d), which `placePendingTriggers` surfaces as a decision.
  const targets: TargetSpec[] = [];
  if (modalBlock !== null) targets.push(...modalBlock.targets);
  const alloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
    targets.push(
      kind === 'cardInGraveyard'
        ? graveyardCardTarget(
            graveyardOwnerScope ?? 'controller',
            filter === undefined ? {} : { filter },
          )
        : {
            kind,
            ...(filter !== undefined ? { filter } : {}),
            ...(controller !== undefined ? { controller } : {}),
          },
    );
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
  let effects: Effect[] | null =
    paidTransform ??
    (modalBlock === null
      ? (parseBlinkChosenBlock(body, allocCount) ??
        parseLookAtTopBlock(body, card) ??
        parseExileTopPlayableBlock(body) ??
        parseAddManaTriggerBlock(body, card) ??
        parseHellkiteCourserBlock(body, alloc, card) ??
        parseDoublePowerThoseGainBlock(body) ??
        parseDepartedSourceToLibraryBlock(body, heads) ??
        parseExileReturnAtNextEndStepBlock(body, alloc) ??
        parseReanimateHasteExileAtEndStepBlock(body, alloc))
      : []);
  if (effects === null) {
    effects = [];
    for (const sentence of splitSentences(body)) {
      const parsed = parseEffectSentence(sentence, alloc, card, opts);
      if (parsed === null) return null;
      appendSentenceEffects(effects, sentence, parsed);
    }
  }
  if (effects.length === 0 && modalBlock === null) return null;

  return heads.map((head) => ({
    kind: 'triggered' as const,
    trigger: { ...head, ...(condition !== undefined ? { condition } : {}) } as TriggerSpec,
    optional,
    targets,
    effects,
    ...(modalBlock !== null ? { modes: modalBlock.modes } : {}),
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

function parseTargetClause(
  text: string,
): { kind: TargetKind; filter?: Selector; controller?: TargetSpec['controller'] } | null {
  let cleaned = text.trim();
  let controller: TargetSpec['controller'] | undefined = undefined;
  if (cleaned.endsWith("you don't control") || cleaned.endsWith('an opponent controls')) {
    controller = 'opponent';
    cleaned = cleaned.replace(/\s+(you don't control|an opponent controls)$/, '').trim();
  } else if (cleaned.endsWith('you control')) {
    controller = 'you';
    cleaned = cleaned.replace(/\s+you control$/, '').trim();
  } else if (cleaned.endsWith('that player controls')) {
    controller = 'eventPlayer';
    cleaned = cleaned.replace(/\s+that player controls$/, '').trim();
  }

  let filter: Selector | undefined = undefined;
  if (cleaned.startsWith('monocolored ')) {
    filter = IS_MONOCOLORED;
    cleaned = cleaned.replace(/^monocolored\s+/, '').trim();
  }

  // "target permanent with mana value 4 or greater" (Despark) / "target nonland permanent with
  // mana value 3 or less" (Abrupt Decay) â€” the targeted counterpart to `parseMassSubject`'s
  // identical clause for the untargeted "destroy all â€¦" form.
  const manaValueClause = cleaned.match(/^(.+) with mana value (\d+) or (less|greater)$/i);
  if (manaValueClause !== null) {
    const n = Number(manaValueClause[2]);
    const bound =
      manaValueClause[3]?.toLowerCase() === 'less' ? manaValueAtMost(n) : manaValueAtLeast(n);
    filter = filter === undefined ? bound : allOf(filter, bound);
    cleaned = manaValueClause[1] as string;
  }

  const kind = parseTargetNoun(cleaned);
  if (kind !== null) {
    return {
      kind,
      ...(filter !== undefined ? { filter } : {}),
      ...(controller !== undefined ? { controller } : {}),
    };
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
const ENTERS_TAPPED_UNLESS_RE = /^(?:~|this land) enters (?:the battlefield )?tapped unless (.+)$/;
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
/**
 * A filter land - "Add {W}{W}, {W}{B}, or {B}{B}." Three printed two-mana outputs; the parse
 * checks they really are the three you can draw twice from a two-symbol alphabet before reading
 * the clause as two independent units.
 */
const MANA_FILTER_PAIR_RE =
  /^add ((?:\{[wubrgc]\}){2}), ((?:\{[wubrgc]\}){2}), or ((?:\{[wubrgc]\}){2})$/;
/** "Add one mana of any color." â€” one unit, any of the five colors. */
const MANA_ANY_COLOR_RE = /^add one mana of any color$/;
const MANA_ANY_COMBINATION_RE = /^add (\w+) mana in any combination of colors$/;
const MANA_X_ONE_COLOR_OTHER_CREATURES_RE =
  /^add x \{([wubrg])\} or x \{([wubrg])\}, where x is the number of other creatures you control$/;
/**
 * "Choose a color. Add an amount of mana of that color equal to X." - Nykthos (X is devotion to
 * the chosen colour) and Three Tree City (X is creatures you control of the chosen creature
 * TYPE, a different choice made as the land entered). Expanded into one alternative ability per
 * colour; see `parseManaAbilityLines`.
 */
const MANA_CHOSEN_COLOR_AMOUNT_RE =
  /^choose a color\. add an amount of mana of that color equal to (.+)$/;
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
const MANA_PERMANENT_COLORS_RE =
  /^for each color among permanents you control, add one mana of that color$/;
const MANA_ONE_PERMANENT_COLOR_RE = /^add one mana of any color among permanents you control$/;
/** "Add one mana of any type that a land you control could produce" (Reflecting Pool). */
const MANA_OWN_LANDS_RE = /^add one mana of any type that a land you control could produce$/;
/** "…any color among legendary creatures and planeswalkers you control" (Mox Amber). */
const MANA_LEGENDARY_PERMANENT_COLOR_RE =
  /^add one mana of any color among legendary creatures and planeswalkers you control$/;

/**
 * "Add {G} for each creature you control" (Gaea's Cradle, Itlimoc) - a fixed SYMBOL repeated a
 * state-derived number of times. The mirror of the dynamic forms above, which compute the symbol
 * set and keep the count fixed.
 */
const MANA_PER_PERMANENT_RE = /^add ((?:\{[wubrgc]\})+) for each (.+)$/;

/**
 * A painland: "{T}: Add {R} or {W}. This land deals 1 damage to you." The damage is a rider on
 * the mana ability, not a separate ability - mana abilities never use the stack (CR 605.3a), so
 * it applies the moment the mana is produced. Ancient Tomb's "Add {C}{C}" is the same shape.
 */
const MANA_WITH_SELF_DAMAGE_RE = /^(add [^.]+)\. ~ deals (\d+) damage to you$/;

/** "Add one mana of any color. Activate only if you control a Dragon." (Mox Jasper) */
const MANA_ACTIVATE_ONLY_IF_RE = /^(add [^.]+)\. activate only if you control (?:a|an) (.+)$/;
/** "Activate only if you control five or more lands." (Temple of the False God) */
const MANA_ACTIVATE_ONLY_IF_COUNT_RE =
  /^(add [^.]+)\. activate only if you control (\w+) or more (.+)$/;
/** Any other "Activate only if <condition>." on a mana ability, read by `parseActivationCondition`. */
const MANA_ACTIVATE_ONLY_IF_ANY_RE = /^(add [^.]+)\. activate only if (.+)$/;
/** "Add three mana of any one color" (Sceptre of Eternal Glory): N units, all the same color. */
const MANA_N_OF_ONE_COLOR_RE = /^add (\w+) mana of any one color$/;

/**
 * The condition of an "Activate only if …" restriction (CR 602.5b), lowercased with no trailing
 * period. Returns null for any phrasing it does not know, so the ability stays unmodeled rather
 * than becoming activatable at times the card forbids.
 */
function parseActivationCondition(text: string, card: OracleCard): Condition | null {
  const sameName = text.match(/^you control (\w+) or more lands with the same name$/);
  if (sameName !== null) {
    const n = parseAmount(sameName[1] as string);
    return n === null ? null : { kind: 'controlsLandsWithSameName', n };
  }
  const opponentMore = text.match(/^an opponent controls more (.+) than you$/);
  if (opponentMore !== null) {
    const selector = parseSubject(opponentMore[1] as string, card);
    return selector === null ? null : { kind: 'opponentControlsMore', selector };
  }
  if (text === 'you created a token this turn') return { kind: 'createdTokenThisTurn' };
  const counted = text.match(/^you control (\w+) or more (.+)$/);
  if (counted !== null) {
    const n = parseAmount(counted[1] as string);
    const selector = parseSubject(counted[2] as string, card);
    return n === null || selector === null ? null : countPermanents(selector, 'you', '>=', n);
  }
  return null;
}

/**
 * "â€¦Spend this mana only to cast a Dragon creature spell." (Haven of the Spirit Dragon) â€” a
 * CR 106.6 restriction riding on the mana produced.
 */
const MANA_SPEND_ONLY_RE = /^(add [^.]+)\. spend this mana only to (.+)$/;
const MANA_SPEND_UNCOUNTERABLE_RE =
  /^(add [^.]+)\. spend this mana only to (.+?),? and that spell (?:can't|cannot) be countered$/;

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
function parseActivationCosts(costText: string, card?: OracleCard): AbilityCost[] | null {
  const costs: AbilityCost[] = [];
  for (const raw of costText.split(',')) {
    const part = raw.trim();
    if (part === 'tap an untapped legendary creature you control') {
      costs.push({
        kind: 'tapOther',
        selector: allOf(ofType('Creature'), ofSupertype('Legendary'), YOURS),
      });
      continue;
    }
    // "Tap an untapped creature you control" may tap the source itself when it is one: the cost
    // names any untapped creature you control, not "another" (allowSelf).
    if (part === 'tap an untapped creature you control') {
      costs.push({ kind: 'tapOther', selector: allOf(ofType('Creature'), YOURS), allowSelf: true });
      continue;
    }
    const tapOthers = part.match(/^tap (two|three|four) untapped (.+) you control$/);
    if (tapOthers !== null) {
      const count = parseAmount(tapOthers[1] as string) as number;
      const noun = tapOthers[2] as string;
      const type = noun === 'artifacts' ? 'Artifact' : noun === 'creatures' ? 'Creature' : null;
      if (type === null) return null;
      costs.push({
        kind: 'tapOthers',
        selector: allOf(ofType(type), YOURS),
        count,
        allowSelf: true,
      });
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
      // The count word runs the full number vocabulary, not just one-to-three: Westvale Abbey
      // asks for FIVE creatures, and a truncated list silently left the whole cost unparsed.
      const picked = phrase.match(
        /^(?:(a|an|one|two|three|four|five|six|seven|eight|nine|ten) )?(another )?(.+)$/,
      );
      if (picked === null) return null;
      const countWord = picked[1] ?? 'one';
      const count = countWord === 'a' || countWord === 'an' ? 1 : (parseAmount(countWord) ?? 1);
      const noun = (picked[3] as string).replace(/s$/, '');
      const subtype = card === undefined ? null : resolveSubtype(noun, card);
      // "Sacrifice a nontoken blue creature" (the Flares' alternative cost): a token or color
      // qualifier on a creature.
      const qualified = noun.match(/^(nontoken )?(?:(white|blue|black|red|green) )?creature$/);
      const qualifiers: Selector[] =
        qualified === null
          ? []
          : [
              ...(qualified[1] !== undefined ? [not(IS_TOKEN)] : []),
              ...(qualified[2] !== undefined ? [ofColor(COLOR_WORDS[qualified[2]] as Color)] : []),
            ];
      const base =
        qualifiers.length > 0
          ? allOf(ofType('Creature'), ...qualifiers)
          : noun === 'artifact or creature'
            ? anyOf(ofType('Artifact'), ofType('Creature'))
            : noun === 'artifact'
              ? ofType('Artifact')
              : noun === 'creature'
                ? ofType('Creature')
                : noun === 'land'
                  ? ofType('Land')
                  : noun === 'permanent'
                    ? anyOf(
                        ofType('Artifact'),
                        ofType('Creature'),
                        ofType('Enchantment'),
                        ofType('Land'),
                        ofType('Planeswalker'),
                        ofType('Battle'),
                      )
                    : noun === 'servo'
                      ? ofSubtype('Servo')
                      : noun === 'token'
                        ? IS_TOKEN
                        : subtype !== null
                          ? ofSubtype(subtype)
                          : null;
      if (base === null) return null;
      costs.push({
        kind: 'sacrificeOther',
        selector: allOf(YOURS, base),
        ...(count > 1 ? { count } : {}),
        ...(picked[2] === undefined ? { allowSelf: true } : {}),
      });
      continue;
    }
    // "Discard this card" (channel lands - Boseiju, Otawara) is the SOURCE leaving hand, not a
    // free choice of card, so it is `discardSelf` rather than `discardCard`. The zone that makes
    // it payable is set by the caller (`parseActivatedLine`), which sees the whole line.
    if (/^discard (?:~|this card)$/.test(part)) {
      costs.push({ kind: 'discardSelf' });
      continue;
    }
    const discard = part.match(
      /^discard (a|an|one|two|three|four|five|six|seven|eight|nine|ten) cards?$/,
    );
    if (discard !== null) {
      const count = parseAmount(discard[1] as string);
      if (count === null) return null;
      costs.push({ kind: 'discardCard', ...(count > 1 ? { count } : {}) });
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
    // "Remove a +1/+1 counter from a creature you control" (Sage of Fables): the counter comes off
    // any matching permanent you control, chosen as the cost is paid.
    const fromAmong = part.match(
      /^remove (a|an|one|two) (\+1\/\+1|[a-z]+) counters? from an? (.+) you control$/,
    );
    if (fromAmong !== null) {
      const count = parseAmount(fromAmong[1] as string);
      if (card === undefined) return null;
      const noun = parseSubject(`${fromAmong[3] as string}s you control`, card);
      if (count === null || noun === null) return null;
      costs.push({
        kind: 'removeCountersFromAmong',
        counter: fromAmong[2] as string,
        count,
        selector: noun,
      });
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

/** Parse Flashback/Escape non-mana components that are not ordinary activation costs. */
function parseGraveyardAlternativeCosts(costText: string): AbilityCost[] | null {
  const exileOther = costText.match(
    /^exile (one|two|three|four|five|six|seven|eight|nine|ten|\d+) other cards? from your graveyard$/,
  );
  if (exileOther !== null) {
    const count = parseAmount(exileOther[1] as string);
    return count === null ? null : [{ kind: 'exileOtherCardsFromGraveyard', count }];
  }
  return parseActivationCosts(costText);
}
/** Parse a non-mana alternate-cost line such as Force of Will's pitch cost. */
function parseNonManaAlternativeCost(
  line: string,
  card: OracleCard,
): { costs: AbilityCost[]; manaCost?: ParsedManaCost; condition?: Condition } | null {
  const match = line.match(
    /^(if it's not your turn, )?you may (.+) rather than pay (?:this spell's|its) mana cost(?: if (.+))?$/,
  );
  if (match === null) return null;
  // "... if there are thirteen or more creatures on the battlefield" (Blasphemous Edict): a
  // condition on choosing the alternative cost, checked as the spell is cast.
  const trailing = match[3] === undefined ? undefined : parseConditionClause(match[3], card);
  if (trailing === null) return null;
  const costs: AbilityCost[] = [];
  let manaCost: ParsedManaCost | undefined;
  for (const part of (match[2] as string).split(' and ')) {
    // "You may pay {B} rather than pay this spell's mana cost": a replacement mana cost.
    const pay = part.match(/^pay ((?:\{[^}]+\})+)$/);
    if (pay !== null && manaCost === undefined) {
      const parsed = parseManaCost((pay[1] as string).toUpperCase() as never);
      if (parsed.cost === null) return null;
      manaCost = parsed.cost;
      continue;
    }
    const payLife = part.match(/^(?:pay) (\d+) life$/);
    if (payLife !== null) {
      costs.push({ kind: 'payLife', amount: Number(payLife[1]) });
      continue;
    }
    const exile = part.match(/^exile (?:a|one) (white|blue|black|red|green) card from your hand$/);
    if (exile !== null) {
      const colors: Record<string, Color> = {
        white: 'W',
        blue: 'U',
        black: 'B',
        red: 'R',
        green: 'G',
      };
      costs.push({
        kind: 'exileCardFromHand',
        selector: ofColor(colors[exile[1] as string] as Color),
      });
      continue;
    }
    // "You may sacrifice a nontoken blue creature rather than pay this spell's mana cost" (the
    // Flares). A spell is never a permanent, so "a creature" can never be the spell itself.
    if (/^sacrifice /.test(part)) {
      const sacrifice = parseActivationCosts(part);
      if (sacrifice === null || sacrifice.some((cost) => cost.kind !== 'sacrificeOther')) {
        return null;
      }
      costs.push(...sacrifice);
      continue;
    }
    return null;
  }
  if (costs.length === 0 && manaCost === undefined) return null;
  if (match[1] !== undefined && trailing !== undefined) return null;
  const condition: Condition | undefined =
    match[1] !== undefined ? { kind: 'notYourTurn' } : trailing;
  return {
    costs,
    ...(manaCost !== undefined ? { manaCost } : {}),
    ...(condition !== undefined ? { condition } : {}),
  };
}

/** Parse the "As an additional cost to cast this spell, ..." header. */
function parseSpellAdditionalCost(line: string): AbilityCost[] | null {
  const m = line.match(/^as an additional cost to cast this spell, (.+)$/i);
  if (m === null) return null;
  // "pay X life" (Toxic Deluge): X is announced with the spell (CR 601.2b) and paid as a cost
  // while casting (CR 601.2h). The caller marks the spell as announcing X.
  if (m[1] === 'pay x life') return [{ kind: 'payLifeValue', amount: { kind: 'xValue' } }];
  return parseActivationCosts(m[1] as string);
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
  // "Activate only if <condition>" in general (Sceptre of Eternal Glory's same-name lands). Read
  // before the counted form below, which would claim "three or more lands with the same name".
  {
    const m = effectText.match(MANA_ACTIVATE_ONLY_IF_ANY_RE);
    if (m !== null) {
      const base = parseManaProduction(m[1] as string, card);
      const condition = parseActivationCondition(m[2] as string, card);
      if (base === null || condition === null) return null;
      return { ...base, condition };
    }
  }
  // "Activate only if you control five or more lands" (Temple of the False God) - the counted
  // form of the gate above. `ManaAbilitySpec.condition` is already honoured by `manaSourcesFor`,
  // so this is a parser gap only.
  {
    const m = effectText.match(MANA_ACTIVATE_ONLY_IF_COUNT_RE);
    if (m !== null) {
      const base = parseManaProduction(m[1] as string, card);
      const count = parseAmount(m[2] as string);
      const selector = parseSubject(m[3] as string, card);
      if (base === null || count === null || selector === null) return null;
      return { ...base, condition: countPermanents(selector, 'you', '>=', count) };
    }
  }
  // "â€¦ Spend this mana only to cast a Dragon creature spell." (CR 106.6) â€” rides on the mana.
  {
    const m = effectText.match(MANA_SPEND_UNCOUNTERABLE_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      const restriction = parseManaSpendClause(m[2] as string, card);
      if (base === null || restriction === null) return null;
      return { ...base, restriction, uncounterableSpell: true };
    }
  }
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
        appendSentenceEffects(effects, sentence, parsed);
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
  // A filter land's three printed outputs are exactly the three multisets you can draw twice
  // from a two-symbol alphabet, so the clause IS two independent units each offering both
  // symbols. Verified as that identity rather than matched loosely: a card printing some other
  // three pairs is a different ability and stays unmodeled.
  {
    const m = effectText.match(MANA_FILTER_PAIR_RE);
    if (m !== null) {
      const options = [m[1], m[2], m[3]].map((group) => manaSymbols(group as string));
      const symbols = [...new Set(options.flat())];
      const multisets = new Set(options.map((option) => [...option].sort().join('')));
      if (symbols.length === 2 && multisets.size === 3) return { units: [symbols, symbols] };
    }
  }
  if (MANA_ANY_COLOR_RE.test(effectText)) return { units: [ALL_COLORS] };
  {
    const m = effectText.match(MANA_N_OF_ONE_COLOR_RE);
    if (m !== null) {
      const count = parseAmount(m[1] as string);
      if (count === null || count < 1) return null;
      return { units: Array.from({ length: count }, () => ALL_COLORS), linked: true };
    }
  }
  {
    const m = effectText.match(MANA_ANY_COMBINATION_RE);
    if (m !== null) {
      const count = parseAmount(m[1] as string);
      if (count !== null) {
        return { units: Array.from({ length: count }, () => ALL_COLORS) };
      }
    }
  }
  {
    const m = effectText.match(MANA_X_ONE_COLOR_OTHER_CREATURES_RE);
    if (m !== null) {
      return {
        units: [[(m[1] as string).toUpperCase() as Color, (m[2] as string).toUpperCase() as Color]],
        amount: {
          kind: 'countPermanents',
          selector: allOf(ofType('Creature'), YOURS, OTHER),
          scope: 'all',
        },
        linked: true,
      };
    }
  }
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
  if (MANA_OWN_LANDS_RE.test(effectText)) return { units: [], dynamic: 'ownLandTypes' };
  if (MANA_LEGENDARY_PERMANENT_COLOR_RE.test(effectText)) {
    return { units: [], dynamic: 'legendaryPermanentColors' };
  }
  // "Add {G} for each creature you control" - one fixed unit, repeated a computed number of times.
  {
    const m = effectText.match(MANA_PER_PERMANENT_RE);
    if (m !== null) {
      const amount = parseDynamicCountValue('the number of ' + (m[2] as string), card);
      if (amount !== null) {
        return { units: manaSymbols(m[1] as string).map((sym) => [sym]), amount };
      }
    }
  }
  if (MANA_PERMANENT_COLORS_RE.test(effectText))
    return { units: [], dynamic: 'colorsAmongPermanents' };
  if (MANA_ONE_PERMANENT_COLOR_RE.test(effectText))
    return { units: [], dynamic: 'oneColorAmongPermanents' };
  // A painland: the self-damage rider applies as the mana is produced.
  {
    const m = effectText.match(MANA_WITH_SELF_DAMAGE_RE);
    if (m) {
      // Recurse for the production half rather than re-reading the symbols here. "Add {R} or {W}"
      // is ONE mana with two choices; Ancient Tomb's "Add {C}{C}" is TWO mana. Parsing the
      // symbols inline collapsed both into a single unit, so Ancient Tomb would have tapped for
      // one colorless and taken 2 damage for it.
      const base = parseManaProduction(m[1] as string, card);
      if (base !== null) {
        return { ...base, onActivate: [{ op: 'damageController', amount: Number(m[2]) }] };
      }
    }
  }
  return null;
}

/**
 * Parse one whole line as a mana ability â€” cost and production. Returns null if it is not one.
 *
 * A cost paid in MANA is a mana ability like any other (CR 605.1a says nothing about what the
 * cost may be) — a filter land's `{W/B}, {T}`, Cabal Coffers' `{2}, {T}`. `planPayment` pays for
 * its own sources, so the cost is charged rather than ignored. `{X}` in that cost is still
 * refused, one layer down in `manaSourcesFor`: nobody announces X for an ability the payment
 * solver activates on its own.
 */
function parseManaAbilityLines(lower: string, card: OracleCard): ManaAbilitySpec[] | null {
  const split = splitActivation(lower);
  if (split === null) return null;
  const costs = parseActivationCosts(split.costText, card);
  if (costs === null) return null;
  // Omit the default so every land and mana rock's spec stays byte-identical to before.
  const tapOnly = costs.length === 1 && costs[0]?.kind === 'tap';
  const withCosts = (spec: ManaAbilitySpec): ManaAbilitySpec =>
    tapOnly ? spec : { ...spec, costs };

  // "Choose a color. Add an amount of mana of that color equal to your devotion to that color."
  // (Nykthos.) The colour choice and the AMOUNT are the same decision — devotion is per colour —
  // and `ManaAbilitySpec` deliberately has no channel coupling a unit's chosen symbol to its own
  // count. So the choice is expressed as five alternative abilities of one permanent, which is
  // the machinery `manaSourcesFor` and `planPayment` already have for Haven of the Spirit
  // Dragon: alternatives share a `cardId` and at most one of them is tapped. Colours with zero
  // devotion resolve to zero units and drop out on their own.
  {
    const m = split.effectText.match(MANA_CHOSEN_COLOR_AMOUNT_RE);
    if (m !== null) {
      const tail = m[1] as string;
      // "your devotion to that color" is per-colour, so each alternative reads its OWN colour.
      // Every other amount ("the number of creatures you control of the chosen type") is the
      // same number whichever colour is picked, and is parsed once.
      const perColour = tail === 'your devotion to that color';
      const shared = perColour ? null : parseDynamicCountValue(tail, card);
      if (perColour || shared !== null) {
        return ALL_COLORS.map((symbol) =>
          withCosts({
            units: [[symbol]],
            amount: perColour
              ? ({ kind: 'devotionTo', color: symbol as Color } as Value)
              : (shared as Value),
          }),
        );
      }
      return null;
    }
  }

  const production = parseManaProduction(split.effectText, card);
  if (production === null) return null;
  return [withCosts(production)];
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
  // "Activate only if <condition>." (CR 602.5b) — checked when activation is offered and paid.
  let condition: Condition | undefined;
  const onlyIf = lower.match(/^(.+)\. activate only if (.+)$/);
  if (onlyIf !== null) {
    const parsed = parseActivationCondition(onlyIf[2] as string, card);
    if (parsed === null) return null;
    condition = parsed;
    lower = onlyIf[1] as string;
  }

  const split = splitActivation(lower);
  if (split === null) return null;
  const costs = parseActivationCosts(split.costText, card);
  if (costs === null) return null;
  if (costs.some((c) => c.kind === 'loyalty') || card.types.includes('Planeswalker')) {
    timing = 'sorcery';
    oncePerTurn = true;
  }

  const modal = parseModalSpellBlock(split.effectText, card);
  if (modal !== null) {
    return {
      costs,
      timing,
      ...(oncePerTurn ? { oncePerTurn: true } : {}),
      ...(condition === undefined ? {} : { condition }),
      ability: {
        kind: 'activated',
        targets: modal.targets,
        effects: [],
        modes: modal.modes,
        description: line,
      },
    };
  }

  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
    targets.push(
      kind === 'cardInGraveyard'
        ? graveyardCardTarget(
            graveyardOwnerScope ?? 'controller',
            filter === undefined ? {} : { filter },
          )
        : {
            kind,
            ...(filter !== undefined ? { filter } : {}),
            ...(controller !== undefined ? { controller } : {}),
          },
    );
    return targets.length - 1;
  };
  const effects: Effect[] =
    parseHerdHeirloomEffect(split.effectText, alloc, card) ??
    parseGraveyardExileCreatureRider(split.effectText, alloc) ??
    parseExileReturnAtNextEndStepBlock(split.effectText, alloc) ??
    parseDiesThisTurnReturnTappedBlock(split.effectText, alloc) ??
    // Same reason as the spell path: this block's later sentences refer back to the first
    // ("them", "the rest"), so it must be matched whole rather than sentence by sentence.
    // Sensei's Divining Top prints it as an activated ability, not as a spell.
    parseLookAtTopBlock(split.effectText, card) ??
    [];
  if (effects.length === 0) {
    for (const sentence of splitSentences(split.effectText)) {
      const parsed = parseEffectSentence(sentence, alloc, card);
      if (parsed === null) return null;
      appendSentenceEffects(effects, sentence, parsed);
    }
  }
  if (effects.length === 0) return null;

  return {
    costs,
    timing,
    ...(oncePerTurn ? { oncePerTurn: true } : {}),
    ...(condition === undefined ? {} : { condition }),
    // "Discard this card" can only be paid from the hand, so the ability functions there
    // (CR 112.6a) — channel lands, Boseiju and Otawara. Without the zone the battlefield loop
    // would offer it and `canPayNonManaCosts` would refuse the cost, making it dead either way.
    ...(costs.some((c) => c.kind === 'discardSelf') ? { zone: 'hand' as const } : {}),
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
  if (lower === "~ can't be blocked") {
    return [{ affects: SELF, op: { layer: 6, setCantBeBlocked: true } }];
  }
  /**
   * The five basic land types (CR 305.6). Wastes is a land type but NOT a basic land type, so it
   * is deliberately absent - `docs/rules/comprehensive-rules.txt` is the authority here, and a
   * card reading "every basic land type" must not grant it.
   *
   * Distinct from `BASIC_LAND_MANA` in `continuous.ts`, which maps a subtype to the mana it makes
   * and DOES include Wastes, because a permanent that is a Wastes taps for {C}.
   */
  const BASIC_LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] as const;

  // Blood Moon â€” "Nonbasic lands are Mountains." (layer 4: set subtype, lose abilities.)
  if (lower === 'enchanted permanent is a colorless forest land') {
    return [
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 4, setTypes: ['Land'], setSubtypes: ['Forest'], loseAbilities: true },
      },
      { affects: { kind: 'attachedToSource' }, op: { layer: 5, setColors: [] } },
    ];
  }
  /*
   * "Lands you control are every basic land type in addition to their other types."
   * (Dryad of the Ilysian Grove, Leyline of the Guildpact) and the single-type twin
   * "Each land is a Swamp in addition to its other land types." (Urborg, Yavimaya).
   *
   * Both are layer-4 ADDITIONS, which is why the same `addSubtypes` op serves them: `finishLayer4`
   * keeps the printed types and `BASIC_LAND_MANA` derives the intrinsic mana ability from the
   * resulting subtype set, so the mana consequence falls out for free (see `continuous.ts`).
   *
   * The five basic land types are Plains, Island, Swamp, Mountain and Forest (CR 305.6,
   * `docs/rules/comprehensive-rules.txt`). Wastes is NOT one of them - do not add it.
   *
   * Note the difference in scope, which the printed text is precise about and this must be too:
   * "lands you control" is controller-restricted; Urborg's "each land" is every land in the game,
   * including opponents'.
   */
  if (lower === 'lands you control are every basic land type in addition to their other types') {
    return [
      {
        affects: allOf(ofType('Land'), YOURS),
        op: { layer: 4, addSubtypes: [...BASIC_LAND_TYPES] },
      },
    ];
  }
  {
    const m = lower.match(
      /^each land is an? (plains|island|swamp|mountain|forest) in addition to its other land types$/,
    );
    if (m !== null) {
      const subtype = m[1] as string;
      return [
        {
          affects: ofType('Land'),
          op: { layer: 4, addSubtypes: [subtype.charAt(0).toUpperCase() + subtype.slice(1)] },
        },
      ];
    }
  }
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
  {
    const both = lower.match(/^~['’]s power and toughness are each equal to the number of (.+)$/);
    if (both !== null) {
      const selector = parseSubject(both[1] as string, card);
      if (selector !== null) {
        const count: Value = { kind: 'countPermanents', selector, scope: 'you' };
        return [
          {
            affects: { kind: 'self' },
            op: { layer: 7, sublayer: 'a', power: count, toughness: count },
          },
        ];
      }
    }
    const power = lower.match(/^~['’]s power is equal to the number of (.+)$/);
    if (power !== null) {
      const selector = parseSubject(power[1] as string, card);
      if (selector !== null) {
        // Only the POWER is characteristic-defining here, so toughness keeps its printed value.
        // A card printed with a "*" toughness would come through as NaN, and a CDA that sets a
        // NaN toughness is worse than leaving the line unmodeled.
        const printedToughness = Number(card.toughness ?? 0);
        if (!Number.isFinite(printedToughness)) return null;
        return [
          {
            affects: { kind: 'self' },
            op: {
              layer: 7,
              sublayer: 'a',
              power: { kind: 'countPermanents', selector, scope: 'you' },
              toughness: constant(printedToughness),
            },
          },
        ];
      }
    }
  }
  {
    const m = lower.match(
      /^(.+?) gets? ([+-]?[0-9]+|[+-]?x)[/]([+-]?[0-9]+|[+-]?x) for each (.+)$/,
    );
    if (m !== null) {
      const affects =
        (m[1] as string) === '~' ? { kind: 'self' as const } : parseSubject(m[1] as string, card);
      const count = parseDynamicCountValue('the number of ' + (m[4] as string), card);
      if (affects !== null && count !== null) {
        const power = (m[2] as string).toLowerCase().includes('x')
          ? count
          : { kind: 'times' as const, of: count, n: Number(m[2]) };
        const toughness = (m[3] as string).toLowerCase().includes('x')
          ? count
          : { kind: 'times' as const, of: count, n: Number(m[3]) };
        return [{ affects, op: { layer: 7, sublayer: 'd', power, toughness } }];
      }
    }
  }
  {
    const m = lower.match(/^(.+?) gets? ([+-]?x)\/([+-]?x), where x is (.+)$/);
    if (m !== null) {
      const affects =
        (m[1] as string) === '~' ? { kind: 'self' as const } : parseSubject(m[1] as string, card);
      const count = parseDynamicCountValue(m[4] as string, card);
      if (affects !== null && count !== null)
        return [{ affects, op: { layer: 7, sublayer: 'd', power: count, toughness: count } }];
    }
  }
  if (lower === 'all creatures have double strike and attack each combat if able') {
    const affects = parseSubject('creatures', card);
    if (affects !== null) {
      return [
        { affects, op: { layer: 6, addKeyword: 'double strike' } },
        { affects, op: { layer: 6, setMustAttackEachCombat: true } },
      ];
    }
  }
  if (lower === 'creatures your opponents control attack each combat if able') {
    const affects = parseSubject('creatures your opponents control', card);
    if (affects !== null) return [{ affects, op: { layer: 6, setMustAttackEachCombat: true } }];
  }
  // "Enchanted/Equipped creature ... and is goaded" (CR 701.38 - it attacks each combat if able
  // and attacks a player other than the goad's controller if able).
  //
  // Anchored to the whole line and delegated back to the ordinary aura/equipment grammar for
  // everything BEFORE the goad, because that prefix carries real abilities: Ghoulish Impetus's
  // +1/+1 and deathtouch, Redemption Arc's indestructible. A loose `(.+) is goaded` would match
  // the entire prefix as a "subject", report the card modeled, and silently drop those - the
  // exact silent-drift failure `requireModeled` exists to catch. If the prefix does not parse,
  // this returns null so the card stays honestly unmodeled rather than half-modeled.
  {
    const affects: Selector = { kind: 'attachedToSource' };
    const goad: StaticEffect = { affects, op: { layer: 6, addGoad: true } };
    if (lower === 'enchanted creature is goaded' || lower === 'equipped creature is goaded') {
      return [goad];
    }
    const m = lower.match(/^(enchanted|equipped) creature (.*?),? and is goaded$/);
    if (m !== null) {
      // The printed form is an Oxford list ("gets +1/+1, has deathtouch, and is goaded"); the
      // anthem grammar spells the same thing with "and".
      const rest = (m[2] as string).replace(/, (has|have) /g, ' and $1 ');
      const parsed = parseStaticLine(`${m[1] as string} creature ${rest}`, card);
      return parsed === null ? null : [...parsed, goad];
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
      // A grant of ALTERNATIVE abilities (the Nykthos shape) has no `addManaAbility` form —
      // layer 6 grants one ability — so it stays unmodeled rather than granting only the first.
      const granted = parseManaAbilityLines((m[2] as string).replace(/\.$/, ''), card);
      const affects = parseSubject(m[1] as string, card);
      if (granted !== null && granted.length === 1 && affects !== null) {
        return [{ affects, op: { layer: 6, addManaAbility: granted[0] as ManaAbilitySpec } }];
      }
    }
  }
  // Dynamic attached buffs: "Equipped creature gets +1/+0 for each land you control"
  {
    const m = lower.match(
      /^(enchanted|equipped) creature gets ([+-]?\d+|[+-]?[xX])\/([+-]?[xX]|[+-]?\d+)(?: (for each|equal to) (.+))?$/,
    );
    if (m) {
      const affects: Selector = { kind: 'attachedToSource' };
      const pStr = m[2] as string;
      const tStr = m[3] as string;
      const countClause = m[5];
      if (countClause) {
        const selector = parseSubject(countClause, card);
        if (selector !== null) {
          const countVal: Value = { kind: 'countPermanents', selector, scope: 'you' };
          const power: Value | number = pStr.toLowerCase().includes('x') ? countVal : Number(pStr);
          const toughness: Value | number = tStr.toLowerCase().includes('x')
            ? countVal
            : Number(tStr);
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
  // "Commander creatures you own have \"When this creature enters or leaves the battlefield, draw
  // a card.\"" (Candlekeep Sage): ownership, not control (CR 108.3), so a commander an opponent
  // controls still has it, and the granted trigger is controlled by the creature's controller.
  {
    const m = lower.match(/^commander creatures you own have "(.+)"$/);
    if (m) {
      const affects = allOf(IS_COMMANDER, ofType('Creature'), { kind: 'owner', who: 'you' });
      // The printed casing, so the granted ability reads as printed on the board.
      const quoted = (m[1] as string).replace(/\.$/, '');
      const at = card.oracleText.toLowerCase().indexOf(quoted);
      const tr = parseTriggerLine(
        at < 0 ? quoted : card.oracleText.slice(at, at + quoted.length),
        card,
      );
      if (tr === null || tr.length === 0) return null;
      return tr.map((ability) => ({ affects, op: { layer: 6, addTrigger: ability } }));
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
        if (parsed.ward !== undefined)
          out.push({
            affects,
            op: { layer: 6, addWard: { kind: 'mana', cost: parsed.ward } },
          });
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
const ADDITIONAL_LAND_DROP_RE =
  /^you may play (an additional land|(?:one|two|three|four) additional lands?) (?:on |during )?each of your turns$/;
const CAST_FROM_LIBRARY_TOP_RE = /^you may cast (.+ spells?) from the top of your library$/;
const PLAY_FROM_ZONE_RE =
  /^you may play (lands?|permanent cards?) from (the top of your library|your graveyard)$/;
const MULDROTHA_PLAY_RE =
  /^during each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard$/;
const REVEAL_TOP_LIBRARY_RE = /^play with the top card of your library revealed$/;
const ENCHANTED_LAND_MANA_RIDER_RE =
  /^whenever enchanted land is tapped for mana, its controller adds an additional ((?:\{[wubrgc]\})+)$/;
const SAME_TYPE_LAND_MANA_RIDER_RE =
  /^whenever you tap a land for mana, add one mana of any type that land produced$/;

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

const TOKEN_COUNT_DOUBLED_RE =
  /^if an effect would create one or more tokens under your control, it creates twice that many(?: of those tokens)? instead$/;

const COUNTER_COUNT_DOUBLED_RE =
  /^if an effect would put one or more counters on a permanent you control, it puts twice that many(?: of (?:each of )?those counters)? on that permanent instead$/;

const PLUS_COUNTER_ADDITION_RE =
  /^if one or more \+1\/\+1 counters would be put on a creature you control, that many plus one \+1\/\+1 counters are put on (?:that creature|it) instead$/;

/**
 * Rule-modifying statics (ADR 0010, Inc 13) â€” cost reduction, "can't be countered", "opponents
 * can't cast spells", casting from a non-hand zone. These have no permanent to apply a layer op
 * to (`rule-statics.ts`), so they are collected separately from `parseStaticLine`.
 */
function parseRuleStaticLine(lower: string, card: OracleCard): RuleStatic[] | null {
  if (
    lower ===
    'if a source you control would deal damage to an opponent or a permanent an opponent controls, it deals double that damage instead'
  ) {
    return [{ kind: 'damageDoubledToOpponents', sourceControllerOnly: true }];
  }
  if (lower === 'affinity for artifacts') {
    return [
      {
        kind: 'costReduction',
        amount: {
          kind: 'countPermanents',
          selector: allOf(ofType('Artifact'), YOURS),
          scope: 'all',
        },
        selfOnly: true,
      },
    ];
  }
  if (LOOK_AT_TOP_ANY_TIME_RE.test(lower)) return [];
  if (DAMAGE_DOUBLED_RE.test(lower)) {
    return [
      { kind: 'damageDoubled', sourceFilter: allOf(ofType('Creature'), YOURS, ENTERED_THIS_TURN) },
    ];
  }

  {
    const dynamic = lower.match(/^(?:this spell|~) costs? \{x\} less to cast, where x is (.+)$/);
    if (dynamic !== null) {
      const amount = parseDynamicCountValue(dynamic[1] as string, card);
      if (amount !== null) return [{ kind: 'costReduction', amount, selfOnly: true }];
    }
    const power = lower.match(
      /^(.+ spells?) you cast with power (\d+) or greater cost \{(\d+)\} less to cast$/,
    );
    if (power !== null) {
      const filter = parseSpellFilter(power[1] as string, card);
      if (filter !== null)
        return [
          costReductionFor(
            filter === ANY_SPELL
              ? powerAtLeast(Number(power[2]))
              : allOf(filter, powerAtLeast(Number(power[2]))),
            Number(power[3]),
          ),
        ];
    }
  }
  if (TOKEN_COUNT_DOUBLED_RE.test(lower)) {
    return [{ kind: 'tokenCountMultiplier', multiplier: 2 }];
  }
  if (COUNTER_COUNT_DOUBLED_RE.test(lower)) {
    return [{ kind: 'counterPlacementReplacement', filter: YOURS, multiplier: 2, addition: 0 }];
  }
  if (PLUS_COUNTER_ADDITION_RE.test(lower)) {
    return [
      {
        kind: 'counterPlacementReplacement',
        filter: allOf(ofType('Creature'), YOURS),
        counter: '+1/+1',
        multiplier: 1,
        addition: 1,
      },
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
  // "Spells of the chosen type you cast cost {W}{U}{B}{R}{G} less to cast. This effect reduces
  // only the amount of colored mana you pay." (Morophon) - a COLORED reduction, which is a
  // different field from the generic one: it subtracts colored pips, and CR 601.2f forbids it
  // reducing generic mana at all. Checked before the generic form below, whose subject group
  // would otherwise swallow the whole line.
  {
    const m = lower.match(
      /^(.+?) you cast cost ((?:\{[^}]+\})+) less to cast\. this effect reduces only the amount of colou?red mana you pay$/,
    );
    if (m) {
      const parsed = parseSpellFilter(m[1] as string, card);
      if (parsed === null) return null;
      const cost = parseManaCost((m[2] as string).toUpperCase() as never);
      if (cost.cost === null || cost.unsupportedSymbols.length > 0) return null;
      return [
        {
          kind: 'costReduction',
          amount: constant(0),
          coloredAmount: cost.cost,
          ...(parsed === ANY_SPELL ? {} : { filter: parsed }),
        },
      ];
    }
  }
  // "As long as you control your commander, activated abilities of cards in your graveyard cost
  // {2} less to activate. This effect can't reduce the mana in that ability's activation cost to
  // less than one mana." (Convergence of Dominion)
  {
    const m = lower.match(
      /^(?:as long as you control your commander, )?activated abilities of cards in your graveyard cost \{(\d+)\} less to activate(?:\. this effect can't reduce the mana in that ability's activation cost to less than (one|two) mana)?$/,
    );
    if (m !== null) {
      const commander = lower.startsWith('as long as you control your commander, ');
      return [
        {
          kind: 'costReduction',
          appliesTo: 'activate',
          graveyardAbilities: true,
          amount: constant(Number(m[1])),
          ...(m[2] !== undefined ? { minimumMana: m[2] === 'one' ? 1 : 2 } : {}),
          ...(commander ? { condition: { kind: 'controlsYourCommander' } } : {}),
        },
      ];
    }
  }
  // "Each nonland card in your hand without foretell has foretell. Its foretell cost is equal
  // to its mana cost reduced by {2}." (Dream Devourer).
  {
    const m = lower.match(
      /^each nonland card in your hand without foretell has foretell\. its foretell cost is equal to its mana cost reduced by \{(\d+)\}\.?(?:\s*\(.*\))?$/,
    );
    if (m !== null) return [{ kind: 'grantForetell', reduction: Number(m[1]) }];
  }
  // "Boast abilities you activate cost {1} less to activate for each Dragon you control."
  // (Dragonkin Berserker): every Boast ability you activate, whatever its source.
  {
    const m = lower.match(
      /^boast abilities you activate cost \{(\d+)\} less to activate(?: for each (.+?))?$/,
    );
    const each = m?.[2] === undefined ? undefined : parseSubject(m[2], card);
    if (m !== null && each !== null) {
      const per = Number(m[1]);
      const amount: Value =
        each === undefined
          ? constant(per)
          : per === 1
            ? { kind: 'countPermanents', selector: each, scope: 'you' }
            : {
                kind: 'times',
                of: { kind: 'countPermanents', selector: each, scope: 'you' },
                n: per,
              };
      return [{ kind: 'costReduction', appliesTo: 'activate', boastOnly: true, amount }];
    }
  }
  // "Spells you cast that target a creature cost {2} less to cast." (Killian, Ink Duelist): the
  // reduction depends on the spell's chosen targets (CR 601.2f).
  {
    const m = lower.match(/^spells you cast that target an? (.+?) cost \{(\d+)\} less to cast$/);
    const targetFilter = m === null ? null : parseSubject(m[1] as string, card);
    if (m !== null && targetFilter !== null) {
      return [{ kind: 'costReduction', amount: constant(Number(m[2])), targetFilter }];
    }
  }
  // "Instant and sorcery spells you cast cost {1} less to cast." (Goblin Electromancer) â€” a
  // plain, unconditional, fixed reduction: no Eminence "as long as" wrapper, no Temur
  // Battlecrier-style per-permanent scaling.
  {
    // The optional " of the chosen type" trails "you cast" rather than the subject
    // (Herald's Horn: "Creature spells you cast of the chosen type cost {1} less to cast").
    const m = lower.match(
      /^(.+ spells?) you cast( of the chosen type)? cost \{(\d+)\} less to cast$/,
    );
    if (m) {
      const parsed = parseSpellFilter(m[1] as string, card);
      if (parsed === null) return null;
      const base = parsed === ANY_SPELL ? undefined : parsed;
      const filter =
        m[2] === undefined
          ? base
          : base === undefined
            ? CHOSEN_SUBTYPE
            : allOf(base, CHOSEN_SUBTYPE);
      return [costReductionFor(filter, Number(m[3]))];
    }
  }
  // "Each spell you cast that's red or green costs {1} less to cast." (Goblin Anarchomancer) â€”
  // the same shape, but the subject is a color pair instead of a card type, and the verb order
  // is reversed ("costs" trails the clause rather than "cost" following the subject).
  {
    const m = lower.match(
      /^each spell you cast that's (\w+)(?: or (\w+))? costs \{(\d+)\} less to cast$/,
    );
    if (m) {
      const first = COLOR_WORDS[m[1] as string];
      if (first === undefined) return null;
      const colors = [ofColor(first)];
      if (m[2] !== undefined) {
        const second = COLOR_WORDS[m[2] as string];
        if (second === undefined) return null;
        colors.push(ofColor(second));
      }
      const filter = colors.length === 1 ? colors[0]! : anyOf(...colors);
      return [costReductionFor(filter, Number(m[3]))];
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
  // Basandra, Battle Seraph. "PLAYERS" — its own controller included, unlike Marisi's
  // opponents-only wording immediately below.
  if (
    lower ===
    "during your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments"
  ) {
    return [
      { kind: 'cantCastSpells', who: 'opponents', yourTurnOnly: true },
      {
        kind: 'cantActivateAbilities',
        who: 'opponents',
        yourTurnOnly: true,
        filter: anyOf(ofType('Artifact'), ofType('Creature'), ofType('Enchantment')),
      },
    ];
  }
  if (lower === "players can't cast spells during combat") {
    return [{ kind: 'cantCastSpells', who: 'all', yourTurnOnly: false, duringCombatOnly: true }];
  }
  // Marisi, Breaker of the Coil.
  if (lower === "your opponents can't cast spells during combat") {
    return [
      { kind: 'cantCastSpells', who: 'opponents', yourTurnOnly: false, duringCombatOnly: true },
    ];
  }
  if (CANT_CAST_SPELLS_RE.test(lower)) {
    return [{ kind: 'cantCastSpells', who: 'opponents', yourTurnOnly: true }];
  }
  {
    const m = lower.match(ADDITIONAL_LAND_DROP_RE);
    if (m !== null) {
      const amount = (m[1] as string).startsWith('an ')
        ? 1
        : ({ one: 1, two: 2, three: 3, four: 4 }[(m[1] as string).split(' ')[0] as string] ?? 0);
      return amount > 0 ? [{ kind: 'additionalLandDrops', count: constant(amount) }] : null;
    }
  }
  {
    const m = lower.match(ENCHANTED_LAND_MANA_RIDER_RE);
    if (m !== null) {
      return [
        {
          kind: 'manaActivationRider',
          source: { kind: 'attachedToSource' },
          add: { kind: 'fixed', units: manaSymbols(m[1] as string).map((symbol) => [symbol]) },
        },
      ];
    }
  }
  if (SAME_TYPE_LAND_MANA_RIDER_RE.test(lower)) {
    return [
      {
        kind: 'manaActivationRider',
        source: allOf(ofType('Land'), YOURS),
        add: { kind: 'oneOfProducedTypes' },
      },
    ];
  }
  if (REVEAL_TOP_LIBRARY_RE.test(lower)) return [{ kind: 'revealTopLibrary' }];
  if (MULDROTHA_PLAY_RE.test(lower)) {
    return [
      {
        kind: 'playFromZone',
        zone: 'graveyard',
        filter: anyOf(
          ofType('Artifact'),
          ofType('Battle'),
          ofType('Creature'),
          ofType('Enchantment'),
          ofType('Land'),
          ofType('Planeswalker'),
        ),
        yourTurnOnly: true,
        permanentTypeBudget: 1,
      },
    ];
  }
  {
    const m = lower.match(PLAY_FROM_ZONE_RE);
    if (m !== null) {
      const zone =
        (m[2] as string) === 'your graveyard' ? ('graveyard' as const) : ('libraryTop' as const);
      const filter = (m[1] as string).startsWith('land')
        ? ofType('Land')
        : anyOf(
            ofType('Artifact'),
            ofType('Battle'),
            ofType('Creature'),
            ofType('Enchantment'),
            ofType('Land'),
            ofType('Planeswalker'),
          );
      return [{ kind: 'playFromZone', zone, filter }];
    }
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
  // "Creatures can't attack you unless their controller pays {2} for each creature they control
  // that's attacking you." (Ghostly Prison, Propaganda) â€” one fixed per-attacker tax.
  {
    const m = lower.match(
      /^creatures can't attack you unless their controller pays (\{[^}]+\}) for each creature they control that's attacking you$/,
    );
    if (m) {
      const cost = parseManaCost((m[1] as string).toUpperCase() as never);
      if (
        cost.cost !== null &&
        cost.cost.generic > 0 &&
        cost.cost.colorless === 0 &&
        Object.values(cost.cost.colored).every((n) => n === 0)
      ) {
        return [{ kind: 'attackTax', amount: cost.cost.generic }];
      }
      return null;
    }
  }
  return null;
}

/**
 * A modal DFC face this parser can read as "just a land that taps for one fixed color" (Pathway
 * lands: "{T}: Add {B}." and nothing else on either face â€” no other line, no enters-tapped, no
 * second ability). Returns null for anything printed beyond that single sentence, since guessing
 * at an unread clause on a land face would silently drop it rather than leave the card unmodeled.
 */
function parseSimpleLandFace(typeLine: string, oracleText: string): Color | null {
  if (!typeLine.includes('Land')) return null;
  const m = stripReminderText(oracleText)
    .trim()
    .toLowerCase()
    .match(/^\{t\}: add \{([wubrg])\}\.?$/);
  return m === null ? null : ((m[1] as string).toUpperCase() as Color);
}

/**
 * A Pathway-shaped modal DFC land (CR 712.9, Zendikar Rising): two faces, each a plain land
 * whose only text is a single fixed-color tap ability, no basic land types or other printed
 * characteristics. Modeled with `entersChoosingOption` (the same as-enters modal-choice
 * mechanism Caged Sun's color pick and Frontier Siege's mode pick already use) plus a
 * `chosenColor`-dynamic mana ability that reads the choice back at query time, instead of the
 * generic per-line loop's ordinary reading of the FRONT face alone (which is all `card.oracleText`
 * ever carries) â€” that would silently lose the back face's color entirely, offering only half of
 * what the land can actually do.
 */
/**
 * Parse the land face of a spell // land modal DFC. The back face is deliberately represented as
 * an alternate cast rather than a second CardDefinition: it is playable from hand, but only as a
 * land, and its front face remains the spell used by the normal casting path.
 */
function buildMdfcLandFace(card: OracleCard): AlternativeCast | null {
  const back = card.backFace;
  if (card.layout !== 'modal_dfc' || back === undefined || card.types.includes('Land')) return null;
  if (!card.types.includes('Instant') && !card.types.includes('Sorcery')) return null;

  const typeParts = back.typeLine.split(/\s+—\s+/);
  const typeWords = (typeParts[0] ?? '').trim().split(/\s+/).filter(Boolean);
  const supertypes = typeWords.filter((type) =>
    ['Basic', 'Legendary', 'Snow', 'World'].includes(type),
  );
  const types = typeWords.filter((type) => !supertypes.includes(type));
  if (!types.includes('Land')) return null;
  const subtypes = (typeParts[1] ?? '').trim().split(/\s+/).filter(Boolean);

  let entersTapped = false;
  let entersTappedUnless: Condition | undefined;
  const manaAbilities: ManaAbilitySpec[] = [];
  const unhandled: string[] = [];
  for (const rawLine of stripReminderText(back.oracleText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const lower = line.toLowerCase().replace(/\.$/, '');
    const pay = lower.match(ENTERS_PAY_LIFE_RE);
    if (pay !== null) {
      entersTappedUnless = { kind: 'mayPayLife', n: Number(pay[1]) };
      continue;
    }
    if (
      /^(?:~|this land) enters (?:the battlefield )?tapped$/.test(lower) ||
      lower === back.name.toLowerCase() + ' enters tapped'
    ) {
      entersTapped = true;
      continue;
    }
    const mana = parseManaAbilityLines(lower, card);
    if (mana !== null) {
      manaAbilities.push(...mana);
      continue;
    }
    unhandled.push(line);
  }
  if (manaAbilities.length === 0 || unhandled.length > 0) return null;

  // This is a card-face descriptor, not a token definition; the shared rule is intentionally scoped out here.
  // eslint-disable-next-line no-restricted-syntax
  const landFace: MdfcLandFace = {
    name: back.name,
    typeLine: back.typeLine,
    oracleText: back.oracleText,
    manaCost: back.manaCost,
    frontOracleText: card.oracleText,
    frontManaCost: card.manaCost,
    colors: [...back.colors],
    supertypes,
    types,
    subtypes,
    manaAbilities,
    entersTapped,
    ...(entersTappedUnless !== undefined ? { entersTappedUnless } : {}),
  };
  return {
    kind: 'mdfc',
    name: back.name,
    typeLine: back.typeLine,
    manaCost: parseManaCost('{0}').cost!,
    description: back.name,
    landFace,
  };
}
interface TransformBackFaceResult {
  backFace: BackFace;
  reasons: string[];
}

/** Interpret the second face of a traditional transforming DFC with the normal card grammar. */
function interpretSecondFace(card: OracleCard): CardDefinition | null {
  const back = card.backFace;
  if (back === undefined) return null;

  const [leftRaw, rightRaw = ''] = back.typeLine.split(/\s+\u2014\s+/);
  const left = (leftRaw ?? '').trim().split(/\s+/).filter(Boolean);
  const knownSupertypes = new Set([
    'Basic',
    'Legendary',
    'Snow',
    'World',
    'Ongoing',
    'Host',
    'Elite',
  ]);
  const supertypes = left.filter((word) => knownSupertypes.has(word));
  const types = left.filter((word) => !knownSupertypes.has(word));
  const subtypes = rightRaw.trim().split(/\s+/).filter(Boolean);
  const synthetic: OracleCard = {
    oracleId: `${card.oracleId}:back` as OracleCard['oracleId'],
    scryfallId: card.scryfallId,
    name: back.name,
    manaCost: back.manaCost,
    cmc: 0,
    colors: [...back.colors],
    colorIdentity: [...card.colorIdentity],
    typeLine: back.typeLine,
    supertypes,
    types,
    subtypes,
    oracleText: back.oracleText,
    power: back.power,
    toughness: back.toughness,
    loyalty: back.loyalty ?? null,
    defense: back.defense ?? null,
    keywords: [],
    layout: 'normal',
    commanderLegality: card.commanderLegality,
    isBasicLand: supertypes.includes('Basic') && types.includes('Land'),
  };
  return interpretCard(synthetic);
}

function buildTransformBackFace(card: OracleCard): TransformBackFaceResult | null {
  if (card.layout !== 'transform' || card.backFace === undefined) return null;
  const back = card.backFace;
  const def = interpretSecondFace(card)!;
  /* eslint-disable no-restricted-syntax -- this is a permanent face descriptor, not a token spec */
  return {
    backFace: {
      name: def.name,
      typeLine: def.typeLine,
      oracleText: back.oracleText,
      manaCostText: back.manaCost,
      frontOracleText: card.oracleText,
      frontManaCostText: card.manaCost,
      manaCost: def.manaCost,
      hasUnsupportedCost: def.hasUnsupportedCost,
      supertypes: [...def.supertypes],
      types: [...def.types],
      subtypes: [...def.subtypes],
      colors: [...def.colors],
      power: def.power,
      toughness: def.toughness,
      loyalty: def.loyalty,
      defense: def.defense,
      keywords: [...def.keywords],
      ...(def.ward !== undefined ? { ward: def.ward } : {}),
      ...(def.protectionFrom !== undefined ? { protectionFrom: [...def.protectionFrom] } : {}),
      manaAbilities: [...def.manaAbilities],
      activatedAbilities: [...def.activatedAbilities],
      entersTapped: def.entersTapped,
      ...(def.entersTappedUnless !== undefined
        ? { entersTappedUnless: def.entersTappedUnless }
        : {}),
      ...(def.entersWithCounters !== undefined
        ? { entersWithCounters: { ...def.entersWithCounters } }
        : {}),
      triggers: [...def.triggers],
      staticEffects: [...def.staticEffects],
      ruleStatics: [...def.ruleStatics],
      ...(def.cantBlock === true ? { cantBlock: true } : {}),
      ...(def.cantBeBlocked === true ? { cantBeBlocked: true } : {}),
    },
    reasons: def.unmodeledReasons.map((reason) => `back face: ${reason}`),
  };
  /* eslint-enable no-restricted-syntax */
}
function buildPathwayLand(card: OracleCard): {
  entersChoosingOption: NonNullable<CardDefinition['entersChoosingOption']>;
  manaAbilities: ManaAbilitySpec[];
} | null {
  if (card.backFace === undefined) return null;
  const frontColor = parseSimpleLandFace(card.typeLine, card.oracleText);
  const backColor = parseSimpleLandFace(card.backFace.typeLine, card.backFace.oracleText);
  if (frontColor === null || backColor === null || frontColor === backColor) return null;
  return {
    entersChoosingOption: {
      prompt: 'Choose a face',
      options: [
        { key: frontColor, label: card.name },
        { key: backColor, label: card.backFace.name },
      ],
    },
    manaAbilities: [{ units: [], dynamic: 'chosenColor' }],
  };
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

  const pathwayLand = card.layout === 'modal_dfc' ? buildPathwayLand(card) : null;
  const mdfcLandFace = card.layout === 'modal_dfc' ? buildMdfcLandFace(card) : null;
  const transformBack = card.layout === 'transform' ? buildTransformBackFace(card) : null;
  if (transformBack !== null) reasons.push(...transformBack.reasons);
  if (
    card.layout !== 'normal' &&
    card.layout !== 'adventure' &&
    card.layout !== 'omen' &&
    pathwayLand === null &&
    mdfcLandFace === null &&
    transformBack === null
  ) {
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
  const additionalCountersOnEntry: { affects: Selector; counter: string; count: Value }[] = [];
  const ruleStatics: RuleStatic[] = [];
  const entersWithCounters: Record<string, number | Value> = {};
  let cantBlock = false;
  let entersTapped = false;
  let entersTappedUnless: Condition | undefined;
  let tokenCreationReplacement: TokenSpec | undefined;
  let chosenCreatureType = false;
  let ward: ParsedManaCost | undefined;
  let protectionFrom: Color[] | undefined;
  let spellCantBeCountered = false;
  const spellAdditionalCosts: AbilityCost[] = [];
  let commanderFreeCast = false;
  let spellModes: NonNullable<Ability['modes']> | undefined;
  let announcesX = false;
  let castFromGraveyard = false;
  let optionalAdditionalCost: CardDefinition['optionalAdditionalCost'];
  let morphCost: ParsedManaCost | undefined;
  let alternativeCasts: import('./ability').AlternativeCast[] | undefined =
    mdfcLandFace === null ? undefined : [mdfcLandFace];

  if (card.name === 'Dragon Tempest') {
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
        addWard: { kind: 'mana', cost: manaCost('{4}') },
      },
      condition: { kind: 'isUntapped' },
    });
    triggers.push(
      triggered(onCombatDamageToPlayer(), {
        effects: [
          { op: 'draw', count: constant(1) },
          { op: 'drawUpTo', count: 3 },
        ],
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
            {
              description: 'Return nonland permanents <= 6 total MV',
              effects: [{ op: 'bounceUpTo6MV' }],
            },
            {
              description: 'Mill 6 and return up to 2 spells from graveyard',
              effects: [{ op: 'millAndReturnSpells' }],
            },
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
    // Morophon, the Boundless is no longer bespoke. Its two "of the chosen type" lines used to be
    // hardcoded to Dragon (correct only in the Ur-Dragon fixture deck it was written for); the
    // generic grammar now reads them as `chosenSubtype` against the type actually chosen as it
    // entered, which is what the card says.
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
        effects: [
          { op: 'searchLibrary', filter: ofSubtype('Dragon'), destinations: [{ zone: 'hand' }] },
        ],
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
    // "Dragon spells you cast cost {1} less to cast." now parses generically (the per-line loop
    // below), so it is no longer hand-pushed here.
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
      triggered(
        whenPermanent('dealsCombatDamageToPlayer', allOf(ofSubtype('Dragon'), YOURS), {
          aggregate: true,
        }),
        {
          effects: [{ op: 'noOp' }],
          description: 'Combat damage look top 3',
        },
      ),
    );
    reasons.length = 0;
  }

  const isSpell = card.types.includes('Instant') || card.types.includes('Sorcery');
  const frontName =
    card.layout === 'transform' ? (card.name.split(' // ')[0] ?? card.name) : card.name;
  const text = substituteSelfName(stripReminderText(card.oracleText), frontName);

  // Whole-card block patterns that only mean something read together: a modal spell's mode
  // choice (CR 601.2b) and Stubborn Denial's Ferocious clause, which shares line 1's target
  // rather than declaring one of its own. Tried before the per-line loop, which would otherwise
  // allocate each line its own disconnected target slot.
  let spellBlockHandled = false;
  if (isSpell) {
    const spellBlockHasTrailingRebound = /\nrebound\.?$/i.test(text.trim());
    const spellBlockText = spellBlockHasTrailingRebound
      ? text.trim().replace(/\nrebound\.?$/i, '')
      : text;
    const libraryBlock = parseLookAtTopBlock(spellBlockText.toLowerCase(), card);
    if (libraryBlock !== null) {
      spellEffects.push(...libraryBlock);
      spellBlockHandled = true;
    }
    if (!spellBlockHandled) {
      const spree = parseSpreeSpellBlock(spellBlockText, card);
      const modal = spree ?? parseModalSpellBlock(spellBlockText, card);
      if (modal !== null) {
        spellTargets.push(...modal.targets);
        spellModes = modal.modes;
        spellBlockHandled = true;
      } else {
        const ferocious = parseCounterUnlessFerociousBlock(spellBlockText, card);
        if (ferocious !== null) {
          spellTargets.push(...ferocious.targets);
          spellEffects.push(...ferocious.effects);
          spellBlockHandled = true;
        } else {
          const wholeSpell =
            parseTargetThenUntapBlock(spellBlockText, card) ??
            parseBlinkSpellBlock(spellBlockText) ??
            parseKeywordCountSpellBlock(spellBlockText) ??
            parseHuntersInsightBlock(spellBlockText, card) ??
            parseRemoveAndControllerSearchBlock(spellBlockText, card) ??
            parseCounterAndCreateTokenBlock(spellBlockText, card) ??
            parseDestroyAndCreateTokenBlock(spellBlockText, card) ??
            parseReanimateBlock(spellBlockText, card) ??
            parseDestroyThenLoseLifeEqualToManaValueBlock(spellBlockText, card) ??
            parseLivingDeathBlock(spellBlockText) ??
            parseVictimizeBlock(spellBlockText);
          if (wholeSpell !== null) {
            spellTargets.push(...wholeSpell.targets);
            spellEffects.push(...wholeSpell.effects);
            spellBlockHandled = true;
          }
        }
      }
      if (spellBlockHandled && spellBlockHasTrailingRebound && !keywords.includes('rebound')) {
        keywords.push('rebound');
      }
    }
  }
  const registeredOverride = getOverride(card.oracleId);
  const genericLabelStripAllowed =
    registeredOverride === undefined || Object.keys(registeredOverride.def).length === 0;
  const rawLines = text.split('\n');
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const rawLine = rawLines[lineIndex] as string;
    if (spellBlockHandled) break;
    const originalLine = rawLine.trim();
    const knownAbilityWordStripped = stripAbilityWord(originalLine);
    const reasonLine =
      knownAbilityWordStripped === originalLine ? originalLine : knownAbilityWordStripped;
    const line = genericLabelStripAllowed
      ? stripGenericAbilityLabel(knownAbilityWordStripped)
      : knownAbilityWordStripped;
    if (line.length === 0) continue;
    const lower = line.toLowerCase().replace(/\.$/, '');
    // "You may cast this card from your graveyard." (Their Number Is Legion): the card's own
    // permission to be cast from there for its normal costs.
    if (lower === 'you may cast this card from your graveyard' && isSpell) {
      castFromGraveyard = true;
      continue;
    }
    // "You may cast this card from your graveyard by paying {2}{W} rather than paying its mana
    // cost" (Raffine's Guidance): a graveyard alternative cost with no flashback exile, so the
    // card returns to the graveyard (or stays on the battlefield) and can be cast this way again.
    {
      const recast = lower.match(
        /^you may cast this card from your graveyard by paying ((?:\{[^}]+\})+) rather than paying its mana cost$/,
      );
      const cost =
        recast === null ? null : parseManaCost((recast[1] as string).toUpperCase() as never).cost;
      if (cost !== null) {
        if (alternativeCasts === undefined) alternativeCasts = [];
        alternativeCasts.push({
          kind: 'nonMana',
          from: 'graveyard',
          manaCost: cost,
          description: line,
        });
        continue;
      }
    }
    // "Flashback—Sacrifice three creatures" (Dread Return): a flashback cost with no mana at all.
    {
      const nonManaFlashback = lower.match(/^flashback[\u2014\u2013-]\s*([^{].*)$/);
      const costs =
        nonManaFlashback === null
          ? null
          : parseGraveyardAlternativeCosts(nonManaFlashback[1] as string);
      if (costs !== null && costs.every((cost) => cost.kind !== 'mana')) {
        if (alternativeCasts === undefined) alternativeCasts = [];
        alternativeCasts.push({
          kind: 'nonMana',
          from: 'graveyard',
          manaCost: emptyCost(),
          costs,
          exileOnResolution: true,
          description: line,
        });
        continue;
      }
    }
    {
      const graveyardAlternative = lower.match(
        /^(flashback|escape)(?:\s+|[\u2014\u2013-])((?:\{[^}]+\})+)(?:,\s*(.+))?$/,
      );
      if (graveyardAlternative !== null) {
        const cost = parseManaCost((graveyardAlternative[2] as string).toUpperCase() as never);
        const additionalCosts =
          graveyardAlternative[3] === undefined
            ? []
            : parseGraveyardAlternativeCosts(graveyardAlternative[3] as string);
        if (cost.cost !== null && additionalCosts !== null) {
          if (alternativeCasts === undefined) alternativeCasts = [];
          alternativeCasts.push(
            graveyardAlternativeCost(graveyardAlternative[1] as 'flashback' | 'escape', cost.cost, {
              description: line,
              ...(additionalCosts.length > 0 ? { costs: additionalCosts } : {}),
            }),
          );
          continue;
        }
      }
    }
    if (isSpell) {
      const additionalCosts = parseSpellAdditionalCost(lower);
      if (additionalCosts !== null) {
        spellAdditionalCosts.push(...additionalCosts);
        if (
          card.manaCost?.includes('{X}') !== true &&
          additionalCosts.some(
            (cost) => cost.kind === 'payLifeValue' && cost.amount.kind === 'xValue',
          )
        ) {
          announcesX = true;
        }
        continue;
      }
      const alternativeCosts = parseNonManaAlternativeCost(lower, card);
      if (alternativeCosts !== null) {
        if (alternativeCasts === undefined) alternativeCasts = [];
        alternativeCasts.push({
          kind: 'nonMana',
          manaCost: alternativeCosts.manaCost ?? parseManaCost('{0}').cost!,
          ...(alternativeCosts.costs.length > 0 ? { costs: alternativeCosts.costs } : {}),
          ...(alternativeCosts.condition !== undefined
            ? { condition: alternativeCosts.condition }
            : {}),
          description: line,
        });
        continue;
      }
    }
    if (lower === 'station') {
      activatedAbilities.push({
        costs: [
          {
            kind: 'tapOther',
            selector: allOf(OTHER, YOURS, ofType('Creature')),
            capturePowerForStation: true,
          },
        ],
        timing: 'sorcery',
        ability: {
          kind: 'activated',
          targets: [],
          effects: [
            {
              op: 'putCountersEach',
              selector: SELF,
              counter: 'charge',
              count: { kind: 'stationPower' },
            },
          ],
          description: 'Station',
        },
      });
      continue;
    }
    {
      const tier = line.match(/^(\d+)\+\s*\|\s*(.+)$/);
      if (tier !== null) {
        const threshold: Condition = {
          kind: 'hasCounters',
          selector: SELF,
          counter: 'charge',
          cmp: '>=',
          n: Number(tier[1]),
        };
        const tierText = tier[2] as string;
        const tierKeywords = parseKeywordLine(tierText.toLowerCase().replace(/\.$/, ''));
        if (
          tierKeywords !== null &&
          tierKeywords.ward === undefined &&
          tierKeywords.protectionFrom === undefined
        ) {
          for (const keyword of tierKeywords.keywords)
            staticEffects.push({
              affects: SELF,
              op: { layer: 6, addKeyword: keyword },
              condition: threshold,
            });
          continue;
        }
        const tierTriggers = parseTriggerLine(tierText, card);
        if (tierTriggers !== null) {
          for (const ability of tierTriggers) {
            if (ability.trigger !== undefined) {
              ability.trigger = {
                ...ability.trigger,
                condition:
                  ability.trigger.condition === undefined
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
    if (
      lower === '~ can be your commander' ||
      lower === 'sivitri, dragon master can be your commander'
    ) {
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
                condition: {
                  kind: 'totalCreaturePower',
                  scope: 'you',
                  cmp: '>=',
                  n: Number(mosswort[1]),
                },
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

    // Persist and undying (CR 702.79a, 702.93a): each is a dies trigger with an intervening-if
    // read from the permanent's last-known counters, returning the card it became.
    if (lower === 'persist' || lower === 'undying') {
      const counter = lower === 'persist' ? '-1/-1' : '+1/+1';
      triggers.push(
        triggered(onDies(), {
          condition: { kind: 'sourceHasCounters', counter, cmp: '<=', n: 0 },
          effects: [{ op: 'returnDiedSourceToBattlefield', counter }],
          description: lower === 'persist' ? 'Persist' : 'Undying',
        }),
      );
      continue;
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
      const mana = parseManaAbilityLines(lower, card);
      if (mana !== null) {
        manaAbilities.push(...mana);
        continue;
      }
      // Only judge production once the COST half really is a cost. Otherwise a line that
      // merely quotes an ability (`Lands you control have "{T}: Add â€¦"`) splits at the wrong
      // colon and gets rejected here before the static-ability parse ever sees it.
      const split = splitActivation(lower);
      if (
        split !== null &&
        parseActivationCosts(split.costText, card) !== null &&
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
    // Static replacement effects that add counters to other permanents as they enter.
    {
      const fixedAdditional = lower.match(
        /^each (.+) enters with an additional ([+-][0-9]+[/][+-][0-9]+) counter on (?:it|them)$/,
      );
      if (fixedAdditional !== null) {
        const affects = parseSubject(fixedAdditional[1] as string, card);
        if (affects !== null) {
          additionalCountersOnEntry.push({
            affects,
            counter: fixedAdditional[2] as string,
            count: constant(1),
          });
          continue;
        }
      }
      const arwen = lower.match(
        /^each (.+) enters with a number of additional ([+-][0-9]+[/][+-][0-9]+) counters? on (?:it|them) equal to (.+)$/,
      );
      if (arwen !== null) {
        const affects = parseSubject(arwen[1] as string, card);
        const count = parseDynamicCountValue(arwen[3] as string, card);
        if (affects !== null && count !== null) {
          additionalCountersOnEntry.push({ affects, counter: arwen[2] as string, count });
          continue;
        }
      }
      const gev = lower.match(
        /^other (.+) enter with an additional ([+-][0-9]+[/][+-][0-9]+) counter on them for each opponent who lost life this turn$/,
      );
      if (gev !== null) {
        const affects = parseSubject('other ' + (gev[1] as string), card);
        if (affects !== null) {
          additionalCountersOnEntry.push({
            affects,
            counter: gev[2] as string,
            count: { kind: 'opponentsLostLifeThisTurn' },
          });
          continue;
        }
      }
    }
    // 3a-bis. "As this artifact enters, choose a creature type." (Cavern of Souls, Herald's Horn,
    //     Patchwork Banner) - an as-enters CHOICE (CR 614.1c), not a trigger, so the type is
    //     recorded before anything can read it back. The domain is computed at entry rather than
    //     printed here; see `creatureTypeChoicesFor`.
    if (
      /^as (?:~|this (?:artifact|creature|enchantment|land|permanent)) enters, choose a creature type$/.test(
        lower,
      )
    ) {
      chosenCreatureType = true;
      continue;
    }
    // 3b. "~ enters with three +1/+1 counters on it" â€” a replacement effect (CR 614.1c),
    //     applied in `makePermanent`, never a trigger. See `CardDefinition.entersWithCounters`.
    {
      const m = lower.match(
        // A NAMED counter ("four ice counters") is as valid here as a P/T one: `entersWithCounters`
        // is keyed by counter name, and `makePermanent` applies whatever it finds.
        /^~ enters (?:the battlefield )?with (\w+) ([+-]\d+\/[+-]\d+|[a-z]+) counters? on it$/,
      );
      if (m) {
        const count = parseCountPhrase(m[1] as string);
        if (count !== null) {
          const counter = m[2] as string;
          const previous = entersWithCounters[counter];
          if (previous === undefined) {
            entersWithCounters[counter] = count.kind === 'const' ? count.n : count;
          } else if (typeof previous === 'number' && count.kind === 'const') {
            entersWithCounters[counter] = previous + count.n;
          } else {
            reasons.push('multiple dynamic entry-counter replacements for ' + counter);
          }
          continue;
        }
      }
      // "~ enters with a +1/+1 counter on it for each creature that died this turn" (Sautekh
      // Immortal): the same replacement, counted as it enters.
      const forEach = lower.match(
        /^~ enters (?:the battlefield )?with (\w+) ([+-][0-9]+[/][+-][0-9]+) counters? on it for each (.+)$/,
      );
      if (forEach !== null && entersWithCounters[forEach[2] as string] === undefined) {
        const per = parseCountPhrase(forEach[1] as string);
        // "creature that died this turn" is the state-level tally of creatures put into a
        // graveyard from the battlefield this turn (CR 700.4), whoever controlled them.
        const count: Value | null =
          forEach[3] === 'creature that died this turn'
            ? { kind: 'creaturesDiedThisTurn' }
            : parseDynamicCountValue('the number of ' + (forEach[3] as string), card);
        if (per !== null && per.kind === 'const' && count !== null) {
          entersWithCounters[forEach[2] as string] =
            per.n === 1 ? count : { kind: 'times', of: count, n: per.n };
          continue;
        }
      }
      const dynamic = lower.match(
        /^~ enters (?:the battlefield )?with (?:a number of )?([+-][0-9]+[/][+-][0-9]+) counters? on it equal to (.+)$/,
      );
      if (dynamic !== null) {
        const count = parseDynamicCountValue(dynamic[2] as string, card);
        if (count !== null) {
          entersWithCounters[dynamic[1] as string] = count;
          continue;
        }
      }
    }
    if (
      lower ===
      'if one or more creature tokens would be created under your control, those tokens plus a 1/1 white soldier creature token are created instead'
    ) {
      tokenCreationReplacement = SOLDIER_1_1;
      continue;
    }
    if (lower === 'you have no maximum hand size') {
      ruleStatics.push({ kind: 'noMaximumHandSize' });
      continue;
    } // 4. A triggered ability.
    {
      let triggerText = line;
      let triggerEnd = lineIndex;
      const lowerLine = line.toLowerCase();
      const modalHeader = [
        'choose up to one',
        'choose one',
        'choose one or more',
        'choose one or both',
        'choose any number',
        'choose two',
        'choose three',
      ].some((header) => lowerLine.includes(header));
      if (
        modalHeader &&
        (rawLines[lineIndex + 1] as string | undefined)
          ?.trimStart()
          .startsWith(String.fromCharCode(8226)) === true
      ) {
        const blockLines = [line];
        let next = lineIndex + 1;
        while (
          next < rawLines.length &&
          (rawLines[next] as string).trimStart().startsWith(String.fromCharCode(8226))
        ) {
          blockLines.push((rawLines[next] as string).trim());
          triggerEnd = next;
          next += 1;
        }
        if (triggerEnd > lineIndex) triggerText = blockLines.join(String.fromCharCode(10));
      }
      const parsed = parseTriggerLine(triggerText, card);
      if (parsed !== null) {
        triggers.push(...parsed);
        lineIndex = triggerEnd;
        continue;
      }
    }
    // 4b. A continuous static ability / CDA (ADR 0005). These specific patterns will move to
    //     the authored-override registry; here they prove the layer engine end-to-end.
    // "~ can't block." — the printed characteristic `combat.ts` checks on the permanent.
    if (lower === "~ can't block") {
      cantBlock = true;
      continue;
    }
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
    // Outlast is a sorcery-speed tap ability whose effect is always one +1/+1 counter on self.
    {
      const m = lower.match(/^outlast ((?:\{[^}]+\})+)$/);
      if (m !== null) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null && cost.unsupportedSymbols.length === 0) {
          activatedAbilities.push({
            costs: [{ kind: 'mana', cost: cost.cost }, { kind: 'tap' }],
            timing: 'sorcery',
            ability: {
              kind: 'activated',
              targets: [],
              effects: [
                { op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: constant(1) },
              ],
              description: line,
            },
          });
          continue;
        }
      }
    }
    // Equip commander is Equip with a commander-only target restriction.
    {
      const m = lower.match(/^equip commander ((?:\{[^}]+\})+)$/);
      if (m !== null) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null && cost.unsupportedSymbols.length === 0) {
          activatedAbilities.push({
            costs: [{ kind: 'mana', cost: cost.cost }],
            timing: 'sorcery',
            ability: {
              kind: 'activated',
              targets: [{ kind: 'creature', controller: 'you', filter: IS_COMMANDER }],
              effects: [{ op: 'attachSelfTo', target: 0 }],
              description: line,
            },
          });
          continue;
        }
      }
    } // 4b2. Equip (CR 702.6) â€” "Equip {2}" is a sorcery-speed activated ability that attaches
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
        const typeOrSubtype = m[1] as string;
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
              // CR 702.29a: typecycling's search reveals the found card. A search for a card
              // with a stated quality may always find nothing (CR 701.19b).
              effects: [
                {
                  op: 'searchLibrary',
                  filter,
                  destinations: [{ zone: 'hand' }],
                  reveal: true,
                  allowFailToFind: true,
                },
                { op: 'shuffle' },
              ],
              description: line,
            },
          });
          continue;
        }
      }
    }
    /*
     * KICKER IS DELIBERATELY NOT PARSED - it falls through to `unrecognized rules text`.
     *
     * `{ kind: 'kicker' }` (see `rule-statics.ts`) used to be pushed here, but nothing ever
     * consumed it: no cast path offers the optional cost, and `EnginePermanent.kicked` /
     * `wasKicked` are never assigned, so the `wasKicked` Condition is ALWAYS false. Every
     * "if this spell was kicked" clause silently took the not-kicked branch while the card
     * reported `modeled: true` - a failure no coverage metric can see, because a card that is
     * modeled and does nothing looks exactly like a card that works.
     *
     * The `RuleStatic` member, the state fields and the Condition are kept: they are the right
     * shape for a real implementation. Kicker is a full additional-cost mechanic - an
     * announcement-time choice (CR 601.2b), multikicker's repeatable payment, and {X} kicker -
     * and belongs with the other cost-bearing keywords in
     * `docs/plans/post-tier3-card-coverage.md`, not with a one-line parse.
     */
    // "Morph {B}" (CR 702.37): cast face down as a 2/2 for {3} (`castFaceDown`), and turn it
    // face up any time you have priority by paying this cost (`turnFaceUp`).
    {
      const m = lower.match(/^morph ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null && cost.unsupportedSymbols.length === 0) {
          morphCost = cost.cost;
          continue;
        }
      }
    }
    // "Replicate {2}" (CR 702.56a): an additional cost payable any number of times, and a cast
    // trigger copying the spell once per payment (`queueKeywordCastTriggers`).
    {
      const m = lower.match(/^replicate ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null && cost.unsupportedSymbols.length === 0) {
          optionalAdditionalCost = { mechanic: 'replicate', cost: cost.cost, repeatable: true };
          continue;
        }
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
      let activatedText = line;
      let activatedEnd = lineIndex;
      const lowerLine = line.toLowerCase();
      const modalHeader = [
        'choose up to one',
        'choose one',
        'choose one or more',
        'choose one or both',
        'choose any number',
        'choose two',
        'choose three',
      ].some((header) => lowerLine.includes(header));
      if (
        modalHeader &&
        (rawLines[lineIndex + 1] as string | undefined)
          ?.trimStart()
          .startsWith(String.fromCharCode(8226)) === true
      ) {
        const blockLines = [line];
        let next = lineIndex + 1;
        while (
          next < rawLines.length &&
          (rawLines[next] as string).trimStart().startsWith(String.fromCharCode(8226))
        ) {
          blockLines.push((rawLines[next] as string).trim());
          activatedEnd = next;
          next += 1;
        }
        if (activatedEnd > lineIndex) activatedText = blockLines.join(String.fromCharCode(10));
      }
      // "This ability costs {1} less to activate for each legendary creature you control."
      // (Boseiju, Otawara) - a scaling ACTIVATION discount printed as the ability's last
      // sentence. Stripped here rather than inside `parseActivatedLine`, because it is a
      // card-level `RuleStatic`, not part of the ability it trails.
      let activationDiscount: RuleStatic | null = null;
      const discount = activatedText.match(
        /^([\s\S]+?)\. this ability costs \{(\d+)\} less to activate for each (.+?)\.?$/i,
      );
      if (discount !== null) {
        const selector = parseSubject((discount[3] as string).toLowerCase(), card);
        if (selector !== null) {
          activationDiscount = {
            kind: 'costReduction',
            appliesTo: 'activate',
            selfOnly: true,
            amount: { kind: 'countPermanents', selector, scope: 'you' },
          };
          activatedText = discount[1] as string;
        }
      }
      const activated = parseActivatedLine(activatedText, card);
      if (activated !== null) {
        // "Boast — [Cost]: [Effect]" adds "Activate only if this creature attacked this turn and
        // only once each turn" (CR 702.142a). The label itself was stripped as a generic label.
        if (/^boast\s+[—–-]\s+/i.test(originalLine)) {
          activated.requiresAttackedThisTurn = true;
          activated.oncePerTurn = true;
          activated.boast = true;
        }
        activatedAbilities.push(activated);
        if (activationDiscount !== null) ruleStatics.push(activationDiscount);
        lineIndex = activatedEnd;
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
    // "If you control a commander, you may cast this spell without paying its mana cost."
    // (Flawless Maneuver, Deadly Rollick, Fierce Guardianship, Deflecting Swat) â€” a property of
    // the cast action (CR 601.2f), so it's a top-level flag alongside `spellCantBeCountered`
    // rather than a `spellAbility` effect.
    if (
      lower === 'if you control a commander, you may cast this spell without paying its mana cost'
    ) {
      commanderFreeCast = true;
      continue;
    }
    // 5. Spell effect sentences (instants/sorceries only). Parse into a scratch slot list
    //    (based at the current spell slot count) so a partially-parsing line allocates no
    //    slots; merge only when the whole line parses.
    if (isSpell) {
      if (
        lower ===
        "counter target spell. at the beginning of your next main phase, add an amount of {c} equal to that spell's mana value"
      ) {
        const target = spellTargets.length;
        spellTargets.push(counterSpellTarget());
        spellEffects.push({ op: 'counter', target, addManaAtNextMainPhase: true });
        continue;
      }
      if (
        lower ===
        "counter target noncreature spell. if that spell is countered this way, exile it instead of putting it into its owner's graveyard"
      ) {
        const target = spellTargets.length;
        spellTargets.push(counterSpellTarget('noncreatureSpell'));
        spellEffects.push({ op: 'counter', target, exileIfCountered: true });
        continue;
      }
      const counterAndKeyword = lower.match(
        /^put (\w+) ([+-]\d+\/[+-]\d+) counters? on target creature( you control)?(?:, where x is (.+?))?\. it gains ([a-z ,]+) until end of turn$/,
      );
      if (counterAndKeyword !== null) {
        const count =
          counterAndKeyword[4] === undefined
            ? parseCountPhrase(counterAndKeyword[1] as string)
            : counterAndKeyword[1] === 'x'
              ? parseDynamicCountValue(counterAndKeyword[4] as string, card)
              : null;
        const parsed = parseKeywordLine(counterAndKeyword[5] as string);
        if (
          count !== null &&
          parsed !== null &&
          parsed.ward === undefined &&
          parsed.protectionFrom === undefined
        ) {
          const target = spellTargets.length;
          spellTargets.push({
            kind: 'creature',
            ...(counterAndKeyword[3] === undefined ? {} : { controller: 'you' as const }),
          });
          spellEffects.push(
            {
              op: 'putCounters',
              target,
              counter: counterAndKeyword[2] as string,
              count,
            },
            ...parsed.keywords.map((keyword): Effect => ({
              op: 'grantKeywordUntilEot',
              target,
              keyword,
            })),
          );
          continue;
        }
      }
      if (
        lower ===
        'put a +1/+1 counter on target creature. it gains indestructible until end of turn'
      ) {
        const target = spellTargets.length;
        spellTargets.push({ kind: 'creature' });
        spellEffects.push(
          { op: 'putCounters', target, counter: '+1/+1', count: constant(1) },
          { op: 'grantKeywordUntilEot', target, keyword: 'indestructible' },
        );
        continue;
      }
      // The look-at-top-N block is multi-SENTENCE but single-LINE ("…put them back in any
      // order. You may shuffle."), so it has to be tried before `splitSentences` cuts it up —
      // its later sentences say "them"/"the rest", which mean nothing on their own. The
      // whole-card attempt above only fires when the block IS the entire card; Ponder prints
      // "Draw a card." on a second line, which is what brings it here.
      const lineLibraryBlock = parseLookAtTopBlock(lower, card);
      if (lineLibraryBlock !== null) {
        spellEffects.push(...lineLibraryBlock);
        continue;
      }
      const sentences = splitSentences(line);
      const lineEffects: Effect[] = [];
      const lineTargets: TargetSpec[] = [];
      const base = spellTargets.length;
      const lineAlloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
        lineTargets.push(
          kind === 'cardInGraveyard'
            ? graveyardCardTarget(
                graveyardOwnerScope ?? 'controller',
                filter === undefined ? {} : { filter },
              )
            : {
                kind,
                ...(filter !== undefined ? { filter } : {}),
                ...(controller !== undefined ? { controller } : {}),
              },
        );
        return base + lineTargets.length - 1;
      };
      let allParsed = sentences.length > 0;
      for (const sentence of sentences) {
        const parsed = parseEffectSentence(sentence, lineAlloc, card);
        if (parsed === null) {
          allParsed = false;
          break;
        }
        appendSentenceEffects(lineEffects, sentence, parsed);
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
  if (
    keywords.includes('convoke' as KeywordAbility) &&
    !ruleStatics.some((r) => r.kind === 'convoke')
  ) {
    ruleStatics.push({ kind: 'convoke' });
  }
  if (
    keywords.includes('improvise' as KeywordAbility) &&
    !ruleStatics.some((r) => r.kind === 'improvise')
  ) {
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
  // A recognized Pathway-shaped land overrides whatever the per-line loop derived from the
  // FRONT face alone (a plain fixed-color mana ability â€” correct as far as it goes, but missing
  // the back face's color entirely) with the dynamic, choice-aware version.
  if (pathwayLand !== null) {
    manaAbilities.length = 0;
    manaAbilities.push(...pathwayLand.manaAbilities);
  }
  // An authored override may implement lines the grammar cannot read (ADR 0010). It clears
  // only the specific reasons it names, so an errata'd card re-opens loudly rather than
  // silently keeping stale behavior â€” see `overrides/index.ts`.
  const definition = enforceInterpretedDefinition(
    applyOverride({
      oracleId: card.oracleId,
      scryfallId: card.scryfallId,
      name: frontName,
      typeLine: card.typeLine,
      supertypes: card.supertypes,
      types: card.types,
      subtypes: card.subtypes,
      colors: card.colors,
      colorIdentity: card.colorIdentity,
      // CR 118.6: absence of a printed mana cost is an unpayable cost, distinct from {0}.
      manaCost:
        isLandCard || card.manaCost === null || card.manaCost === '' ? null : costResult.cost,
      hasUnsupportedCost: costResult.unsupportedSymbols.length > 0,
      power,
      toughness,
      loyalty,
      defense,
      ...(transformBack !== null ? { backFace: transformBack.backFace } : {}),
      keywords,
      ...(ward !== undefined ? { ward: { kind: 'mana' as const, cost: ward } } : {}),
      ...(protectionFrom !== undefined ? { protectionFrom } : {}),
      manaAbilities,
      activatedAbilities,
      entersTapped,
      ...(entersTappedUnless !== undefined ? { entersTappedUnless } : {}),
      ...(Object.keys(entersWithCounters).length > 0 ? { entersWithCounters } : {}),
      ...(additionalCountersOnEntry.length > 0 ? { additionalCountersOnEntry } : {}),
      ...(tokenCreationReplacement !== undefined ? { tokenCreationReplacement } : {}),
      ...(pathwayLand !== null
        ? { entersChoosingOption: pathwayLand.entersChoosingOption }
        : chosenCreatureType
          ? {
              entersChoosingOption: {
                prompt: 'choose a creature type',
                domain: 'creatureType' as const,
              },
            }
          : {}),
      spellAbility:
        (isSpell && (spellEffects.length > 0 || spellModes !== undefined)) ||
        (card.subtypes.includes('Aura') && spellTargets.length > 0)
          ? {
              kind: 'spell',
              targets: spellTargets,
              effects: spellEffects,
              ...(spellModes !== undefined ? { modes: spellModes } : {}),
              ...(spellCantBeCountered ? { cantBeCountered: true } : {}),
            }
          : null,
      ...(spellCantBeCountered ? { spellCantBeCountered: true } : {}),
      ...(commanderFreeCast ? { commanderFreeCast: true } : {}),
      ...(spellAdditionalCosts.length > 0 ? { spellAdditionalCosts } : {}),
      triggers,
      staticEffects,
      ruleStatics,
      ...(alternativeCasts ? { alternativeCasts } : {}),
      ...(cantBlock ? { cantBlock: true } : {}),
      ...(castFromGraveyard ? { castFromGraveyard: true as const } : {}),
      ...(announcesX ? { announcesX: true } : {}),
      ...(optionalAdditionalCost !== undefined ? { optionalAdditionalCost } : {}),
      ...(morphCost !== undefined ? { morphCost } : {}),
      modeled: reasons.length === 0,
      unmodeledReasons: reasons,
    }),
  );
  if (!definition.modeled || (card.layout !== 'adventure' && card.layout !== 'omen'))
    return definition;
  const face = interpretSecondFace(card);
  if (
    face === null ||
    !face.modeled ||
    face.manaCost === null ||
    face.types.length !== 1 ||
    !face.types.some((type) => type === 'Instant' || type === 'Sorcery') ||
    !face.subtypes.some((type) => type === 'Adventure' || type === 'Omen') ||
    face.spellAbility === null
  ) {
    return {
      ...definition,
      modeled: false,
      unmodeledReasons: [
        ...definition.unmodeledReasons,
        ...(face?.unmodeledReasons.length
          ? face.unmodeledReasons.map((reason) => `${card.backFace!.name}: ${reason}`)
          : ['missing or unsupported executable spell face']),
      ],
    };
  }
  const faceKind = face.subtypes.includes('Omen') ? 'omen' : 'adventure';
  return enforceInterpretedDefinition({
    ...definition,
    alternativeCasts: [
      ...(definition.alternativeCasts ?? []).filter(
        (alt) => alt.kind !== 'adventure' && alt.kind !== 'omen',
      ),
      {
        kind: faceKind,
        manaCost: face.manaCost,
        name: face.name,
        typeLine: face.typeLine,
        description: face.name,
        ability: face.spellAbility,
        spellFace: face,
      },
    ],
  });
}
