// Adapters from XMage's shared ability, effect and filter classes to our card IR.
//
// Each adapter is strict: an argument it does not recognize, a duration other than the one it
// handles, or a filter predicate with no Selector equivalent throws `Unmapped` naming that node.
// A card is translated whole-line or not at all; there is no partial output.
//
// The IR emitted here is the same IR the Oracle interpreter produces for the same wording (for
// example "Creatures you control get +1/+1" from Glorious Anthem), so the engine sees no
// difference between a translated card and a parsed one.

import type { Color } from '../../packages/shared/src';
import type { CardDefinition, Effect } from '../../packages/engine/src/cards/definition';
import type { Selector } from '../../packages/engine/src/cards/selector';
import type { StaticEffect } from '../../packages/engine/src/cards/continuous-types';
import type { RuleStatic } from '../../packages/engine/src/cards/rule-statics';
import type { Value } from '../../packages/engine/src/cards/value';
import type {
  Ability,
  AbilityCost,
  ActivatedAbility,
  KeywordAbility,
  TargetKind,
  TargetSpec,
  TokenSpec,
} from '../../packages/engine/src/cards/ability';
import { parseManaCost } from '../../packages/engine/src/mana/cost';
import { CLUE, creatureToken, FOOD, TREASURE } from '../../packages/engine/src/cards/tokens';
import { type JExpr, parseExpr } from './java-expr';
import type { XAbility, XCard, XField } from './extract';

export class Unmapped extends Error {
  constructor(
    readonly node: string,
    detail = '',
  ) {
    super(`unmapped ${node}${detail ? `: ${detail}` : ''}`);
  }
}

export interface XmageContext {
  card: XCard;
  /** XMage `SubType` enum constant → printed subtype ("GOBLIN" → "Goblin"). */
  subtypes: Record<string, string>;
  /** `StaticFilters.FILTER_*` declarations, parsed like a card's own static filters. */
  staticFilters: Record<string, XField>;
  /** Source text of an XMage token class (`SoldierToken`), or undefined when there is none. */
  tokenSource: (cls: string) => string | undefined;
}

export type Fragment = Pick<
  Partial<CardDefinition>,
  'staticEffects' | 'ruleStatics' | 'spellAbility' | 'activatedAbilities' | 'triggers'
>;

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

const short = (cls: string) => cls.split('.').pop()!;

function describe(e: JExpr | undefined): string {
  if (!e) return '<missing>';
  switch (e.t) {
    case 'new':
      return `new ${short(e.cls)}(${e.args.length})`;
    case 'call':
      return `${e.target ? describe(e.target) : ''}.${e.name}()`;
    case 'ref':
      return e.path;
    case 'str':
      return JSON.stringify(e.v);
    case 'num':
      return String(e.v);
    case 'bool':
      return String(e.v);
    default:
      return e.t;
  }
}

function int(e: JExpr | undefined): number {
  if (e?.t === 'num' && Number.isInteger(e.v)) return e.v;
  if (e?.t === 'op' && e.op === 'neg') return -int(e.args[0]);
  throw new Unmapped(describe(e), 'expected an integer literal');
}

function bool(e: JExpr | undefined): boolean {
  if (e?.t === 'bool') return e.v;
  throw new Unmapped(describe(e), 'expected a boolean literal');
}

function expectDuration(e: JExpr | undefined, allowed: string[]): void {
  if (e?.t === 'ref' && allowed.includes(e.path)) return;
  throw new Unmapped(describe(e), `duration must be one of ${allowed.join(', ')}`);
}

const allOf = (parts: Selector[]): Selector =>
  parts.length === 1 ? parts[0]! : { kind: 'allOf', of: parts };

/** Flattens nested allOf so equivalent selectors compare equal to the interpreter's output. */
function flatten(parts: Selector[]): Selector[] {
  return parts.flatMap((p) => (p.kind === 'allOf' ? flatten(p.of) : [p]));
}

// ── Keywords ─────────────────────────────────────────────────────────────────────────────────

const KEYWORD_CLASSES: Record<string, KeywordAbility> = {
  FlyingAbility: 'flying',
  ReachAbility: 'reach',
  TrampleAbility: 'trample',
  DeathtouchAbility: 'deathtouch',
  LifelinkAbility: 'lifelink',
  FirstStrikeAbility: 'first strike',
  DoubleStrikeAbility: 'double strike',
  VigilanceAbility: 'vigilance',
  HasteAbility: 'haste',
  DefenderAbility: 'defender',
  IndestructibleAbility: 'indestructible',
  HexproofAbility: 'hexproof',
  ShroudAbility: 'shroud',
  MenaceAbility: 'menace',
  FlashAbility: 'flash',
  InfectAbility: 'infect',
};

/** `FlyingAbility.getInstance()`, `new MenaceAbility()`, or `FlyingAbility.class` (predicates). */
function keyword(e: JExpr | undefined): KeywordAbility {
  let cls: string | null = null;
  if (e?.t === 'call' && e.name === 'getInstance' && e.target?.t === 'ref')
    cls = short(e.target.path);
  else if (e?.t === 'new' && e.args.length === 0) cls = short(e.cls);
  else if (e?.t === 'ref' && e.path.endsWith('.class'))
    cls = short(e.path.slice(0, -'.class'.length));
  const kw = cls ? KEYWORD_CLASSES[cls] : undefined;
  if (!kw) throw new Unmapped(describe(e), 'not a keyword our engine implements');
  return kw;
}

// ── Filters → Selector ───────────────────────────────────────────────────────────────────────

