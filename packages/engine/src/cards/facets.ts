import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from './definition';

/**
 * Oracle facets (ADR 0034 decision 6): a few things the Oracle text says that its definition must
 * say too, counted on both sides per card. A count that differs is a warning, not an error: the
 * extractors are deliberately small, and a known modeling choice is recorded on the manifest card
 * entry as `facetNotes: [{ facet, reason }]`.
 *
 * | Facet            | Oracle text                                 | IR                                    |
 * | ---------------- | ------------------------------------------- | ------------------------------------- |
 * | `other`          | "another", "other" in a subject or selector | a selector excluding the source       |
 * | `interveningIf`  | `, if` after a trigger condition (CR 603.4) | a trigger `condition`                 |
 * | `untilEndOfTurn` | "until end of turn"                         | an `…UntilEot` op or such a duration  |
 * | `optional`       | "you may" before an instruction             | `optional: true`                      |
 * | `targetCount`    | each "target" and "up to N target"          | the abilities' target slots           |
 */
export type Facet = 'other' | 'interveningIf' | 'untilEndOfTurn' | 'optional' | 'targetCount';

export const FACETS: readonly Facet[] = [
  'other',
  'interveningIf',
  'untilEndOfTurn',
  'optional',
  'targetCount',
];

export type FacetCounts = Record<Facet, number>;

export interface FacetMismatch {
  facet: Facet;
  text: number;
  ir: number;
}

const zero = (): FacetCounts => ({
  other: 0,
  interveningIf: 0,
  untilEndOfTurn: 0,
  optional: 0,
  targetCount: 0,
});

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/**
 * The card's rules text as `handledLines` reads it: reminder text dropped, and its name (each
 * face's, and a legend's short name) and "this creature" and the like read as `~`.
 */
export function facetText(card: OracleCard): string {
  const text = [card.oracleText, card.backFace?.oracleText ?? ''].filter(Boolean).join('\n');
  const names = [card.name, ...card.name.split(' // '), card.name.split(', ')[0]!]
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length);
  let named = text.replace(/\([^)]*\)/g, '');
  for (const name of names) named = named.split(name).join('~');
  return named.replace(
    /\bthis (?:creature|artifact|enchantment|land|permanent|token|spell|Vehicle|Equipment|Saga|planeswalker|Aura)\b/gi,
    '~',
  );
}

/**
 * Words that look like a facet and are not one: "other types" and "the other player" exclude no
 * permanent, and "~ or another" includes the source; "the target of" and "a single target" name
 * no target slot; "you may choose new targets for the copy", "you may cast" and "you may play" are
 * a copy's retargeting and permissions, and "you may pay" is an optional cost.
 */
const NOT_OTHER =
  /(?:\b(?:other (?:types?|costs?|players?|opponents?)|the other|each other player)\b|~ or another\b)/gi;
const NOT_TARGET = /\b(?:the target of|a single target|must target a different)\b/gi;
const NOT_OPTIONAL = /\byou may (?:choose new targets|cast|play|pay)\b/gi;

/** The facets the Oracle text states. */
export function textFacets(card: OracleCard): FacetCounts {
  const text = facetText(card);
  const lines = text.split('\n');
  return {
    // "other than" and "each other creature" name the same exclusion; "otherwise" is another word.
    other: count(text, /\b(?:another|other)\b/gi) - count(text, NOT_OTHER),
    interveningIf: lines.filter((line) => /^(?:when|whenever|at)\b[^.]*, if\b/i.test(line.trim()))
      .length,
    untilEndOfTurn: count(text, /\buntil end of turn\b/gi),
    optional: count(text, /\byou may\b/gi) - count(text, NOT_OPTIONAL),
    // "up to two target creatures" is one slot, as "target creature" is. An Aura spell targets
    // what it will enchant (CR 303.4a), and equip is "attach to target creature you control".
    targetCount:
      count(text, /\btarget\b/gi) -
      count(text, NOT_TARGET) +
      lines.filter((line) => /^(?:enchant|equip)\b/i.test(line.trim())).length,
  };
}

/** The facets a definition states, anywhere in it: faces, modes and granted abilities included. */
export function irFacets(definition: CardDefinition): FacetCounts {
  const counts = zero();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Record<string, unknown>;
    if (node['kind'] === 'other') counts.other++;
    // An op or rule static that names its exclusion: `sacrificeOtherForMana`,
    // `triggerAdditionalForShamanOrOtherWizard`.
    for (const name of [node['op'], node['kind']])
      if (typeof name === 'string' && /Others?(?:[A-Z]|$)/.test(name)) counts.other++;
    if (node['optional'] === true) counts.optional++;
    // A `may…` op asks first; a search for a stated quality may always fail to find (CR 701.19b).
    if (typeof node['op'] === 'string' && /^may[A-Z]/.test(node['op'])) counts.optional++;
    if (node['op'] === 'searchLibrary' && node['filter'] !== undefined) counts.optional++;
    if (typeof node['op'] === 'string' && node['op'].includes('UntilEot')) counts.untilEndOfTurn++;
    if (node['duration'] === 'untilEndOfTurn') counts.untilEndOfTurn++;
    const trigger = node['trigger'];
    if (typeof trigger === 'object' && trigger !== null && 'condition' in trigger)
      counts.interveningIf++;
    if (
      (node['kind'] === 'spell' || node['kind'] === 'triggered' || node['kind'] === 'activated') &&
      Array.isArray(node['targets'])
    )
      counts.targetCount += node['targets'].length;
    for (const [key, child] of Object.entries(node)) {
      // An alternative cast of a spell face states the face's spell ability as its own `ability`.
      if (key === 'spellFace' && 'ability' in node && typeof child === 'object' && child !== null) {
        const { spellAbility: _mirror, ...face } = child as Record<string, unknown>;
        visit(face);
      } else visit(child);
    }
  };
  visit(definition);
  return counts;
}

/** Each facet whose counts differ between the card's text and its definition. */
export function facetMismatches(card: OracleCard, definition: CardDefinition): FacetMismatch[] {
  const text = textFacets(card);
  const ir = irFacets(definition);
  return FACETS.filter((facet) => text[facet] !== ir[facet]).map((facet) => ({
    facet,
    text: text[facet],
    ir: ir[facet],
  }));
}
