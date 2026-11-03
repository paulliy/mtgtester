/**
 * "You may have this creature enter as a copy of any artifact or creature on the battlefield,
 * except it's an artifact in addition to its other types." (Phyrexian Metamorph, Clone, Copy
 * Artifact): the as-enters copy replacement (CR 707.2, 614.1c) and its exceptions, which become
 * part of the copy's copiable values (CR 707.9b), so a copy of the copy has them too.
 *
 * Read here: which permanents may be copied, and three kinds of exception: a card type "in
 * addition to its other types", "it isn't legendary", and an implemented keyword it "has".
 * Anything else (a copied card in a graveyard, a subtype or supertype added, a quoted ability, a
 * mana-spent bound) leaves the line unparsed.
 */
import type { OracleCard } from '@mtg/shared';
import { IMPLEMENTED_KEYWORDS, type KeywordAbility } from '../ability';
import type { CardDefinition } from '../definition';
import type { Selector } from '../selector';
import { OPPONENTS, YOURS, allOf, not, ofSubtype, ofType } from '../selector';
import { noteSlotFailure } from './diagnostics';
import { parseCompoundPermanentTypeNoun, parseTriggerSubject } from './subject';

type EntersAsCopy = NonNullable<CardDefinition['entersAsCopy']>;

const ENTERS_AS_COPY_RE =
  /^you may have (?:~|this (?:creature|artifact|enchantment|land|equipment|vehicle|permanent)) enter (?:the battlefield )?as a copy of (?:any |an? )(.+?)(?:, except (.+))?$/;

const CARD_TYPES: Record<string, string> = {
  artifact: 'Artifact',
  creature: 'Creature',
  enchantment: 'Enchantment',
  land: 'Land',
};

/** The permanents a copy may copy: "artifact or creature", "creature you control", … */
function parseCopyCandidates(phrase: string, card: OracleCard): Selector | null {
  const text = phrase.replace(/ on the battlefield$/, '');
  // A card in a graveyard, a bound by mana spent, an entry this turn: not a permanent selector.
  if (/\b(?:card|graveyard|mana|this turn|named)\b/.test(text)) return null;
  const whole = parseTriggerSubject(text, card);
  if (whole !== null) return whole;
  let rest = text;
  let controller: Selector | undefined;
  const owned = rest.match(/^(.+) (you control|an opponent controls)$/);
  if (owned !== null) {
    rest = owned[1] as string;
    controller = owned[2] === 'you control' ? YOURS : OPPONENTS;
  }
  let kind: Selector | null;
  if (rest === 'nonland permanent') kind = not(ofType('Land'));
  else if (rest === 'equipment') kind = ofSubtype('Equipment');
  else kind = parseCompoundPermanentTypeNoun(rest);
  if (kind === null) return null;
  return controller === undefined ? kind : allOf(controller, kind);
}

/** "it's an artifact in addition to its other types", "it isn't legendary", "it has haste". */
function parseCopyExceptions(text: string): Partial<EntersAsCopy> | null {
  const clauses = text
    .split(/,? and (?=(?:it|is|has|isn't)\b)|, (?=(?:it|is|has|isn't)\b)/)
    .map((clause) =>
      clause
        .trim()
        .replace(/^it's /, 'is ')
        .replace(/^it (?=is |has |isn't )/, ''),
    );
  const addTypes: string[] = [];
  const addKeywords: KeywordAbility[] = [];
  const removeSupertypes: string[] = [];
  for (const clause of clauses) {
    const types = clause.match(/^is (?:an? )?(.+) in addition to its other types$/);
    if (types !== null) {
      for (const word of (types[1] as string).split(/ and | /)) {
        const type = CARD_TYPES[word];
        if (type === undefined) return null;
        addTypes.push(type);
      }
      continue;
    }
    if (clause === "isn't legendary") {
      removeSupertypes.push('Legendary');
      continue;
    }
    const has = clause.match(/^has ([a-z ]+)$/);
    if (has !== null && (IMPLEMENTED_KEYWORDS as readonly string[]).includes(has[1] as string)) {
      addKeywords.push(has[1] as KeywordAbility);
      continue;
    }
    return null;
  }
  return {
    ...(addTypes.length > 0 ? { addTypes } : {}),
    ...(addKeywords.length > 0 ? { addKeywords } : {}),
    ...(removeSupertypes.length > 0 ? { removeSupertypes } : {}),
  };
}

/** The `entersAsCopy` replacement a line describes, or null when it is not one this reads. */
export function parseEntersAsCopy(lower: string, card: OracleCard): EntersAsCopy | null {
  const m = lower.match(ENTERS_AS_COPY_RE);
  if (m === null) return null;
  const selector = parseCopyCandidates(m[1] as string, card);
  if (selector === null) return null;
  const exceptions = m[2] === undefined ? {} : parseCopyExceptions(m[2]);
  if (exceptions === null) {
    noteSlotFailure('effect', m[2] as string);
    return null;
  }
  return { selector, ...exceptions };
}
