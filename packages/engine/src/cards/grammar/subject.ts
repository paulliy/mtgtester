/**
 * Subject, target and filter phrases for the card grammar (ADR 0038): the noun phrases that pick
 * out objects. "creatures you control", "a Dragon you control", "target nonland permanent",
 * "a basic land card", "an instant or sorcery spell". Each parser returns a `Selector` (or a
 * target slot) or null, and null leaves the card unmodeled.
 */

import type { Color, OracleCard } from '@mtg/shared';
import type { TargetKind, TargetSpec } from '../ability';
import {
  CARD_TYPE_PLURALS,
  CARD_TYPE_SINGULARS,
  COLOR_WORDS,
  KEYWORD_SET,
  LAND_SUBTYPES,
  resolveSubtype,
  titleCase,
} from './words';
import type { Selector } from '../selector';
import {
  CHOSEN_SUBTYPE,
  IS_ENCHANTED,
  IS_EQUIPPED,
  IS_MONOCOLORED,
  IS_TOKEN,
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
} from '../selector';
import { PERMANENT_CARD_TYPES } from '../definition';
import { noteSlotFailure } from './diagnostics';

/**
 * Allocates a target slot of the given kind and returns its index (ADR 0004). `filter` further
 * restricts a zone-qualified kind (`cardInGraveyard`) — "target Dragon permanent card".
 */
export type SlotAllocator = (
  kind: TargetKind,
  filter?: Selector,
  controller?: TargetSpec['controller'],
  graveyardOwnerScope?: TargetSpec['graveyardOwnerScope'],
) => number;

/**
 * Allocates a variable-COUNT target slot ("up to two other targets", "any number of target
 * creatures") and returns its index. Only offered where a variable count actually means
 * something — inside a triggered ability's own target list (`parseTriggerLine`) — because a
 * cast spell's targets are all chosen in the same option-menu step {X} already uses, which has
 * no room for a decision sequence.
 */
export type CountSlotAllocator = (
  kind: TargetKind,
  count: { min: number; max: number },
  controller?: TargetSpec['controller'],
  filter?: Selector,
) => number;

/**
 * The noun phrase after "target" → a `TargetKind`. Returns null for anything unlisted so the
 * card stays unmodeled rather than being silently retargeted at the wrong thing.
 */
