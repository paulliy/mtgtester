/**
 * IR to English: render a card definition (or a compiled patch) back to Oracle-style rules text,
 * deterministically. It is the free first half of the compiler's meaning check: when every node
 * of a patch renders and the text matches the Oracle lines it claims, the card passes with no
 * model call. Anything it cannot render exactly is reported as unrendered, never guessed, and the
 * check falls back to the model back-translation.
 *
 * Strictness is the point. Every node's keys are checked against the keys its renderer reads, so
 * a restriction the renderer does not understand (an extra filter, a duration) makes the node
 * unrendered instead of silently dropping out of the text.
 *
 * Coverage grows one renderer at a time: `bun run scripts/card-compiler/render.ts` reports, over
 * every modeled card in the pinned pool, how many render fully and how many match Oracle text,
 * with the most common unrendered nodes first.
 */
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { CLUE, FOOD, TREASURE } from '../../packages/engine/src/cards/tokens';

export class Unrendered extends Error {
  constructor(readonly node: string) {
    super(`unrendered: ${node}`);
  }
}

type Node = Record<string, unknown>;

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** Throw unless `node` has only `allowed` keys (plus the discriminant). */
function only(node: Node, tag: string, allowed: string[]): void {
  for (const key of Object.keys(node))
    if (!allowed.includes(key) && node[key] !== undefined) throw new Unrendered(`${tag}.${key}`);
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── Alternatives ──────────────────────────────────────────────────────────────────────────────

/*
 * Oracle text words the same IR more than one way ("you gain X life, where X is the number of
 * Elves", "you gain 1 life for each Elf"). A renderer that knows each wording is equivalent writes
 * them all as one alternative group, `⟨first¦second⟩`, and the comparison accepts a printed line
 * that matches any expansion. Every expansion must mean exactly what the IR means: an
 * alternative is a second spelling, never a looser reading.
 */
const OPEN = '\u27e8';
const BAR = '\u00a6';
const CLOSE = '\u27e9';
const MAX_EXPANSIONS = 256;

/** One alternative group: the wordings, all meaning the same thing. */
export function alt(...wordings: string[]): string {
  const distinct = [...new Set(wordings)];
  return distinct.length === 1 ? distinct[0]! : `${OPEN}${distinct.join(BAR)}${CLOSE}`;
}

/** Every wording of a rendered line, with each group expanded. Innermost groups go first. */
export function expandAlternatives(text: string): string[] {
  const close = text.indexOf(CLOSE);
  if (close < 0) return [text];
  const open = text.lastIndexOf(OPEN, close);
  if (open < 0) throw new Error(`unbalanced alternative group in "${text}"`);
  const options = text.slice(open + 1, close).split(BAR);
  const out: string[] = [];
  for (const option of options) {
    for (const expanded of expandAlternatives(
      text.slice(0, open) + option + text.slice(close + 1),
    )) {
      out.push(expanded);
      if (out.length > MAX_EXPANSIONS) throw new Unrendered('alternatives:too-many');
    }
  }
  // A nested group repeats its outer wordings once per inner wording; keep each one once.
  return [...new Set(out)];
}

/** A rendered line as a reader sees it: the first wording of each group. */
export function firstWording(text: string): string {
  return expandAlternatives(text)[0]!;
}

// ── Values ────────────────────────────────────────────────────────────────────────────────────

/** A number as Oracle text writes a count: "a", "two", "X". */
function countWord(value: unknown, article = 'a'): string {
  if (typeof value === 'number')
    return value === 1 ? article : (NUMBER_WORDS[value] ?? String(value));
  if (isNode(value) && value['kind'] === 'const' && typeof value['n'] === 'number')
    return countWord(value['n'], article);
  if (isNode(value) && value['kind'] === 'xValue') return 'X';
  throw new Unrendered(`count:${isNode(value) ? String(value['kind']) : typeof value}`);
}

/** A number as an amount: "3", "X". */
function amount(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (isNode(value)) {
    if (value['kind'] === 'const' && typeof value['n'] === 'number') return String(value['n']);
    if (value['kind'] === 'xValue') return 'X';
  }
  throw new Unrendered(`amount:${isNode(value) ? String(value['kind']) : typeof value}`);
}

/**
 * A dynamic amount: `x` is the "where X is …" clause ("the number of Elves on the battlefield"),
 * and `each` the "for each …" noun when the amount counts objects ("Elf on the battlefield").
 */
interface Dynamic {
  x: string;
  each?: string;
}

/**
 * A dynamic amount, or null for a fixed number. `targetCount` is the number of target slots of
 * the ability the value sits in: "its power" is only unambiguous when there is exactly one.
 */
function dynamicX(value: unknown, targetCount = 0): Dynamic | null {
  if (typeof value === 'number' || !isNode(value)) return null;
  switch (value['kind']) {
    case 'const':
    case 'xValue':
      return null;
    case 'countPermanents': {
      only(value, 'countPermanents', ['kind', 'selector', 'scope']);
      const scope = value['scope'];
      const owner =
        scope === 'you' ? ' you control' : scope === 'all' || scope === undefined ? '' : null;
      if (owner === null) throw new Unrendered(`countPermanents.scope:${String(scope)}`);
      const where = (noun: string): string =>
        `${noun}${noun.includes('you control') ? '' : owner}${scope === 'all' ? ' on the battlefield' : ''}`;
      return {
        x: `the number of ${where(selectorNoun(value['selector'], { plural: true }))}`,
        each: where(selectorNoun(value['selector'])),
      };
    }
    case 'countersOnSelf': {
      only(value, 'countersOnSelf', ['kind', 'counter']);
      const counter = String(value['counter']);
      return { x: `the number of ${counter} counters on ~`, each: `${counter} counter on ~` };
    }
    case 'powerOfTarget':
      only(value, 'powerOfTarget', ['kind', 'target']);
      // "its" names a slot only when the ability has a single target; any other shape would let a
      // patch that reads the wrong slot render the same English as the right one.
      if (value['target'] !== 0 || targetCount !== 1) throw new Unrendered('powerOfTarget.slot');
      return { x: 'its power' };
    default:
      throw new Unrendered(`value:${String(value['kind'])}`);
  }
}

/**
 * An amount in a phrase, with every Oracle wording of a dynamic one. `template` holds `{n}` where
 * the number goes ("you gain {n} life"); `equal`, when the phrase has an "equal to" form, holds
 * `{y}` for the amount ("you gain life equal to {y}"). `one` is how the template writes one of
 * something for the "for each" form ("1": "you gain 1 life for each Elf").
 */
function amountPhrase(
  template: string,
  value: unknown,
  targetCount: number,
  options: { equal?: string; one?: string } = {},
): string {
  const dynamic = dynamicX(value, targetCount);
  if (dynamic === null) return template.replace('{n}', amount(value));
  const wordings = [`${template.replace('{n}', 'X')}, where X is ${dynamic.x}`];
  if (options.equal !== undefined) wordings.push(options.equal.replace('{y}', dynamic.x));
  if (dynamic.each !== undefined)
    wordings.push(`${template.replace('{n}', options.one ?? '1')} for each ${dynamic.each}`);
  return alt(...wordings);
}

// ── Selectors ─────────────────────────────────────────────────────────────────────────────────

const TYPE_PLURAL: Record<string, string> = {
  Creature: 'creatures',
  Artifact: 'artifacts',
  Enchantment: 'enchantments',
  Land: 'lands',
  Planeswalker: 'planeswalkers',
  Instant: 'instants',
  Sorcery: 'sorceries',
  Battle: 'battles',
};

interface NounOptions {
  plural?: boolean;
  /** Default noun when the selector names no card type ("permanent", "card"). */
  base?: string;
  /**
   * A noun that follows the types and comes before any suffix: "artifact card with mana value 6
   * or greater", "creature spell". Singular only.
   */
  noun?: string;
}

/**
 * A selector as a noun phrase: "other creatures you control", "nontoken creature". Supports the
 * conjunctive shapes Oracle text uses; anything else is unrendered.
 */
export function selectorNoun(selector: unknown, options: NounOptions = {}): string {
  if (!isNode(selector)) throw new Unrendered('selector:not-an-object');
  const parts = selector['kind'] === 'allOf' ? (selector['of'] as unknown[]) : [selector];
  if (selector['kind'] === 'allOf') only(selector, 'allOf', ['kind', 'of']);
  const prefixes: string[] = [];
  const adjectives: string[] = [];
  let types: string[] = [];
  const subtypes: string[] = [];
  const suffixes: string[] = [];
  let choice: string | null = null;
  for (const part of parts) {
    if (!isNode(part)) throw new Unrendered('selector:part');
    const kind = String(part['kind']);
    switch (kind) {
      case 'type':
        only(part, 'type', ['kind', 'value']);
        types.push(String(part['value']));
        break;
      case 'anyOf': {
        only(part, 'anyOf', ['kind', 'of']);
        const options = part['of'] as unknown[];
        // A choice among card types ("artifact or creature") or among subtypes ("Goblin or Orc").
        const plain = (kindOf: string) =>
          options.length >= 2 &&
          options.every((o) => isNode(o) && o['kind'] === kindOf && Object.keys(o).length === 2);
        const values = options.map((o) => String((o as Node)['value']));
        const mixed =
          options.length >= 2 &&
          options.every(
            (o) =>
              isNode(o) &&
              (o['kind'] === 'type' || o['kind'] === 'subtype') &&
              Object.keys(o).length === 2,
          );
        if (plain('type')) types = [...types, values.join(' or ')];
        else if (plain('subtype')) subtypes.push(values.join(' or '));
        else if (mixed) {
          // "Instant, sorcery, or Wizard": card types lowercase, subtypes capitalized.
          if (choice !== null) throw new Unrendered('selector:several-choices');
          choice = options
            .map((o) => {
              const value = String((o as Node)['value']);
              return (o as Node)['kind'] === 'type' ? value.toLowerCase() : value;
            })
            .join(' or ');
        } else throw new Unrendered('selector:anyOf-non-type');
        break;
      }
      case 'subtype':
        only(part, 'subtype', ['kind', 'value']);
        subtypes.push(String(part['value']));
        break;
      case 'supertype':
        only(part, 'supertype', ['kind', 'value']);
        adjectives.push(String(part['value']).toLowerCase());
        break;
      case 'color':
        only(part, 'color', ['kind', 'value']);
        adjectives.push(COLOR_WORD[String(part['value'])] ?? '?');
        break;
      case 'other':
        only(part, 'other', ['kind']);
        prefixes.push('other');
        break;
      case 'controller': {
        only(part, 'controller', ['kind', 'who']);
        const who = part['who'];
        suffixes.push(
          who === 'you'
            ? 'you control'
            : who === 'opponents' || who === 'opponent'
              ? 'your opponents control'
              : `?${String(who)}`,
        );
        if (String(suffixes.at(-1)).startsWith('?'))
          throw new Unrendered(`controller:${String(who)}`);
        break;
      }
      case 'not': {
        only(part, 'not', ['kind', 'of']);
        const inner = part['of'];
        if (isNode(inner) && inner['kind'] === 'isToken') adjectives.push('nontoken');
        else if (isNode(inner) && inner['kind'] === 'type')
          adjectives.push(`non${String(inner['value']).toLowerCase()}`);
        else if (isNode(inner) && inner['kind'] === 'hasAnyCounter')
          suffixes.push('with no counters on them');
        else if (isNode(inner) && inner['kind'] === 'color' && Object.keys(inner).length === 2) {
          const color = COLOR_WORD[String(inner['value'])];
          if (color === undefined) throw new Unrendered('not:color');
          adjectives.push(`non${color}`);
        } else if (
          isNode(inner) &&
          inner['kind'] === 'supertype' &&
          Object.keys(inner).length === 2
        )
          adjectives.push(`non${String(inner['value']).toLowerCase()}`);
        else throw new Unrendered(`not:${isNode(inner) ? String(inner['kind']) : '?'}`);
        break;
      }
      case 'isToken':
        only(part, 'isToken', ['kind']);
        types.push('token');
        break;
      case 'hasAnyCounter':
        only(part, 'hasAnyCounter', ['kind']);
        suffixes.push('with a counter on it');
        break;
      case 'enteredThisTurn':
        only(part, 'enteredThisTurn', ['kind']);
        suffixes.push('that entered this turn');
        break;
      case 'hasCounter':
        only(part, 'hasCounter', ['kind', 'counter']);
        suffixes.push(`with ${article(String(part['counter']))} counter on it`);
        break;
      case 'manaValueAtLeast':
        only(part, 'manaValueAtLeast', ['kind', 'n']);
        if (typeof part['n'] !== 'number') throw new Unrendered('manaValueAtLeast.n');
        suffixes.push(`with mana value ${part['n']} or greater`);
        break;
      case 'isCommander':
        only(part, 'isCommander', ['kind']);
        types.push('commander');
        break;
      default:
        throw new Unrendered(`selector:${kind}`);
    }
  }
  const plural = options.plural === true;
  let head: string;
  if (types.length === 0) head = subtypes.length > 0 ? '' : (options.base ?? 'permanent');
  else if (types.length === 1)
    head = types[0]!
      .split(' or ')
      .map((t) => t.toLowerCase())
      .join(' or ');
  else throw new Unrendered('selector:several-types');
  if (subtypes.length > 1) throw new Unrendered('selector:several-subtypes');
  if (subtypes.length === 1 && subtypes[0]!.includes(' or ') && head.includes(' or '))
    throw new Unrendered('selector:subtype-and-type-choice');
  if (choice !== null) {
    if (types.length > 0 || subtypes.length > 0) throw new Unrendered('selector:choice-and-type');
    head = choice;
  }
  let noun = [subtypes[0], head].filter((word) => word !== undefined && word !== '').join(' ');
  // Creature plus a subtype stays "Elf creature": bare "Elves" also counts a noncreature Kindred
  // Elf, so dropping the type would render a narrower selector as the wider printed one.
  if (plural) noun = pluralize(noun);
  noun = orList(noun);
  if (options.noun !== undefined) {
    if (plural) throw new Unrendered('selector:plural-noun');
    noun = `${noun} ${options.noun}`.trim();
  }
  return [...prefixes, ...adjectives, noun, ...suffixes].join(' ');
}

/** "a or b or c" as Oracle lists three or more: "a, b, or c". */
function orList(noun: string): string {
  const items = noun.split(' or ');
  return items.length <= 2 ? noun : `${items.slice(0, -1).join(', ')}, or ${items.at(-1)!}`;
}

function pluralize(noun: string): string {
  return noun
    .split(' or ')
    .map((word) => {
      const lower = word.toLowerCase();
      if (TYPE_PLURAL[word[0]!.toUpperCase() + lower.slice(1)] !== undefined)
        return TYPE_PLURAL[word[0]!.toUpperCase() + lower.slice(1)]!;
      if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
      if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
      if (word.endsWith('f')) return `${word.slice(0, -1)}ves`;
      return `${word}s`;
    })
    .join(' or ');
}

const COLOR_WORD: Record<string, string> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
};

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