const COLORS: Record<string, Color> = { WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G' };
const CARD_TYPES: Record<string, string> = {
  ARTIFACT: 'Artifact',
  BATTLE: 'Battle',
  CREATURE: 'Creature',
  ENCHANTMENT: 'Enchantment',
  INSTANT: 'Instant',
  LAND: 'Land',
  PLANESWALKER: 'Planeswalker',
  SORCERY: 'Sorcery',
  KINDRED: 'Kindred',
};
const SUPERTYPES: Record<string, string> = { LEGENDARY: 'Legendary', BASIC: 'Basic', SNOW: 'Snow' };

/** What each XMage filter class matches before any predicate is added. */
const FILTER_BASES: Record<string, { parts: Selector[]; zone: 'battlefield' | 'spell' | 'card' }> =
  {
    FilterPermanent: { parts: [], zone: 'battlefield' },
    FilterCreaturePermanent: { parts: [{ kind: 'type', value: 'Creature' }], zone: 'battlefield' },
    FilterControlledPermanent: { parts: [{ kind: 'controller', who: 'you' }], zone: 'battlefield' },
    FilterControlledCreaturePermanent: {
      parts: [
        { kind: 'controller', who: 'you' },
        { kind: 'type', value: 'Creature' },
      ],
      zone: 'battlefield',
    },
    FilterOpponentsCreaturePermanent: {
      parts: [
        { kind: 'controller', who: 'opponents' },
        { kind: 'type', value: 'Creature' },
      ],
      zone: 'battlefield',
    },
    FilterNonlandPermanent: {
      parts: [{ kind: 'not', of: { kind: 'type', value: 'Land' } }],
      zone: 'battlefield',
    },
    FilterArtifactPermanent: { parts: [{ kind: 'type', value: 'Artifact' }], zone: 'battlefield' },
    FilterEnchantmentPermanent: {
      parts: [{ kind: 'type', value: 'Enchantment' }],
      zone: 'battlefield',
    },
    FilterLandPermanent: { parts: [{ kind: 'type', value: 'Land' }], zone: 'battlefield' },
    FilterPlaneswalkerPermanent: {
      parts: [{ kind: 'type', value: 'Planeswalker' }],
      zone: 'battlefield',
    },
    FilterCreatureSpell: { parts: [{ kind: 'type', value: 'Creature' }], zone: 'spell' },
    FilterSpell: { parts: [], zone: 'spell' },
    FilterNoncreatureSpell: {
      parts: [{ kind: 'not', of: { kind: 'type', value: 'Creature' } }],
      zone: 'spell',
    },
    FilterInstantOrSorcerySpell: {
      parts: [
        {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Instant' },
            { kind: 'type', value: 'Sorcery' },
          ],
        },
      ],
      zone: 'spell',
    },
    FilterCard: { parts: [], zone: 'card' },
    FilterCreatureCard: { parts: [{ kind: 'type', value: 'Creature' }], zone: 'card' },
    FilterArtifactCard: { parts: [{ kind: 'type', value: 'Artifact' }], zone: 'card' },
    FilterEnchantmentCard: { parts: [{ kind: 'type', value: 'Enchantment' }], zone: 'card' },
    FilterNonlandCard: {
      parts: [{ kind: 'not', of: { kind: 'type', value: 'Land' } }],
      zone: 'card',
    },
    FilterInstantOrSorceryCard: {
      parts: [
        {
          kind: 'anyOf',
          of: [
            { kind: 'type', value: 'Instant' },
            { kind: 'type', value: 'Sorcery' },
          ],
        },
      ],
      zone: 'card',
    },
  };

export interface ResolvedFilter {
  selector: Selector;
  zone: 'battlefield' | 'spell' | 'card';
}

function filterFromField(field: XField, ctx: XmageContext, name: string): ResolvedFilter {
  if (!field.init) throw new Unmapped(name, 'filter initializer did not parse');
  rejectAnonymous(field.init);
  field.adds.forEach(rejectAnonymous);
  const base = filterFromNew(field.init, ctx);
  const parts = [
    ...flatten([base.selector].filter((s) => !(s.kind === 'allOf' && s.of.length === 0))),
  ];
  for (const add of field.adds) parts.push(predicate(add, ctx));
  return { selector: allOf(flatten(parts)), zone: base.zone };
}

function filterFromNew(e: JExpr, ctx: XmageContext): ResolvedFilter {
  if (e.t !== 'new') throw new Unmapped(describe(e), 'expected a filter constructor');
  const base = FILTER_BASES[short(e.cls)];
  if (!base) throw new Unmapped(`new ${short(e.cls)}`, 'filter class');
  const parts = [...base.parts];
  for (const arg of e.args) {
    if (arg.t === 'str') continue; // the filter's display text
    if (arg.t === 'ref' && arg.path.startsWith('SubType.')) {
      parts.push({ kind: 'subtype', value: subtype(arg.path, ctx) });
      continue;
    }
    throw new Unmapped(describe(arg), `argument to ${short(e.cls)}`);
  }
  return { selector: allOf(parts), zone: base.zone };
}

function subtype(path: string, ctx: XmageContext): string {
  const key = path.slice('SubType.'.length);
  const v = ctx.subtypes[key];
  if (!v) throw new Unmapped(path, 'unknown subtype');
  return v;
}

export function filter(e: JExpr | undefined, ctx: XmageContext): ResolvedFilter {
  if (!e) throw new Unmapped('<missing filter>');
  if (e.t === 'ref' && ctx.card.fields[e.path])
    return filterFromField(ctx.card.fields[e.path]!, ctx, e.path);
  if (e.t === 'ref' && e.path.startsWith('StaticFilters.')) {
    const key = e.path.slice('StaticFilters.'.length);
    const f = ctx.staticFilters[key];
    if (!f) throw new Unmapped(e.path, 'unknown static filter');
    return filterFromField(f, ctx, e.path);
  }
  if (e.t === 'new') return filterFromNew(e, ctx);
  throw new Unmapped(describe(e), 'filter');
}

