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
import { graveyardAlternativeCost } from './effect-builders';
import type { Color, OracleCard } from '@mtg/shared';
import { enforceInterpretedDefinition } from './overload';
import { offsetEffectSlots } from './effect-reference-contracts';
import { colorsOfManaCost, combinedManaCost, emptyCost, parseManaCost } from '../mana/cost';
import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type { AbilityCost, ActivatedAbility, AlternativeCast, MdfcLandFace } from './ability';
import { transformDefinition } from '../testing/definition-transform';
import { SELF_SUBJECT } from './ability';
import type { Ability, Effect, KeywordAbility, TargetSpec, TokenSpec } from './ability';
import { parseEntersAsCopy } from './grammar/copy';
import {
  COLOR_WORDS,
  KEYWORD_SET,
  parseAmount,
  resolveSubtype,
  SELF_OBJECT_RE,
  titleCase,
} from './grammar/words';
import {
  ANY_SPELL,
  parseCardFilterPhrase,
  parseMassSubject,
  parseSpellFilter,
  parseSubject,
  parseTargetClause,
  parseTriggerSubject,
} from './grammar/subject';
import type { SlotAllocator } from './grammar/subject';
import { parseCountPhrase, parseDynamicCountValue } from './grammar/amount';
import {
  parseActivationCondition,
  parseConditionClause,
  parseEntersUnlessClause,
} from './grammar/condition';
import {
  parseActivationCosts,
  parseGraveyardAlternativeCosts,
  parseNonManaAlternativeCost,
  parseSpellAdditionalCost,
  splitActivation,
} from './grammar/cost';
import {
  ANTHEM_RE,
  appendSentenceEffects,
  MANA_ABILITY_RE,
  manaSymbols,
  parseCreateTokenSentence,
  parseEffectSentence,
  parseExileReturnAtNextEndStepBlock,
  parseKeywordLine,
  parseExileFaceDownPlayableBlock,
  parseLookAtTopBlock,
  parseManaSpendClause,
  parseModalSpellBlock,
  parseTokenFace,
  parseTriggerLine,
  splitSentences,
} from './grammar/effect';
import { collectSlotDiagnostics, type SlotFailure } from './grammar/diagnostics';
import type { Condition } from './condition';
import { countPermanents } from './condition';
import { CREATURE_TYPES } from './creature-types';
import type { ProtectionQuality, StaticEffect } from './continuous-types';
import type { RuleStatic } from './rule-statics';
import type { Selector } from './selector';
import {
  CHOSEN_SUBTYPE,
  ENTERED_THIS_TURN,
  IS_COMMANDER,
  NONBASIC_LANDS,
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
import {
  costReductionFor,
  mana,
  manaCost,
  onAttacks,
  onCast,
  onCombatDamageToPlayer,
  onDies,
  onEtb,
  TAP,
  triggered,
  whenEnters,
  whenPermanent,
} from './templates';
import { SOLDIER_1_1, TREASURE } from './tokens';
// Use the explicit module path so the registry imported by authored override modules and the
// interpreter share one module instance under Bun/TypeScript path resolution.
import { applyOverride, getOverride } from './overrides/index';
import type { BackFace, CardDefinition, ManaAbilitySpec } from './definition';

/** Basic land subtypes â†’ intrinsic mana ability (CR 305.6). */
const BASIC_LAND_MANA: Record<string, ManaUnit> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: ['C'],
};

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
/**
 * "Creatures you control gain indestructible until end of turn.\nAddendum — If you cast this
 * spell during your main phase, put a +1/+1 counter on each of those creatures and they gain
 * vigilance until end of turn." (Unbreakable Formation). Read as one block because "those
 * creatures" is the first line's set: fixed as the spell resolves (CR 611.2c), the same
 * creatures you control when the Addendum half applies a moment later.
 */