// ── Targets ───────────────────────────────────────────────────────────────────────────────────

const TARGET_NOUN: Record<string, string> = {
  creature: 'creature',
  player: 'player',
  permanent: 'permanent',
  anyTarget: 'any target',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
  nonlandPermanent: 'nonland permanent',
  artifactOrEnchantment: 'artifact or enchantment',
  spell: 'spell',
  noncreatureSpell: 'noncreature spell',
  playerOrPlaneswalker: 'player or planeswalker',
  cardInGraveyard: 'card',
};

/** How Oracle refers back to a target it already named: "untap that creature". */
const THAT_NOUN: Record<string, string> = {
  creature: 'creature',
  permanent: 'permanent',
  player: 'player',
  spell: 'spell',
  artifact: 'artifact',
  enchantment: 'enchantment',
  land: 'land',
  planeswalker: 'planeswalker',
  cardInGraveyard: 'card',
};

/** "target creature you control", "target instant or sorcery spell". */
function targetPhrase(spec: unknown): string {
  if (!isNode(spec)) throw new Unrendered('target:not-an-object');
  const kind = String(spec['kind']);
  only(spec, `target.${kind}`, ['kind', 'controller', 'filter', 'graveyardOwnerScope']);
  const base = TARGET_NOUN[kind];
  if (base === undefined) throw new Unrendered(`target:${kind}`);
  let noun = base;
  if (spec['filter'] !== undefined) {
    if (kind === 'cardInGraveyard') noun = selectorNoun(spec['filter'], { base: '', noun: 'card' });
    else if (kind === 'spell') noun = selectorNoun(spec['filter'], { base: '', noun: 'spell' });
    else if (kind === 'permanent') noun = selectorNoun(spec['filter']);
    else noun = selectorNoun(spec['filter'], { base: '', noun: base });
  }
  noun = noun.replace(/\s+/g, ' ');
  const controller = spec['controller'];
  if (controller === 'you') noun += ' you control';
  else if (controller === 'opponent') noun += " you don't control";
  else if (controller !== undefined)
    throw new Unrendered(`target.controller:${String(controller)}`);
  if (kind === 'anyTarget') {
    // "any target" has no wording for a filter or controller, so a restricted slot is unrendered.
    if (spec['filter'] !== undefined || controller !== undefined)
      throw new Unrendered('target.anyTarget:restricted');
    return 'any target';
  }
  if (kind === 'cardInGraveyard') {
    const scope = spec['graveyardOwnerScope'];
    const head = noun.startsWith('other ') ? `another target ${noun.slice(6)}` : `target ${noun}`;
    if (scope === 'any') return `${head} from a graveyard`;
    if (scope === undefined) return `${head} from your graveyard`;
    throw new Unrendered(`graveyardOwnerScope:${String(scope)}`);
  }
  if (spec['graveyardOwnerScope'] !== undefined) throw new Unrendered('target.graveyardOwnerScope');
  // A filter that excludes the source reads "another target creature", as Oracle writes it.
  return noun.startsWith('other ') ? `another target ${noun.slice(6)}` : `target ${noun}`;
}

