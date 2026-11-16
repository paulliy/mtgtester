/**
 * Effect sentences for the card grammar (ADR 0038): what an ability does once its cost is paid or
 * its trigger fires. "Draw two cards", "create a 1/1 white Soldier creature token", "destroy
 * target creature", and the modal, reflexive and multi-sentence blocks built from them.
 *
 * Trigger lines live here too, because the recursion runs both ways: an effect can grant a
 * triggered ability ("creatures you control gain 'Whenever this creature attacks, …'"), and a
 * trigger's body is an effect. `parseTriggerHead` (trigger-event.ts) reads the head; this module
 * assembles the ability around it.
 *
 * Every parser returns null for text it does not know, and null leaves the card unmodeled.
 */

import { graveyardCardTarget } from '../target-builders';
import { searchLibraryCards } from '../effect-builders';
import type { Color, OracleCard } from '@mtg/shared';
import { emptyCost, parseManaCost } from '../../mana/cost';
import type { ManaUnit, ParsedManaCost } from '../../mana/cost';
import type { ManaRestriction, SearchDestination } from '../ability';
import { IMPLEMENTED_KEYWORDS, SELF_SUBJECT } from '../ability';
import type {
  Ability,
  Effect,
  KeywordAbility,
  TargetKind,
  TargetSpec,
  TokenSpec,
  TriggerHead,
  TriggerSpec,
} from '../ability';
import {
  COLOR_WORDS,
  FIVE_COLORS,
  KEYWORD_SET,
  ORDINAL_TIMES,
  ORDINALS_FROM_TOP,
  parseAmount,
  resolveSubtype,
  SELF_OBJECT_RE,
} from './words';
import {
  ANY_SPELL,
  parseCardFilterPhrase,
  parseMassSubject,
  parseSearchFilter,
  parseSpellFilter,
  parseSubject,
  parseTargetClause,
} from './subject';
import type { CountSlotAllocator, SlotAllocator } from './subject';
import { parseCountPhrase, parseDamageAmount, parseDynamicCountValue } from './amount';
import { INTERVENING_IF_RE, parseConditionClause } from './condition';
import { parseTriggerHead } from './trigger-event';
import type { Condition } from '../condition';
import type { ProtectionQuality } from '../continuous-types';
import type { Selector } from '../selector';
import {
  IS_TOKEN,
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
} from '../selector';
import type { Value } from '../value';
import { constant } from '../value';
import { canonicalizeToken, CLUE, FOOD, MUTAGEN, TREASURE } from '../tokens';
import { noteSlotFailure } from './diagnostics';
import { bindX, parseForEachCount, rewriteEqualTo, scaleByCount } from './amount-forms';
import { parsePlayerVerbSentence } from './player-verb';
import { parseDamageSentence } from './damage';
import { triggerProvidesEventPlayer } from '../trigger-contracts';

/**
 * The slot a sentence allocated, when it allocated exactly one and that one is a permanent: what a
 * following "its controller" refers back to.
 */
export function soleTargetSince(targets: TargetSpec[], before: number): number | undefined {
  if (targets.length !== before + 1) return undefined;
  const kind = targets[before]?.kind;
  const notPermanent: TargetKind[] = [
    'player',
    'spell',
    'noncreatureSpell',
    'anyTarget',
    'playerOrPlaneswalker',
    'cardInGraveyard',
  ];
  return kind === undefined || notPermanent.includes(kind) ? undefined : before;
}

/**
 * The slot a sentence allocated, when it allocated exactly one and that one is a player: what a
 * following "that player" or "they" refers back to (Memory Worm: "… deals 2 damage to target
 * player. That player discards a card, …").
 */
export function solePlayerTargetSince(targets: TargetSpec[], before: number): number | undefined {
  return targets.length === before + 1 && targets[before]?.kind === 'player' ? before : undefined;
}

/** Split a line into sentences, dropping the terminal period of each. */
export function splitSentences(line: string): string[] {
  return line
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 0);
}

export function appendSentenceEffects(effects: Effect[], sentence: string, parsed: Effect[]): void {
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

export const WARD_RE = /^ward ((?:\{[^}]+\})+)$/;

export const PROTECTION_RE = /^protection from (.+)$/;

/**
 * A keyword list as printed — "Flying, ward {3}", "Flying, protection from white and from
 * black", "Other Dragons you control have ward {2}".
 *
 * Ward and protection carry an argument, so they come back as their own fields rather than as
 * members of `keywords`; see `Characteristics.ward`. Returns null if ANY element is a keyword
 * the engine does not implement, so a card is never modeled with a keyword silently dropped.
 */
export interface ParsedKeywordLine {
  keywords: KeywordAbility[];
  ward?: ParsedManaCost;
  protectionFrom?: ProtectionQuality[];
}