function parseAddendumMassBlock(text: string): { targets: TargetSpec[]; effects: Effect[] } | null {
  const lines = text
    .toLowerCase()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 2) return null;
  const first = (lines[0] as string).match(
    /^creatures you control gain (\w+) until end of turn\.?$/,
  );
  const second = (lines[1] as string).match(
    /^(?:addendum \u2014 )?if you cast this spell during your main phase, put a \+1\/\+1 counter on each of those creatures and they gain (\w+) until end of turn\.?$/,
  );
  if (first === null || second === null) return null;
  const keywordA = first[1] as KeywordAbility;
  const keywordB = second[1] as KeywordAbility;
  if (!KEYWORD_SET.has(keywordA) || !KEYWORD_SET.has(keywordB)) return null;
  const creatures = allOf(YOURS, ofType('Creature'));
  return {
    targets: [],
    effects: [
      { op: 'grantKeywordEachUntilEot', selector: creatures, keyword: keywordA },
      {
        op: 'conditionalEffect',
        condition: { kind: 'castDuringYourMainPhase' },
        then: [
          { op: 'putCountersEach', selector: creatures, counter: '+1/+1', count: 1 },
          { op: 'grantKeywordEachUntilEot', selector: creatures, keyword: keywordB },
        ],
        else: [],
      },
    ],
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

/**
 * Parse a full line as one or more triggered abilities. Returns null when unrecognized.
 *
 * A list, not a single ability, because one printed line can be two triggers: "Whenever Ureni
 * enters **or attacks**" is two separate triggered abilities with the same effect (CR 603.1),
 * and modeling it as one would make it fire once when it should fire twice.
 */
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
 * The reveal lands (CR 701.20a): "As this land enters, you may reveal an Island or Swamp card from
 * your hand. If you don't, this land enters tapped." (Choked Estuary, the Snarls) and the older
 * "~ enters tapped unless you reveal a Plains or Swamp card from your hand." Both are the same
 * as-enters choice, offered only while the hand holds a card of one of the named subtypes.
 */
const ENTERS_REVEAL_RE =
  /^as (?:~|this land) enters, you may reveal an? (\w+)(?: or (?:an? )?(\w+))? card from your hand\. if you don't, (?:~|this land|it) enters tapped$/;

function parseEntersRevealChoice(lower: string, card: OracleCard): Condition | null {
  const m =
    lower.match(ENTERS_REVEAL_RE) ??
    lower.match(
      /^(?:~|this land) enters (?:the battlefield )?tapped unless you reveal an? (\w+)(?: or (?:an? )?(\w+))? card from your hand$/,
    );
  if (m === null) return null;
  const subtypes: string[] = [];
  for (const word of [m[1], m[2]]) {
    if (word === undefined) continue;
    const subtype = resolveSubtype(titleCase(word), card);
    if (subtype === null) return null;
    subtypes.push(subtype);
  }
  return { kind: 'mayRevealCardFromHand', subtypes };
}

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

/** "{T}: Add {G}{G}. You gain 2 life." (The Great Henge): a mana ability with a life rider. */
const MANA_WITH_LIFE_GAIN_RE = /^(add [^.]+)\. you gain (\d+) life$/;

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
 * Mana production this parser deliberately refuses, with a distinct reason so the coverage
 * report can rank it. Each of these looks cheap to support and would silently produce mana the
 * player cannot legally spend â€” over-permissive modeling is worse than none (brief Â§6.3).
 */
const UNSUPPORTED_MANA_RE =
  /^add (two|three|\w+) mana|^add one mana of any (?!color$)|spend this mana only/;

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
  // The same with a life gain: still a mana ability (CR 605.1a), so the life is gained as the
  // mana is produced, without using the stack (CR 605.3a).
  {
    const m = effectText.match(MANA_WITH_LIFE_GAIN_RE);
    if (m) {
      const base = parseManaProduction(m[1] as string, card);
      if (base !== null)
        return { ...base, onActivate: [{ op: 'gainLife', amount: constant(Number(m[2])) }] };
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
  // A modal activation arrives as its header line plus the bullet lines. Its "Activate only …"
  // restrictions trail the header ("{4}, {T}: Choose one. Activate only as a sorcery." —
  // Aetheric Amplifier), so they are stripped from that first line; the bullets rejoin after.
  const newline = line.indexOf('\n');
  const modeLines = newline < 0 ? '' : line.slice(newline).toLowerCase();
  let lower = (newline < 0 ? line : line.slice(0, newline)).toLowerCase().replace(/\.$/, '');
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
  // The header keeps its own punctuation: "choose one —" as printed, "choose one." restored.
  if (modeLines !== '') lower = `${lower}${/[\u2014-]$/.test(lower) ? '' : '.'}${modeLines}`;

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
      // "~ gets +2/+2 for each Aura attached to it" (Kor Spiritdancer): "it" is the source.
      const count: Value | null =
        (m[1] as string) === '~' && (m[4] as string) === 'aura attached to it'
          ? { kind: 'aurasAttachedToSource' }
          : parseDynamicCountValue('the number of ' + (m[4] as string), card);
      if (affects !== null && count !== null) {
        // "-X/-X" keeps its sign: the count is negated, never applied as a bonus.
        const signed = (part: string): Value =>
          part.toLowerCase().includes('x')
            ? part.startsWith('-')
              ? { kind: 'negate', of: count }
              : count
            : { kind: 'times' as const, of: count, n: Number(part) };
        const power = signed(m[2] as string);
        const toughness = signed(m[3] as string);
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
      // "This creature gets -X/-X, where X is your life total" (Death's Shadow): the sign stays.
      const signed = (part: string): Value | null =>
        count === null ? null : part.startsWith('-') ? { kind: 'negate', of: count } : count;
      const power = signed(m[2] as string);
      const toughness = signed(m[3] as string);
      if (affects !== null && power !== null && toughness !== null)
        return [{ affects, op: { layer: 7, sublayer: 'd', power, toughness } }];
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
  // "~ attacks each combat if able" (Toski, Darksteel Juggernaut) and "enchanted creature attacks
  // each combat if able": a requirement (CR 508.1d) on the source or the creature it is attached to.
  {
    const m = lower.match(/^(.+?) attacks? each combat if able$/);
    const subject = m === null ? null : (m[1] as string);
    const affects: Selector | null =
      subject === null
        ? null
        : SELF_OBJECT_RE.test(subject)
          ? SELF
          : subject === 'enchanted creature' || subject === 'equipped creature'
            ? { kind: 'attachedToSource' }
            : null;
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
  // "This creature and enchanted creature each get +1/+1 for each creature you control and +1/+1
  // for each Aura you control" (Eidolon of Countless Battles): two additive buffs to the same
  // pair, the source itself and whatever it enchants while bestowed.
  {
    const m = lower.match(
      /^~ and enchanted creature each get \+(\d+)\/\+(\d+) for each creature you control and \+(\d+)\/\+(\d+) for each aura you control$/,
    );
    if (m !== null) {
      const affects = anyOf(SELF, { kind: 'attachedToSource' });
      const perCreature: Value = {
        kind: 'countPermanents',
        selector: ofType('Creature'),
        scope: 'you',
      };
      const perAura: Value = { kind: 'countPermanents', selector: ofSubtype('Aura'), scope: 'you' };
      const buff = (count: Value, p: string, t: string): StaticEffect => ({
        affects,
        op: {
          layer: 7,
          sublayer: 'd',
          power: { kind: 'times', of: count, n: Number(p) },
          toughness: { kind: 'times', of: count, n: Number(t) },
        },
      });
      return [
        buff(perCreature, m[1] as string, m[2] as string),
        buff(perAura, m[3] as string, m[4] as string),
      ];
    }
  }
  // "Enchanted creature gets +10/+10 and has trample and annihilator 2" (Eldrazi Conscription):
  // annihilator is a triggered ability (CR 702.86a), granted as one in layer 6.
  {
    const m = lower.match(
      /^(enchanted|equipped) creature gets ([+-]\d+)\/([+-]\d+) and has ([a-z ,]+?) and annihilator (\d+)$/,
    );
    const parsed = m === null ? null : parseKeywordLine(m[4] as string);
    if (
      m !== null &&
      parsed !== null &&
      parsed.ward === undefined &&
      parsed.protectionFrom === undefined
    ) {
      const affects: Selector = { kind: 'attachedToSource' };
      const n = Number(m[5]);
      return [
        { affects, op: { layer: 7, sublayer: 'd', power: Number(m[2]), toughness: Number(m[3]) } },
        ...parsed.keywords.map((keyword): StaticEffect => ({
          affects,
          op: { layer: 6, addKeyword: keyword },
        })),
        {
          affects,
          op: {
            layer: 6,
            addTrigger: {
              kind: 'triggered',
              trigger: {
                when: 'attacks',
                subject: SELF_SUBJECT,
                defendingPlayerIsEventPlayer: true,
              },
              optional: false,
              targets: [],
              effects: [{ op: 'eventPlayerSacrificesPermanents', count: n }],
              description: `Annihilator ${n}`,
            },
          },
        },
      ];
    }
  }
  // "Enchanted creature gets +4/+4, has flying and first strike, and is an Angel in addition to
  // its other types" (Angelic Destiny): the creature type is a layer-4 addition (CR 205.1b), the
  // keywords layer 6 and the stats the same P/T modification sublayer as every attached buff.
  {
    const m = lower.match(
      /^(enchanted|equipped) creature gets ([+-]\d+)\/([+-]\d+), has ([a-z ]+?), and is an? ([a-z]+) in addition to its other types$/,
    );
    if (m !== null) {
      const affects: Selector = { kind: 'attachedToSource' };
      const subtype = titleCase(m[5] as string);
      const parsed = parseKeywordLine(m[4] as string);
      if (
        CREATURE_TYPES.includes(subtype) &&
        parsed !== null &&
        parsed.keywords.length > 0 &&
        parsed.ward === undefined &&
        parsed.protectionFrom === undefined
      )
        return [
          { affects, op: { layer: 4, addSubtypes: [subtype] } },
          ...parsed.keywords.map((keyword): StaticEffect => ({
            affects,
            op: { layer: 6, addKeyword: keyword },
          })),
          {
            affects,
            op: { layer: 7, sublayer: 'd', power: Number(m[2]), toughness: Number(m[3]) },
          },
        ];
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
    // "Enchanted creature has flying and \"Sacrifice a creature: ...\"" (Fallen Ideal): printed
    // keywords ahead of the quoted ability are granted alongside it.
    const m = lower.match(/^(enchanted|equipped) creature has (?:([a-z ,]+?) and )?"(.+)"$/);
    if (m) {
      const affects: Selector = { kind: 'attachedToSource' };
      const keywordGrants: StaticEffect[] = [];
      if (m[2] !== undefined) {
        const parsed = parseKeywordLine(m[2] as string);
        if (
          parsed === null ||
          parsed.ward !== undefined ||
          parsed.protectionFrom !== undefined ||
          parsed.keywords.length === 0
        )
          return null;
        for (const keyword of parsed.keywords)
          keywordGrants.push({ affects, op: { layer: 6, addKeyword: keyword } });
      }
      const text = (m[3] as string).replace(/\.$/, '');
      // A granted mana ability (Karametra's Favor's "{T}: Add one mana of any color"): the
      // enchanted creature taps for it, so summoning sickness applies to it (CR 302.6).
      const mana = parseManaAbilityLines(text, card);
      if (mana !== null && mana.length === 1)
        return [
          ...keywordGrants,
          { affects, op: { layer: 6, addManaAbility: mana[0] as ManaAbilitySpec } },
        ];
      const act = parseActivatedLine(text, card);
      if (act !== null) {
        return [...keywordGrants, { affects, op: { layer: 6, addActivatedAbility: act } }];
      }
      const tr = parseTriggerLine(text, card);
      if (tr !== null && tr.length > 0) {
        return [
          ...keywordGrants,
          ...tr.map((ability) => ({ affects, op: { layer: 6 as const, addTrigger: ability } })),
        ];
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
  if (lower === 'prevent all combat damage that would be dealt to this creature') {
    return [{ kind: 'preventCombatDamageToSelf' }];
  }
  // Affinity for [permanent type] (CR 702.41a): costs {1} less for each such permanent you control.
  const affinity = lower.match(/^affinity for (artifacts|planeswalkers)$/);
  if (affinity !== null) {
    return [
      {
        kind: 'costReduction',
        amount: {
          kind: 'countPermanents',
          selector: allOf(ofType(affinity[1] === 'artifacts' ? 'Artifact' : 'Planeswalker'), YOURS),
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
  // "Untap all permanents you control during each other player's untap step." (Seedborn Muse):
  // part of every other player's untap step (CR 502.3), so a rule static, never a trigger.
  {
    if (
      /^untap (?:~|this (?:artifact|creature|land|permanent)) during each other player's untap step$/.test(
        lower,
      )
    )
      return [{ kind: 'untapDuringOthersUntapSteps', filter: SELF }];
    const m = lower.match(/^untap all (.+?) you control during each other player's untap step$/);
    if (m !== null) {
      if (m[1] === 'permanents') return [{ kind: 'untapDuringOthersUntapSteps' }];
      const filter = parseMassSubject(m[1] as string, card);
      if (filter === null) return null;
      return [{ kind: 'untapDuringOthersUntapSteps', filter }];
    }
  }
  // "Creature spells of the chosen type cost {2} less to cast." (Urza's Incubator), "Spells cost
  // {1} less to cast." (Helm of Awakening): no "you cast", so every player's spells.
  {
    const m = lower.match(
      /^((?:.+ )?spells?(?: of the chosen type)?) cost \{(\d+)\} less to cast$/,
    );
    if (m !== null && !/\byou cast\b/.test(m[1] as string)) {
      const parsed = parseSpellFilter(m[1] as string, card);
      if (parsed === null) return null;
      const filter = parsed === ANY_SPELL ? undefined : parsed;
      return [
        {
          kind: 'costReduction',
          amount: constant(Number(m[2])),
          ...(filter === undefined ? {} : { filter }),
          allPlayers: true,
        },
      ];
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
 * Parse the land face of a spell // land or permanent // land modal DFC (Witch Enchanter //
 * Witch-Blessed Meadow). The back face is deliberately represented as an alternate cast rather
 * than a second CardDefinition: it is playable from hand, but only as a land, and its front face
 * remains the spell used by the normal casting path. A permanent played this way has only the land
 * face's characteristics (CR 712.8f, `landFacePermanentDefinition`), so none of the front face's
 * abilities reach it.
 */
function buildMdfcLandFace(card: OracleCard): AlternativeCast | null {
  const back = card.backFace;
  if (card.layout !== 'modal_dfc' || back === undefined || card.types.includes('Land')) return null;

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
const FUSE_REMINDER = /^Fuse \(You may cast one or both halves of this card from your hand\.\)$/;

/**
 * A split card whose halves are both instants or sorceries (CR 709). Each half is interpreted
 * as its own card and cast as an alternative face; the card itself, everywhere but the stack,
 * has the two halves' characteristics combined (CR 709.4). With fuse, both halves may be cast
 * together from hand: the fused spell has the combined characteristics, its targets are the
 * left half's then the right half's, and it follows the left half's instructions first (CR
 * 702.102). Rooms (split permanents) are not handled here.
 */
function interpretSplitCard(card: OracleCard): CardDefinition | null {
  const back = card.backFace;
  const names = card.name.split(' // ');
  const rawCosts = (card.manaCost ?? '').split(' // ');
  const costs =
    back !== undefined && card.layout === 'split' && rawCosts.length !== 2
      ? [card.manaCost ?? '', back.manaCost ?? '']
      : rawCosts;
  const rawTypeLines = card.typeLine.split(' // ').map((line) => line.trim());
  const typeLines =
    back !== undefined && card.layout === 'split' && rawTypeLines.length !== 2
      ? [card.typeLine.trim(), back.typeLine.trim()]
      : rawTypeLines;
  if (back === undefined || names.length !== 2 || costs.length !== 2 || typeLines.length !== 2)
    return null;
  if (!typeLines.every((line) => line === 'Instant' || line === 'Sorcery')) return null;
  const fuse = card.keywords.includes('Fuse');
  const halfText = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !(fuse && FUSE_REMINDER.test(line.trim())))
      .join('\n');
  const half = (suffix: string, index: 0 | 1, oracleText: string): CardDefinition => {
    const cost = costs[index]!.trim();
    return interpretOracleCard({
      oracleId: `${card.oracleId}:${suffix}` as OracleCard['oracleId'],
      scryfallId: card.scryfallId,
      name: names[index]!,
      manaCost: cost as OracleCard['manaCost'],
      cmc: 0,
      colors: colorsOfManaCost(parseManaCost(cost as OracleCard['manaCost']).cost),
      colorIdentity: [...card.colorIdentity],
      typeLine: typeLines[index]!,
      supertypes: [],
      types: [typeLines[index]!],
      subtypes: [],
      oracleText: halfText(oracleText),
      power: null,
      toughness: null,
      loyalty: null,
      defense: null,
      keywords: [],
      layout: 'normal',
      commanderLegality: card.commanderLegality,
      isBasicLand: false,
    });
  };
  const left = half('left', 0, card.oracleText);
  const right = half('right', 1, back.oracleText);
  const reasons = [
    ...left.unmodeledReasons.map((reason) => `${left.name}: ${reason}`),
    ...right.unmodeledReasons.map((reason) => `${right.name}: ${reason}`),
  ];
  const halvesCastable =
    left.manaCost !== null &&
    right.manaCost !== null &&
    left.spellAbility?.kind === 'spell' &&
    right.spellAbility?.kind === 'spell';
  if (!halvesCastable && reasons.length === 0) reasons.push('split half has no executable spell');
  const combinedCost =
    left.manaCost !== null && right.manaCost !== null
      ? combinedManaCost(left.manaCost, right.manaCost)
      : null;
  const types = [...new Set([...left.types, ...right.types])];
  const alternativeCasts: AlternativeCast[] = [];
  for (const face of [left, right]) {
    if (face.manaCost === null || face.spellAbility === null) continue;
    alternativeCasts.push({
      kind: 'split',
      manaCost: face.manaCost,
      name: face.name,
      typeLine: face.typeLine,
      description: face.name,
      ability: face.spellAbility,
      spellFace: face,
    });
  }
  if (fuse && halvesCastable && combinedCost !== null) {
    const leftAbility = left.spellAbility!;
    const rightAbility = right.spellAbility!;
    const offset = leftAbility.targets.length;
    const rightEffects = rightAbility.effects.map((effect) => offsetEffectSlots(effect, offset));
    const slotLinked = (spec: TargetSpec): boolean =>
      spec.graveyardOwnerSlot !== undefined ||
      spec.differentPlayerTargetSlots !== undefined ||
      spec.perPlayer === true;
    if (
      leftAbility.modes !== undefined ||
      rightAbility.modes !== undefined ||
      rightEffects.some((effect) => effect === undefined) ||
      [...leftAbility.targets, ...rightAbility.targets].some(slotLinked) ||
      (leftAbility.targets.some((spec) => spec.count !== undefined) &&
        rightAbility.targets.some((spec) => spec.count === undefined))
    ) {
      reasons.push('fused split halves whose targets cannot be laid side by side');
    } else {
      const spellAbility: Ability = {
        kind: 'spell',
        targets: [...leftAbility.targets, ...rightAbility.targets],
        effects: [...leftAbility.effects, ...(rightEffects as Effect[])],
        description: `${leftAbility.description ?? left.name}, then ${rightAbility.description ?? right.name}`,
      };
      const fusedFace: CardDefinition = {
        ...left,
        oracleId: `${card.oracleId}:fused` as CardDefinition['oracleId'],
        name: card.name,
        typeLine: card.typeLine,
        types,
        colors: [...card.colors],
        manaCost: combinedCost,
        spellAbility,
        modeled: true,
        unmodeledReasons: [],
      };
      alternativeCasts.push({
        kind: 'split',
        fused: true,
        from: 'hand',
        manaCost: combinedCost,
        name: card.name,
        typeLine: card.typeLine,
        description: `${card.name} (fused)`,
        ability: spellAbility,
        spellFace: fusedFace,
      });
    }
  }
  return enforceInterpretedDefinition(
    applyOverride({
      ...left,
      oracleId: card.oracleId,
      scryfallId: card.scryfallId,
      name: card.name,
      typeLine: card.typeLine,
      types,
      colors: [...card.colors],
      colorIdentity: [...card.colorIdentity],
      manaCost: combinedCost,
      hasUnsupportedCost: left.hasUnsupportedCost || right.hasUnsupportedCost,
      keywords: [],
      spellAbility: null,
      alternativeCasts,
      modeled: reasons.length === 0,
      unmodeledReasons: reasons,
    }),
  );
}

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
  return interpretOracleCard(synthetic);
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
  return transformDefinition(interpretOracleCard(card));
}

/**
 * `interpretCard`, plus the slot failures recorded while it ran (ADR 0038 decision 2): which
 * subject, amount, condition, cost, trigger event or effect sentence the grammar could not read.
 * For triage only; the definition is exactly what `interpretCard` returns.
 */
export function interpretCardWithDiagnostics(card: OracleCard): {
  definition: CardDefinition;
  failures: SlotFailure[];
} {
  const { result, failures } = collectSlotDiagnostics(() => interpretCard(card));
  return { definition: result, failures };
}

/** `interpretCard` without the test-only transform: its recursive calls for halves and faces. */
function interpretOracleCard(card: OracleCard): CardDefinition {
  if (card.layout === 'split') {
    const split = interpretSplitCard(card);
    if (split !== null) return split;
  }
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
  // CR 308.1: a Kindred card is cast and resolves as its other card type; its subtypes are
  // creature types (CR 308.2), which the subtype list already carries. Only Kindred Auras
  // (Eldrazi Conscription) are reviewed; Kindred spells with changeling or creature-type spell
  // effects stay fail-closed until they are.
  const kindredReviewed = card.types.includes('Enchantment') && card.subtypes.includes('Aura');
  const KNOWN_TYPES = [
    ...(kindredReviewed ? ['Kindred'] : []),
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
  let protectionFrom: ProtectionQuality[] | undefined;
  let spellCantBeCountered = false;
  const spellAdditionalCosts: AbilityCost[] = [];
  let commanderFreeCast = false;
  let spellModes: NonNullable<Ability['modes']> | undefined;
  let announcesX = false;
  let castFromGraveyard = false;
  let optionalAdditionalCost: CardDefinition['optionalAdditionalCost'];
  let morphCost: ParsedManaCost | undefined;
  let faceDownVariant: CardDefinition['faceDownVariant'];
  let toxic = 0;
  let doesntUntapDuringUntapStep = false;
  let asTurnedFaceUpCounters: Record<string, number> | undefined;
  let entersAsCopy: CardDefinition['entersAsCopy'];
  let alternativeCasts: import('./ability').AlternativeCast[] | undefined =
    mdfcLandFace === null ? undefined : [mdfcLandFace];

  if (card.name === 'Dragon Tempest') {
    // Only the haste line is bespoke; the Dragon damage line is read by the effect grammar.
    triggers.push(
      triggered(whenEnters(allOf(ofType('Creature'), withKeyword('flying'), YOURS)), {
        effects: [{ op: 'grantKeywordUntilEot', keyword: 'haste', target: 'triggerObject' }],
        description: 'Flying ETB haste',
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
    // Its sacrifice ability ("look at the top seven cards … reveal a Dragon card") is read by the
    // look-at-the-top grammar. It used to be bespoke here as a search of the whole library,
    // which the card never says.
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
          aggregate: 'byEventPlayer',
        }),
        {
          // "Look at the top three cards of your library. Put one of them into your hand and the
          // rest on the bottom of your library in any order. You may return one of those Dragons
          // to its owner's hand." "Those Dragons" are the ones that dealt the damage.
          effects: [
            {
              op: 'lookAtTopN',
              count: 3,
              mayPut: { filter: allOf(), destination: { zone: 'hand' }, required: true },
              rest: 'bottomAnyOrder',
            },
            { op: 'mayReturnEventGroupMemberToHand' },
          ],
          description:
            'Look at the top three cards, put one into your hand and the rest on the bottom in any order; you may return one of those Dragons to its owner’s hand',
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
            parseVictimizeBlock(spellBlockText) ??
            parseAddendumMassBlock(spellBlockText) ??
            (() => {
              // Praetor's Grasp: a face-down exile its caster may play (CR 406.3).
              const targets: TargetSpec[] = [];
              const effects = parseExileFaceDownPlayableBlock(
                spellBlockText.toLowerCase(),
                (kind, filter, controller) =>
                  targets.push({
                    kind,
                    ...(filter !== undefined ? { filter } : {}),
                    ...(controller !== undefined ? { controller } : {}),
                  }) - 1,
                false,
              );
              return effects === null ? null : { targets, effects };
            })();
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
    // Bestow (CR 702.103a): an alternative cost that casts this creature card as a bestowed Aura.
    {
      const m = lower.match(/^bestow ((?:\{[^}]+\})+)$/);
      if (m && card.types.includes('Creature')) {
        const cost = parseManaCost((m[1] as string).toUpperCase() as never);
        if (cost.cost !== null) {
          if (!alternativeCasts) alternativeCasts = [];
          alternativeCasts.push({
            kind: 'bestow',
            manaCost: cost.cost,
            description: `Bestow ${m[1]}`,
          });
          continue;
        }
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

    // Increment: "Whenever you cast a spell, if the amount of mana you spent is greater than this
    // creature's power or toughness, put a +1/+1 counter on this creature." Greater than either
    // one suffices; both the mana spent and the creature are read again on resolution (CR 603.4).
    if (lower === 'increment') {
      const exceeds = (stat: Value): Condition => ({
        kind: 'compareValues',
        left: { kind: 'manaSpent' },
        cmp: '>=',
        right: { kind: 'plus', of: stat, n: 1 },
      });
      triggers.push(
        triggered(onCast('you'), {
          condition: {
            kind: 'anyOf',
            of: [exceeds({ kind: 'powerOfSource' }), exceeds({ kind: 'toughnessOfSource' })],
          },
          effects: [{ op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: 1 }],
          description: 'Increment',
        }),
      );
      continue;
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
    // Graft N (CR 702.58a): "This permanent enters with N +1/+1 counters on it" and "Whenever
    // another creature enters, if this permanent has a +1/+1 counter on it, you may move a +1/+1
    // counter from this permanent onto that creature." The intervening-if is the rule's, not the
    // reminder text's.
    {
      const graft = lower.match(/^graft (\w+)$/);
      const n = graft === null ? null : parseAmount(graft[1] as string);
      const previous = entersWithCounters['+1/+1'];
      if (n !== null && n > 0 && (previous === undefined || typeof previous === 'number')) {
        entersWithCounters['+1/+1'] = (previous ?? 0) + n;
        triggers.push(
          triggered(whenEnters(allOf(OTHER, ofType('Creature'))), {
            condition: { kind: 'sourceHasCounters', counter: '+1/+1', cmp: '>=', n: 1 },
            optional: true,
            effects: [
              {
                op: 'moveCounters',
                from: 'source',
                to: 'triggerObject',
                counter: '+1/+1',
                count: 1,
              },
            ],
            description: `Graft ${n}`,
          }),
        );
        continue;
      }
    }
    // Keywords that are triggered abilities, read through the grammar as their reminder text
    // says: prowess (CR 702.108a) and exalted (CR 702.83a). Each instance is its own trigger.
    {
      const reminder =
        lower === 'prowess'
          ? 'Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.'
          : lower === 'exalted'
            ? 'Whenever a creature you control attacks alone, that creature gets +1/+1 until end of turn.'
            : null;
      if (reminder !== null) {
        const parsed = parseTriggerLine(reminder, card);
        if (parsed !== null) {
          triggers.push(
            ...parsed.map((ability) => ({
              ...ability,
              description: lower === 'prowess' ? 'Prowess' : 'Exalted',
            })),
          );
          continue;
        }
      }
    }
    // Modular N (CR 702.43a): "This permanent enters with N +1/+1 counters on it" and "When this
    // permanent is put into a graveyard from the battlefield, you may put a +1/+1 counter on
    // target artifact creature for each +1/+1 counter on this permanent."
    {
      const modular = lower.match(/^modular (\w+)$/);
      const n = modular === null ? null : parseAmount(modular[1] as string);
      const previous = entersWithCounters['+1/+1'];
      if (n !== null && n > 0 && (previous === undefined || typeof previous === 'number')) {
        const parsed = parseTriggerLine(
          'When this creature dies, you may put its +1/+1 counters on target artifact creature.',
          card,
        );
        if (parsed !== null) {
          entersWithCounters['+1/+1'] = (previous ?? 0) + n;
          triggers.push(...parsed.map((ability) => ({ ...ability, description: `Modular ${n}` })));
          continue;
        }
      }
    }
    // Devoid (CR 702.114a): a characteristic-defining ability making the card colorless in every
    // zone. Oracle data already lists such a card with no colors, which is where the engine reads
    // color from; a card whose data disagrees is not read.
    if (lower === 'devoid' && card.colors.length === 0) continue;
    // Toxic N (CR 702.164): combat damage to a player also gives that many poison counters.
    // Instances add up to the total toxic value (CR 702.164b).
    {
      const m = lower.match(/^toxic (\w+)$/);
      const n = m === null ? null : parseAmount(m[1] as string);
      if (n !== null && n > 0) {
        toxic += n;
        continue;
      }
    }
    // "~ doesn't untap during your untap step" (Grim Monolith, CR 502.3).
    if (
      /^(?:~|this (?:artifact|creature|land|permanent)) doesn't untap during your untap step$/.test(
        lower,
      )
    ) {
      doesntUntapDuringUntapStep = true;
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
    // 2b. "You may have this creature enter as a copy of …" (CR 707.2): an as-enters copy
    //     replacement, applied in `moveObject` before enters triggers are queued.
    if (entersAsCopy === undefined) {
      const copy = parseEntersAsCopy(lower, card);
      if (copy !== null) {
        entersAsCopy = copy;
        continue;
      }
    }
    // 3. Enters tapped.
    if (/^(?:~|this land) enters (?:the battlefield )?tapped$/.test(lower)) {
      entersTapped = true;
      continue;
    }
    // "~ enters tapped with two charge counters on it" (Vivid lands): both replacements at once.
    {
      const m = lower.match(
        /^(?:~|this land) enters (?:the battlefield )?tapped with (\w+) ([a-z]+) counters? on it$/,
      );
      const n = m === null ? null : parseAmount(m[1] as string);
      // Stun counters have a rule of their own (CR 122.1d) the engine does not implement.
      if (
        m !== null &&
        n !== null &&
        n > 0 &&
        m[2] !== 'stun' &&
        entersWithCounters[m[2] as string] === undefined
      ) {
        entersTapped = true;
        entersWithCounters[m[2] as string] = n;
        continue;
      }
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
      const reveal = parseEntersRevealChoice(lower, card);
      if (reveal !== null) {
        entersTappedUnless = reveal;
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
      // "Megamorph {U}" (CR 702.37b) and "Disguise {1}{B}" (CR 702.168) are morph with a rider.
      const m = lower.match(/^(morph|megamorph|disguise) ((?:\{[^}]+\})+)(?:\s*\(.*\))?\.?$/i);
      if (m) {
        const cost = parseManaCost((m[2] as string).toUpperCase() as never);
        if (cost.cost !== null && cost.unsupportedSymbols.length === 0) {
          morphCost = cost.cost;
          if (m[1] !== 'morph') faceDownVariant = m[1] as 'megamorph' | 'disguise';
          continue;
        }
      }
    }
    // "As this creature is turned face up, put five +1/+1 counters on it" (Hooded Hydra): the
    // counters are there as it turns face up, before its "turned face up" triggers (CR 708.8).
    {
      const m = lower.match(
        /^as (?:~|this creature) is turned face up, put (\w+) ([+-]\d+\/[+-]\d+|\w+) counters? on it$/,
      );
      const n = m === null ? null : parseAmount(m[1] as string);
      if (m !== null && n !== null && n > 0) {
        asTurnedFaceUpCounters = { [m[2] as string]: n };
        continue;
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
        } else if (clause === 'creature card in a graveyard') {
          // Animate Dead: an Aura spell targeting a card in any graveyard (CR 303.4a).
          spellTargets.push({
            kind: 'cardInGraveyard',
            filter: ofType('Creature'),
            graveyardOwnerScope: 'any',
          });
          continue;
        } else if (clause === 'player') {
          // An Aura can enchant a player (CR 303.4a, 702.5a): its host is that player.
          spellTargets.push({ kind: 'player' });
          continue;
        } else if (clause === 'opponent') {
          spellTargets.push({ kind: 'player', controller: 'opponent' });
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
      'Dragon Tempest',
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
      ...(toxic > 0 ? { toxic } : {}),
      ...(doesntUntapDuringUntapStep ? { doesntUntapDuringUntapStep: true } : {}),
      ...(faceDownVariant !== undefined && morphCost !== undefined ? { faceDownVariant } : {}),
      ...(asTurnedFaceUpCounters !== undefined ? { asTurnedFaceUpCounters } : {}),
      ...(entersAsCopy !== undefined ? { entersAsCopy } : {}),
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