// ── Effects ───────────────────────────────────────────────────────────────────────────────────

interface EffectContext {
  targets: unknown[];
  /** How the source is named: "~" or "it". */
  self: string;
}

function targetRef(ref: unknown, ctx: EffectContext, used: Set<number>): string {
  if (typeof ref === 'number') {
    const spec = ctx.targets[ref];
    if (spec === undefined) throw new Unrendered('target:missing-slot');
    if (used.has(ref)) {
      // "It" names a slot only when the ability has one; with two, a patch that reads the wrong
      // slot would render the same English as the right one.
      if (ctx.targets.length !== 1) throw new Unrendered('targetRef:ambiguous-it');
      const kind = isNode(spec) ? String(spec['kind']) : '';
      const noun = THAT_NOUN[kind];
      return noun === undefined ? 'it' : alt('it', `that ${noun}`);
    }
    used.add(ref);
    return targetPhrase(spec);
  }
  // The object the trigger saw. With no targets in the ability, "it" can only mean that object.
  if (ref === 'triggerObject')
    return ctx.targets.length === 0 ? alt('that creature', 'it') : 'that creature';
  if (ref === 'attachedToSource') return ATTACHED;
  throw new Unrendered(`targetRef:${String(ref)}`);
}

/**
 * The permanent the source is attached to. An Equipment calls it "equipped creature" and an Aura
 * "enchanted creature"; the card can only be one of them, so either wording means this.
 */
const ATTACHED = alt('equipped creature', 'enchanted creature');

const MANA_ZERO = { W: 0, U: 0, B: 0, R: 0, G: 0 };

/** {2}{U} from a ParsedManaCost. */
export function manaText(cost: unknown): string {
  if (!isNode(cost)) throw new Unrendered('mana:not-an-object');
  only(cost, 'mana', ['generic', 'colored', 'colorless', 'x']);
  const colored = (cost['colored'] ?? MANA_ZERO) as Record<string, number>;
  let out = '';
  if (typeof cost['x'] === 'number' && cost['x'] > 0) out += '{X}'.repeat(cost['x']);
  if (typeof cost['generic'] === 'number' && cost['generic'] > 0) out += `{${cost['generic']}}`;
  if (typeof cost['colorless'] === 'number') out += '{C}'.repeat(cost['colorless']);
  for (const color of ['W', 'U', 'B', 'R', 'G']) out += `{${color}}`.repeat(colored[color] ?? 0);
  return out.length === 0 ? '{0}' : out;
}

