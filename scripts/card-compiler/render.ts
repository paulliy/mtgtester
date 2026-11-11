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

/** A dynamic amount as the "where X is …" clause, or null for a fixed number. */
/**
 * `targetCount` is the number of target slots of the ability the value sits in: "its power" is
 * only unambiguous when there is exactly one.
 */
function dynamicX(value: unknown, targetCount = 0): string | null {
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
      const noun = selectorNoun(value['selector'], { plural: true });
      return `the number of ${noun}${noun.includes('you control') ? '' : owner}${scope === 'all' ? ' on the battlefield' : ''}`;
    }
    case 'countersOnSelf':
      only(value, 'countersOnSelf', ['kind', 'counter']);
      return `the number of ${String(value['counter'])} counters on ~`;
    case 'powerOfTarget':
      only(value, 'powerOfTarget', ['kind', 'target']);
      // "its" names a slot only when the ability has a single target; any other shape would let a
      // patch that reads the wrong slot render the same English as the right one.
      if (value['target'] !== 0 || targetCount !== 1) throw new Unrendered('powerOfTarget.slot');
      return 'its power';
    default:
      throw new Unrendered(`value:${String(value['kind'])}`);
  }
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
        if (!options.every((o) => isNode(o) && o['kind'] === 'type' && Object.keys(o).length === 2))
          throw new Unrendered('selector:anyOf-non-type');
        types = [...types, options.map((o) => String((o as Node)['value'])).join(' or ')];
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
  let noun = [subtypes[0], head].filter((word) => word !== undefined && word !== '').join(' ');
  // Creature plus a subtype stays "Elf creature": bare "Elves" also counts a noncreature Kindred
  // Elf, so dropping the type would render a narrower selector as the wider printed one.
  if (plural) noun = pluralize(noun);
  return [...prefixes, ...adjectives, noun, ...suffixes].join(' ');
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

/** "target creature you control", "target instant or sorcery spell". */
function targetPhrase(spec: unknown): string {
  if (!isNode(spec)) throw new Unrendered('target:not-an-object');
  const kind = String(spec['kind']);
  only(spec, `target.${kind}`, ['kind', 'controller', 'filter', 'graveyardOwnerScope']);
  const base = TARGET_NOUN[kind];
  if (base === undefined) throw new Unrendered(`target:${kind}`);
  let noun = base;
  if (spec['filter'] !== undefined) {
    if (kind === 'cardInGraveyard')
      noun = `${selectorNoun(spec['filter'], { base: '' })} card`.trim();
    else if (kind === 'spell') noun = `${selectorNoun(spec['filter'], { base: '' })} spell`.trim();
    else if (kind === 'permanent') noun = selectorNoun(spec['filter']);
    else noun = `${selectorNoun(spec['filter'], { base: '' })} ${base}`.trim();
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
    if (scope === 'any') return `target ${noun} from a graveyard`;
    if (scope === undefined) return `target ${noun} from your graveyard`;
    throw new Unrendered(`graveyardOwnerScope:${String(scope)}`);
  }
  if (spec['graveyardOwnerScope'] !== undefined) throw new Unrendered('target.graveyardOwnerScope');
  return `target ${noun}`;
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
    if (used.has(ref)) return 'it';
    used.add(ref);
    return targetPhrase(spec);
  }
  if (ref === 'triggerObject') return 'that creature';
  throw new Unrendered(`targetRef:${String(ref)}`);
}

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
  const withX = (text: string, value: unknown): string => {
    const x = dynamicX(value, ctx.targets.length);
    return x === null
      ? text.replace('{n}', amount(value))
      : `${text.replace('{n}', 'X')}, where X is ${x}`;
  };
  switch (op) {
    case 'draw': {
      only(effect, op, ['op', 'count']);
      const x = dynamicX(effect['count'], ctx.targets.length);
      if (x !== null) return `draw cards equal to ${x}`;
      const n = countWord(effect['count']);
      return n === 'a' ? 'draw a card' : `draw ${n} cards`;
    }
    case 'gainLife':
      only(effect, op, ['op', 'amount']);
      return withX('you gain {n} life', effect['amount']);
    case 'loseLife':
      only(effect, op, ['op', 'amount']);
      return withX('you lose {n} life', effect['amount']);
    case 'eachOpponentLosesLife':
      only(effect, op, ['op', 'amount']);
      return withX('each opponent loses {n} life', effect['amount']);
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
    case 'graveyardToHand':
      only(effect, op, ['op', 'target']);
      return `return ${t()} to ${t().endsWith('from your graveyard') ? 'your hand' : "its owner's hand"}`;
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
        const x = dynamicX(effect['amount'], ctx.targets.length);
        if (x === null) throw new Unrendered('dealDamage.source-fixed');
        return `${source} deals damage equal to ${x} to ${target}`;
      }
      return withX(`${ctx.self} deals {n} damage to ${target}`, effect['amount']);
    }
    case 'eachOpponentDamage':
      only(effect, op, ['op', 'amount']);
      return withX(`${ctx.self} deals {n} damage to each opponent`, effect['amount']);
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
    if (px !== tx) throw new Unrendered('pump:mixed-dynamic');
    return `+X/+X, where X is ${px}`;
  }
  const sign = (v: unknown) => {
    const n = Number(amount(v));
    return n >= 0 ? `+${n}` : String(n);
  };
  return `${sign(power)}/${sign(toughness)}`;
}