/** One `filter.add(...)` predicate. */
function predicate(e: JExpr, ctx: XmageContext): Selector {
  // CardType.CREATURE.getPredicate(), SubType.GOBLIN.getPredicate(), SuperType.LEGENDARY.getPredicate()
  if (e.t === 'call' && e.name === 'getPredicate' && e.args.length === 0 && e.target?.t === 'ref') {
    const p = e.target.path;
    if (p.startsWith('CardType.') && CARD_TYPES[p.slice(9)])
      return { kind: 'type', value: CARD_TYPES[p.slice(9)]! };
    if (p.startsWith('SubType.')) return { kind: 'subtype', value: subtype(p, ctx) };
    if (p.startsWith('SuperType.') && SUPERTYPES[p.slice(10)])
      return { kind: 'supertype', value: SUPERTYPES[p.slice(10)]! };
  }
  // TargetController.YOU.getControllerPredicate()
  if (e.t === 'call' && e.name === 'getControllerPredicate' && e.target?.t === 'ref') {
    if (e.target.path === 'TargetController.YOU') return { kind: 'controller', who: 'you' };
    if (
      e.target.path === 'TargetController.OPPONENT' ||
      e.target.path === 'TargetController.NOT_YOU'
    )
      return { kind: 'controller', who: 'opponents' };
  }
  if (e.t === 'call' && e.target?.t === 'ref' && e.target.path === 'Predicates') {
    const args = e.args.map((a) => predicate(a, ctx));
    if (e.name === 'not' && args.length === 1) return { kind: 'not', of: args[0]! };
    if (e.name === 'or') return { kind: 'anyOf', of: args };
    if (e.name === 'and') return allOf(flatten(args));
  }
  if (e.t === 'new' && short(e.cls) === 'ColorPredicate' && e.args.length === 1) {
    const c = e.args[0];
    if (c?.t === 'ref' && c.path.startsWith('ObjectColor.') && COLORS[c.path.slice(12)])
      return { kind: 'color', value: COLORS[c.path.slice(12)]! };
  }
  if (e.t === 'new' && short(e.cls) === 'AbilityPredicate' && e.args.length === 1)
    return { kind: 'hasKeyword', keyword: keyword(e.args[0]) };
  if (e.t === 'new' && short(e.cls) === 'CounterTypePredicate' && e.args[0]?.t === 'ref') {
    const ct = e.args[0].path;
    if (ct === 'CounterType.P1P1') return { kind: 'hasCounter', counter: '+1/+1' };
  }
  if (
    e.t === 'new' &&
    ['ManaValuePredicate', 'PowerPredicate', 'ToughnessPredicate'].includes(short(e.cls))
  ) {
    const [cmp, nExpr] = e.args;
    const n = int(nExpr);
    const which = short(e.cls);
    const at = (kind: 'AtLeast' | 'AtMost', v: number): Selector => {
      if (which === 'ManaValuePredicate')
        return { kind: kind === 'AtLeast' ? 'manaValueAtLeast' : 'manaValueAtMost', n: v };
      if (which === 'PowerPredicate')
        return { kind: kind === 'AtLeast' ? 'powerAtLeast' : 'powerAtMost', n: v };
      if (kind === 'AtLeast') return { kind: 'toughnessAtLeast', n: v };
      throw new Unmapped(describe(e), 'toughness at most has no selector');
    };
    if (cmp?.t === 'ref') {
      switch (cmp.path) {
        case 'ComparisonType.MORE_THAN':
          return at('AtLeast', n + 1);
        case 'ComparisonType.OR_GREATER':
          return at('AtLeast', n);
        case 'ComparisonType.FEWER_THAN':
          return at('AtMost', n - 1);
        case 'ComparisonType.OR_LESS':
          return at('AtMost', n);
      }
    }
  }
  if (e.t === 'ref') {
    switch (e.path) {
      case 'AnotherPredicate.instance':
        return { kind: 'other' };
      case 'TokenPredicate.TRUE':
        return { kind: 'isToken' };
      case 'TokenPredicate.FALSE':
        return { kind: 'not', of: { kind: 'isToken' } };
      case 'CounterAnyPredicate.instance':
        return { kind: 'hasAnyCounter' };
      case 'MonocoloredPredicate.instance':
        return { kind: 'isMonocolored' };
      case 'CommanderPredicate.instance':
        return { kind: 'isCommander' };
      case 'TappedPredicate.TAPPED':
        return { kind: 'tapped' };
      case 'TappedPredicate.UNTAPPED':
        return { kind: 'not', of: { kind: 'tapped' } };
      case 'AttackingPredicate.instance':
        return { kind: 'combatRole', role: 'attacking' };
      case 'BlockingPredicate.instance':
        return { kind: 'combatRole', role: 'blocking' };
    }
  }
  throw new Unmapped(describe(e), 'predicate');
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────

function value(e: JExpr | undefined, ctx: XmageContext): Value | number {
  if (e?.t === 'num' || (e?.t === 'op' && e.op === 'neg')) return int(e);
  if (e?.t === 'new' && short(e.cls) === 'StaticValue' && e.args.length === 1)
    return int(e.args[0]);
  if (
    e?.t === 'call' &&
    e.name === 'get' &&
    e.target?.t === 'ref' &&
    e.target.path === 'StaticValue'
  )
    return int(e.args[0]);
  if (e?.t === 'new' && short(e.cls) === 'PermanentsOnBattlefieldCount' && e.args.length === 1) {
    const f = filter(e.args[0], ctx);
    if (f.zone !== 'battlefield')
      throw new Unmapped(describe(e), 'count over a non-battlefield filter');
    return countPermanents(f.selector);
  }
  throw new Unmapped(describe(e), 'value');
}

/** Moves a top-level controller leaf into `scope`, as the interpreter writes counts. */
function countPermanents(sel: Selector): Value {
  const parts = sel.kind === 'allOf' ? sel.of : [sel];
  const ctl = parts.find((p) => p.kind === 'controller');
  const rest = parts.filter((p) => p !== ctl);
  const scope = !ctl
    ? 'all'
    : ctl.kind === 'controller' && ctl.who === 'you'
      ? 'you'
      : ctl.kind === 'controller' && ctl.who === 'opponents'
        ? 'opponents'
        : null;
  if (scope === null) throw new Unmapped('count', 'controller scope');
  return {
    kind: 'countPermanents',
    // No card type is named "Permanent", so an empty conjunction is how "every permanent" is written.
    selector: rest.length === 0 ? { kind: 'allOf', of: [] } : allOf(rest),
    scope,
  };
}

// ── Static abilities ─────────────────────────────────────────────────────────────────────────

const ATTACHED: Selector = { kind: 'attachedToSource' };

function staticEffect(
  e: JExpr,
  ctx: XmageContext,
): { statics: StaticEffect[]; rules: RuleStatic[] } {
  if (e.t !== 'new') throw new Unmapped(describe(e), 'expected an effect constructor');
  const cls = short(e.cls);
  const a = e.args;
  const pt = (affects: Selector, p: JExpr | undefined, t: JExpr | undefined): StaticEffect => ({
    affects,
    op: { layer: 7, sublayer: 'd', power: value(p, ctx), toughness: value(t, ctx) },
  });
  const controlled = (
    f: JExpr | undefined,
    defaultParts: Selector[],
    excludeSource: boolean,
  ): Selector => {
    const parts: Selector[] = [{ kind: 'controller', who: 'you' }];
    if (f) {
      const r = filter(f, ctx);
      if (r.zone !== 'battlefield') throw new Unmapped(describe(f), 'non-permanent filter');
      parts.push(
        ...flatten([r.selector]).filter((s) => !(s.kind === 'controller' && s.who === 'you')),
      );
    } else parts.push(...defaultParts);
    if (excludeSource) parts.push({ kind: 'other' });
    return allOf(dedupe(parts));
  };
  const everyone = (f: JExpr | undefined, excludeSource: boolean): Selector => {
    const r = filter(f, ctx);
    if (r.zone !== 'battlefield') throw new Unmapped(describe(f), 'non-permanent filter');
    const parts = flatten([r.selector]);
    if (excludeSource) parts.push({ kind: 'other' });
    return allOf(dedupe(parts));
  };
  switch (cls) {
    case 'BoostControlledEffect': {
      // (power, toughness, duration [, filter [, excludeSource]])
      if (a.length < 3 || a.length > 5) break;
      expectDuration(a[2], ['Duration.WhileOnBattlefield']);
      // The 4-argument overload's last argument is either a filter or `excludeSource`.
      const [f, ex] = a[3]?.t === 'bool' ? [undefined, a[3]] : [a[3], a[4]];
      const sel = controlled(f, [{ kind: 'type', value: 'Creature' }], ex ? bool(ex) : false);
      return { statics: [pt(sel, a[0], a[1])], rules: [] };
    }
    case 'BoostAllEffect': {
      if (a.length < 3 || a.length > 5) break;
      expectDuration(a[2], ['Duration.WhileOnBattlefield']);
      const creatures: Selector = { kind: 'type', value: 'Creature' };
      const sel =
        a[3] === undefined
          ? creatures
          : a[3].t === 'bool'
            ? allOf(bool(a[3]) ? [creatures, { kind: 'other' }] : [creatures])
            : everyone(a[3], a[4] ? bool(a[4]) : false);
      return { statics: [pt(sel, a[0], a[1])], rules: [] };
    }
    case 'BoostEquippedEffect':
    case 'BoostEnchantedEffect': {
      if (a.length < 2 || a.length > 3) break;
      if (a[2]) expectDuration(a[2], ['Duration.WhileOnBattlefield']);
      return { statics: [pt(ATTACHED, a[0], a[1])], rules: [] };
    }
    case 'GainAbilityControlledEffect': {
      if (a.length < 2 || a.length > 4) break;
      expectDuration(a[1], ['Duration.WhileOnBattlefield']);
      const [f, ex] = a[2]?.t === 'bool' ? [undefined, a[2]] : [a[2], a[3]];
      const sel = controlled(f, [{ kind: 'type', value: 'Creature' }], ex ? bool(ex) : false);
      return {
        statics: [{ affects: sel, op: { layer: 6, addKeyword: keyword(a[0]) } }],
        rules: [],
      };
    }
    case 'GainAbilityAllEffect': {
      if (a.length < 3 || a.length > 4) break;
      expectDuration(a[1], ['Duration.WhileOnBattlefield']);
      const sel = everyone(a[2], a[3] ? bool(a[3]) : false);
      return {
        statics: [{ affects: sel, op: { layer: 6, addKeyword: keyword(a[0]) } }],
        rules: [],
      };
    }
    case 'GainAbilityAttachedEffect': {
      if (a.length < 2 || a.length > 3) break;
      if (
        a[1]?.t !== 'ref' ||
        !['AttachmentType.EQUIPMENT', 'AttachmentType.AURA'].includes(a[1].path)
      )
        break;
      if (a[2]) expectDuration(a[2], ['Duration.WhileOnBattlefield']);
      return {
        statics: [{ affects: ATTACHED, op: { layer: 6, addKeyword: keyword(a[0]) } }],
        rules: [],
      };
    }
    case 'CantBeBlockedAllEffect': {
      if (a.length !== 2) break;
      expectDuration(a[1], ['Duration.WhileOnBattlefield']);
      return {
        statics: [{ affects: everyone(a[0], false), op: { layer: 6, setCantBeBlocked: true } }],
        rules: [],
      };
    }
    case 'CantBeBlockedAttachedEffect': {
      if (
        a.length !== 1 ||
        a[0]?.t !== 'ref' ||
        !['AttachmentType.EQUIPMENT', 'AttachmentType.AURA'].includes(a[0].path)
      )
        break;
      return {
        statics: [{ affects: ATTACHED, op: { layer: 6, setCantBeBlocked: true } }],
        rules: [],
      };
    }
    case 'SpellsCostReductionControllerEffect': {
      // (filter, amount) — amount is an int or a ManaCosts for colored reduction; only int here.
      // (filter, int) or (filter, int, upTo=false). ManaCosts (colored) and "up to" are not mapped.
      if (a.length === 3 && !(a[2]?.t === 'bool' && !a[2].v)) break;
      if (a.length !== 2 && a.length !== 3) break;
      if (a[1]?.t !== 'num')
        throw new Unmapped(describe(a[1]), 'cost reduction amount must be an integer');
      const f = filter(a[0], ctx);
      if (f.zone === 'battlefield')
        throw new Unmapped(describe(a[0]), 'cost reduction over a permanent filter');
      const amount = value(a[1], ctx);
      const rule: RuleStatic = {
        kind: 'costReduction',
        amount: typeof amount === 'number' ? { kind: 'const', n: amount } : amount,
        ...(isEmpty(f.selector) ? {} : { filter: f.selector }),
      };
      return { statics: [], rules: [rule] };
    }
  }
  throw new Unmapped(`new ${cls}(${a.length})`, 'static effect');
}

function isEmpty(s: Selector): boolean {
  return s.kind === 'allOf' && s.of.length === 0;
}

function dedupe(parts: Selector[]): Selector[] {
  const seen = new Set<string>();
  return parts.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Targets ──────────────────────────────────────────────────────────────────────────────────

const TYPE_KIND: Record<string, TargetKind> = {
  Creature: 'creature',
  Artifact: 'artifact',
  Enchantment: 'enchantment',
  Land: 'land',
  Planeswalker: 'planeswalker',
};

/** Splits a permanent filter into the interpreter's (kind, controller, filter) target form. */
function permanentTarget(sel: Selector): TargetSpec {
  let parts = flatten([sel]).filter((p) => !isEmpty(p));
  let controller: TargetSpec['controller'];
  const ctl = parts.find((p) => p.kind === 'controller');
  if (ctl && ctl.kind === 'controller') {
    if (ctl.who === 'you') controller = 'you';
    else if (ctl.who === 'opponents') controller = 'opponent';
    else throw new Unmapped('target controller');
    parts = parts.filter((p) => p !== ctl);
  }
  let kind: TargetKind = 'permanent';
  const typeLeaf = parts.find((p) => p.kind === 'type' && TYPE_KIND[p.value]);
  const nonland = parts.find(
    (p) => p.kind === 'not' && p.of.kind === 'type' && p.of.value === 'Land',
  );
  const artOrEnch = parts.find(
    (p) =>
      p.kind === 'anyOf' &&
      p.of.length === 2 &&
      p.of.every((q) => q.kind === 'type') &&
      new Set(p.of.map((q) => (q as { value: string }).value)).size === 2 &&
      p.of.some((q) => (q as { value: string }).value === 'Artifact') &&
      p.of.some((q) => (q as { value: string }).value === 'Enchantment'),
  );
  const typeSet = (p: Selector, want: string[]) =>
    p.kind === 'anyOf' &&
    p.of.length === want.length &&
    p.of.every((q) => q.kind === 'type' && want.includes(q.value)) &&
    new Set(p.of.map((q) => (q as { value: string }).value)).size === want.length;
  const artEnchPw = parts.find((p) => typeSet(p, ['Artifact', 'Enchantment', 'Planeswalker']));
  if (typeLeaf && typeLeaf.kind === 'type') {
    kind = TYPE_KIND[typeLeaf.value]!;
    parts = parts.filter((p) => p !== typeLeaf);
  } else if (nonland) {
    kind = 'nonlandPermanent';
    parts = parts.filter((p) => p !== nonland);
  } else if (artEnchPw) {
    kind = 'artifactEnchantmentOrPlaneswalker';
    parts = parts.filter((p) => p !== artEnchPw);
  } else if (artOrEnch) {
    kind = 'artifactOrEnchantment';
    parts = parts.filter((p) => p !== artOrEnch);
  }
  return {
    kind,
    ...(controller ? { controller } : {}),
    ...(parts.length ? { filter: allOf(parts) } : {}),
  };
}

const SIMPLE_TARGETS: Record<string, TargetSpec> = {
  TargetCreaturePermanent: { kind: 'creature' },
  TargetPermanent: { kind: 'permanent' },
  TargetNonlandPermanent: { kind: 'nonlandPermanent' },
  TargetArtifactPermanent: { kind: 'artifact' },
  TargetEnchantmentPermanent: { kind: 'enchantment' },
  TargetLandPermanent: { kind: 'land' },
  TargetPlaneswalkerPermanent: { kind: 'planeswalker' },
  TargetControlledCreaturePermanent: { kind: 'creature', controller: 'you' },
  TargetOpponentsCreaturePermanent: { kind: 'creature', controller: 'opponent' },
  TargetAnyTarget: { kind: 'anyTarget' },
  TargetPlayer: { kind: 'player' },
  TargetOpponent: { kind: 'player', controller: 'opponent' },
  TargetPlayerOrPlaneswalker: { kind: 'playerOrPlaneswalker' },
  TargetSpell: { kind: 'spell' },
};

function target(e: JExpr, ctx: XmageContext): TargetSpec {
  if (e.t !== 'new') throw new Unmapped(describe(e), 'expected a target constructor');
  const cls = short(e.cls);
  const a = e.args;
  if (a.length === 0 && SIMPLE_TARGETS[cls]) return { ...SIMPLE_TARGETS[cls]! };
  if (
    a.length === 1 &&
    [
      'TargetPermanent',
      'TargetCreaturePermanent',
      'TargetControlledPermanent',
      'TargetControlledCreaturePermanent',
    ].includes(cls)
  ) {
    const f = filter(a[0], ctx);
    if (f.zone !== 'battlefield') throw new Unmapped(describe(a[0]), 'target filter zone');
    const base = cls.includes('Controlled')
      ? allOf([{ kind: 'controller', who: 'you' }, f.selector])
      : f.selector;
    const withType = cls.includes('Creature')
      ? allOf([{ kind: 'type', value: 'Creature' }, base])
      : base;
    return permanentTarget(allOf(dedupe(flatten([withType]))));
  }
  // (1, 1, filter[, false]) is the explicit form of a single target.
  if (
    (a.length === 3 || (a.length === 4 && a[3]?.t === 'bool' && !a[3].v)) &&
    a[0]?.t === 'num' &&
    a[0].v === 1 &&
    a[1]?.t === 'num' &&
    a[1].v === 1
  )
    return target({ ...e, args: [a[2]!] }, ctx);
  if (cls === 'TargetSpell' && a.length === 1) {
    const f = filter(a[0], ctx);
    if (f.zone !== 'spell') throw new Unmapped(describe(a[0]), 'spell target filter zone');
    const parts = flatten([f.selector]).filter((x) => !isEmpty(x));
    if (
      parts.length === 1 &&
      parts[0]!.kind === 'not' &&
      parts[0]!.of.kind === 'type' &&
      parts[0]!.of.value === 'Creature'
    )
      return { kind: 'noncreatureSpell' };
    return { kind: 'spell', ...(parts.length ? { filter: allOf(parts) } : {}) };
  }
  if (cls === 'TargetCardInYourGraveyard' && a.length <= 1) {
    if (a.length === 0) return { kind: 'cardInGraveyard' };
    const f = filter(a[0], ctx);
    if (f.zone !== 'card') throw new Unmapped(describe(a[0]), 'graveyard target filter zone');
    return { kind: 'cardInGraveyard', ...(isEmpty(f.selector) ? {} : { filter: f.selector }) };
  }
  throw new Unmapped(`new ${cls}(${a.length})`, 'target');
}

// ── Costs ────────────────────────────────────────────────────────────────────────────────────

function manaCost(text: string): AbilityCost {
  const r = parseManaCost(text as Parameters<typeof parseManaCost>[0]);
  if (!r.cost || r.unsupportedSymbols.length) throw new Unmapped(JSON.stringify(text), 'mana cost');
  return { kind: 'mana', cost: r.cost };
}

function cost(e: JExpr, ctx: XmageContext): AbilityCost[] {
  if (e.t !== 'new') throw new Unmapped(describe(e), 'expected a cost constructor');
  const cls = short(e.cls);
  const a = e.args;
  switch (cls) {
    case 'ManaCostsImpl':
      if (a.length === 1 && a[0]?.t === 'str') return [manaCost(a[0].v)];
      break;
    case 'GenericManaCost':
      if (a.length === 1) return [manaCost(`{${int(a[0])}}`)];
      break;
    case 'TapSourceCost':
      if (a.length === 0) return [{ kind: 'tap' }];
      break;
    case 'SacrificeSourceCost':
      if (a.length === 0) return [{ kind: 'sacrificeSelf' }];
      break;
    case 'ExileSourceCost':
      if (a.length === 0) return [{ kind: 'exileSelf' }];
      break;
    case 'PayLifeCost':
      if (a.length === 1) return [{ kind: 'payLife', amount: int(a[0]) }];
      break;
    case 'SacrificeTargetCost': {
      // (filter) or (count, filter). "Sacrifice a creature" may sacrifice the source itself;
      // "another" (AnotherPredicate) may not.
      const [n, fe] =
        a.length === 2 ? [int(a[0]), a[1]] : a.length === 1 ? [1, a[0]] : [0, undefined];
      if (!fe || n < 1) break;
      const f = filter(fe, ctx);
      if (f.zone !== 'battlefield') throw new Unmapped(describe(fe), 'sacrifice filter zone');
      const parts = flatten([f.selector]).filter(
        (x) => !isEmpty(x) && !(x.kind === 'controller' && x.who === 'you'),
      );
      const other = parts.some((x) => x.kind === 'other');
      const rest = parts.filter((x) => x.kind !== 'other');
      return [
        {
          kind: 'sacrificeOther',
          selector: allOf([{ kind: 'controller', who: 'you' }, ...rest]),
          ...(n > 1 ? { count: n } : {}),
          ...(other ? {} : { allowSelf: true }),
        },
      ];
    }
    case 'DiscardCardCost':
      if (a.length === 0) return [{ kind: 'discardCard' }];
      break;
  }
  void ctx;
  throw new Unmapped(`new ${cls}(${a.length})`, 'cost');
}

// ── Tokens ───────────────────────────────────────────────────────────────────────────────────

const PREDEFINED_TOKENS: Record<string, TokenSpec> = {
  TreasureToken: TREASURE,
  FoodToken: FOOD,
  ClueArtifactToken: CLUE,
};

/**
 * `new SoldierToken()`: predefined tokens map to our catalog; plain creature tokens are read from
 * the token class (card type, colors, subtypes, P/T and keyword abilities only).
 */
function token(e: JExpr | undefined, ctx: XmageContext): TokenSpec {
  if (e?.t !== 'new' || e.args.length !== 0) throw new Unmapped(describe(e), 'token');
  const cls = short(e.cls);
  if (PREDEFINED_TOKENS[cls]) return PREDEFINED_TOKENS[cls]!;
  const src = ctx.tokenSource(cls);
  if (!src) throw new Unmapped(`new ${cls}()`, 'token class not found');
  const ctor = new RegExp(`public\\s+${cls}\\s*\\(\\s*\\)\\s*\\{([\\s\\S]*?)\\n    \\}`).exec(src);
  if (!ctor) throw new Unmapped(`new ${cls}()`, 'token constructor');
  const body = ctor[1]!;
  const types: string[] = [];
  const colors: Color[] = [];
  const subs: string[] = [];
  const keywords: KeywordAbility[] = [];
  let power: number | null = null;
  let toughness: number | null = null;
  for (const raw of body.split(';')) {
    const line = raw.replace(/\/\/.*$/gm, '').trim();
    if (!line || line.startsWith('super(')) continue;
    let m: RegExpExecArray | null;
    if ((m = /^cardType\.add\(CardType\.(\w+)\)$/.exec(line)))
      types.push(CARD_TYPES[m[1]!] ?? `?${m[1]}`);
    else if ((m = /^color\.set(White|Blue|Black|Red|Green)\(true\)$/.exec(line)))
      colors.push(COLORS[m[1]!.toUpperCase()]!);
    else if ((m = /^subtype\.add\(SubType\.(\w+)\)$/.exec(line)))
      subs.push(subtype(`SubType.${m[1]}`, ctx));
    else if ((m = /^power = new MageInt\((\d+)\)$/.exec(line))) power = Number(m[1]);
    else if ((m = /^toughness = new MageInt\((\d+)\)$/.exec(line))) toughness = Number(m[1]);
    else if ((m = /^(?:this\.)?addAbility\(([\s\S]+)\)$/.exec(line))) {
      try {
        keywords.push(keyword(parseExpr(m[1]!)));
      } catch {
        throw new Unmapped(`new ${cls}()`, `token ability ${m[1]!.slice(0, 40)}`);
      }
    } else throw new Unmapped(`new ${cls}()`, `token line ${line.slice(0, 50)}`);
  }
  if (types.some((t) => t.startsWith('?'))) throw new Unmapped(`new ${cls}()`, 'token card type');
  if (!types.includes('Creature') || power === null || toughness === null || subs.length === 0)
    throw new Unmapped(`new ${cls}()`, 'only creature tokens with fixed P/T are read');
  const extra = types.filter((t) => t !== 'Creature');
  if (extra.length > 1 || (extra.length === 1 && extra[0] !== 'Artifact'))
    throw new Unmapped(`new ${cls}()`, 'token types');
  // A token "named X" (Kobolds of Kher Keep, Koma's Coil) keeps that name: name selectors and
  // "same name" checks compare it. XMage states it in the description it passes to super().
  const named = /super\(\s*"(?:[^"\\]|\\.)*"\s*,\s*"[^"]*\bnamed ([^"]+)"/.exec(body)?.[1];
  return creatureToken({
    name: named ?? subs.join(' '),
    subtypes: subs,
    colors,
    power,
    toughness,
    ...(keywords.length ? { keywords } : {}),
    ...(extra.length ? { artifact: true } : {}),
  });
}