function effectText(effect: unknown, ctx: EffectContext, used: Set<number>): string {
  if (!isNode(effect)) throw new Unrendered('effect:not-an-object');
  const op = String(effect['op']);
  const t = (key = 'target') => targetRef(effect[key], ctx, used);
  const withX = (text: string, value: unknown, equal?: string): string =>
    amountPhrase(text, value, ctx.targets.length, equal === undefined ? {} : { equal });
  switch (op) {
    case 'draw': {
      only(effect, op, ['op', 'count']);
      const x = dynamicX(effect['count'], ctx.targets.length);
      if (x !== null)
        return alt(
          `draw cards equal to ${x.x}`,
          `draw X cards, where X is ${x.x}`,
          ...(x.each === undefined ? [] : [`draw a card for each ${x.each}`]),
        );
      const n = countWord(effect['count']);
      return n === 'a' ? 'draw a card' : `draw ${n} cards`;
    }
    case 'gainLife':
      only(effect, op, ['op', 'amount']);
      return withX('you gain {n} life', effect['amount'], 'you gain life equal to {y}');
    case 'loseLife':
      only(effect, op, ['op', 'amount']);
      return withX('you lose {n} life', effect['amount'], 'you lose life equal to {y}');
    case 'eachOpponentLosesLife':
      only(effect, op, ['op', 'amount']);
      return withX(
        'each opponent loses {n} life',
        effect['amount'],
        'each opponent loses life equal to {y}',
      );
    case 'scry':
    case 'surveil':
      only(effect, op, ['op', 'count']);
      return `${op} ${amount(effect['count'])}`;
    case 'mill':
      only(effect, op, ['op', 'count']);
      return `mill ${countWord(effect['count'])} card${countWord(effect['count']) === 'a' ? '' : 's'}`;
    case 'proliferate':
      only(effect, op, ['op']);
      return 'proliferate';
    case 'populate':
      only(effect, op, ['op']);
      return 'populate';
    case 'shuffle':
      only(effect, op, ['op']);
      return 'shuffle';
    case 'destroy':
    case 'exile':
    case 'counter':
      only(effect, op, ['op', 'target']);
      return `${op} ${t()}`;
    case 'returnToHand':
      only(effect, op, ['op', 'target']);
      return `return ${t()} to its owner's hand`;
    case 'graveyardToHand': {
      only(effect, op, ['op', 'target']);
      // A card from your own graveyard goes to your hand; Oracle says so.
      const card = t();
      return `return ${card} to ${card.endsWith('from your graveyard') ? alt('your hand', "its owner's hand") : "its owner's hand"}`;
    }
    case 'graveyardToBattlefield':
      only(effect, op, ['op', 'target']);
      return `return ${t()} to the battlefield`;
    case 'tapTarget':
      only(effect, op, ['op', 'target']);
      return `tap ${t()}`;
    case 'untapTarget':
      only(effect, op, ['op', 'target']);
      return `untap ${t()}`;
    case 'regenerate':
      only(effect, op, ['op', 'target']);
      return `regenerate ${t()}`;
    case 'dealDamage': {
      only(effect, op, ['op', 'target', 'amount', 'source']);
      const target = t();
      if (effect['source'] !== undefined) {
        const source = targetRef(effect['source'], ctx, new Set());
        used.add(effect['source'] as number);
        // "Target creature you control deals damage equal to its power": "its" is the source's.
        const amountNode = effect['amount'];
        if (
          isNode(amountNode) &&
          amountNode['kind'] === 'powerOfTarget' &&
          typeof effect['source'] === 'number'
        ) {
          only(amountNode, 'powerOfTarget', ['kind', 'target']);
          if (amountNode['target'] !== effect['source']) throw new Unrendered('powerOfTarget.slot');
          return `${source} deals damage equal to its power to ${target}`;
        }
        const x = dynamicX(effect['amount'], ctx.targets.length);
        if (x === null) throw new Unrendered('dealDamage.source-fixed');
        return `${source} deals damage equal to ${x.x} to ${target}`;
      }
      return withX(
        `${ctx.self} deals {n} damage to ${target}`,
        effect['amount'],
        `${ctx.self} deals damage equal to {y} to ${target}`,
      );
    }
    case 'eachOpponentDamage':
      only(effect, op, ['op', 'amount']);
      return withX(
        `${ctx.self} deals {n} damage to each opponent`,
        effect['amount'],
        `${ctx.self} deals damage equal to {y} to each opponent`,
      );
    case 'damageEach':
      only(effect, op, ['op', 'selector', 'amount']);
      return withX(
        `${ctx.self} deals {n} damage to each ${selectorNoun(effect['selector'])}`,
        effect['amount'],
      );
    case 'destroyEach':
      only(effect, op, ['op', 'selector']);
      return `destroy all ${selectorNoun(effect['selector'], { plural: true })}`;
    case 'exileEach':
      only(effect, op, ['op', 'selector']);
      return `exile all ${selectorNoun(effect['selector'], { plural: true })}`;
    case 'putCounters': {
      only(effect, op, ['op', 'target', 'counter', 'count']);
      const n = countWord(effect['count']);
      return `put ${n} ${String(effect['counter'])} counter${n === 'a' ? '' : 's'} on ${t()}`;
    }
    case 'putCountersEach': {
      only(effect, op, ['op', 'selector', 'counter', 'count']);
      const n = countWord(effect['count']);
      const where =
        isNode(effect['selector']) && effect['selector']['kind'] === 'self'
          ? ctx.self
          : `each ${selectorNoun(effect['selector'])}`;
      return `put ${n} ${String(effect['counter'])} counter${n === 'a' ? '' : 's'} on ${where}`;
    }
    case 'pumpUntilEot': {
      only(effect, op, ['op', 'target', 'power', 'toughness']);
      return `${t()} gets ${pt(effect['power'], effect['toughness'], ctx.targets.length)} until end of turn`;
    }
    case 'grantKeywordUntilEot':
      only(effect, op, ['op', 'target', 'keyword']);
      return `${t()} gains ${String(effect['keyword'])} until end of turn`;
    case 'createToken':
      only(effect, op, ['op', 'spec', 'count']);
      return `create ${tokenText(effect['spec'], effect['count'])}`;
    case 'createTokenCopyOf':
      only(effect, op, ['op', 'ref', 'count']);
      if (effect['ref'] !== 'source') throw new Unrendered('createTokenCopyOf.ref');
      if (countWord(effect['count']) !== 'a') throw new Unrendered('createTokenCopyOf.count');
      return `create a token that's a copy of ${ctx.self}`;
    case 'copyTargetSpell':
      only(effect, op, ['op', 'target', 'newTargets']);
      return `copy ${t()}${effect['newTargets'] === true ? '. You may choose new targets for the copy' : ''}`;
    case 'searchLibrary': {
      only(effect, op, ['op', 'filter', 'destinations', 'reveal']);
      const destinations = effect['destinations'];
      if (!Array.isArray(destinations) || destinations.length !== 1)
        throw new Unrendered('searchLibrary.destinations');
      const destination = destinations[0] as unknown;
      if (!isNode(destination)) throw new Unrendered('searchLibrary.destination');
      only(destination, 'searchLibrary.destination', ['zone', 'tapped']);
      const zone = destination['zone'];
      if (destination['tapped'] !== undefined && zone !== 'battlefield')
        throw new Unrendered('searchLibrary.tapped');
      const put =
        zone === 'hand'
          ? 'put it into your hand'
          : zone === 'battlefield'
            ? `put it onto the battlefield${destination['tapped'] === true ? ' tapped' : ''}`
            : zone === 'graveyard'
              ? 'put it into your graveyard'
              : null;
      if (put === null) throw new Unrendered(`searchLibrary.zone:${String(zone)}`);
      const card = selectorNoun(effect['filter'], { base: '', noun: 'card' });
      const reveal = effect['reveal'] === true ? `reveal ${alt('it', 'that card')}, ` : '';
      return `search your library for ${article(card)}, ${reveal}${put}`;
    }
    case 'returnDepartedSourceToBattlefield':
      only(effect, op, ['op', 'fromYourGraveyard']);
      if (effect['fromYourGraveyard'] !== true)
        throw new Unrendered('returnDepartedSourceToBattlefield.from');
      return `return ${ctx.self} from your graveyard to the battlefield`;
    case 'gainControlTarget': {
      only(effect, op, ['op', 'target', 'duration']);
      const duration = effect['duration'];
      if (duration !== undefined && duration !== 'untilEndOfTurn')
        throw new Unrendered(`gainControlTarget.duration:${JSON.stringify(duration)}`);
      return `gain control of ${t()}${duration === 'untilEndOfTurn' ? ' until end of turn' : ''}`;
    }
    case 'pumpEachUntilEot': {
      only(effect, op, ['op', 'selector', 'power', 'toughness']);
      const boost = `${pt(effect['power'], effect['toughness'], ctx.targets.length)} until end of turn`;
      // "Each creature you control gets" and "Creatures you control get" say the same thing.
      return alt(
        `each ${selectorNoun(effect['selector'])} gets ${boost}`,
        `${selectorNoun(effect['selector'], { plural: true })} get ${boost}`,
      );
    }
    case 'conditionalEffect': {
      only(effect, op, ['op', 'condition', 'then', 'else']);
      if (Array.isArray(effect['else']) && effect['else'].length > 0)
        throw new Unrendered('conditionalEffect.else');
      // A printed "if" covers only its own sentence, but a false condition skips every effect in
      // the branch, so a multi-effect branch cannot be compared by text.
      if (!Array.isArray(effect['then']) || effect['then'].length !== 1)
        throw new Unrendered('conditionalEffect:multi-effect');
      const body = joinEffects(effect['then'] as unknown[], ctx, used);
      return `if ${conditionText(effect['condition'])}, ${body}`;
    }
    default:
      throw new Unrendered(`op:${op}`);
  }
}