export const TARGET_NOUNS: Record<string, TargetKind> = {
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

/**
 * "Artifact, creature, or planeswalker" / "creature or enchantment" — an arbitrary permanent-type
 * alternation that `TARGET_NOUNS` doesn't special-case. Rather than adding a new `TargetKind`
 * literal (and a new `permanentMatchesKind` branch) for every combination removal spells happen
 * to print — Bedevil, Mortify, Putrefy, Despark's "with mana value N or greater" restriction all
 * want a different subset — this composes the general `permanent` kind (matches everything) with
 * an `anyOf(ofType(...))` filter, which the target-legality code already applies on top of any
 * kind. Two or more comma/"or"-separated single-word type nouns, each a known permanent type;
 * anything else (a card name, a qualifier, a single noun already in `TARGET_NOUNS`) returns null.
 */
export const PERMANENT_TYPE_NOUNS: Record<string, string> = {
  creature: 'Creature',
  artifact: 'Artifact',
  enchantment: 'Enchantment',
  land: 'Land',
  planeswalker: 'Planeswalker',
};

/** Sentinel for "whenever you cast **a spell**" — no filter at all, which is not the same as an
 * unparseable one. Compared by identity, never matched against anything. */
export const ANY_SPELL: Selector = { kind: 'type', value: '*any spell*' };

/**
 * Parse the subject of an anthem — "other Elves you control", "creatures your opponents
 * control" — into a `Selector`. Returns null when any part is unrecognized.
 */
function parseSubjectUntraced(phrase: string, card: OracleCard): Selector | null {
  const parts: Selector[] = [];
  let noun = phrase;

  // "Equipped creature has haste" / "Enchanted creature gets +2/+2" — the subject is whatever
  // the source is currently attached to, which is a relation, not a characteristic. The whole
  // phrase must be that one noun: a lazy anthem match hands over subjects like "enchanted
  // creature can't be blocked and" or "enchanted creature gets +1/+1 for each plains you control
  // and", and reading those as the attached creature silently dropped everything but the trailing
  // keywords (Whispersilk Cloak, Ethereal Armor, On Serra's Wings).
  if (
    /^(equipped|enchanted|fortified) (creature|permanent|land|artifact|enchantment|planeswalker|battle|plains|island|swamp|mountain|forest)$/.test(
      noun,
    )
  )
    return { kind: 'attachedToSource' };
  // "Equipped creatures you control get +1/+1" (Kemba), "Enchanted creatures you control have
  // shroud" (Greater Auramancy): every creature of yours with an Equipment/Aura attached, not
  // the thing this source is attached to.
  {
    const m = noun.match(/^(equipped|enchanted) (creatures you control)$/);
    if (m !== null) {
      const rest = parseSubjectUntraced(m[2] as string, card);
      return rest === null ? null : allOf(m[1] === 'equipped' ? IS_EQUIPPED : IS_ENCHANTED, rest);
    }
  }
  if (/^(equipped|enchanted|fortified) /.test(noun)) return null;

  if (noun.startsWith('each ')) noun = noun.slice('each '.length);
  // "All Sliver creatures get +1/+1" (Muscle Sliver): "all" adds nothing to the subject.
  if (noun.startsWith('all ')) noun = noun.slice('all '.length);

  // "Commander creatures you own have …" (Inspiring Leader and the other Backgrounds, CR 903.3):
  // your commanders that are creatures, wherever control has gone.
  if (noun === 'commander creatures you own')
    return allOf({ kind: 'isCommander' }, ofType('Creature'), { kind: 'owner', who: 'you' });
  // "creatures that are enchanted by an Aura you control" (Killian, Decisive Mentor).
  const enchantedByYours = noun.match(/^(.+) that are enchanted by an aura you control$/);
  if (enchantedByYours !== null) {
    parts.push({ kind: 'enchantedByAuraYouControl' });
    noun = enchantedByYours[1] as string;
  }
  const combat = noun.match(/^(attacking|blocking) (.+)$/);
  if (combat !== null) {
    parts.push({ kind: 'combatRole', role: combat[1] as 'attacking' | 'blocking' });
    noun = combat[2] as string;
  }
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

  // "each other creature you control that's a token or a Rabbit" (Finneas, Ace Archer).
  const tokenOrType = noun.match(/^(.+?) that's a token or an? ([a-z]+)$/);
  if (tokenOrType !== null) {
    parts.push(anyOf(IS_TOKEN, ofSubtype(titleCase(tokenOrType[2] as string))));
    noun = tokenOrType[1] as string;
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

  // "other creatures you control with base power and toughness 1/1" (Bess, Soul Nourisher).
  const baseClause = noun.match(/^(.+) with base power and toughness (\d+)\/(\d+)$/);
  if (baseClause !== null) {
    parts.push({
      kind: 'basePowerToughness',
      power: Number(baseClause[2]),
      toughness: Number(baseClause[3]),
    });
    noun = baseClause[1] as string;
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

  // "creatures you control each with power greater than its base power" (Kutzil).
  const aboveBase = noun.match(
    /^(.+?) (?:each )?with power greater than (?:its|their) base power$/,
  );
  if (aboveBase !== null) {
    parts.push({ kind: 'powerGreaterThanBase' });
    noun = aboveBase[1] as string;
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
  // "non-Human creatures you control" (Return of the Wildspeaker) — a negated tribe, the plural
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
    // "destroy all nonland permanents your opponents control" (Ruinous Ultimatum) — the plural
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
 * The subject of an object trigger — "a Dragon you control", "another creature you control
 * with power 4 or greater" — as a `Selector`. The singular counterpart to `parseSubject`,
 * which reads the plural noun phrases anthems use.
 *
 * Returns null for anything unrecognized, leaving the card unmodeled: a trigger with a subject
 * that silently matches nothing would never fire, which is a misplay every game.
 */
function parseTriggerSubjectUntraced(phrase: string, card: OracleCard): Selector | null {
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

  // "Whenever an enchanted creature dies" (Hateful Eidolon): any creature with an Aura attached,
  // read off the leaving creature's last-known facts.
  if (noun === 'enchanted creature') {
    parts.push(IS_ENCHANTED);
    noun = 'creature';
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
 * The subject of a mass effect — "each creature without flying", "each Dragon you control".
 * Plural `parseSubject` with a singular head, plus the keyword clause only mass effects use.
 */
function parseMassSubjectUntraced(phrase: string, card: OracleCard): Selector | null {
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

  // "destroy all creatures with mana value 3 or less" / "…4 or greater" (Austere Command).
  const manaValueClause = noun.match(/^(.+) with mana value (\d+) or (less|greater)$/i);
  if (manaValueClause !== null) {
    const n = Number(manaValueClause[2]);
    parts.push(
      manaValueClause[3]?.toLowerCase() === 'less' ? manaValueAtMost(n) : manaValueAtLeast(n),
    );
    noun = manaValueClause[1] as string;
  }

  // "…without flying" / "…with flying". Event-only (see `cards/selector.ts`): safe here because
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
 * "Dragon permanent card" / "creature card" / "permanent card" → a `Selector` matching cards in
 * a non-battlefield zone by their PRINTED characteristics (`state/queries.ts::cardZoneCandidate`).
 *
 * Distinct from `parseTriggerSubject`: "permanent" is not a real card type (CR 110), so a bare
 * "permanent card" means "any of the six permanent card types", not a single `ofType`.
 */
function parseCardFilterPhraseUntraced(phrase: string, card: OracleCard): Selector | null {
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

/** "a Plains, Island, Swamp, or Mountain card" / "up to two basic land cards" → a `Selector`. */
function parseSearchFilterUntraced(phrase: string, card: OracleCard): Selector | null {
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
  // "a card" (Demonic Tutor) — unrestricted, not narrowed to permanent types the way
  // `parseCardFilterPhrase`'s bare "card"/"permanent" is for its (zone-restricted) callers.
  // `allOf()` with no operands is vacuously true (CR-accurate: every `every()` over an empty
  // list holds), so it matches any card in the library without a dedicated "match anything"
  // selector kind.
  if (noun === 'card' || noun === 'cards') return allOf();

  // "basic land" — a supertype plus a type, not a subtype.
  if (noun === 'basic land') return allOf(ofSupertype('Basic'), ofType('Land'));
  // "a basic Forest, Island, or Mountain card" (the Landscapes, Riveteers Overlook): a basic land
  // of one of the named basic land types (CR 205.3i).
  {
    const basics = noun.match(/^basic ([a-z]+(?:, [a-z]+)*,? or [a-z]+)$/);
    if (basics !== null) {
      const types = (basics[1] as string).split(/,? or |, /).map(titleCase);
      if (types.every((type) => LAND_SUBTYPES.includes(type)))
        return allOf(ofSupertype('Basic'), anyOf(...types.map(ofSubtype)));
    }
  }

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
 * The spell a `castsSpell` trigger watches — "a Dragon spell", "a creature spell", "a Dragon
 * creature spell".
 *
 * A spell is matched on card characteristics, so this reuses `parseTriggerSubject` after
 * stripping the trailing "spell": "a Dragon spell" and "a Dragon" describe the same
 * characteristics, and only the zone differs.
 */
function parseSpellFilterUntraced(phrase: string, card: OracleCard): Selector | null {
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
  // "Whenever you cast a historic spell" (Jhoira's Familiar): artifacts, legendaries and Sagas
  // are historic (CR 700.6).
  if (noun === 'historic')
    return anyOf(ofType('Artifact'), ofSupertype('Legendary'), ofSubtype('Saga'));
  // "Red spells you cast cost {1} less to cast" (Ruby Medallion): the spell's color (CR 105.2).
  if (COLOR_WORDS[noun] !== undefined) return ofColor(COLOR_WORDS[noun] as Color);
  // "Whenever you cast an Aura spell" (Kor Spiritdancer): the spell's subtype (CR 205.3h).
  if (noun === 'aura') return ofSubtype('Aura');
  // "an instant or sorcery spell" (Archmage Emeritus) / "Instant and sorcery spells" (Goblin
  // Electromancer) — each side is its own card type, not a tribe the way `parseTriggerSubject`'s
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

export function parseTargetNoun(noun: string): TargetKind | null {
  return TARGET_NOUNS[noun.trim()] ?? null;
}

export function parseCompoundPermanentTypeNoun(text: string): Selector | null {
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

function parseTargetClauseUntraced(
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
  // "another target creature you control" (Selfless Savior): any but the ability's source.
  if (cleaned.startsWith('another ')) {
    const rest = parseTargetClauseUntraced(cleaned.slice('another '.length));
    if (rest === null || rest.kind === 'player') return null;
    return {
      kind: rest.kind,
      filter: rest.filter === undefined ? OTHER : allOf(OTHER, rest.filter),
      ...(controller !== undefined
        ? { controller }
        : rest.controller !== undefined
          ? { controller: rest.controller }
          : {}),
    };
  }
  if (cleaned.startsWith('monocolored ')) {
    filter = IS_MONOCOLORED;
    cleaned = cleaned.replace(/^monocolored\s+/, '').trim();
  }

  // "target permanent with mana value 4 or greater" (Despark) / "target nonland permanent with
  // mana value 3 or less" (Abrupt Decay) — the targeted counterpart to `parseMassSubject`'s
  // identical clause for the untargeted "destroy all …" form.
  const manaValueClause = cleaned.match(/^(.+) with mana value (\d+) or (less|greater)$/i);
  if (manaValueClause !== null) {
    const n = Number(manaValueClause[2]);
    const bound =
      manaValueClause[3]?.toLowerCase() === 'less' ? manaValueAtMost(n) : manaValueAtLeast(n);
    filter = filter === undefined ? bound : allOf(filter, bound);
    cleaned = manaValueClause[1] as string;
  }

  // "target opponent": a player slot restricted to the ability controller's opponents, not any
  // player (CR 115.2: an opponent is never yourself).
  if (cleaned === 'opponent' && controller === undefined) controller = 'opponent';
  const kind = parseTargetNoun(cleaned);
  if (kind !== null) {
    return {
      kind,
      ...(filter !== undefined ? { filter } : {}),
      ...(controller !== undefined ? { controller } : {}),
    };
  }

  // Not one of the named single/compound target kinds — try reading it as an arbitrary
  // permanent-type alternation instead (see `parseCompoundPermanentTypeNoun`). `filter` can
  // already hold `IS_MONOCOLORED` from above; combine rather than overwrite.
  const compound = parseCompoundPermanentTypeNoun(cleaned);
  if (compound === null) {
    // EDHREC plan Phase 4 batch 5: a target noun with qualifiers ("nonblack creature",
    // "nonbasic land", "attacking or blocking creature", "Forest", "legendary permanent",
    // "creature with power 4 or greater", "artifact, enchantment, or creature with flying").
    const qualified = parseQualifiedTargetNoun(cleaned);
    if (qualified === null) return null;
    const merged =
      qualified.filter === undefined
        ? filter
        : filter === undefined
          ? qualified.filter
          : allOf(filter, qualified.filter);
    return {
      kind: qualified.kind,
      ...(merged !== undefined ? { filter: merged } : {}),
      ...(controller !== undefined ? { controller } : {}),
    };
  }
  return {
    kind: 'permanent',
    filter: filter === undefined ? compound : allOf(filter, compound),
    ...(controller !== undefined ? { controller } : {}),
  };
}

const QUALIFIER_SUPERTYPES: Record<string, string> = {
  legendary: 'Legendary',
  basic: 'Basic',
  snow: 'Snow',
};

/** One leading word of a target noun as a selector: "nonblack", "legendary", "tapped", "red". */
function parseTargetQualifier(word: string): Selector | null {
  const negated = word.match(/^non-?(.+)$/);
  if (negated !== null) {
    const inner = negated[1] as string;
    if (inner === 'token') return not(IS_TOKEN);
    const color = COLOR_WORDS[inner];
    if (color !== undefined) return not(ofColor(color as Color));
    const supertype = QUALIFIER_SUPERTYPES[inner];
    if (supertype !== undefined) return not(ofSupertype(supertype));
    const type = CARD_TYPE_SINGULARS[inner];
    if (type !== undefined) return not(ofType(type));
    const subtype = resolveSubtype(titleCase(inner), NO_CARD);
    return subtype === null ? null : not(ofSubtype(subtype));
  }
  const color = COLOR_WORDS[word];
  if (color !== undefined) return ofColor(color as Color);
  const supertype = QUALIFIER_SUPERTYPES[word];
  if (supertype !== undefined) return ofSupertype(supertype);
  if (word === 'tapped') return { kind: 'tapped' };
  if (word === 'untapped') return not({ kind: 'tapped' });
  if (word === 'attacking') return { kind: 'combatRole', role: 'attacking' };
  if (word === 'blocking') return { kind: 'combatRole', role: 'blocking' };
  return null;
}

const NO_CARD = { subtypes: [] } as unknown as OracleCard;

function parseQualifiedTargetNoun(text: string): { kind: TargetKind; filter?: Selector } | null {
  // "artifact, enchantment, or creature with flying" (Broken Wings): a trailing "with …" belongs
  // to the last alternative only, so an artifact without flying is still a legal target.
  {
    const list = text.match(/^((?:[a-z]+, )+(?:or )?|[a-z]+ or )([a-z]+) (with .+)$/);
    if (list !== null) {
      const heads = (list[1] as string)
        .replace(/,? or $|, $/, '')
        .split(/, (?:or )?| or /)
        .filter(Boolean);
      const types = [...heads, list[2] as string].map((word) => CARD_TYPE_SINGULARS[word]);
      if (types.some((type) => type === undefined || type === 'Instant' || type === 'Sorcery'))
        return null;
      const last = parseQualifiedTargetNoun(`${list[2] as string} ${list[3] as string}`);
      if (last === null || last.filter === undefined) return null;
      return {
        kind: 'permanent',
        filter: anyOf(
          ...types.slice(0, -1).map((type) => ofType(type as string)),
          allOf(ofType(types.at(-1) as string), last.filter),
        ),
      };
    }
  }
  let rest = text;
  const filters: Selector[] = [];
  // A trailing "with power N or greater/less" or "with <keyword>".
  const power = rest.match(/^(.+) with power (\d+) or (greater|less)$/);
  if (power !== null) {
    const n = Number(power[2]);
    filters.push(power[3] === 'greater' ? powerAtLeast(n) : { kind: 'powerAtMost', n });
    rest = power[1] as string;
  } else {
    const keyword = rest.match(/^(.+) with ([a-z ]+)$/);
    if (keyword !== null && KEYWORD_SET.has(keyword[2] as string)) {
      filters.push(withKeyword(keyword[2] as string));
      rest = keyword[1] as string;
    }
  }
  if (rest.startsWith('attacking or blocking ')) {
    filters.push({ kind: 'inCombat' });
    rest = rest.slice('attacking or blocking '.length);
  }
  // Leading qualifiers, possibly comma-separated ("nonartifact, nonblack creature").
  for (;;) {
    const m = rest.match(/^([a-z-]+),? (.+)$/);
    if (m === null) break;
    const qualifier = parseTargetQualifier(m[1] as string);
    if (qualifier === null) break;
    filters.push(qualifier);
    rest = m[2] as string;
  }
  if (filters.length === 0 && !/^[a-z]+$/.test(rest)) return null;
  let kind = parseTargetNoun(rest);
  if (kind === null) {
    const compound = parseCompoundPermanentTypeNoun(rest);
    if (compound !== null) {
      kind = 'permanent';
      filters.unshift(compound);
    } else {
      // A bare subtype: "target Forest", "target Wizard".
      const subtype = resolveSubtype(titleCase(rest), NO_CARD);
      if (subtype === null) return null;
      kind = 'permanent';
      filters.unshift(ofSubtype(subtype));
    }
  }
  if (kind === 'player' || kind === 'spell' || filters.length === 0) return null;
  return { kind, filter: filters.length === 1 ? (filters[0] as Selector) : allOf(...filters) };
}

/**
 * "(each) other attacking creature(s)" (battle cry): "other" in front of a subject the rest
 * reads, tried only after the subject parser failed.
 */
function parseOtherSubject(phrase: string, card: OracleCard): Selector | null {
  const m = phrase.match(/^(?:each )?other (.+)$/);
  if (m === null) return null;
  const rest = parseSubjectUntraced(m[1] as string, card);
  return rest === null ? null : allOf(OTHER, rest);
}

/** `parseSubjectUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseSubject(
  ...args: Parameters<typeof parseSubjectUntraced>
): ReturnType<typeof parseSubjectUntraced> {
  const result = parseSubjectUntraced(...args) ?? parseOtherSubject(...args);
  if (result === null) noteSlotFailure('subject', args[0]);
  return result;
}

/** `parseTriggerSubjectUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseTriggerSubject(
  ...args: Parameters<typeof parseTriggerSubjectUntraced>
): ReturnType<typeof parseTriggerSubjectUntraced> {
  const result = parseTriggerSubjectUntraced(...args);
  if (result === null) noteSlotFailure('subject', args[0]);
  return result;
}

/** `parseMassSubjectUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseMassSubject(
  ...args: Parameters<typeof parseMassSubjectUntraced>
): ReturnType<typeof parseMassSubjectUntraced> {
  const result = parseMassSubjectUntraced(...args);
  if (result === null) noteSlotFailure('subject', args[0]);
  return result;
}

/** `parseCardFilterPhraseUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseCardFilterPhrase(
  ...args: Parameters<typeof parseCardFilterPhraseUntraced>
): ReturnType<typeof parseCardFilterPhraseUntraced> {
  const result = parseCardFilterPhraseUntraced(...args);
  if (result === null) noteSlotFailure('card filter', args[0]);
  return result;
}

/** `parseSearchFilterUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseSearchFilter(
  ...args: Parameters<typeof parseSearchFilterUntraced>
): ReturnType<typeof parseSearchFilterUntraced> {
  const result = parseSearchFilterUntraced(...args);
  if (result === null) noteSlotFailure('card filter', args[0]);
  return result;
}

/** `parseSpellFilterUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseSpellFilter(
  ...args: Parameters<typeof parseSpellFilterUntraced>
): ReturnType<typeof parseSpellFilterUntraced> {
  const result = parseSpellFilterUntraced(...args);
  if (result === null) noteSlotFailure('spell filter', args[0]);
  return result;
}

/** `parseTargetClauseUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseTargetClause(
  ...args: Parameters<typeof parseTargetClauseUntraced>
): ReturnType<typeof parseTargetClauseUntraced> {
  const result = parseTargetClauseUntraced(...args);
  if (result === null) noteSlotFailure('target', args[0]);
  return result;
}