// ── Effects ──────────────────────────────────────────────────────────────────────────────────

const constant = (n: number): Value => ({ kind: 'const', n });

/**
 * One XMage effect. `targets` is how many targets the ability declares; a targeted effect reads
 * the first one (XMage's default target pointer). An effect with its own target pointer is
 * refused by `stripCosmetic` leaving a `setTargetPointer` call behind.
 */
function effect(e: JExpr, ctx: XmageContext, targets: number): Effect {
  if (e.t !== 'new') throw new Unmapped(describe(e), 'expected an effect constructor');
  const cls = short(e.cls);
  const a = e.args;
  const targeted = (): 0 => {
    if (targets !== 1) throw new Unmapped(`new ${cls}`, `targeted effect with ${targets} targets`);
    return 0;
  };
  const untargeted = () => {
    if (targets !== 0) throw new Unmapped(`new ${cls}`, 'untargeted effect on a targeted ability');
  };
  const each = (f: JExpr | undefined): Selector => {
    const r = filter(f, ctx);
    if (r.zone !== 'battlefield') throw new Unmapped(describe(f), 'non-permanent filter');
    return r.selector;
  };
  const E = (x: Record<string, unknown>) => x as unknown as Effect;
  switch (cls) {
    // Mass effects
    case 'DestroyAllEffect':
      untargeted();
      if (a.length === 1) return E({ op: 'destroyEach', selector: each(a[0]) });
      if (a.length === 2)
        return E({
          op: 'destroyEach',
          selector: each(a[0]),
          ...(bool(a[1]) ? { cantRegenerate: true } : {}),
        });
      break;
    case 'ExileAllEffect':
      untargeted();
      if (a.length === 1) return E({ op: 'exileEach', selector: each(a[0]) });
      break;
    case 'ReturnToHandFromBattlefieldAllEffect':
      untargeted();
      if (a.length === 1) return E({ op: 'returnToHandEach', selector: each(a[0]) });
      break;
    // Targeted
    case 'DestroyTargetEffect':
      if (a.length === 0) return E({ op: 'destroy', target: targeted() });
      if (a.length === 1)
        return E({
          op: 'destroy',
          target: targeted(),
          ...(bool(a[0]) ? { cantRegenerate: true } : {}),
        });
      break;
    case 'ExileTargetEffect':
      if (a.length === 0) return E({ op: 'exile', target: targeted() });
      break;
    case 'ReturnToHandTargetEffect':
      if (a.length === 0) return E({ op: 'returnToHand', target: targeted() });
      break;
    case 'TapTargetEffect':
      if (a.length === 0) return E({ op: 'tapTarget', target: targeted() });
      break;
    case 'UntapTargetEffect':
      if (a.length === 0) return E({ op: 'untapTarget', target: targeted() });
      break;
    case 'CounterTargetEffect':
      if (a.length === 0) return E({ op: 'counter', target: targeted() });
      break;
    case 'DamageTargetEffect':
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'dealDamage', target: targeted(), amount: constant(int(a[0])) });
      break;
    case 'BoostTargetEffect':
      if (
        (a.length === 2 ||
          (a.length === 3 && a[2]?.t === 'ref' && a[2].path === 'Duration.EndOfTurn')) &&
        a[0]?.t !== 'new'
      )
        return E({
          op: 'pumpUntilEot',
          target: targeted(),
          power: int(a[0]),
          toughness: int(a[1]),
        });
      break;
    case 'GainAbilityTargetEffect':
      if (
        a.length === 1 ||
        (a.length === 2 && a[1]?.t === 'ref' && a[1].path === 'Duration.EndOfTurn')
      )
        return E({ op: 'grantKeywordUntilEot', target: targeted(), keyword: keyword(a[0]) });
      break;
    case 'ReturnFromGraveyardToHandTargetEffect':
      if (a.length === 0) return E({ op: 'graveyardToHand', target: targeted() });
      break;
    case 'ReturnFromGraveyardToBattlefieldTargetEffect':
      if (a.length === 0) return E({ op: 'graveyardToBattlefield', target: targeted() });
      break;
    case 'DrawCardTargetEffect':
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'drawTarget', target: targeted(), count: constant(int(a[0])) });
      break;
    case 'LoseLifeTargetEffect':
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'loseLifeTarget', target: targeted(), amount: constant(int(a[0])) });
      break;
    case 'MillCardsTargetEffect':
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'millTargetPlayer', target: targeted(), count: int(a[0]) });
      break;
    case 'AddCountersTargetEffect': {
      const c = a[0];
      if (
        a.length === 1 &&
        c?.t === 'call' &&
        c.name === 'createInstance' &&
        c.target?.t === 'ref' &&
        c.target.path === 'CounterType.P1P1'
      ) {
        const n = c.args.length === 0 ? 1 : int(c.args[0]);
        return E({ op: 'putCounters', target: targeted(), counter: '+1/+1', count: n });
      }
      break;
    }
    // Untargeted, controller-relative
    case 'DrawCardSourceControllerEffect':
      untargeted();
      if (a.length === 1 && a[0]?.t === 'num') return E({ op: 'draw', count: constant(int(a[0])) });
      break;
    case 'GainLifeEffect':
      untargeted();
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'gainLife', amount: constant(int(a[0])) });
      break;
    case 'LoseLifeSourceControllerEffect':
      untargeted();
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'loseLife', amount: constant(int(a[0])) });
      break;
    case 'LoseLifeOpponentsEffect':
      untargeted();
      if (a.length === 1 && a[0]?.t === 'num')
        return E({ op: 'eachOpponentLosesLife', amount: int(a[0]) });
      break;
    case 'DamagePlayersEffect':
      untargeted();
      if (
        a.length === 2 &&
        a[0]?.t === 'num' &&
        a[1]?.t === 'ref' &&
        a[1].path === 'TargetController.OPPONENT'
      )
        return E({ op: 'eachOpponentDamage', amount: int(a[0]) });
      break;
    case 'ScryEffect':
      untargeted();
      if ((a.length === 1 || (a.length === 2 && a[1]?.t === 'bool')) && a[0]?.t === 'num')
        return E({ op: 'scry', count: int(a[0]) });
      break;
    case 'CreateTokenEffect': {
      untargeted();
      if (a.length !== 1 && !(a.length === 2 && a[1]?.t === 'num')) break;
      const n = a.length === 2 ? int(a[1]) : 1;
      return E({ op: 'createToken', spec: token(a[0], ctx), count: constant(n) });
    }
    case 'MillCardsControllerEffect':
      untargeted();
      if (a.length === 1 && a[0]?.t === 'num') return E({ op: 'mill', count: constant(int(a[0])) });
      break;
  }
  throw new Unmapped(`new ${cls}(${a.length})`, 'effect');
}