function pt(power: unknown, toughness: unknown, targetCount: number): string {
  const px = dynamicX(power, targetCount);
  const tx = dynamicX(toughness, targetCount);
  if (px !== null || tx !== null) {
    if (px === null || tx === null || px.x !== tx.x) throw new Unrendered('pump:mixed-dynamic');
    return `+X/+X, where X is ${px.x}`;
  }
  const sign = (v: unknown) => {
    const n = Number(amount(v));
    return n >= 0 ? `+${n}` : String(n);
  };
  return `${sign(power)}/${sign(toughness)}`;
}

/**
 * Predefined tokens (CR 111.10): Oracle names them only, so a spec that is exactly the engine's
 * catalog token, `typeLine` aside, renders as "a Treasure token".
 */
const PREDEFINED_TOKENS = [TREASURE, FOOD, CLUE];

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (!isNode(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .filter((key) => key !== 'typeLine' && value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`)
    .join(',')}}`;
}

function tokenText(spec: unknown, count: unknown): string {
  if (!isNode(spec)) throw new Unrendered('token:not-an-object');
  const predefined = PREDEFINED_TOKENS.find((token) => sortedJson(token) === sortedJson(spec));
  if (predefined !== undefined) {
    const n = countWord(count);
    return n === 'a' ? `a ${predefined.name} token` : `${n} ${predefined.name} tokens`;
  }
  only(spec, 'token', [
    'name',
    'typeLine',
    'types',
    'subtypes',
    'colors',
    'power',
    'toughness',
    'keywords',
  ]);
  const n = countWord(count);
  const subtypeList = (spec['subtypes'] as string[] | undefined) ?? [];
  const typeList = (spec['types'] as string[] | undefined) ?? [];
  // `typeLine` is display text derived from the types; one that disagrees with them is a patch
  // the check cannot read. The name is rules text ("named Koma's Coil"), so a name other than the
  // subtypes is printed.
  const typeLine = spec['typeLine'];
  if (
    typeLine !== undefined &&
    String(typeLine).replace(/^Token /, '') !== `${typeList.join(' ')} — ${subtypeList.join(' ')}`
  )
    throw new Unrendered('token.typeLine');
  if (typeof spec['name'] !== 'string') throw new Unrendered('token.name');
  const named = spec['name'] === subtypeList.join(' ') ? '' : ` named ${spec['name']}`;
  const colors = (spec['colors'] as string[] | undefined) ?? [];
  const colorText =
    colors.length === 0 ? 'colorless' : colors.map((c) => COLOR_WORD[c] ?? '?').join(' and ');
  const subtypes = ((spec['subtypes'] as string[] | undefined) ?? []).join(' ');
  const types = ((spec['types'] as string[] | undefined) ?? [])
    .map((t) => t.toLowerCase())
    .join(' ');
  const keywords = (spec['keywords'] as string[] | undefined) ?? [];
  const body =
    `${spec['power'] !== undefined ? `${String(spec['power'])}/${String(spec['toughness'])} ` : ''}${colorText} ${subtypes} ${types} token${n === 'a' ? '' : 's'}`.replace(
      /\s+/g,
      ' ',
    );
  return `${n === 'a' ? article(body) : `${n} ${body}`}${keywords.length > 0 ? ` with ${keywords.join(' and ')}` : ''}${named}`;
}

function conditionText(condition: unknown): string {
  if (!isNode(condition)) throw new Unrendered('condition:not-an-object');
  const kind = String(condition['kind']);
  switch (kind) {
    case 'countPermanents': {
      only(condition, kind, ['kind', 'selector', 'scope', 'cmp', 'n']);
      if (condition['scope'] !== 'you') throw new Unrendered('condition.countPermanents.scope');
      const n = Number(condition['n']);
      if (condition['cmp'] === '>=' && n === 1)
        return `you control ${article(selectorNoun(condition['selector']))}`;
      if (condition['cmp'] === '>=')
        return `you control ${NUMBER_WORDS[n] ?? n} or more ${selectorNoun(condition['selector'], { plural: true })}`;
      throw new Unrendered('condition.countPermanents.cmp');
    }
    case 'compareValues': {
      only(condition, kind, ['kind', 'left', 'cmp', 'right']);
      const left = condition['left'];
      if (isNode(left) && left['kind'] === 'cardTypesInYourGraveyard' && condition['cmp'] === '>=')
        return `there are ${NUMBER_WORDS[Number(amount(condition['right']))]} or more card types among cards in your graveyard`;
      throw new Unrendered('condition.compareValues');
    }
    default:
      throw new Unrendered(`condition:${kind}`);
  }
}

/** "a and b", "a, b, and c". */
function andList(items: string[]): string {
  return items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)!}`;
}

/**
 * The effects as Oracle phrases them: one phrase per effect, except where Oracle folds several
 * into one ("gains flying and haste until end of turn", "search …, then shuffle").
 */
function effectPhrases(effects: unknown[], ctx: EffectContext, used: Set<number>): string[] {
  const phrases: string[] = [];
  for (let index = 0; index < effects.length; index++) {
    const effect = effects[index];
    if (isNode(effect) && effect['op'] === 'grantKeywordUntilEot') {
      // Keywords granted to the same object one after another are one phrase in Oracle text.
      only(effect, 'grantKeywordUntilEot', ['op', 'target', 'keyword']);
      const keywords = [String(effect['keyword'])];
      while (index + 1 < effects.length) {
        const next = effects[index + 1];
        if (!isNode(next) || next['op'] !== 'grantKeywordUntilEot') break;
        if (next['target'] !== effect['target']) break;
        only(next, 'grantKeywordUntilEot', ['op', 'target', 'keyword']);
        keywords.push(String(next['keyword']));
        index++;
      }
      phrases.push(
        `${targetRef(effect['target'], ctx, used)} gains ${andList(keywords)} until end of turn`,
      );
      continue;
    }
    const text = effectText(effect, ctx, used);
    const next = effects[index + 1];
    if (
      isNode(effect) &&
      effect['op'] === 'searchLibrary' &&
      isNode(next) &&
      next['op'] === 'shuffle' &&
      Object.keys(next).length === 1
    ) {
      phrases.push(`${text}, then shuffle`);
      index++;
      continue;
    }
    phrases.push(text);
  }
  return phrases;
}

function joinEffects(effects: unknown[], ctx: EffectContext, used: Set<number>): string {
  // Oracle joins effects with "and", "then" or a period; the comparison ignores the difference.
  return effectPhrases(effects, ctx, used).map(capitalize).join('. ');
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

// ── Abilities ─────────────────────────────────────────────────────────────────────────────────

function triggerText(trigger: unknown): string {
  if (!isNode(trigger)) throw new Unrendered('trigger:not-an-object');
  const when = String(trigger['when']);
  const subject = trigger['subject'];
  const subjectText = (): string => {
    if (!isNode(subject)) throw new Unrendered('trigger.subject');
    if (subject['kind'] === 'self') return '~';
    if (subject['kind'] === 'permanent') {
      only(subject, 'subject', ['kind', 'selector']);
      const selector = subject['selector'];
      if (isNode(selector) && selector['kind'] === 'attachedToSource') {
        only(selector, 'attachedToSource', ['kind']);
        return ATTACHED;
      }
      return article(selectorNoun(selector));
    }
    throw new Unrendered(`trigger.subject:${String(subject['kind'])}`);
  };
  const player = (who: unknown): string => {
    if (who === 'you') return 'your';
    if (who === 'each') return 'each';
    throw new Unrendered(`trigger.player:${String(who)}`);
  };
  switch (when) {
    case 'enters':
      only(trigger, when, ['when', 'subject']);
      return `When ${subjectText()} enters`
        .replace('When a', 'Whenever a')
        .replace('When an', 'Whenever an');
    case 'dies':
      only(trigger, when, ['when', 'subject']);
      return `When ${subjectText()} dies`
        .replace('When a', 'Whenever a')
        .replace('When an', 'Whenever an');
    case 'attacks':
      only(trigger, when, ['when', 'subject']);
      return `Whenever ${subjectText()} attacks`;
    case 'dealsCombatDamageToPlayer':
      only(trigger, when, ['when', 'subject']);
      return `Whenever ${subjectText()} deals combat damage to a player`;
    case 'leavesBattlefield': {
      only(trigger, when, ['when', 'subject', 'leavesTo']);
      const to = trigger['leavesTo'];
      if (!Array.isArray(to) || to.length !== 1 || to[0] !== 'graveyard')
        throw new Unrendered('leavesBattlefield.leavesTo');
      const subject = subjectText();
      return `${subject === '~' ? 'When' : 'Whenever'} ${subject} is put into a graveyard from the battlefield`;
    }
    case 'dealtDamage':
      only(trigger, when, ['when', 'subject']);
      return `Whenever ${subjectText()} is dealt damage`;
    case 'becomesTargeted':
      only(trigger, when, ['when', 'subject']);
      return `Whenever ${subjectText()} becomes the target of a spell or ability`;
    case 'upkeep':
      only(trigger, when, ['when', 'player']);
      return `At the beginning of ${player(trigger['player'])} upkeep`;
    case 'endStep':
      only(trigger, when, ['when', 'player']);
      return `At the beginning of ${player(trigger['player'])} end step`;
    case 'castsSpell': {
      only(trigger, when, ['when', 'caster', 'filter']);
      const caster = trigger['caster'];
      const who =
        caster === 'you'
          ? 'you cast'
          : caster === 'opponent'
            ? 'an opponent casts'
            : caster === 'each'
              ? 'a player casts'
              : null;
      if (who === null) throw new Unrendered('castsSpell.caster');
      const spell =
        trigger['filter'] === undefined
          ? 'spell'
          : selectorNoun(trigger['filter'], { base: '', noun: 'spell' });
      return `Whenever ${who} ${article(spell)}`;
    }
    case 'drawsCard':
      only(trigger, when, ['when', 'player']);
      if (trigger['player'] !== 'you') throw new Unrendered('drawsCard.player');
      return 'Whenever you draw a card';
    default:
      throw new Unrendered(`when:${when}`);
  }
}

function abilityBody(ability: unknown): string {
  if (!isNode(ability)) throw new Unrendered('ability:not-an-object');
  only(ability, 'ability', ['kind', 'trigger', 'optional', 'targets', 'effects', 'description']);
  const targets = (ability['targets'] as unknown[] | undefined) ?? [];
  const ctx: EffectContext = { targets, self: '~' };
  const used = new Set<number>();
  const phrases = effectPhrases((ability['effects'] as unknown[]) ?? [], ctx, used);
  // An ability with no effects has no sentence to compare: it goes to the model check.
  if (phrases.length === 0) throw new Unrendered('ability:no-effects');
  if (used.size !== targets.length) throw new Unrendered('ability:unused-target-slot');
  const text = phrases.map(capitalize).join('. ');
  if (ability['optional'] !== true) return text;
  // Declining an optional trigger skips every effect, but "you may" in printed text covers only
  // its own phrase, so an optional ability is compared only when its effects are one phrase
  // ("you may search …, then shuffle").
  if (phrases.length !== 1) throw new Unrendered('ability:optional-multi-effect');
  return `you may ${text[0]!.toLowerCase()}${text.slice(1)}`;
}

/**
 * "Sacrifice another creature or artifact". The engine only offers the controller's own
 * permanents and excludes the source unless `allowSelf` is set, so "another" is the absence of
 * `allowSelf`; an `other` part of the selector says the same thing again. The selector must say
 * "you control" (every parsed sacrifice does), which the printed cost leaves implicit.
 */
function sacrificeText(cost: Node): string {
  only(cost, 'cost.sacrificeOther', ['kind', 'selector', 'count', 'allowSelf']);
  const selector = cost['selector'];
  if (!isNode(selector) || selector['kind'] !== 'allOf') throw new Unrendered('sacrifice.selector');
  const parts = selector['of'] as unknown[];
  const yours = (part: unknown) =>
    isNode(part) && part['kind'] === 'controller' && part['who'] === 'you';
  const other = (part: unknown) => isNode(part) && part['kind'] === 'other';
  if (parts.filter(yours).length !== 1) throw new Unrendered('sacrifice.controller');
  const allowSelf = cost['allowSelf'];
  if (allowSelf !== undefined && allowSelf !== true) throw new Unrendered('sacrifice.allowSelf');
  if (allowSelf === true && parts.some(other)) throw new Unrendered('sacrifice.self-and-other');
  const rest = parts.filter((part) => !yours(part) && !other(part));
  const noun = selectorNoun(rest.length === 1 ? rest[0] : { kind: 'allOf', of: rest });
  const count = cost['count'];
  if (count !== undefined && count !== 1) {
    if (typeof count !== 'number') throw new Unrendered('sacrifice.count');
    return `Sacrifice ${countWord(count)} ${allowSelf === true ? '' : 'other '}${pluralize(noun)}`;
  }
  return `Sacrifice ${allowSelf === true ? article(noun) : `another ${noun}`}`;
}

function costText(cost: unknown): string {
  if (!isNode(cost)) throw new Unrendered('cost:not-an-object');
  switch (cost['kind']) {
    case 'mana':
      only(cost, 'cost.mana', ['kind', 'cost']);
      return manaText(cost['cost']);
    case 'tap':
      only(cost, 'cost.tap', ['kind']);
      return '{T}';
    case 'sacrificeSelf':
      only(cost, 'cost.sacrificeSelf', ['kind']);
      return 'Sacrifice ~';
    case 'payLife':
      only(cost, 'cost.payLife', ['kind', 'amount']);
      return `Pay ${amount(cost['amount'])} life`;
    case 'exileSelfFromGraveyard':
      only(cost, 'cost.exileSelfFromGraveyard', ['kind']);
      return 'Exile ~ from your graveyard';
    case 'sacrificeOther':
      return sacrificeText(cost);
    default:
      throw new Unrendered(`cost:${String(cost['kind'])}`);
  }
}

// ── Static abilities ──────────────────────────────────────────────────────────────────────────

/** Who a static ability affects, and whether the verb agrees with one object or many. */
function affectedText(affects: unknown, conditioned: boolean): { text: string; plural: boolean } {
  if (!isNode(affects)) throw new Unrendered('static.affects');
  if (affects['kind'] === 'self') {
    only(affects, 'static.self', ['kind']);
    // After "As long as …," Oracle may call the card "it".
    return { text: conditioned ? alt('~', 'it') : '~', plural: false };
  }
  if (affects['kind'] === 'attachedToSource') {
    only(affects, 'static.attachedToSource', ['kind']);
    return { text: ATTACHED, plural: false };
  }
  // "Skeletons you control and other Zombies you control": a union of plain selectors.
  if (affects['kind'] === 'anyOf') {
    only(affects, 'static.anyOf', ['kind', 'of']);
    const options = affects['of'] as unknown[];
    if (!options.every((o) => isNode(o) && o['kind'] === 'allOf'))
      throw new Unrendered('static.anyOf');
    return {
      text: options.map((o) => selectorNoun(o, { plural: true })).join(' and '),
      plural: true,
    };
  }
  return { text: selectorNoun(affects, { plural: true }), plural: true };
}

/** What a layer operation does to the affected objects: "get +1/+1", "has flying". */
function staticPredicate(op: unknown, plural: boolean): string {
  if (!isNode(op)) throw new Unrendered('static.op');
  const verb = (one: string, many: string) => (plural ? many : one);
  if (op['layer'] === 7 && op['sublayer'] === 'd') {
    only(op, 'static.pt', ['layer', 'sublayer', 'power', 'toughness']);
    if (dynamicX(op['power']) !== null || dynamicX(op['toughness']) !== null)
      throw new Unrendered('static.pt:dynamic');
    return `${verb('gets', 'get')} ${pt(op['power'], op['toughness'], 0)}`;
  }
  if (op['layer'] === 6) {
    if ('addKeyword' in op) {
      only(op, 'static.addKeyword', ['layer', 'addKeyword']);
      return `${verb('has', 'have')} ${String(op['addKeyword'])}`;
    }
    if ('setCantBeBlocked' in op) {
      only(op, 'static.setCantBeBlocked', ['layer', 'setCantBeBlocked']);
      if (op['setCantBeBlocked'] !== true) throw new Unrendered('static.setCantBeBlocked');
      return "can't be blocked";
    }
    if ('setMustAttackEachCombat' in op) {
      only(op, 'static.setMustAttackEachCombat', ['layer', 'setMustAttackEachCombat']);
      if (op['setMustAttackEachCombat'] !== true)
        throw new Unrendered('static.setMustAttackEachCombat');
      return `${verb('attacks', 'attack')} each combat if able`;
    }
    throw new Unrendered(`static.layer6:${Object.keys(op).join(',')}`);
  }
  if (op['layer'] === 4) {
    if ('setLandSubtype' in op) {
      // "Nonbasic lands are Islands": setting a land type removes the land's rules-text
      // abilities (CR 305.7), so the IR must say so too.
      only(op, 'static.setLandSubtype', ['layer', 'setLandSubtype', 'loseAbilities']);
      if (op['loseAbilities'] !== true) throw new Unrendered('static.setLandSubtype:abilities');
      const land = String(op['setLandSubtype']);
      return plural ? `are ${pluralize(land)}` : `is ${article(land)}`;
    }
    if ('addSubtypes' in op) {
      only(op, 'static.addSubtypes', ['layer', 'addSubtypes']);
      const subtypes = op['addSubtypes'] as unknown[];
      if (!Array.isArray(subtypes) || subtypes.length !== 1)
        throw new Unrendered('static.addSubtypes');
      const subtype = String(subtypes[0]);
      return `${plural ? `are ${pluralize(subtype)}` : `is ${article(subtype)}`} in addition to ${plural ? 'their' : 'its'} other types`;
    }
    throw new Unrendered(`static.layer4:${Object.keys(op).join(',')}`);
  }
  throw new Unrendered(`static.layer:${String(op['layer'])}`);
}

function staticCondition(condition: unknown): string {
  if (!isNode(condition)) throw new Unrendered('static.condition');
  if (condition['kind'] === 'sourceHasCounters') {
    only(condition, 'sourceHasCounters', ['kind', 'counter', 'cmp', 'n']);
    const n = condition['n'];
    if (condition['cmp'] !== '>=' || typeof n !== 'number' || n < 2)
      throw new Unrendered('sourceHasCounters.cmp');
    return `~ has ${NUMBER_WORDS[n] ?? n} or more ${String(condition['counter'])} counters on it`;
  }
  return conditionText(condition);
}

/**
 * Static abilities, one line per run of statics that affect the same objects under the same
 * condition: "Equipped creature gets +2/+0 and has trample."
 */
function staticLines(statics: unknown[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < statics.length;) {
    const first = statics[index];
    if (!isNode(first)) throw new Unrendered('static:not-an-object');
    const key = JSON.stringify([first['affects'], first['condition']]);
    const run: Node[] = [];
    while (index < statics.length) {
      const next = statics[index];
      if (!isNode(next) || JSON.stringify([next['affects'], next['condition']]) !== key) break;
      only(next, 'static', ['affects', 'op', 'condition']);
      run.push(next);
      index++;
    }
    const conditioned = first['condition'] !== undefined;
    const subject = affectedText(first['affects'], conditioned);
    const predicates = run.map((effect) => staticPredicate(effect['op'], subject.plural));
    const body = `${subject.text} ${andList(predicates)}`;
    lines.push(
      conditioned
        ? `As long as ${staticCondition(first['condition'])}, ${body}.`
        : `${capitalize(body)}.`,
    );
  }
  return lines;
}

/** One rendered line per ability in the definition's behavior fields. Throws `Unrendered`. */
export function renderBehavior(def: Partial<CardDefinition>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(def)) {
    if (value === undefined) continue;
    switch (key) {
      case 'triggers':
        for (const ability of value as unknown[]) {
          const a = ability as Node;
          const head = triggerText(a['trigger']);
          const body = abilityBody(ability);
          lines.push(`${head}, ${body[0]!.toLowerCase()}${body.slice(1)}.`);
        }
        break;
      case 'activatedAbilities':
        for (const activated of value as unknown[]) {
          if (!isNode(activated)) throw new Unrendered('activated:not-an-object');
          only(activated, 'activated', ['costs', 'timing', 'ability', 'zone']);
          const timing = activated['timing'];
          if (timing !== 'any' && timing !== 'sorcery' && timing !== undefined)
            throw new Unrendered(`activated.timing:${String(timing)}`);
          const costs = (activated['costs'] as unknown[]).map(costText).join(', ');
          const line = `${costs}: ${abilityBody(activated['ability'])}.${timing === 'sorcery' ? ' Activate only as a sorcery.' : ''}`;
          // An ability activated from the graveyard says so in its own text: a cost or an effect
          // that names "~ from your graveyard". Without that, the zone is unreadable.
          // Text that names "~ from your graveyard" is an ability of the card in the graveyard,
          // and the other way round.
          const zone = activated['zone'];
          if (zone !== undefined && zone !== 'battlefield' && zone !== 'graveyard')
            throw new Unrendered(`activated.zone:${String(zone)}`);
          if ((zone === 'graveyard') !== firstWording(line).includes('~ from your graveyard'))
            throw new Unrendered('activated.zone:graveyard-unstated');
          lines.push(line);
        }
        break;
      case 'spellAbility': {
        const ability = value as Node;
        lines.push(`${abilityBody(ability)}.`);
        break;
      }
      case 'manaAbilities':
        for (const mana of value as unknown[]) {
          if (!isNode(mana)) throw new Unrendered('mana:not-an-object');
          only(mana, 'manaAbility', ['units', 'amount']);
          const units = mana['units'] as string[][];
          // Each unit is one mana; a unit with several colors is a choice among them.
          let symbols: string;
          if (units.every((unit) => unit.length === 1))
            symbols = units.map((unit) => `{${unit[0]}}`).join('');
          else if (units.length === 1 && [...new Set(units[0])].sort().join('') === 'BGRUW')
            symbols = 'one mana of any color';
          else if (units.length === 1)
            symbols = units[0]!.map((color) => `{${color}}`).join(' or ');
          else throw new Unrendered('manaAbility:choice');
          const x = dynamicX(mana['amount']);
          if (mana['amount'] !== undefined && x?.each === undefined)
            throw new Unrendered('manaAbility.amount');
          lines.push(`{T}: Add ${symbols}${x === null ? '' : ` for each ${x.each}`}.`);
        }
        break;
      case 'keywords':
        for (const keyword of value as string[]) lines.push(capitalize(keyword));
        break;
      case 'entersTapped':
        // A compiled patch is applied over the parsed card, and a scalar field replaces the parsed
        // value: `false` would silently remove a printed "enters tapped", so it is never settled.
        if (value !== true) throw new Unrendered('entersTapped');
        lines.push('~ enters tapped.');
        break;
      case 'staticEffects':
        lines.push(...staticLines(value as unknown[]));
        break;
      default:
        throw new Unrendered(`field:${key}`);
    }
  }
  return lines;
}

// ── Comparison with Oracle text ───────────────────────────────────────────────────────────────

const SELF_NAMES =
  /\bthis (creature|artifact|enchantment|land|equipment|spacecraft|aura|permanent|spell|vehicle|card)\b/g;

/** A line reduced to what matters for comparison. */
export function normalizeLine(text: string, cardName: string): string {
  let out = text.toLowerCase().replace(/\([^)]*\)/g, ' ');
  // An ability word or flavor word ("Magecraft —", "Peaceful Coexistence —") has no rules
  // meaning (CR 207.2c-d). Only one before a trigger or a static "as long as" is dropped: a
  // keyword before a cost (Boast, Forecast, Exhaust) restricts the ability, so it must stay.
  out = out.replace(/^[a-z][a-z' -]{2,40} — (?=(when|whenever|at the beginning|as long as)\b)/, '');
  for (const name of [cardName, ...cardName.split(/ \/\/ |, /)])
    if (name.length > 2) out = out.split(name.toLowerCase()).join('~');
  out = out.replace(SELF_NAMES, '~');
  // A legendary person's own text calls the card "he" or "she"; the renderer never writes either.
  out = out.replace(/\b(he|she)\b/g, '~');
  // "All permanents other than ~" is "all other permanents": the renderer writes the second.
  out = out.replace(/\b(all|each) ([a-z]+) other than ~/g, '$1 other $2');
  // The order of mana symbols in a cost or an add means nothing: {G}{U} is {U}{G}.
  out = out.replace(/(?:\{[wubrg]\})+/g, (run) =>
    (run.match(/\{[wubrg]\}/g) ?? [])
      .sort((a, b) => 'wubrg'.indexOf(a[1]!) - 'wubrg'.indexOf(b[1]!))
      .join(''),
  );
  for (const [index, word] of NUMBER_WORDS.entries())
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), String(index));
  out = out.replace(/\ban\b/g, 'a');
  // Effects in one ability may be joined by "and", "then" or a new sentence, with or without "you".
  out = out.replace(/[.,]?\s*\b(and|then)\b\s+/g, ' ');
  out = out.replace(
    /(^|[.,:]\s*|\s)you (draw|lose|gain|scry|mill|surveil|create|sacrifice)\b/g,
    '$1$2',
  );
  return out
    .replace(/[.,;:—•"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Use up one copy of `line` from `pool`; false when none is left. */
function consumeOne(pool: Map<string, number>, line: string): boolean {
  const left = pool.get(line) ?? 0;
  if (left === 0) return false;
  pool.set(line, left - 1);
  return true;
}

export type TextCheck =
  | { verdict: 'match'; rendered: string[] }
  | { verdict: 'mismatch'; rendered: string[] }
  | { verdict: 'unrendered'; node: string };

/**
 * Render a patch and compare it with the Oracle lines it claims. `oracleText` is the whole card,
 * because a patch that replaces a whole field (a spell) restates lines the parser already read.
 */
export function textCheck(
  def: Partial<CardDefinition>,
  lines: string[],
  cardName: string,
  oracleText: string,
): TextCheck {
  // A spell ability replaces the parsed one, so its text may restate any line of the card. Every
  // other field is appended to what the parser built from the other lines, so its text must come
  // from the lines the patch claims to handle; otherwise it would duplicate a parsed ability.
  const { spellAbility, ...appended } = def;
  let spellLines: string[];
  let appendedLines: string[];
  try {
    spellLines = spellAbility === undefined ? [] : renderBehavior({ spellAbility });
    appendedLines = renderBehavior(appended);
  } catch (error) {
    if (error instanceof Unrendered) return { verdict: 'unrendered', node: error.node };
    // A malformed patch (a missing list, a wrong type) is not this check's to judge: the validator
    // reports it, and the card goes to the model check.
    return { verdict: 'unrendered', node: `malformed:${String(error)}` };
  }
  const rendered = [...spellLines, ...appendedLines];
  const normalize = (text: string): string => normalizeLine(text, cardName);
  const pool = (texts: string[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const text of texts) out.set(normalize(text), (out.get(normalize(text)) ?? 0) + 1);
    return out;
  };
  // Each rendered line uses up one printed line (the first of its wordings that is still free),
  // so the same ability twice does not match one printed line, and one rendered line cannot
  // cover two printed lines however many wordings it has.
  const used: string[] = [];
  const consume =
    (printed: Map<string, number>) =>
    (text: string): boolean => {
      for (const wording of expandAlternatives(text)) {
        const line = normalize(wording);
        const left = printed.get(line) ?? 0;
        if (left > 0) {
          printed.set(line, left - 1);
          used.push(line);
          return true;
        }
      }
      return false;
    };
  // A replacement spell ability must restate every line of the card, not only the claimed ones,
  // or parsed spell effects could silently disappear. Lines it cannot restate (a keyword, say)
  // send the card to the model check, which is the safe direction.
  const required = spellAbility === undefined ? lines : oracleText.split('\n');
  let ok: boolean;
  try {
    ok =
      spellLines.every(consume(pool(oracleText.split('\n')))) &&
      appendedLines.every(consume(pool(lines)));
  } catch (error) {
    if (error instanceof Unrendered) return { verdict: 'unrendered', node: error.node };
    throw error;
  }
  // Every required line must be used up by its own rendered line: two identical printed lines
  // need two rendered abilities, so coverage counts lines rather than testing membership.
  const covered = new Map<string, number>();
  for (const line of used) covered.set(line, (covered.get(line) ?? 0) + 1);
  ok = ok && required.every((line) => consumeOne(covered, normalize(line)));
  return { verdict: ok ? 'match' : 'mismatch', rendered: rendered.map(firstWording) };
}

if (import.meta.main) {
  const { interpretCard } = await import('../../packages/engine/src/cards/interpret');
  const { behaviorOf, pinnedPool } = await import('./lib');
  let modeled = 0;
  let renderedAll = 0;
  let matched = 0;
  const misses = new Map<string, number>();
  const mismatches: string[] = [];
  for (const { card } of pinnedPool()) {
    const definition = interpretCard(card);
    if (!definition.modeled || (card.oracleText ?? '') === '') continue;
    modeled++;
    const behavior = behaviorOf(definition) as Partial<CardDefinition>;
    const lines = (card.oracleText ?? '').split('\n');
    const result = textCheck(behavior, lines, card.name, card.oracleText ?? '');
    if (result.verdict === 'unrendered') {
      misses.set(result.node, (misses.get(result.node) ?? 0) + 1);
      continue;
    }
    renderedAll++;
    if (result.verdict === 'match') matched++;
    else if (mismatches.length < 15)
      mismatches.push(
        `${card.name}\n  oracle:   ${lines.join(' | ')}\n  rendered: ${result.rendered.join(' | ')}`,
      );
  }
  console.log(
    `modeled cards: ${modeled}; fully rendered: ${renderedAll} (${((100 * renderedAll) / modeled).toFixed(1)}%); match Oracle: ${matched} (${((100 * matched) / modeled).toFixed(1)}%)`,
  );
  console.log('most common unrendered nodes (a card counts once, at its first miss):');
  for (const [node, count] of [...misses].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${String(count).padStart(5)}  ${node}`);
  if (process.argv.includes('--mismatches')) console.log(mismatches.join('\n'));
}