function tokenText(spec: unknown, count: unknown): string {
  if (!isNode(spec)) throw new Unrendered('token:not-an-object');
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
  return `${n === 'a' ? article(body) : `${n} ${body}`}${keywords.length > 0 ? ` with ${keywords.join(' and ')}` : ''}`;
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

function joinEffects(effects: unknown[], ctx: EffectContext, used: Set<number>): string {
  const parts = effects.map((effect) => effectText(effect, ctx, used));
  const sentences: string[] = [];
  for (const part of parts) {
    // Oracle joins effects with "and", "then" or a period; the comparison ignores the difference.
    sentences.push(part);
  }
  return sentences.map(capitalize).join('. ');
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
      if (isNode(selector) && selector['kind'] === 'attachedToSource') return 'equipped creature';
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
    case 'becomesTargeted':
      only(trigger, when, ['when', 'subject']);
      return `Whenever ${subjectText()} becomes the target of a spell or ability`;
    case 'upkeep':
      only(trigger, when, ['when', 'player']);
      return `At the beginning of ${player(trigger['player'])} upkeep`;
    case 'endStep':
      only(trigger, when, ['when', 'player']);
      return `At the beginning of ${player(trigger['player'])} end step`;
    case 'castsSpell':
      only(trigger, when, ['when', 'caster']);
      if (trigger['caster'] !== 'you') throw new Unrendered('castsSpell.caster');
      return 'Whenever you cast a spell';
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
  const text = joinEffects((ability['effects'] as unknown[]) ?? [], ctx, used);
  if (used.size !== targets.length) throw new Unrendered('ability:unused-target-slot');
  if (ability['optional'] !== true) return text;
  // Declining an optional trigger skips every effect, but "you may" in printed text covers only
  // its own sentence, so an optional ability with more than one effect cannot be compared safely.
  if (((ability['effects'] as unknown[]) ?? []).length > 1)
    throw new Unrendered('ability:optional-multi-effect');
  return `you may ${text[0]!.toLowerCase()}${text.slice(1)}`;
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
    default:
      throw new Unrendered(`cost:${String(cost['kind'])}`);
  }
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
          only(activated, 'activated', ['costs', 'timing', 'ability']);
          if (activated['timing'] !== 'any' && activated['timing'] !== undefined)
            throw new Unrendered(`activated.timing:${String(activated['timing'])}`);
          const costs = (activated['costs'] as unknown[]).map(costText).join(', ');
          lines.push(`${costs}: ${abilityBody(activated['ability'])}.`);
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
          if (mana['amount'] !== undefined && x === null)
            throw new Unrendered('manaAbility.amount');
          lines.push(
            `{T}: Add ${symbols}${x === null ? '' : ` for each ${x.replace(/^the number of /, '').replace(/s on the battlefield$/, ' on the battlefield')}`}.`,
          );
        }
        break;
      case 'keywords':
        for (const keyword of value as string[]) lines.push(capitalize(keyword));
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
  for (const name of [cardName, ...cardName.split(/ \/\/ |, /)])
    if (name.length > 2) out = out.split(name.toLowerCase()).join('~');
  out = out.replace(SELF_NAMES, '~');
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
    throw error;
  }
  const rendered = [...spellLines, ...appendedLines];
  const counts = (texts: string[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const text of texts) {
      const line = normalizeLine(text, cardName);
      out.set(line, (out.get(line) ?? 0) + 1);
    }
    return out;
  };
  // Each rendered line uses up one printed line, so the same ability twice does not match.
  const take = (pool: Map<string, number>) => (text: string) => {
    const line = normalizeLine(text, cardName);
    const left = pool.get(line) ?? 0;
    pool.set(line, left - 1);
    return left > 0;
  };
  // A replacement spell ability must restate every line of the card, not only the claimed ones,
  // or parsed spell effects could silently disappear. Lines it cannot restate (a keyword, say)
  // send the card to the model check, which is the safe direction.
  const required = spellAbility === undefined ? lines : oracleText.split('\n');
  const want = new Set(required.map((line) => normalizeLine(line, cardName)));
  const got = new Set(rendered.map((line) => normalizeLine(line, cardName)));
  const ok =
    spellLines.every(take(counts(oracleText.split('\n')))) &&
    appendedLines.every(take(counts(lines))) &&
    [...want].every((line) => got.has(line));
  return { verdict: ok ? 'match' : 'mismatch', rendered };
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