// ── Ability entry point ──────────────────────────────────────────────────────────────────────

/** Unwraps a call chain: `new X(a).addEffect(b).setText("…")` → root `new X(a)` + calls. */
function chain(e: JExpr): { root: JExpr; calls: { name: string; args: JExpr[] }[] } {
  const calls: { name: string; args: JExpr[] }[] = [];
  let cur = e;
  while (cur.t === 'call' && cur.target) {
    calls.unshift({ name: cur.name, args: cur.args });
    cur = cur.target;
  }
  return { root: cur, calls };
}

/** Calls that only change XMage's display text or UI hints, never behavior. */
const COSMETIC = new Set(['setText', 'addHint', 'withFlavorWord', 'concatBy', 'setOutcome']);

function stripCosmetic(e: JExpr): JExpr {
  if (e.t === 'call' && e.target && COSMETIC.has(e.name)) return stripCosmetic(e.target);
  return e;
}

interface Built {
  effects: JExpr[];
  costs: JExpr[];
  targets: JExpr[];
}

/** Collects the `addEffect` / `addCost` / `addTarget` calls of an ability's chain. */
function collect(
  calls: { name: string; args: JExpr[] }[],
  first: Partial<Built>,
  where: string,
): Built {
  const b: Built = {
    effects: [...(first.effects ?? [])],
    costs: [...(first.costs ?? [])],
    targets: [...(first.targets ?? [])],
  };
  for (const c of calls) {
    if (COSMETIC.has(c.name)) continue;
    if (c.args.length !== 1) throw new Unmapped(`${where}.${c.name}()`, 'call arity');
    if (c.name === 'addEffect') b.effects.push(c.args[0]!);
    else if (c.name === 'addCost') b.costs.push(c.args[0]!);
    else if (c.name === 'addTarget') b.targets.push(c.args[0]!);
    else throw new Unmapped(`${where}.${c.name}()`, 'ability call');
  }
  return b;
}