export function parseKeywordLine(text: string): ParsedKeywordLine | null {
  const out: ParsedKeywordLine = { keywords: [] };
  // Split on commas only at the top level: " and " is ambiguous, because it also joins the
  // colors inside "protection from white and from black".
  // "lifelink and ward {2}" (Sheltered by Ghosts): a trailing ward joined by " and " is its own
  // part; its cost is a mana cost, never another keyword, so the split is unambiguous.
  const parts = text.split(',').flatMap((raw) => {
    const trailingWard = raw.match(/^(.+) and (ward (?:\{[^}]+\})+)$/);
    return trailingWard === null ? [raw] : [trailingWard[1] as string, trailingWard[2] as string];
  });
  for (const raw of parts) {
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
      // "protection from multicolored" (CR 105.4) and "protection from creatures" (a card
      // type, CR 702.16a) are qualities of their own, never joined with a color.
      if (argument === 'multicolored' || argument === 'creatures') {
        out.protectionFrom = [...(out.protectionFrom ?? []), argument];
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

/**
 * "<subject> get +X/+X [and have <keywords>]" / "<subject> have <keywords>" — the anthem and
 * lord shape. The same grammar with "gain" instead of "have" and a trailing "until end of
 * turn" is the spell form (Overrun); see `MASS_UNTIL_EOT_RE`.
 */
export const ANTHEM_RE =
  /^(.+?) (?:gets? ([+-]\d+)\/([+-]\d+)(?: and (?:have|has) (.+))?|(?:have|has) (.+))$/;

/** The spell form of `ANTHEM_RE` — "Creatures you control get +3/+3 … until end of turn". */
export const MASS_UNTIL_EOT_RE =
  /^(.+?) (?:gets? ([+-]\d+)\/([+-]\d+)(?: and gains? (.+?))?|gains? (.+?)) until end of turn$/;

/**
 * Predefined token faces that rules text names rather than describes (CR 111.10). "Create a
 * Treasure token" says nothing about what a Treasure *is* — the face is defined by the rules,
 * so it has to be spelled out here or the token would enter as a blank artifact.
 */
export const PREDEFINED_TOKENS: Record<string, TokenSpec> = {
  // Was hand-spelled here with `typeLine: 'Token Artifact — Treasure'` (encoding-corrupted in
  // source to boot) — disagreeing with `tokens.ts`'s `TREASURE` on the type line, though the two
  // mana-ability costs happened to match. One token, one spelling.
  treasure: TREASURE,
  food: FOOD,
  mutagen: MUTAGEN,
};

/** "1/1 black and green Pest creature token" → a `TokenSpec`, or null if any part is unread. */
export function parseTokenFace(phrase: string, card: OracleCard): TokenSpec | null {
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
export function parseCreateTokenSentence(
  s: string,
  card: OracleCard,
  opts: { triggerObject?: boolean; thatMany?: Value },
): Effect[] | null {
  // The copy form first: it shares the "create a token" prefix but nothing else.
  // Per-opponent attacking tokens (Adeline, Ainok Strike Leader, Endless Foot Assault).
  {
    const attacking = s.match(
      /^create (?:a|an) (.+?) token that(?:'s| is) tapped and attacking that player( or a planeswalker they control)?$/,
    );
    if (attacking !== null) {
      const spec = parseTokenFace((attacking[1] as string) + ' token', card);
      if (spec !== null) {
        return [
          {
            op: 'createTokenForEachOpponent',
            spec,
            attacking: true,
            ...(attacking[2] !== undefined ? { orPlaneswalker: true } : {}),
          },
        ];
      }
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

/**
 * "Search your library for <what>, put <them> <where>, then shuffle" (CR 701.19) — the
 * basic-land tutor template, which recurs on four cards in the coverage fixtures.
 *
 * Returns the search AND the shuffle: they are printed as one sentence, and a search whose
 * shuffle got lost would leave the searcher's library ordered by what they looked at.
 */
export function parseSearchSentence(s: string, card: OracleCard): Effect[] | null {
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

/**
 * "put it onto the battlefield tapped" / "put one onto the battlefield tapped and the other
 * into your hand" → one destination per card the search may find, in the order the player is
 * asked about them.
 */
export function parseSearchDestinations(phrase: string): SearchDestination[] | null {
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

export const MANA_ABILITY_RE = /^add ((?:\{[wubrgc]\})+)$/;

/** Symbols inside a mana clause, uppercased: "{g} or {w}" → ['G','W']. */
export function manaSymbols(clause: string): ManaUnit {
  return [...clause.matchAll(/\{([wubrgc])\}/g)].map(
    (m) => (m[1] as string).toUpperCase() as ManaUnit[number],
  );
}

/**
 * The object clause of a spend restriction or spend trigger — "cast a Dragon creature spell",
 * "cast spells", "cast a creature spell that shares a creature type with your commander".
 *
 * Returns null for anything unread, which leaves the whole card unmodeled. That is the only safe
 * direction: a restriction the engine drops silently becomes mana spendable on anything.
 */
export function parseManaSpendClause(clause: string, card: OracleCard): ManaRestriction | null {
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

  const m = rest.match(/^(?:cast )?(?:on )?(.+)$/);
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
export const ADD_X_MANA_ANY_COLORS_RE =
  /^add x mana in any combination of colors, where x is the total power of attacking creatures\. spend this mana only to (.+?)\. until end of turn, you don't lose this mana as steps and phases end$/;

export function parseAddManaTriggerBlock(lower: string, card: OracleCard): Effect[] | null {
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
 * "Exile the top three cards of your library. You may play them this turn." (Jeska's Will)
 *
 * A whole-block parse for the same reason `parseLookAtTopBlock` is one: "them" in the second
 * sentence only means anything relative to the first, and the IR has no way to carry an exiled
 * set between two independently-parsed ops.
 */
export const EXILE_TOP_PLAYABLE_RE =
  /^exile the top (\w+) cards? of your library\. you may play (?:them|it) this turn$/;

export function parseExileTopPlayableBlock(lower: string): Effect[] | null {
  const m = lower.replace(/\.$/, '').match(EXILE_TOP_PLAYABLE_RE);
  if (m === null) return null;
  const count = parseAmount(m[1] as string);
  if (count === null || count <= 0) return null;
  return [{ op: 'exileTopNPlayableUntilEot', count: constant(count) }];
}

/**
 * "Look at the top four cards of target opponent's library, exile one of them face down, then
 * put the rest on the bottom of that library in a random order. You may cast that card for as
 * long as it remains exiled, and mana of any type can be spent to cast that spell." (Gonti; Thief
 * of Sanity reads "that player's library … into their graveyard"), and Praetor's Grasp's search.
 * `eventPlayer` says whether "that player" has a referent (a combat-damage head).
 */
export function parseExileFaceDownPlayableBlock(
  lower: string,
  alloc: SlotAllocator,
  eventPlayer: boolean,
): Effect[] | null {
  const text = lower.replace(/\.$/, '');
  const look = text.match(
    /^look at the top (\w+) cards of (target opponent's|that player's) library, exile one of them face down, then put the rest (on the bottom of that library in a random order|into their graveyard)\. you may cast that card for as long as it remains exiled, and mana of any type can be spent to cast that spell$/,
  );
  if (look !== null) {
    const count = parseAmount(look[1] as string);
    if (count === null || count < 1) return null;
    if (look[2] === "that player's" && !eventPlayer) return null;
    return [
      {
        op: 'exileFaceDownPlayable',
        library:
          look[2] === "that player's" ? 'eventPlayer' : alloc('player', undefined, 'opponent'),
        from: {
          look: count,
          rest: look[3] === 'into their graveyard' ? 'graveyard' : 'bottomRandom',
        },
        castOnly: true,
        anyType: true,
      },
    ];
  }
  if (
    text ===
    "search target opponent's library for a card and exile it face down. then that player shuffles. you may play that card for as long as it remains exiled"
  )
    return [
      {
        op: 'exileFaceDownPlayable',
        library: alloc('player', undefined, 'opponent'),
        from: 'search',
        castOnly: false,
        anyType: false,
      },
    ];
  return null;
}

/** Thrown when a vote outcome would allocate a target slot, which the vote cannot announce. */
class VoteTargetRefused extends Error {}

/**
 * "Look at the top eight cards of your library. You may put a Dragon creature card from among
 * them onto the battlefield. Put the rest on the bottom of your library in a random order."
 *
 * Matched as a whole THREE-sentence block rather than sentence by sentence: the later sentences
 * refer to "them" and "the rest", which only mean anything relative to the first. Parsing them
 * independently would need the IR to carry a revealed set between ops, which it does not.
 */
export function parseLookAtTopBlock(lower: string, card: OracleCard): Effect[] | null {
  const normalized = lower.replace(/\.$/, '');
  // Will of the council (CR 701.38): "Starting with you, each player votes for time or
  // knowledge. If time gets more votes, …. If knowledge gets more votes or the vote is tied, …."
  // (Plea for Power). Each outcome is ordinary effect grammar; a target inside one is not read
  // here, since the vote's outcome is unknown when targets would be chosen.
  {
    const vote = normalized.match(
      /^starting with you, each player votes for ([a-z]+) or ([a-z]+)\. if ([a-z]+) gets more votes, (.+?)\. if ([a-z]+) gets more votes or the vote is tied, (.+)$/,
    );
    if (vote !== null && vote[3] === vote[1] && vote[5] === vote[2]) {
      const refuse: SlotAllocator = () => {
        throw new VoteTargetRefused();
      };
      const outcome = (text: string): Effect[] | null => {
        const effects: Effect[] = [];
        for (const sentence of text.split(/\. /)) {
          let parsed: Effect[] | null;
          try {
            parsed = parseEffectSentence(sentence, refuse, card);
          } catch (error) {
            if (error instanceof VoteTargetRefused) return null;
            throw error;
          }
          if (parsed === null) return null;
          effects.push(...parsed);
        }
        return effects;
      };
      const more = outcome(vote[4] as string);
      const otherwise = outcome(vote[6] as string);
      if (more === null || otherwise === null) return null;
      return [
        {
          op: 'councilVote',
          choices: [vote[1] as string, vote[2] as string],
          more,
          otherwise,
        },
      ];
    }
  }
  // "Search your library and/or graveyard for a creature card with mana value X or less and put
  // it onto the battlefield. If you search your library this way, shuffle. If X is 10 or more,
  // creatures you control get +X/+X and gain haste until end of turn." (Finale of Devastation):
  // the shuffle is part of the two-zone search, and the rider reads the announced X.
  {
    const finale = normalized.match(
      /^search your library and\/or graveyard for (?:a|an) (.+?) card with mana value x or less and put it onto the battlefield\. if you search your library this way, shuffle(?:\. if x is (\d+) or more, (.+?) get \+x\/\+x and gain ([a-z ,]+?) until end of turn)?$/,
    );
    if (finale !== null) {
      const filter = parseCardFilterPhrase(`${finale[1] as string} card`, card);
      if (filter === null) return null;
      const effects: Effect[] = [
        {
          op: 'searchLibraryAndOrGraveyardToBattlefield',
          filter,
          maxManaValue: { kind: 'xValue' },
        },
      ];
      if (finale[2] !== undefined) {
        const selector = parseSubject(finale[3] as string, card);
        const keywords = parseKeywordLine(finale[4] as string);
        if (selector === null || keywords === null || keywords.ward !== undefined) return null;
        if (keywords.protectionFrom !== undefined) return null;
        effects.push({
          op: 'conditionalEffect',
          condition: {
            kind: 'compareValues',
            left: { kind: 'xValue' },
            cmp: '>=',
            right: constant(Number(finale[2])),
          },
          then: [
            {
              op: 'pumpEachUntilEot',
              selector,
              power: { kind: 'xValue' },
              toughness: { kind: 'xValue' },
            },
            ...keywords.keywords.map((keyword): Effect => ({
              op: 'grantKeywordEachUntilEot',
              selector,
              keyword,
            })),
          ],
          else: [],
        });
      }
      return effects;
    }
  }
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
  // "You may reveal a creature card from among them and put it into your hand. Put the rest on
  // the bottom of your library in a random order." (Monumental Henge, Growing Rites of Itlimoc).
  const reveal = normalized.match(
    /^look at the top (\w+) cards of your library\. you may reveal (?:a|an) (.+?) from among them and put (?:it|that card) into your hand\. put the rest on the bottom of your library in (a random|any) order$/,
  );
  if (reveal !== null) {
    const count = parseAmount(reveal[1] as string);
    const filter = parseSearchFilter(reveal[2] as string, card);
    if (count === null || filter === null) return null;
    return [
      {
        op: 'lookAtTopN',
        count,
        mayPut: { filter, destination: { zone: 'hand' }, reveal: true },
        rest: reveal[3] === 'any' ? 'bottomAnyOrder' : 'bottomRandom',
      },
    ];
  }
  // "Put one of them into your hand and the rest into your graveyard." (Forbidden Alchemy),
  // "Put two of them into your hand and the rest on the bottom of your library in any order."
  // (Stock Up), "… and the other on the bottom of your library." (Sleight of Hand): required picks.
  const picks = normalized.match(
    /^look at the top (\w+) cards of your library\. put (\w+) of (?:them|those cards) into your hand and the (?:rest|other) (into your graveyard|on the bottom of your library(?: in any order)?)$/,
  );
  if (picks !== null) {
    const count = parseAmount(picks[1] as string);
    const take = parseAmount(picks[2] as string);
    if (count === null || take === null || take < 1 || take >= count) return null;
    return [
      {
        op: 'lookAtTopN',
        count,
        mayPut: {
          filter: { kind: 'allOf', of: [] },
          destination: { zone: 'hand' },
          required: true,
          ...(take > 1 ? { count: take } : {}),
        },
        rest: picks[3] === 'into your graveyard' ? 'graveyard' : 'bottomAnyOrder',
      },
    ];
  }
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
 * "You may sacrifice ~. If you do, create four 4/4 … tokens" (The Fantasticar): the rest happens
 * only if the source was actually sacrificed — not if it already left the battlefield.
 */
export function parseSacrificeSelfIfYouDoBlock(
  body: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: Parameters<typeof parseEffectSentence>[3],
): Effect[] | null {
  const m = body.match(/^sacrifice ~\. if you do, (.+?)\.?$/);
  if (m === null) return null;
  const sentence = m[1] as string;
  const parsed = parseEffectSentence(sentence, alloc, card, opts);
  if (parsed === null) return null;
  const then: Effect[] = [];
  appendSentenceEffects(then, sentence, parsed);
  return [{ op: 'sacrificeOneThen', selector: SELF, then }];
}

/**
 * "Put a +1/+1 counter on each attacking creature. They gain indestructible until end of turn."
 * (Captain America, Skybound): "they" is the set the first sentence counted, fixed as the
 * ability resolves (CR 608.2c) — the same creatures a moment later.
 */
export function parseCountersThenTheyGainBlock(body: string, card: OracleCard): Effect[] | null {
  const m = body.match(
    /^put a \+1\/\+1 counter on each (.+?)\. they gain (\w+) until end of turn\.?$/,
  );
  const selector = m === null ? null : parseSubject(m[1] as string, card);
  const keyword = m?.[2] as KeywordAbility | undefined;
  if (selector === null || keyword === undefined || !KEYWORD_SET.has(keyword)) return null;
  return [
    { op: 'putCountersEach', selector, counter: '+1/+1', count: 1 },
    { op: 'grantKeywordEachUntilEot', selector, keyword },
  ];
}

/**
 * "You gain 1 life if this is the first time this ability has resolved this turn. If it's the
 * second time, draw a card. If it's the third time, …" (Belladonna Took) and "scry 1. If this is
 * the second time this ability has resolved this turn, draw a card instead." (Rumor Gatherer):
 * branches on how many times this ability has resolved this turn, counting this resolution.
 */
export function parseResolutionCountBlock(
  body: string,
  key: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: Parameters<typeof parseEffectSentence>[3],
): Effect[] | null {
  if (!body.includes(' time this ability has resolved this turn')) return null;
  const sentences = splitSentences(body);
  const cases: { n: number; effects: Effect[] }[] = [];
  let otherwise: Effect[] = [];
  const parse = (text: string): Effect[] | null => {
    const parsed = parseEffectSentence(text, alloc, card, opts);
    if (parsed === null) return null;
    const effects: Effect[] = [];
    appendSentenceEffects(effects, text, parsed);
    return effects;
  };
  const addCase = (ordinal: string, text: string): boolean => {
    const n = ORDINAL_TIMES[ordinal];
    const effects = parse(text);
    if (n === undefined || effects === null || cases.some((entry) => entry.n === n)) return false;
    cases.push({ n, effects });
    return true;
  };
  const [first, ...rest] = sentences.map((sentence) => sentence.replace(/\.$/, ''));
  if (first === undefined) return null;
  const leading = first.match(
    /^(.+) if this is the (\w+) time this ability has resolved this turn$/,
  );
  if (leading !== null) {
    // Belladonna: each sentence is one count's effect; any other count does nothing.
    if (!addCase(leading[2] as string, leading[1] as string)) return null;
    for (const sentence of rest) {
      const m = sentence.match(/^if it's the (\w+) time, (.+)$/);
      if (m === null || !addCase(m[1] as string, m[2] as string)) return null;
    }
  } else {
    // Rumor Gatherer: the first sentence is the usual effect, which the count replaces.
    const instead =
      rest.length === 1
        ? (rest[0] as string).match(
            /^if this is the (\w+) time this ability has resolved this turn, (.+) instead$/,
          )
        : null;
    const usual = parse(first);
    if (instead === null || usual === null) return null;
    if (!addCase(instead[1] as string, instead[2] as string)) return null;
    otherwise = usual;
  }
  return [{ op: 'byResolutionCountThisTurn', key, cases, otherwise }];
}

/**
 * The ability a "When you do, …" reflexive trigger puts on the stack (CR 603.12). It declares
 * its own targets, chosen as it goes on the stack (CR 603.3d), so it gets its own slot list —
 * ordinary slots first, then variable-count ones, as `pushTriggerOnStack` requires.
 */
export function parseReflexiveAbility(text: string, card: OracleCard): Ability | null {
  const targets: TargetSpec[] = [];
  let countSlotSeen = false;
  let ordinaryAfterCount = false;
  const alloc: SlotAllocator = (kind, filter, controller, graveyardOwnerScope) => {
    if (countSlotSeen) ordinaryAfterCount = true;
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
  const allocCount: CountSlotAllocator = (kind, count, controller, filter) => {
    countSlotSeen = true;
    targets.push({
      kind,
      count,
      ...(controller !== undefined ? { controller } : {}),
      ...(filter !== undefined ? { filter } : {}),
    });
    return targets.length - 1;
  };
  // One sentence only: where a later sentence stops belonging to the reflexive ability and
  // goes back to the triggering one is not knowable from the text alone, so fail closed.
  const sentences = splitSentences(text);
  if (sentences.length !== 1) return null;
  const sentence = sentences[0] as string;
  const parsed = parseEffectSentence(sentence, alloc, card, { allocCount });
  if (parsed === null) return null;
  const effects: Effect[] = [];
  appendSentenceEffects(effects, sentence, parsed);
  if (effects.length === 0 || ordinaryAfterCount) return null;
  return { kind: 'triggered', targets, effects, description: `When you do, ${text}` };
}

export function parseModalSpellBlock(
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

export function parseHellkiteCourserBlock(
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
export function parseDoublePowerThoseGainBlock(body: string): Effect[] | null {
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
export function parseExileReturnAtNextEndStepBlock(
  body: string,
  alloc: SlotAllocator,
): Effect[] | null {
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
export function parseReanimateHasteExileAtEndStepBlock(
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
 * "Put it into its owner's library third from the top" (God-Eternal Rhonas), on a trigger for the
 * source itself dying or being exiled: "it" is the card the source became (CR 400.7e).
 */
export function parseDepartedSourceToLibraryBlock(
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

export function parseBlinkChosenBlock(
  body: string,
  allocCount: CountSlotAllocator,
): Effect[] | null {
  const match = body.match(
    /^exile up to one target (.+?) you control, then return (?:it|that card) to the battlefield under its owner's control\.?$/,
  );
  if (match === null) return null;
  const clause = parseTargetClause(`${match[1] as string} you control`);
  if (clause === null) return null;
  const targetSlot = allocCount(clause.kind, { min: 0, max: 1 }, clause.controller, clause.filter);
  return [{ op: 'blinkEachChosen', targetSlot, returnUnder: 'owner' }];
}

/** Animate Dead's enters trigger, as one line (CR 603.4 intervening if, then the swap). */
export const REANIMATE_ATTACH_TRIGGER =
  'when this aura enters, if it\'s on the battlefield, it loses "enchant creature card in a graveyard" and gains "enchant creature put onto the battlefield with this aura." return enchanted creature card to the battlefield under your control and attach this aura to it. when this aura leaves the battlefield, that creature\'s controller sacrifices it';

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
function parseEffectSentenceUntraced(
  sentence: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: {
    triggerObject?: boolean;
    /** Every head's subject is the source itself ("Whenever ~ attacks"): a bare "it" is the source. */
    selfSubject?: boolean;
    /** Every head's event names a player, whom "that player" and "they" refer to. */
    eventPlayer?: boolean;
    /** A surrounding "where X is …" defines X for this sentence (`parseAmountForm`). */
    xBound?: boolean;
    /** The sentence opens with "It" right after one that created a token: "it" is that token. */
    afterToken?: boolean;
    /** The previous sentence's one permanent target, which "its controller" names. */
    lastTarget?: number;
    /** The previous sentence's one player target, which "that player" and "they" name. */
    lastPlayerTarget?: number;
    /** Every head is this object leaving the battlefield: its last-known facts are the event's. */
    departedSelf?: boolean;
    departedTriggerObject?: boolean;
    /** Every head is this object going from the battlefield to a graveyard. */
    departedToGraveyard?: boolean;
    /** Every head is the creature this Aura or Equipment is attached to dying. */
    attachedDies?: boolean;
    /** Every head is this Aura's enchanted player being attacked; the event player attacks. */
    enchantedPlayerAttacked?: boolean;
    thatMany?: Value;
    allocCount?: CountSlotAllocator;
  } = {},
): Effect[] | null {
  const s = sentence.toLowerCase();
  // "You may cast spells this turn as though they had flash" (Borne Upon a Wind, Emergence Zone):
  // a timing permission for the controller until the turn ends (CR 601.3b, 514.2).
  if (s === 'you may cast spells this turn as though they had flash')
    return [{ op: 'castAsThoughFlashThisTurn' }];
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
  // "Exile target creature you control, then return it to the battlefield under its owner's
  // control." (Ephemerate) / "… return that card … under your control" (Cloudshift). The returned
  // card is a new object (CR 400.7).
  {
    const blink = s.match(
      /^exile (another )?target (.+?), then return (?:it|that card) to the battlefield under (its owner's|your) control$/,
    );
    const clause =
      blink === null ? null : parseTargetClause(`${blink[1] ?? ''}${blink[2] as string}`);
    if (blink !== null && clause !== null && clause.kind !== 'player') {
      const slot = alloc(clause.kind, clause.filter, clause.controller);
      if (typeof slot === 'number')
        return [
          {
            op: 'blinkTarget',
            target: slot,
            returnUnder: blink[3] === 'your' ? 'you' : 'owner',
          },
        ];
    }
  }
  if (s === 'exile all graveyards') return [{ op: 'exileAllGraveyards' }];
  // "Exile target nonland permanent an opponent controls until this enchantment leaves the
  // battlefield" (Conclave Tribunal): it returns when the source leaves (CR 610.3).
  {
    const until = s.match(
      /^exile target (.+) until (?:~|this (?:enchantment|artifact|creature|permanent|aura)) leaves the battlefield$/,
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
    return [{ op: 'extraCombatPhase', additionalMain: true }];
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
  // A trailing "where X is …" defines X for both halves, so it is read around the whole
  // sentence (`parseAmountForm`) rather than split off with the second half alone.
  for (const match of /, where x is /.test(s) ? [] : s.matchAll(/\s+and\s+/g)) {
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
  // "Search your library for a red or white instant card with mana value 4 or less and cast that
  // card without paying its mana cost" (Sunforger): the found card is cast, not moved (CR 608.2g).
  {
    const m = s.match(
      /^search your library for an? ((?:white|blue|black|red|green)(?: or (?:white|blue|black|red|green))*) (instant|sorcery) card with mana value (\d+) or less and cast that card without paying its mana cost$/,
    );
    if (m !== null) {
      const colors = (m[1] as string)
        .split(' or ')
        .map((word) => ofColor(COLOR_WORDS[word] as Color));
      return [
        {
          op: 'searchLibraryCastFree',
          filter: allOf(
            ofType(m[2] === 'instant' ? 'Instant' : 'Sorcery'),
            colors.length === 1 ? (colors[0] as Selector) : anyOf(...colors),
            manaValueAtMost(Number(m[3])),
          ),
        },
      ];
    }
  }
  if (s === 'then shuffle') return [{ op: 'shuffle' }];
  // "Return up to one target Aura or Equipment card from your graveyard to the battlefield
  // attached to that token" (Forum Filibuster's reflexive ability).
  if (
    s ===
      'return up to one target aura or equipment card from your graveyard to the battlefield attached to that token' &&
    opts.allocCount !== undefined
  ) {
    const targetSlot = opts.allocCount(
      'cardInGraveyard',
      { min: 0, max: 1 },
      undefined,
      anyOf(ofSubtype('Aura'), ofSubtype('Equipment')),
    );
    return [{ op: 'returnChosenCardsAttachedTo', targetSlot, to: 'triggerObject' }];
  }
  {
    const m = s.match(
      /^attach (?:this equipment|~) to target creature (you control|an opponent controls)$/,
    );
    if (m !== null)
      return [
        {
          op: 'attachSelfTo',
          target: alloc('creature', undefined, m[1] === 'you control' ? 'you' : 'opponent'),
        },
      ];
  }
  if (s === 'it gains haste until end of turn') {
    // Right after "create a … token", "it" is the token, which no op here can name.
    if (opts.afterToken === true) return null;
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
  // "Shuffle Blue Sun's Zenith into its owner's library": the resolving spell itself goes into
  // the library, then it is shuffled. A bare library shuffle would leave the card in the
  // graveyard. On a permanent "~" is not the resolving spell, which this does not read.
  if (s === "shuffle ~ into its owner's library" || s === 'shuffle ~ into your library') {
    return card.types.includes('Instant') || card.types.includes('Sorcery')
      ? [{ op: 'resolvingSpellShuffleIntoLibrary' }]
      : null;
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
  // "Add {R} for each tapped land your opponents control" (Mana Geyser): a resolving spell's
  // mana, counted as it resolves (CR 608.2h).
  {
    const m = s.match(/^add (\{[wubrgc]\}) for each (.+)$/);
    if (m !== null && !/\btarget\b/.test(m[2] as string)) {
      const symbol = manaSymbols(m[1] as string)[0];
      const amount = parseDynamicCountValue(`the number of ${m[2] as string}`, card);
      if (symbol === undefined || amount === null) return null;
      return [{ op: 'addMana', amount, colors: [symbol] }];
    }
  }
  // "Permanents your opponents control lose hexproof and indestructible until end of turn"
  // (Shadowspear): a mass layer-6 removal, the permanents fixed as it resolves (CR 611.2c).
  {
    const m = s.match(/^(.+?) lose ([a-z ]+?)(?: and ([a-z ]+?))? until end of turn$/);
    if (m !== null && !/\btarget\b|^(?:it|~|they)$/.test(m[1] as string)) {
      const keywords = [m[2], m[3]].filter((word): word is string => word !== undefined);
      const selector = parseMassSubject(m[1] as string, card);
      if (
        selector !== null &&
        keywords.every((word) => (IMPLEMENTED_KEYWORDS as readonly string[]).includes(word))
      )
        return [
          {
            op: 'loseKeywordsEachUntilEot',
            selector,
            keywords: keywords as KeywordAbility[],
          },
        ];
    }
  }
  // Phase 4 batch 1: common sentences over existing ops.
  // "you may gain 1 life" reaches here as "gain 1 life" once the optional prefix is stripped.
  {
    const m = s.match(/^gain (\w+) life$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null) return [{ op: 'gainLife', amount: constant(n) }];
  }
  // "Investigate" (CR 701.36a): create a Clue token.
  if (s === 'investigate') return [{ op: 'createToken', spec: CLUE, count: constant(1) }];
  // "Each opponent discards a card" / "each player discards two cards": each chooses (CR 701.9).
  {
    const m = s.match(/^each (opponent|player) discards (a card|(\w+) cards)$/);
    const n = m === null ? null : m[3] === undefined ? 1 : parseAmount(m[3] as string);
    if (m !== null && n !== null && n > 0)
      return [
        {
          op: 'discardEachPlayer',
          scope: m[1] === 'opponent' ? 'opponents' : 'all',
          count: constant(n),
        },
      ];
  }
  // "Target player mills three cards" (Hedron Crab, Thought Scour).
  {
    const m = s.match(/^target player mills (a card|(\w+) cards)$/);
    const n = m === null ? null : m[2] === undefined ? 1 : parseAmount(m[2] as string);
    if (m !== null && n !== null && n > 0)
      return [{ op: 'millTargetPlayer', target: alloc('player'), count: n }];
  }
  // Fog: "Prevent all combat damage that would be dealt this turn" (CR 615).
  if (s === 'prevent all combat damage that would be dealt this turn')
    return [{ op: 'preventCombatDamageAll' }];
  // Karoo lands: "return a land you control to its owner's hand", chosen on resolution.
  {
    const m = s.match(/^return an? (.+) you control to its owner's hand$/);
    if (m !== null && !/\btarget\b/.test(m[1] as string)) {
      const kind = parseSubject(m[1] as string, card);
      if (kind !== null) return [{ op: 'returnOneToHand', selector: allOf(kind, YOURS) }];
    }
  }
  // "it deals 1 damage to target opponent" (Abraded Bluffs): with a self head "it" is the source.
  {
    const m = s.match(
      /^(~|it) deals (\w+) damage to target (opponent|player|player or planeswalker)$/,
    );
    const n = m === null ? null : parseAmount(m[2] as string);
    if (m !== null && n !== null && (m[1] === '~' || opts.triggerObject !== true)) {
      const target =
        m[3] === 'opponent'
          ? alloc('player', undefined, 'opponent')
          : alloc(m[3] === 'player' ? 'player' : 'playerOrPlaneswalker');
      return [{ op: 'dealDamage', target, amount: constant(n) }];
    }
  }
  // "Manifest dread" (CR 701.62a, Innocuous Rat).
  if (s === 'manifest dread') return [{ op: 'manifestDread', player: 'you' }];
  // "Take an extra turn after this one" (Plea for Power's time outcome, CR 500.7).
  if (s === 'take an extra turn after this one') return [{ op: 'takeExtraTurn' }];
  // "Each player draws a card" (Faerie Mastermind) / "each opponent draws two cards".
  {
    const m = s.match(/^each (player|opponent) draws (a card|(\w+) cards)$/);
    const n = m === null ? null : m[3] === undefined ? 1 : parseAmount(m[3] as string);
    if (m !== null && n !== null && n > 0)
      return [
        {
          op: 'eachPlayerDraws',
          scope: m[1] === 'player' ? 'all' : 'opponents',
          count: constant(n),
        },
      ];
  }
  if (s === "~ fights target creature you don't control") {
    return [{ op: 'fight', first: 'source', second: alloc('creature', undefined, 'opponent') }];
  }
  // "you may move any number of +1/+1 counters from this creature onto other creatures"
  // (Forgotten Ancient): a division chosen on resolution, zero included, so the "may" is part of it.
  {
    const m = s.match(
      /^(?:you may )?move any number of ([+-]\d+\/[+-]\d+) counters from (?:~|this creature) onto other creatures$/,
    );
    if (m !== null)
      return [
        {
          op: 'distributeCountersFromSource',
          counter: m[1] as string,
          selector: allOf(OTHER, ofType('Creature')),
        },
      ];
  }
  // "bolster 2" (CR 701.39a): a choice made on resolution among the least-toughness creatures.
  {
    const m = s.match(/^bolster (\w+)$/);
    const n = m === null ? null : parseAmount(m[1] as string);
    if (n !== null && n > 0) return [{ op: 'bolster', count: n }];
  }
  if (s === 'double the number of each kind of counter on target permanent') {
    return [{ op: 'doubleCountersTarget', target: alloc('permanent') }];
  }
  // CR 122.1: energy and poison are the player counters the engine tracks.
  if (s === 'double the number of each kind of counter you have') {
    return [{ op: 'doublePlayerCounters' }];
  }
  // "double the number of each kind of counter on any number of target permanents you control"
  // (The Thing): a variable-count slot, so only where a trigger can announce one.
  {
    const m = s.match(
      /^double the number of each kind of counter on any number of target (permanents|creatures)( you control)?$/,
    );
    if (m !== null && opts.allocCount !== undefined) {
      const slot = opts.allocCount(
        m[1] === 'permanents' ? 'permanent' : 'creature',
        { min: 0, max: Infinity },
        m[2] === undefined ? undefined : 'you',
      );
      return [{ op: 'doubleCountersEachChosen', targetSlot: slot }];
    }
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
  // in Blood) — the target draws, not the caster (contrast the untargeted "you draw N cards and
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
  // Vigean Graftmage: the counter is part of the target's legality, checked again on
  // resolution (CR 608.2b).
  if (s === 'untap target creature with a +1/+1 counter on it') {
    return [{ op: 'untapTarget', target: alloc('creature', hasCounter('+1/+1')) }];
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
  // "Exile target player's graveyard" (Angel of Finality, Boggart Trawler): the same op the
  // Bojuka Bog-style overrides compose, any player as the target.
  if (s === "exile target player's graveyard") {
    return [{ op: 'exileTargetPlayerGraveyard', target: alloc('player') }];
  }
  if (s === 'exile target attacking or blocking creature') {
    return [{ op: 'exile', target: alloc('creature', { kind: 'inCombat' }) }];
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
      /^each player discards their hand, then draws (\w+) cards$|^each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way$/,
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
  // Sivitri, Dragon Master's +1: a life tax on attacks on you and your planeswalkers.
  {
    const m = s.match(
      /^until your next turn, creatures can't attack you or planeswalkers you control unless their controller pays (\d+) life for each of those creatures$/,
    );
    if (m !== null) return [{ op: 'attackLifeTaxUntilYourNextTurn', amount: Number(m[1]) }];
  }

  // "When enchanted creature dies, return it to the battlefield under your control" (Changing
  // Loyalty): "it" is the card the trigger's subject became, wherever it was put (CR 400.7).
  if (opts.triggerObject === true && s === 'return it to the battlefield under your control') {
    return [{ op: 'graveyardToBattlefield', target: 'triggerObject' }];
  }
  // "If that enchantment is an Aura, you may attach it to the token" (Ajani's Chosen) and the
  // optional trigger body "attach this Aura to that creature" (Shielded by Faith).
  if (opts.triggerObject === true) {
    if (s === 'if that enchantment is an aura, you may attach it to the token')
      return [
        {
          op: 'attach',
          what: 'triggerObject',
          to: 'createdToken',
          requireAura: true,
          optional: true,
        },
      ];
    if (s === 'attach this aura to that creature')
      return [{ op: 'attach', what: 'source', to: 'triggerObject' }];
  }
  // "When enchanted creature dies, return that card to the battlefield under its owner's control"
  // (Gift of Immortality): only a dies head, so "that card" is in a graveyard, where the op looks.
  if (
    opts.attachedDies === true &&
    s === "return that card to the battlefield under its owner's control"
  ) {
    return [{ op: 'graveyardToBattlefield', target: 'triggerObject', under: 'owner' }];
  }
  // "Return this card [from your graveyard] to the battlefield [attached to that creature] [at the
  // beginning of the next end step]" (Screams from Within, Ghoulish Impetus, Gift of Immortality).
  // "This card" is the card the source became, so the head must be the source leaving or the
  // creature it is attached to dying (which puts an Aura in the graveyard, CR 704.5m).
  {
    const m = s.match(
      /^return this card (from your graveyard )?to the battlefield( attached to that creature)?( at the beginning of the next end step)?$/,
    );
    if (
      m !== null &&
      (opts.attachedDies === true ||
        (opts.departedSelf === true &&
          m[2] === undefined &&
          // The resolver looks for the card only in a graveyard, so a bare "leaves the
          // battlefield" head (exile, hand, library) must name the graveyard itself.
          (m[1] !== undefined || opts.departedToGraveyard === true)))
    )
      return [
        {
          op: 'returnDepartedSourceToBattlefield',
          ...(m[1] !== undefined ? { fromYourGraveyard: true as const } : {}),
          ...(m[3] !== undefined ? { delay: 'nextEndStep' as const } : {}),
          ...(m[2] !== undefined ? { attachTo: 'triggerObject' as const } : {}),
        },
      ];
  }
  // "... return that card to the battlefield under its owner's control at the beginning of the
  // next end step" (Resurrection Orb). Only the owner's form: Marchesa's "under your control"
  // twin carries a +1/+1-counter subject her reviewed override models.
  if (
    opts.attachedDies === true &&
    s ===
      "return that card to the battlefield under its owner's control at the beginning of the next end step"
  )
    return [{ op: 'returnDiedTriggerObjectAtNextEndStep', returnUnder: 'owner' }];
  // "that creature gets +1/+1 until end of turn" (exalted, CR 702.83a; "it gets …"): the
  // trigger's subject, a fixed bonus.
  if (opts.triggerObject === true) {
    const m = s.match(/^(?:it|that creature) gets ([+-]\d+)\/([+-]\d+) until end of turn$/);
    if (m !== null)
      return [
        {
          op: 'pumpUntilEot',
          target: 'triggerObject',
          power: Number(m[1]),
          toughness: Number(m[2]),
        },
      ];
  }
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

  // Aura/Equipment activated effects such as Pemmin's Aura's "{U}: Untap enchanted creature."
  // Their subject is not a target: it is the object currently attached to this source.
  if (s === 'untap enchanted creature' || s === 'untap equipped creature') {
    return [{ op: 'untapTarget', target: 'attachedToSource' }];
  }
  if (s === 'tap enchanted creature' || s === 'tap equipped creature') {
    return [{ op: 'tapTarget', target: 'attachedToSource' }];
  }
  // Redemption Arc's "{1}{W}: Exile enchanted creature." — again the attached object, untargeted.
  if (s === 'exile enchanted creature' || s === 'exile equipped creature') {
    return [{ op: 'exile', target: 'attachedToSource' }];
  }
  if (s === 'tap target creature that player controls') {
    return [{ op: 'tapTarget', target: alloc('creature', undefined, 'eventPlayer') }];
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
  // "~ and up to one other target creature you control can't be blocked this turn" (Lockjaw).
  {
    const m = s.match(/^~ and up to (\w+) other target (.+?) can't be blocked this turn$/);
    const max = m === null ? null : parseAmount(m[1] as string);
    const clause = m === null ? null : parseTargetClause(m[2] as string);
    if (max !== null && max > 0 && clause !== null && opts.allocCount !== undefined) {
      const slot = opts.allocCount(
        clause.kind,
        { min: 0, max },
        clause.controller,
        clause.filter === undefined ? OTHER : allOf(OTHER, clause.filter),
      );
      return [
        { op: 'cantBeBlockedUntilEot', target: 'source' },
        { op: 'cantBeBlockedEachChosen', targetSlot: slot },
      ];
    }
  }
  // "you may have The Fantasticar become an artifact creature until end of turn": a Vehicle,
  // so its printed power and toughness apply (CR 301.7b), as when it is crewed.
  if (
    /^~ becomes? an artifact creature until end of turn$/.test(s) &&
    card.subtypes.includes('Vehicle')
  ) {
    return [{ op: 'becomeArtifactCreature' }];
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
  // "Target creature you control gains protection from the color of your choice until end of
  // turn" (Gods Willing, Shelter): the color is chosen on resolution, the same op Mother of Runes
  // uses.
  {
    const m = s.match(
      /^target creature( you control)? gains protection from the color of your choice until end of turn$/,
    );
    if (m !== null) {
      const target = alloc('creature', undefined, m[1] === undefined ? undefined : 'you');
      return [{ op: 'grantChosenColorProtectionUntilEot', target }];
    }
  }
  // "target creature gains flying until end of turn"
  {
    const m = s.match(/^target creature gains ([a-z ,]+) until end of turn$/);
    if (m) {
      if (KEYWORD_SET.has(m[1] as string)) {
        return [
          {
            op: 'grantKeywordUntilEot',
            target: alloc('creature'),
            keyword: m[1] as KeywordAbility,
          },
        ];
      }
      // "gains deathtouch and indestructible until end of turn" (Offer Immortality): one grant
      // per keyword, all on the same target.
      const listed = parseKeywordLine(m[1] as string);
      if (
        listed === null ||
        listed.keywords.length < 2 ||
        listed.ward !== undefined ||
        listed.protectionFrom !== undefined
      )
        return null;
      const target = alloc('creature');
      return listed.keywords.map((keyword) => ({ op: 'grantKeywordUntilEot', target, keyword }));
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
    // "each other creature you control with base power and toughness 1/1 gets +X/+X until end
    // of turn, where X is the number of +1/+1 counters on ~" (Bess): X is fixed on resolution
    // (CR 608.2h) and the affected set with it (CR 611.2c).
    // "creatures you control gain trample and get +X/+X until end of turn, where X is the number
    // of creatures you control" (Craterhoof Behemoth): the keywords ride on the same set.
    const where = s.match(
      /^(.+?) (?:gains? ([a-z ,]+?) and )?gets? \+x\/\+x(?: and gains? ([a-z ,]+?))? until end of turn, where x is (.+)$/,
    );
    if (where !== null) {
      const selector = parseSubject(where[1] as string, card);
      const count = parseDynamicCountValue(where[4] as string, card);
      if (selector === null || count === null) return null;
      const effects: Effect[] = [
        { op: 'pumpEachUntilEot', selector, power: count, toughness: count },
      ];
      for (const text of [where[2], where[3]]) {
        if (text === undefined) continue;
        const parsed = parseKeywordLine(text);
        if (parsed === null || parsed.ward !== undefined || parsed.protectionFrom !== undefined)
          return null;
        for (const keyword of parsed.keywords)
          effects.push({ op: 'grantKeywordEachUntilEot', selector, keyword });
      }
      return effects;
    }
    // "Whenever enchanted creature attacks, each other creature that's attacking one of your
    // opponents gets +1/+1 until end of turn" (Martial Impetus): "other" is beside the attacking
    // creature, and any creature attacking an opponent of this ability's controller counts.
    {
      const m = s.match(
        /^each other creature that's attacking one of your opponents gets \+(\d+)\/\+(\d+) until end of turn$/,
      );
      if (m !== null && opts.triggerObject === true)
        return [
          {
            op: 'pumpEachUntilEot',
            selector: allOf(ofType('Creature'), { kind: 'attackingOpponent' }),
            power: Number(m[1]),
            toughness: Number(m[2]),
            exceptTriggerObject: true,
          },
        ];
    }
    const m = s.match(MASS_UNTIL_EOT_RE);
    if (m) {
      // "All creatures get -4/-4 until end of turn" (Languish): "all" adds nothing to the subject.
      const subject = m[1] as string;
      const selector =
        parseSubject(subject, card) ??
        (subject.startsWith('all ') ? parseSubject(subject.slice('all '.length), card) : null);
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
          // The granted-protection effect carries colors only; refuse any other quality.
          const colors = parsed.protectionFrom.filter((q): q is Color => q.length === 1);
          if (colors.length !== parsed.protectionFrom.length) return null;
          effects.push({ op: 'grantProtectionEachUntilEot', selector, colors });
        }
      }
      if (effects.length > 0) return effects;
    }
  }
  // "~ deals 3 damage to any target" / "… to target creature" / "… to each opponent"
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
    // "it deals X damage to any target, where X is the number of Dragons you control" (Scourge of
    // Valkas): "it" is the creature that triggered this, the damage source with last known
    // information (CR 608.2h), and X is counted as the ability resolves.
    const itDealsX = s.match(/^it deals x damage to any target, where x is (.+)$/);
    if (itDealsX !== null && opts.triggerObject === true) {
      const count = parseDynamicCountValue(itDealsX[1] as string, card, opts);
      if (count === null) return null;
      return [
        {
          op: 'dealDamage',
          target: alloc('anyTarget'),
          amount: count,
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
      // "Crystal deals X damage to each opponent, where X is the number of colors that spell is"
      // (Crystal, Inhuman Princess): the triggering spell's colors, kept on the trigger as cast.
      if (
        s === '~ deals x damage to each opponent, where x is the number of colors that spell is'
      ) {
        return [{ op: 'eachOpponentDamage', amount: { kind: 'spellColorCount' } }];
      }
      // "this creature deals 3 damage to that player" (Thunderbreak Regent): the event's player,
      // here the controller of the spell or ability that targeted the Dragon.
      const toThatPlayer = s.match(/^~ deals (\d+) damage to that player$/);
      if (toThatPlayer !== null) {
        return [
          { op: 'dealDamage', target: 'eventPlayer', amount: constant(Number(toThatPlayer[1])) },
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
  // "Counter target instant or sorcery spell unless its controller pays {1}" (Flusterstorm),
  // "Counter target creature spell" (Essence Scatter): a spell target narrowed by the spell
  // filter slot, read from the spell as it is on the stack.
  {
    const m = s.match(/^counter target (.+?) spell(?: unless its controller pays (\{[^}]+\}))?$/);
    if (
      m !== null &&
      m[1] !== 'noncreature' &&
      !/\b(?:or ability|you control|an opponent controls)\b/.test(m[1] as string)
    ) {
      const filter = parseSpellFilter(`${m[1] as string} spell`, card);
      if (filter === null || filter === ANY_SPELL) return null;
      const target = alloc('spell', filter);
      if (m[2] === undefined) return [{ op: 'counter', target }];
      const parsedCost = parseManaCost((m[2] as string).toUpperCase() as never);
      if (parsedCost.cost === null) return null;
      return [{ op: 'counterUnlessControllerPays', target, cost: parsedCost.cost }];
    }
  }
  // "Add {B}{B}{B}." (a ritual spell) / "Add {U}{B}." (the effect half of a signet's activated
  // ability, once its `{1}, {T}` cost has already routed it away from `parseManaAbilityLine` —
  // that function refuses any cost paid in mana, so a rock with a mana activation cost falls
  // through to the ordinary stack-based ability path and needs its production line readable as
  // a ordinary effect too). Fixed symbols only: "Add {U} or {B}" is a player choice, a shape
  // `parseManaProduction`'s `MANA_CHOICE_RE` already owns for true mana abilities and which this
  // sentence-level path does not attempt to duplicate.
  // "Add one mana of any color." (Lotus Cobra) / "Add {R} or {G}." as a RESOLVING effect: a
  // trigger or a spell that adds mana uses the stack (CR 605.1b), so it is an effect, not a mana
  // ability. One mana, one color choice. "two mana of any one color" is all one color and is not
  // read here: `addMana` asks per mana.
  {
    if (s === 'add one mana of any color' || s === 'add one mana of any one color') {
      return [{ op: 'addMana', amount: constant(1), colors: 'any' }];
    }
    const choice = s.match(/^add (\{[wubrgc]\}(?:, \{[wubrgc]\})*,? or \{[wubrgc]\})$/);
    if (choice !== null) {
      const symbols = [...new Set(manaSymbols((choice[1] as string).replace(/,? or /g, '')))];
      if (symbols.length >= 2) return [{ op: 'addMana', amount: constant(1), colors: symbols }];
    }
  }
  {
    const m = s.match(MANA_ABILITY_RE);
    if (m) {
      const symbols = [...manaSymbols(m[1] as string)];
      return [
        { op: 'addMana', amount: constant(symbols.length), colors: [], fixedSymbols: symbols },
      ];
    }
  }
  // "tap up to one target creature and goad it" (Killian, Decisive Mentor): the same
  // variable-count slot; choosing nothing is legal.
  if (s === 'tap up to one target creature and goad it' && opts.allocCount !== undefined) {
    const targetSlot = opts.allocCount('creature', { min: 0, max: 1 });
    return [{ op: 'tapAndGoadEachChosen', targetSlot }];
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
  // "destroy target creature" / "exile target monocolored permanent" / "destroy target artifact you don't control" / …
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
  // modes) — the untargeted mass form, by tribe.
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
  // (Drakuseth, Maw of Flames) — a fixed hit plus a variable-count group of "other" targets,
  // each dealt the same fixed amount independently.
  {
    const m = s.match(
      /^(?:it|~) deals (\w+) damage to any target and (\w+) damage to each of up to (\w+) other targets$/,
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
  // under-permissive — see ADR 0010): only the creature half is offered.
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
  // "…to your hand" (Haven of the Spirit Dragon) / "return all artifact cards from your graveyard to the battlefield"
  {
    // "return target card from your graveyard to your hand" (Eternal Witness) has no type word
    // between "target" and "card" at all — the filter group is optional, and its absence means
    // an unrestricted `cardInGraveyard` slot (any card, CR 608.2b), not "any permanent card".
    const m = s.match(
      /^return (?:up to (\w+) )?(other |another )?target(?: (.+?))? (?:card|cards)(?: with mana value (\d+) or (less|greater))? from (your|a) graveyard to (the battlefield|your hand)$/,
    );
    if (m) {
      const typePhrase = m[3];
      const typeFilter = typePhrase === undefined ? null : parseCardFilterPhrase(typePhrase, card);
      // "with mana value 3 or less" (Sun Titan): a bound on the same graveyard card.
      const bound =
        m[4] === undefined
          ? undefined
          : m[5] === 'less'
            ? manaValueAtMost(Number(m[4]))
            : manaValueAtLeast(Number(m[4]));
      if (typePhrase === undefined || typeFilter !== null) {
        const typed =
          bound === undefined ? typeFilter : typeFilter === null ? bound : allOf(typeFilter, bound);
        // "another target artifact card" (Myr Retriever): any but the source, which a dies
        // trigger finds in the same graveyard (CR 109.2, the Body Launderer reading below).
        const filter = m[2] === undefined ? typed : typed === null ? OTHER : allOf(OTHER, typed);
        const target = alloc(
          'cardInGraveyard',
          filter ?? undefined,
          undefined,
          m[6] === 'a' ? 'any' : undefined,
        );
        return [
          m[7] === 'the battlefield'
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
      /^(destroy|exile|return) all (.+?)( to (?:its owner's hand|their owners' hands|their owner's hand))?$/,
    );
    // A return names its destination ("to their owner's hand", Aetherize); one without it is
    // some other zone change this production does not read.
    if (m && (m[1] !== 'return' || m[3] !== undefined)) {
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
  // "When this Aura is put into a graveyard from the battlefield, return it to its owner's hand"
  // (Fallen Ideal): "it" is the card the departed source became (CR 400.7e), looked for only in the
  // graveyard when every head puts it there.
  if (opts.departedSelf === true && s === "return it to its owner's hand")
    return [
      {
        op: 'returnDepartedSourceToHand',
        ...(opts.departedToGraveyard === true ? { fromGraveyard: true as const } : {}),
      },
    ];
  // "Each opponent attacking that player untaps all nonland permanents they control" (Curse of
  // Bounty): the attacking player, when that player is an opponent of this ability's controller.
  if (
    opts.enchantedPlayerAttacked === true &&
    s === 'each opponent attacking that player untaps all nonland permanents they control'
  )
    return [{ op: 'attackingOpponentUntapsNonland' }];
  // "When enchanted creature dies, return this card to its owner's hand" (Angelic Destiny): the
  // Aura card the source became once it followed its creature to the graveyard.
  if (opts.attachedDies === true && s === "return this card to its owner's hand")
    return [{ op: 'returnDepartedSourceToHand', fromGraveyard: true }];
  // "put those counters on ~" (The Ozolith): every counter the departed trigger object last had
  // (CR 603.10a), each kind and number, onto this ability's source, through counter-placement
  // replacements. Only a head that watches another object names "those counters".
  if (
    opts.triggerObject === true &&
    opts.departedTriggerObject === true &&
    s === 'put those counters on ~'
  )
    return [{ op: 'transferCountersFromTriggerObject', target: 'source' }];
  // "move all counters from ~ onto target creature" (The Ozolith): every kind (CR 122.5).
  {
    const m = s.match(/^move all counters from ~ onto target (.+)$/);
    if (m !== null) {
      const parsed = parseTargetClause(m[1] as string);
      if (parsed === null || parsed.kind !== 'creature') return null;
      return [
        {
          op: 'moveAllCounters',
          from: 'source',
          to: alloc(parsed.kind, parsed.filter, parsed.controller),
        },
      ];
    }
  }
  // "put those counters on target creature you control" (Iron Apprentice): every counter the
  // departed source last had (CR 603.10a), each kind and number, through counter-placement
  // replacements.
  {
    const m = s.match(/^put those counters on target (.+)$/);
    if (m !== null) {
      const parsed = parseTargetClause(m[1] as string);
      if (opts.departedSelf !== true || parsed === null || parsed.kind !== 'creature') return null;
      return [
        {
          op: 'transferCountersFromSource',
          target: alloc(parsed.kind, parsed.filter, parsed.controller),
        },
      ];
    }
  }
  // "you may put its +1/+1 counters on target artifact creature" (Modular, CR 702.43a): the
  // departed source's last-known counters of that one kind.
  {
    const m = s.match(/^put its ([+-]\d+\/[+-]\d+) counters on target (.+)$/);
    if (m !== null) {
      if (opts.departedSelf !== true) return null;
      // "target artifact creature": a creature slot narrowed to artifacts.
      const parsed =
        m[2] === 'artifact creature'
          ? { kind: 'creature' as const, filter: ofType('Artifact'), controller: undefined }
          : parseTargetClause(m[2] as string);
      if (parsed === null || parsed.kind !== 'creature') return null;
      return [
        {
          op: 'transferCountersFromSource',
          target: alloc(parsed.kind, parsed.filter, parsed.controller),
          counter: m[1] as string,
        },
      ];
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
      // "it" names the trigger's object. Anywhere else it refers back to an earlier sentence's
      // object (Match the Odds: "Create a 1/1 … token. Put a +1/+1 counter on it …"), which a
      // fresh target slot would silently retarget.
      if (m[3] === 'it' && opts.triggerObject !== true && opts.selfSubject !== true) return null;
      return m[3] === 'it' && opts.triggerObject === true
        ? [{ op: 'putCounters', target: 'triggerObject', counter, count }]
        : m[3] === '~' || m[3] === 'this creature' || m[3] === 'it'
          ? [{ op: 'putCountersEach', selector: SELF, counter, count }]
          : [{ op: 'putCounters', target: alloc('creature'), counter, count }];
    }
  }
  // "put a gold counter on this artifact" — a named counter on the ability's own source. Not a
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
    // Hateful Eidolon: the dying creature's last-known Auras whose controller is this ability's.
    if (
      opts.triggerObject === true &&
      s === 'draw a card for each aura you controlled that was attached to it'
    ) {
      return [{ op: 'draw', count: { kind: 'aurasYouControlledAttachedToTriggerObject' } }];
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
  // "… greatest power among non-Human creatures you control" (Return of the Wildspeaker).
  // Bounded to exclude a comma so a trailing ", then …" clause is left for the then-split
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
  // "create a 1/1 black and green Pest creature token with '…'" / "create that many Treasure
  // tokens" / "create a token that's a copy of it, except the token isn't legendary"
  {
    const beneficiary = s.match(/^target (opponent|player) creates? (.+)$/);
    if (beneficiary !== null) {
      const parsed = parseCreateTokenSentence(`create ${beneficiary[2] as string}`, card, opts);
      const token = parsed?.length === 1 && parsed[0]?.op === 'createToken' ? parsed[0] : null;
      if (token !== null) {
        return [
          {
            op: 'createTokenForPlayer',
            target: alloc(
              'player',
              undefined,
              beneficiary[1] === 'opponent' ? 'opponent' : undefined,
            ),
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
  // "Then if creatures you control have total power 10 or greater, draw a card." (Finneas): read
  // as the ability resolves, after the counters before it were put (CR 608.2c).
  {
    const m = s.match(
      /^(?:then )?if creatures you control have total power (\d+) or greater, (.+)$/,
    );
    const rest = m === null ? null : parseEffectSentence(m[2] as string, alloc, card, opts);
    if (m !== null && rest !== null)
      return [
        {
          op: 'conditionalEffect',
          condition: { kind: 'totalCreaturePower', scope: 'you', cmp: '>=', n: Number(m[1]) },
          then: rest,
          else: [],
        },
      ];
  }
  // "You draw X cards and gain X life, where X is …" (First Family).
  {
    const m = s.match(/^you draw x cards and gain x life, where x is (.+)$/);
    const amount = m === null ? null : parseDynamicCountValue(m[1] as string, card);
    if (amount !== null)
      return [
        { op: 'draw', count: amount },
        { op: 'gainLife', amount },
      ];
  }
  // "~ deals damage to each creature your opponents control equal to the total mana value of
  // other spells you've cast this turn" (Call Forth the Tempest).
  {
    const m = s.match(
      /^~ deals damage to each (.+?) equal to the total mana value of other spells you've cast this turn$/,
    );
    const selector = m === null ? null : parseMassSubject(m[1] as string, card);
    if (selector !== null)
      return [
        {
          op: 'damageEach',
          selector,
          amount: { kind: 'manaValueOfOtherSpellsCastThisTurn' },
        },
      ];
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

export function parseTriggerLine(line: string, card: OracleCard): Ability[] | null {
  let lower = line.toLowerCase();
  if (
    lower.replace(/\.$/, '') === REANIMATE_ATTACH_TRIGGER &&
    /^enchant creature card in a graveyard$/im.test(card.oracleText)
  )
    return [
      {
        kind: 'triggered',
        trigger: { when: 'enters', subject: SELF_SUBJECT },
        optional: false,
        targets: [],
        effects: [{ op: 'reanimateEnchantedCardAndAttach' }],
        description: line,
      },
    ];
  // Battalion: "Whenever ~ and at least two other creatures attack" is ~'s own attack trigger
  // with an attacker count on the event; the count is put back on the head below.
  const battalion = lower.match(/^whenever ~ and at least (\w+) other creatures attack, /);
  const otherAttackers = battalion === null ? null : parseAmount(battalion[1] as string);
  if (battalion !== null) {
    if (otherAttackers === null || otherAttackers < 1) return null;
    lower = `whenever ~ attacks, ${lower.slice(battalion[0].length)}`;
  }
  const firstLine = lower.split('\n')[0] as string;
  const continuation = lower.split('\n').slice(1).join('\n');

  // The head decides the event; the rest of the line is the effect (after an optional
  // intervening-if and an optional "you may").
  const head = parseTriggerHead(firstLine, card);
  if (head === null) return null;
  let heads = head.heads;
  let body = head.body;
  const implicitCondition = head.implicitCondition;
  const eventCondition = head.eventCondition;

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
  } else if (
    iff !== null &&
    iff[1] === 'it had counters on it' &&
    heads.every(
      (head) =>
        (head.when === 'dies' || head.when === 'leavesBattlefield') &&
        head.subject.kind === 'permanent' &&
        head.aggregate === undefined,
    )
  ) {
    // "Whenever a creature you control leaves the battlefield, if it had counters on it"
    // (The Ozolith): the departed trigger object's last-known counters (CR 603.10a), of any kind.
    // One departing object per firing, so not for an aggregate head.
    condition = { kind: 'triggerObjectMatches', selector: { kind: 'hasAnyCounter' } };
    body = iff[2] as string;
  } else if (iff !== null && iff[1] === '~ has counters on it') {
    // "if ~ has counters on it" (The Ozolith): any kind of counter on the ability's own source,
    // checked as it triggers and again as it resolves (CR 603.4).
    condition = { kind: 'sourceMatches', selector: { kind: 'hasAnyCounter' } };
    body = iff[2] as string;
  } else if (iff !== null && /^(?:it|~) had counters on it$/.test(iff[1] as string)) {
    // "When this creature dies, if it had counters on it" (Iron Apprentice): the departed
    // creature's last-known counters (CR 603.10a), of any kind. Only a self-departure head names
    // an object whose counters "it had" can mean.
    if (
      !heads.every(
        (head) =>
          (head.when === 'dies' || head.when === 'leavesBattlefield') &&
          head.subject.kind === 'self',
      )
    )
      return null;
    condition = { kind: 'sourceMatches', selector: { kind: 'hasAnyCounter' } };
    body = iff[2] as string;
  } else if (iff !== null) {
    const parsed = parseConditionClause(iff[1] as string, card);
    if (parsed === null) return null;
    condition = parsed;
    body = iff[2] as string;
  }
  // "This ability triggers only once each turn." (Mikey & Leo) — a limit on the object's
  // ability, kept on the head so every dispatcher of that event can honor it.
  {
    const once = body.match(/^([\s\S]+?)\.? this ability triggers only once each turn\.?$/);
    if (once !== null) {
      if (!heads.every((head) => 'subject' in head)) return null;
      heads = heads.map((head) => ({ ...head, oncePerTurn: true as const }));
      body = once[1] as string;
    }
  }
  if (otherAttackers !== null) {
    if (!heads.every((head) => head.when === 'attacks')) return null;
    heads = heads.map((head) => ({ ...head, withOtherAttackers: otherAttackers }));
  }
  // "Whenever a creature you control with a +1/+1 counter on it attacks, tap target creature
  // defending player controls" (Elite Scaleguard): for an attacks head the event player is the
  // player that creature is attacking (CR 506.3d), so the target clause reads as "that player".
  // Only the watched-creature head: self heads with this clause (Kogla) are still owned by their
  // reviewed overrides. Not an aggregate head either: "one or more creatures attack" can attack
  // several players at once, so it has no single defending player.
  if (
    / defending player controls\b/.test(body) &&
    heads.every(
      (head) =>
        head.when === 'attacks' &&
        'subject' in head &&
        head.subject.kind === 'permanent' &&
        head.aggregate === undefined,
    )
  ) {
    heads = heads.map((head) => ({ ...head, defendingPlayerIsEventPlayer: true as const }));
    body = body.replace(/ defending player controls\b/g, ' that player controls');
  }
  // "Whenever a creature dies, this artifact deals 2 damage to that creature's controller"
  // (Dingus Staff): the event player is the dying creature's controller as it last existed on
  // the battlefield (CR 603.10a). One dying creature per firing, so not for aggregate heads.
  if (
    / that creature's controller\b/.test(body) &&
    heads.every(
      (head) =>
        head.when === 'dies' &&
        'subject' in head &&
        head.subject.kind === 'permanent' &&
        head.aggregate === undefined,
    )
  )
    heads = heads.map((head) => ({ ...head, subjectControllerIsEventPlayer: true as const }));
  // "You may pay {R}{G}{W}{U}. When you do, …" (The Thing) / "Put a +1/+1 counter on ~. When you
  // do, …" (Lockjaw): a reflexive trigger (CR 603.12) whose ability announces its own targets
  // when it goes on the stack, after this one has resolved.
  let reflexive: Effect[] | null = null;
  {
    const m = body.match(/^(.+?)\. when you do, (.+?)\.?$/);
    const then = m === null ? null : parseReflexiveAbility(m[2] as string, card);
    if (m !== null && then !== null) {
      const action = m[1] as string;
      const pay = action.match(/^you may pay ((?:\{[^}]+\})+)$/);
      const put = action.match(
        /^put (a|an|one|two|three|four|five) ([+-]\d+\/[+-]\d+) counters? on ~$/,
      );
      if (pay !== null) {
        const parsed = parseManaCost((pay[1] as string).toUpperCase() as never);
        if (parsed.cost !== null && parsed.unsupportedSymbols.length === 0)
          reflexive = [{ op: 'mayPayManaThenReflexive', cost: parsed.cost, then }];
      } else if (put !== null) {
        const count = parseAmount(put[1] as string);
        if (count !== null)
          reflexive = [
            { op: 'putCountersOnSourceThenReflexive', counter: put[2] as string, count, then },
          ];
      } else if (/^create an? .+ token\b/.test(action)) {
        // "Create a … token. When you do, …" (Forum Filibuster): "that token" is the one created.
        const created = parseEffectSentence(action, () => -1, card, {});
        if (created !== null && created.length === 1 && created[0]?.op === 'createToken')
          reflexive = [created[0], { op: 'reflexiveOnCreatedToken', then }];
      }
    }
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
  // "you may pay {G}. If you do, draw a card." (Lifecrafter's Bestiary) / "you may pay 2 life. If
  // you do, …": the payment is offered as the ability resolves, and the rest happens only if it
  // was paid (CR 608.2c). Read once the body's own sentences are allocated (below).
  const paidThen =
    paidTransform === null && reflexive === null
      ? body.match(/^you may pay ((?:\{[^}]+\})+|\w+ life)\. if you do, (.+?)\.?$/)
      : null;
  let paidCondition: Condition | null = null;
  if (paidThen !== null) {
    const life = (paidThen[1] as string).match(/^(\w+) life$/);
    if (life !== null) {
      const n = parseAmount(life[1] as string);
      if (n !== null && n > 0) paidCondition = { kind: 'mayPayLife', n };
    } else {
      const parsed = parseManaCost((paidThen[1] as string).toUpperCase() as never);
      if (parsed.cost !== null && parsed.unsupportedSymbols.length === 0)
        paidCondition = { kind: 'mayPayMana', cost: parsed.cost };
    }
    if (paidCondition === null) return null;
    body = paidThen[2] as string;
  }
  // "you may move any number of … counters" (Forgotten Ancient) is one choice, zero included: the
  // division is the decline, so it is not also a "use this ability?" prompt.
  let optional =
    paidTransform === null &&
    reflexive === null &&
    paidCondition === null &&
    body.startsWith('you may ') &&
    !body.startsWith('you may move any number of ');
  if (body.startsWith('you may have ')) {
    optional = true;
    body = body
      .slice('you may have '.length)
      .replace(/^this (creature|artifact|enchantment|land|permanent)\b/, '~')
      .replace(/^~ deal\b/, '~ deals');
  } else if (optional) {
    body = body.slice('you may '.length);
    // "You may draw two cards. If you do, discard a card." (Mask of Memory): accepting the
    // optional draw is what "if you do" asks about, so the follow-up rides on the same yes.
    const drawThen = body.match(/^(draw (?:a card|\w+ cards))\. if you do, (.+)$/);
    if (drawThen !== null) body = `${drawThen[1]}. ${drawThen[2]}`;
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
  // A variable-count slot ("up to two other targets", "any number of target creatures") — see
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
    selfSubject: heads.every((head) => 'subject' in head && head.subject.kind === 'self'),
    eventPlayer: heads.every((head) => triggerProvidesEventPlayer(head.when)),
    departedSelf: heads.every(
      (head) =>
        (head.when === 'dies' || head.when === 'leavesBattlefield') &&
        'subject' in head &&
        head.subject.kind === 'self',
    ),
    departedTriggerObject: heads.every(
      (head) =>
        (head.when === 'dies' || head.when === 'leavesBattlefield') &&
        'subject' in head &&
        head.subject.kind === 'permanent' &&
        head.aggregate === undefined,
    ),
    departedToGraveyard: heads.every(
      (head) =>
        'subject' in head &&
        head.subject.kind === 'self' &&
        (head.when === 'dies' ||
          (head.when === 'leavesBattlefield' &&
            'leavesTo' in head &&
            head.leavesTo?.length === 1 &&
            head.leavesTo[0] === 'graveyard')),
    ),
    enchantedPlayerAttacked: heads.every((head) => head.when === 'enchantedPlayerAttacked'),
    attachedDies: heads.every(
      (head) =>
        head.when === 'dies' &&
        'subject' in head &&
        head.subject.kind === 'permanent' &&
        head.subject.selector.kind === 'attachedToSource',
    ),
    allocCount,
    // What "that many" refers back to. A combat-damage head makes it the damage; an aggregate
    // head makes it the number of objects. See `parseCountPhrase`.
    // A life-gain or life-loss head carries its amount the same way ("that much life").
    ...(firstHead.when === 'dealsCombatDamageToPlayer' ||
    firstHead.when === 'gainsLife' ||
    firstHead.when === 'losesLife'
      ? { thatMany: { kind: 'damageDealt' } as Value }
      : 'aggregate' in firstHead && firstHead.aggregate === true
        ? { thatMany: { kind: 'triggerCount' } as Value }
        : {}),
  };

  // A whole-body pattern first: some effects span several sentences that only mean anything
  // together ("look at the top eight … put the rest …", Klauth's mana-then-restriction-then-
  // persistence).
  let effects: Effect[] | null =
    reflexive ??
    paidTransform ??
    (modalBlock === null
      ? (parseBlinkChosenBlock(body, allocCount) ??
        parseExileFaceDownPlayableBlock(
          body,
          alloc,
          heads.every((head) => head.when === 'dealsCombatDamageToPlayer'),
        ) ??
        parseLookAtTopBlock(body, card) ??
        parseExileTopPlayableBlock(body) ??
        parseAddManaTriggerBlock(body, card) ??
        parseHellkiteCourserBlock(body, alloc, card) ??
        parseDoublePowerThoseGainBlock(body) ??
        parseDepartedSourceToLibraryBlock(body, heads) ??
        parseResolutionCountBlock(body, line, alloc, card, opts) ??
        parseSacrificeSelfIfYouDoBlock(body, alloc, card, opts) ??
        parseCountersThenTheyGainBlock(body, card) ??
        parseExileReturnAtNextEndStepBlock(body, alloc) ??
        parseReanimateHasteExileAtEndStepBlock(body, alloc))
      : []);
  if (effects === null) {
    effects = [];
    let lastTarget: number | undefined;
    let lastPlayerTarget: number | undefined;
    for (const [index, sentence] of splitSentences(body).entries()) {
      const slotsBefore = targets.length;
      // A later sentence's "it" may name an object an earlier one made ("create a token. Put a
      // +1/+1 counter on it"), so only the first sentence reads a bare "it" as the source.
      // After a sentence that created a token, "it" is that token (Krenko, Baron of Tin Street:
      // "create a 1/1 … token. It gains haste"), never the trigger's object or the source.
      // A sentence that names its referent first ("If that enchantment is an Aura, … attach it")
      // is left alone; one that opens with a bare "It" right after the token is about the token.
      const afterToken =
        /^it\b/i.test(sentence) && effects.some((effect) => effect.op === 'createToken');
      const sentenceOpts =
        index === 0
          ? opts
          : {
              ...opts,
              selfSubject: false,
              ...(afterToken ? { triggerObject: false, afterToken: true } : {}),
              ...(lastTarget !== undefined ? { lastTarget } : {}),
              ...(lastPlayerTarget !== undefined ? { lastPlayerTarget } : {}),
            };
      const parsed = parseEffectSentence(sentence, alloc, card, sentenceOpts);
      if (parsed === null) return null;
      lastTarget = soleTargetSince(targets, slotsBefore);
      lastPlayerTarget = solePlayerTargetSince(targets, slotsBefore);
      appendSentenceEffects(effects, sentence, parsed);
    }
  }
  if (effects.length === 0 && modalBlock === null) return null;
  if (paidCondition !== null) {
    if (modalBlock !== null) return null;
    effects = [{ op: 'conditionalEffect', condition: paidCondition, then: effects, else: [] }];
  }

  return heads.map((head) => ({
    kind: 'triggered' as const,
    trigger: {
      ...head,
      ...(condition !== undefined ? { condition } : {}),
      ...(eventCondition !== undefined ? { eventCondition } : {}),
    } as TriggerSpec,
    optional,
    targets,
    effects,
    ...(modalBlock !== null ? { modes: modalBlock.modes } : {}),
    description: line,
  }));
}

/** `parseEffectSentenceUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseEffectSentence(
  ...args: Parameters<typeof parseEffectSentenceUntraced>
): ReturnType<typeof parseEffectSentenceUntraced> {
  const lower = args[0].toLowerCase().replace(/’/g, "'");
  // After a sentence that targeted one player, "that player" / "they" is that player, not the
  // event's: read it only where that referent is honored, and refuse it anywhere else.
  if (args[3]?.lastPlayerTarget !== undefined && /^(?:that player|they)\b/.test(lower)) {
    const bound =
      parsePlayerVerbSentence(lower, args[1], args[2], args[3]) ??
      parseDamageSentence(lower, args[1], args[2], args[3]);
    if (bound === null) noteSlotFailure('effect', args[0]);
    return bound;
  }
  const result =
    parseEffectSentenceUntraced(...args) ??
    parsePlayerVerbSentence(lower, args[1], args[2], args[3] ?? {}) ??
    parseDamageSentence(lower, args[1], args[2], args[3] ?? {}) ??
    parseBatch4Forms(lower, args[1], args[2], args[3] ?? {}) ??
    parseAmountForm(...args);
  if (result === null) noteSlotFailure('effect', args[0]);
  return result;
}

/**
 * Short sentence shapes over existing ops (EDHREC plan Phase 4 batch 4), tried only once the
 * sentence-level parse fails.
 */
function parseBatch4Forms(
  s: string,
  alloc: SlotAllocator,
  card: OracleCard,
  opts: { selfSubject?: boolean },
): Effect[] | null {
  // "Each player sacrifices a creature of their choice" (Fleshbag Marauder): APNAP choices, then
  // every chosen creature is sacrificed at once (CR 101.4).
  if (/^each player sacrifices a creature(?: of their choice)?$/.test(s)) {
    return [{ op: 'sacrificeEachPlayer', count: 1, filter: 'creature' }];
  }
  // "Target creature you control gains shroud until end of turn" (Sylvan Safekeeper) / "another
  // target creature you control gains indestructible until end of turn" (Selfless Savior): any
  // creature target the target grammar reads, one grant per keyword.
  {
    const m = s.match(/^(another )?target (.+?) gains ([a-z ,]+) until end of turn$/);
    const clause = m === null ? null : parseTargetClause(`${m[1] ?? ''}${m[2] as string}`);
    const listed = m === null ? null : parseKeywordLine(m[3] as string);
    if (
      m !== null &&
      clause !== null &&
      clause.kind === 'creature' &&
      listed !== null &&
      listed.keywords.length > 0 &&
      listed.ward === undefined &&
      listed.protectionFrom === undefined
    ) {
      const target = alloc(clause.kind, clause.filter, clause.controller);
      return listed.keywords.map((keyword) => ({ op: 'grantKeywordUntilEot', target, keyword }));
    }
  }
  // "Untap target Forest" (Arbor Elf) / "Tap target permanent" / "untap target legendary
  // permanent" (Minamo): any target noun the target grammar reads, never a player.
  {
    const m = s.match(/^(untap|tap) (another )?target (.+)$/);
    const clause = m === null ? null : parseTargetClause(`${m[2] ?? ''}${m[3] as string}`);
    if (m !== null && clause !== null && clause.kind !== 'player' && clause.kind !== 'spell') {
      const target = alloc(clause.kind, clause.filter, clause.controller);
      return [{ op: m[1] === 'untap' ? 'untapTarget' : 'tapTarget', target }];
    }
  }
  // "When this Equipment enters, attach it to target creature you control" (Maul of the
  // Skyclaves): "it" is the entering Equipment itself (CR 301.5).
  if (
    opts.selfSubject === true &&
    card.subtypes.includes('Equipment') &&
    s === 'attach it to target creature you control'
  ) {
    return [{ op: 'attachSelfTo', target: alloc('creature', undefined, 'you') }];
  }
  return null;
}

/**
 * The amount forms of `amount-forms.ts`, tried only once the sentence itself did not parse:
 * "…, where X is V", "<verb> … equal to V" and "<effect> for each N". The wrapped sentence is
 * parsed with an ordinary amount, which is then replaced by the counted value.
 */
function parseAmountForm(
  ...args: Parameters<typeof parseEffectSentenceUntraced>
): ReturnType<typeof parseEffectSentenceUntraced> {
  const [sentence, alloc, card, opts] = args;
  const s = sentence.toLowerCase().replace(/’/g, "'");
  // A card that announces no X still reads "x" in the wrapped sentence: X is defined right here.
  const withX: OracleCard = (card.manaCost ?? '').includes('{X}')
    ? card
    : { ...card, manaCost: `{X}${card.manaCost ?? ''}` };
  const bound = (body: string, valuePhrase: string): Effect[] | null => {
    const value = parseDynamicCountValue(valuePhrase, card, opts);
    if (value === null) return null;
    const parsed = parseEffectSentence(body, alloc, withX, { ...opts, xBound: true });
    if (parsed === null) return null;
    const { effects, replaced } = bindX(parsed, value);
    return replaced > 0 ? effects : null;
  };
  const where = s.match(/^(.+), where x is (.+)$/);
  if (where !== null) return bound(where[1] as string, where[2] as string);
  const equal = rewriteEqualTo(s);
  if (equal !== null) return bound(equal.body, equal.value);
  const forEach = s.match(/^(.+?) for each (.+)$/);
  if (forEach !== null && !/\bfor each\b/.test(forEach[2] as string)) {
    const per = parseForEachCount(forEach[2] as string, card);
    if (per === null) return null;
    const parsed = parseEffectSentence(forEach[1] as string, alloc, card, opts);
    return parsed === null ? null : scaleByCount(parsed, per);
  }
  return null;
}