/** Drops cosmetic calls on an effect; any other call left on it (target pointer, ...) is refused. */
function effectExpr(e: JExpr): JExpr {
  const x = stripCosmetic(e);
  if (x.t === 'call') throw new Unmapped(`${describe(x)}`, 'call on an effect');
  return x;
}

const TRIGGERS: Record<
  string,
  { head: Record<string, unknown>; shape: 'effect-optional' | 'controller-effect-optional' }
> = {
  EntersBattlefieldTriggeredAbility: {
    head: { when: 'enters', subject: { kind: 'self' } },
    shape: 'effect-optional',
  },
  DiesSourceTriggeredAbility: {
    head: { when: 'dies', subject: { kind: 'self' } },
    shape: 'effect-optional',
  },
  AttacksTriggeredAbility: {
    head: { when: 'attacks', subject: { kind: 'self' } },
    shape: 'effect-optional',
  },
  BeginningOfUpkeepTriggeredAbility: {
    head: { when: 'upkeep', player: 'you' },
    shape: 'controller-effect-optional',
  },
  BeginningOfEndStepTriggeredAbility: {
    head: { when: 'endStep', player: 'you' },
    shape: 'controller-effect-optional',
  },
  BeginningOfCombatTriggeredAbility: {
    head: { when: 'beginningOfCombat', player: 'you' },
    shape: 'controller-effect-optional',
  },
  DealsCombatDamageToAPlayerTriggeredAbility: {
    head: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
    shape: 'effect-optional',
  },
};

/** Triggers whose head carries a filter: XMage passes it as a constructor argument. */
function filteredTrigger(
  cls: string,
  args: JExpr[],
  ctx: XmageContext,
): { head: Record<string, unknown>; effect: JExpr; optional: boolean } | null {
  if (cls === 'DiesCreatureTriggeredAbility') {
    // (effect, optional, filter) or (effect, optional, another)
    if (args.length !== 3) throw new Unmapped(`new ${cls}(${args.length})`, 'arguments');
    const optional = bool(args[1]);
    let selector: Selector;
    if (args[2]?.t === 'bool')
      selector = allOf(
        args[2].v
          ? [{ kind: 'other' }, { kind: 'type', value: 'Creature' }]
          : [{ kind: 'type', value: 'Creature' }],
      );
    else {
      const f = filter(args[2], ctx);
      if (f.zone !== 'battlefield') throw new Unmapped(describe(args[2]), 'dies filter zone');
      selector = f.selector;
    }
    return {
      head: { when: 'dies', subject: { kind: 'permanent', selector } },
      effect: args[0]!,
      optional,
    };
  }
  if (cls === 'SpellCastControllerTriggeredAbility') {
    // (effect, optional) or (effect, filter, optional)
    if (args.length === 2)
      return {
        head: { when: 'castsSpell', caster: 'you' },
        effect: args[0]!,
        optional: bool(args[1]),
      };
    if (args.length !== 3) throw new Unmapped(`new ${cls}(${args.length})`, 'arguments');
    const f = filter(args[1], ctx);
    if (f.zone !== 'spell') throw new Unmapped(describe(args[1]), 'cast filter zone');
    return {
      head: {
        when: 'castsSpell',
        caster: 'you',
        ...(isEmpty(f.selector) ? {} : { filter: f.selector }),
      },
      effect: args[0]!,
      optional: bool(args[2]),
    };
  }
  return null;
}

/**
 * `new X(...) { ... }`: an anonymous subclass overrides behavior or adds restrictions in an
 * initializer, so translating it as plain `X` would drop rules. Refused wherever it appears.
 */
function rejectAnonymous(e: JExpr): void {
  switch (e.t) {
    case 'new':
      if (e.body) throw new Unmapped(`new ${short(e.cls)}() { ... }`, 'anonymous class body');
      e.args.forEach(rejectAnonymous);
      return;
    case 'call':
      if (e.target) rejectAnonymous(e.target);
      e.args.forEach(rejectAnonymous);
      return;
    case 'array':
      e.items.forEach(rejectAnonymous);
      return;
    case 'op':
      e.args.forEach(rejectAnonymous);
      return;
    default:
      return;
  }
}

export function translateAbility(ab: XAbility, ctx: XmageContext, description: string): Fragment {
  // A constructor statement extract.ts could not read may add a cost, condition or restriction to
  // this ability (e.g. `if (...) { ability.addCost(...); }`). Refuse the card rather than drop it.
  if (ctx.card.unparsed.length > 0)
    throw new Unmapped('unparsed constructor statement', ctx.card.unparsed[0]!.slice(0, 80));
  rejectAnonymous(ab.root);
  const { root, calls } = chain(ab.root);
  const build = (b: Built) => {
    const targets = b.targets.map((t) => target(t, ctx));
    const effects = b.effects.map((x) => {
      const fx = effect(effectExpr(x), ctx, targets.length) as unknown as { op: string };
      // XMage's ReturnToHandTargetEffect moves whatever is targeted; on a graveyard card that is
      // our graveyardToHand.
      if (fx.op === 'returnToHand' && targets[0]?.kind === 'cardInGraveyard')
        fx.op = 'graveyardToHand';
      return fx as unknown as Effect;
    });
    if (effects.length === 0) throw new Unmapped('ability', 'no effects');
    return { targets, effects };
  };
  if (ab.kind === 'spell') {
    const { targets, effects } = build(collect(calls, {}, '$spell'));
    return { spellAbility: { kind: 'spell', targets, effects } };
  }
  if (root.t !== 'new') throw new Unmapped(describe(root), 'ability');
  const cls = short(root.cls);
  const args = root.args.filter((x) => !(x.t === 'ref' && x.path === 'Zone.BATTLEFIELD'));
  if (cls === 'SimpleStaticAbility') {
    if (args.length !== 1) throw new Unmapped(describe(root), 'SimpleStaticAbility arguments');
    const b = collect(calls, { effects: [args[0]!] }, cls);
    if (b.costs.length || b.targets.length)
      throw new Unmapped(cls, 'static ability with costs or targets');
    const statics: StaticEffect[] = [];
    const rules: RuleStatic[] = [];
    for (const x of b.effects) {
      const r = staticEffect(stripCosmetic(x), ctx);
      statics.push(...r.statics);
      rules.push(...r.rules);
    }
    return {
      ...(statics.length ? { staticEffects: statics } : {}),
      ...(rules.length ? { ruleStatics: rules } : {}),
    };
  }
  if (cls === 'SimpleActivatedAbility' || cls === 'ActivateAsSorceryActivatedAbility') {
    if (args.length !== 2) throw new Unmapped(describe(root), `${cls} arguments`);
    const b = collect(calls, { effects: [args[0]!], costs: [args[1]!] }, cls);
    const costs = b.costs.flatMap((c) => cost(c, ctx));
    // Our IR lists the mana cost first, then the other costs, as the Oracle text prints them.
    costs.sort((x, y) => (x.kind === 'mana' ? 0 : 1) - (y.kind === 'mana' ? 0 : 1));
    const { targets, effects } = build({ ...b, costs: [] });
    const activated: ActivatedAbility = {
      costs,
      timing: cls === 'ActivateAsSorceryActivatedAbility' ? 'sorcery' : 'any',
      ability: { kind: 'activated', targets, effects, description },
    } as ActivatedAbility;
    return { activatedAbilities: [activated] };
  }
  const trig = TRIGGERS[cls];
  if (trig) {
    let effectArg: JExpr | undefined;
    let optional = false;
    let trigHead = trig.head;
    if (
      trig.shape === 'controller-effect-optional' &&
      args[0]?.t === 'ref' &&
      args[0].path.startsWith('TargetController.')
    ) {
      if (
        !['TargetController.YOU', 'TargetController.ANY'].includes(args[0].path) ||
        args.length !== 3
      )
        throw new Unmapped(describe(args[0]), `${cls} controller`);
      if (args[0].path === 'TargetController.ANY') trigHead = { ...trig.head, player: 'each' };
      effectArg = args[1];
      optional = bool(args[2]);
    } else {
      if (args.length < 1) throw new Unmapped(describe(root), `${cls} arguments`);
      effectArg = args[0];
      if (args[2] !== undefined && !(args[2].t === 'bool' && !args[2].v) && args[2].t !== 'str')
        throw new Unmapped(describe(args[2]), `${cls} target pointer`);
      if (args.length > 3) throw new Unmapped(describe(root), `${cls} arguments`);
      optional = args[1] ? bool(args[1]) : false;
    }
    const b = collect(calls, { effects: [effectArg!] }, cls);
    if (b.costs.length) throw new Unmapped(cls, 'trigger with costs');
    const { targets, effects } = build(b);
    const ability = {
      kind: 'triggered',
      trigger: trigHead,
      optional,
      targets,
      effects,
      description,
    } as unknown as Ability;
    return { triggers: [ability] };
  }
  const ft = filteredTrigger(cls, args, ctx);
  if (ft) {
    const b = collect(calls, { effects: [ft.effect] }, cls);
    if (b.costs.length) throw new Unmapped(cls, 'trigger with costs');
    const { targets, effects } = build(b);
    const ability = {
      kind: 'triggered',
      trigger: ft.head,
      optional: ft.optional,
      targets,
      effects,
      description,
    } as unknown as Ability;
    return { triggers: [ability] };
  }
  throw new Unmapped(describe(root), 'ability');
}
