/**
 * Card-aware scoring for the bot-led tactical mode (ADR 0039). `evaluate.ts` keeps the ranking
 * loop, the veto and the combat search; this module supplies what each option is worth once the
 * bot knows what a card does (`CardKnowledge`) and how its strategist wants it to play
 * (`BotSteering`). Everything degrades to a sensible default when either is absent: mana value
 * comes from the menu's own `manaCost`, and every steering knob has a neutral value.
 */

import type {
  BotSteering,
  CardView,
  DecisionRequest,
  LegalAction,
  ObjectId,
  PermanentView,
  PlayerId,
  PlayerView,
  TargetChoice,
} from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type {
  CardKnowledge,
  CardRole,
  CardTraits,
  TargetPolarity,
  WipeSelector,
} from './card-knowledge';
import { WEIGHTS } from './weights';

const P = WEIGHTS.policy;

export interface PolicyContext {
  request: DecisionRequest;
  view: PlayerView;
  knowledge?: CardKnowledge;
  steering?: BotSteering;
  /** Mulligans this seat has already taken this game. */
  mulligansTaken?: number;
  /** Times this seat already activated the same ability on the same permanent this turn. */
  repeatCount?: (action: LegalAction) => number;
}

// --- Small readers ---------------------------------------------------------------------------

/** Mana value of a displayed cost such as `{2}{G}{G}`: generic counts, X is 0, other symbols 1. */
export function manaValueOfCost(cost: unknown): number {
  if (typeof cost !== 'string') return 0;
  let total = 0;
  for (const match of cost.matchAll(/\{([^}]+)\}/g)) {
    const symbol = match[1]!;
    if (/^\d+$/.test(symbol)) total += Number(symbol);
    else if (symbol === 'X' || symbol === 'Y') continue;
    else total += 1;
  }
  return total;
}

function lower(name: string | undefined): string {
  return (name ?? '').toLowerCase();
}

function namedIn(list: readonly string[] | undefined, name: string | undefined): boolean {
  if (list === undefined || name === undefined) return false;
  const n = lower(name);
  return list.some((entry) => lower(entry) === n);
}

function sourceNameOf(action: LegalAction, view: PlayerView): string | undefined {
  const data = action.data?.['sourceName'];
  if (typeof data === 'string') return data;
  if (action.interaction?.kind === 'source') {
    const id = action.interaction.sourceId;
    return (
      view.battlefield.find((p) => p.id === id)?.name ??
      view.hand.find((c) => c.id === id)?.name ??
      undefined
    );
  }
  return undefined;
}

function abilityIndexOf(action: LegalAction): number | undefined {
  return action.interaction?.kind === 'source' ? action.interaction.abilityIndex : undefined;
}

/**
 * The view sets `power` only on permanents that are creatures right now, which covers crewed
 * Vehicles, animated lands and face-down creatures whose printed type line says otherwise.
 */
function isCreaturePermanent(p: PermanentView): boolean {
  return p.power !== undefined && p.power !== null;
}

function isLandType(typeLine: string | undefined): boolean {
  return (typeLine ?? '').includes('Land');
}

export function traitsFor(ctx: PolicyContext, name: string | undefined): CardTraits | undefined {
  if (name === undefined || ctx.knowledge === undefined) return undefined;
  return ctx.knowledge(name);
}

// --- Values of things on the table -----------------------------------------------------------

/** A permanent's worth in LEP to whoever controls it. */
export function permanentValue(p: PermanentView, ctx: PolicyContext): number {
  if (isCreaturePermanent(p)) {
    const w = WEIGHTS.combat;
    return (
      w.creatureBaseValue +
      Math.max(0, p.power ?? 0) * w.creaturePowerValue * 2 +
      Math.max(0, p.toughness ?? 0) * w.creatureToughnessValue +
      (p.keywords?.length ?? 0) * w.keywordValue
    );
  }
  if (isLandType(p.typeLine)) return P.landPermanentValue;
  const traits = traitsFor(ctx, p.name);
  return P.otherPermanentBase + (traits?.manaValue ?? 2) * P.otherPermanentPerManaValue;
}

/** A card in hand's worth in LEP: spells by mana value and roles, lands by how many we have. */
export function handCardValue(card: CardView, ctx: PolicyContext): number {
  if (isLandType(card.typeLine)) {
    const lands = ctx.view.battlefield.filter(
      (p) => p.controller === ctx.view.seat && isLandType(p.typeLine),
    ).length;
    return lands >= P.enoughLands ? P.excessLandCardValue : P.neededLandCardValue;
  }
  const traits = traitsFor(ctx, card.name);
  const mv = traits?.manaValue ?? manaValueOfCost(card.manaCost);
  return P.spellCardBase + mv * P.spellCardPerManaValue + (traits?.roles.length ?? 0);
}

/** One decision's pressure map: it is read for every action and slot, so compute it once. */
const pressureCache = new WeakMap<PolicyContext, Map<PlayerId, number>>();

/** How much this seat wants to hurt each opponent, highest first. */
function opponentPressure(ctx: PolicyContext): Map<PlayerId, number> {
  const cached = pressureCache.get(ctx);
  if (cached !== undefined) return cached;
  const pressure = computePressure(ctx);
  pressureCache.set(ctx, pressure);
  return pressure;
}

function computePressure(ctx: PolicyContext): Map<PlayerId, number> {
  const { view, steering } = ctx;
  const pressure = new Map<PlayerId, number>();
  for (const o of view.opponents) {
    if (o.life <= 0) continue;
    const board = view.battlefield
      .filter((p) => p.controller === o.seat)
      .reduce((sum, p) => sum + permanentValue(p, ctx), 0);
    // The leader by board is the threat; low life is the opportunity.
    pressure.set(o.seat, board * P.threatBoardWeight + (40 - o.life) * P.threatLowLifeWeight);
  }
  const order = steering?.targetOrder ?? [];
  order.forEach((seat, i) => {
    if (pressure.has(seat)) {
      pressure.set(seat, pressure.get(seat)! + P.steeringTargetBonus * (order.length - i));
    }
  });
  return pressure;
}

// --- Target polarity and choice --------------------------------------------------------------

const HOSTILE_WORDS =
  /destroy|exile|damage|return .* to (its|their) owner|tap target|counter target|sacrifice|gain control|loses|-\d+\/-\d+|fights?|discard/i;

/**
 * The effect half of an action's text: an activated ability's cost ("{1}, Sacrifice this token:")
 * says what is paid, not what happens to the target, so it must not make a +1/+1 counter hostile.
 */
function effectText(action: LegalAction): string {
  const ability = action.data?.['abilityDescription'];
  if (typeof ability === 'string' && ability.length > 0) {
    const colon = ability.indexOf(': ');
    return colon >= 0 ? ability.slice(colon + 2) : ability;
  }
  return action.description;
}

function slotPolarity(action: LegalAction, slot: number, ctx: PolicyContext): TargetPolarity {
  const traits = traitsFor(ctx, sourceNameOf(action, ctx.view));
  const index = abilityIndexOf(action);
  const fromIr =
    action.type === 'activateAbility' && index !== undefined
      ? traits?.abilityTargets?.[index]?.[slot]
      : traits?.spellTargets?.[slot];
  if (fromIr !== undefined && fromIr !== 'neutral') return fromIr;
  const text = effectText(action);
  if (HOSTILE_WORDS.test(text)) return 'hostile';
  if (/gets \+|gains|put .*\+1\/\+1|untap|regenerate|hexproof|indestructible/i.test(text)) {
    return 'friendly';
  }
  return fromIr ?? 'neutral';
}

/** Fixed damage the IR says this slot deals, or null when unknown or not a damage slot. */
function slotDamage(action: LegalAction, slot: number, ctx: PolicyContext): number | null {
  const traits = traitsFor(ctx, sourceNameOf(action, ctx.view));
  const index = abilityIndexOf(action);
  const damage =
    action.type === 'activateAbility' && index !== undefined
      ? traits?.abilityDamage?.[index]?.[slot]
      : traits?.spellDamage?.[slot];
  return damage ?? null;
}

/** Whether `damage` destroys this permanent: enough to meet its toughness, and not indestructible. */
function damageKills(p: PermanentView, damage: number): boolean {
  if (p.keywords?.some((k) => /^indestructible$/i.test(k)) === true) return false;
  if (p.toughness === undefined || p.toughness === null) return true;
  return damage >= p.toughness;
}

interface Candidate {
  /** Who controls or is the option: a seat id, or undefined for an unknown object. */
  owner: PlayerId | undefined;
  /** LEP worth of the object to its controller. */
  value: number;
}

function describeOption(option: ObjectId, ctx: PolicyContext): Candidate {
  const { view } = ctx;
  if (option === view.seat) return { owner: view.seat, value: 10 };
  const opponent = view.opponents.find((o) => o.seat === option);
  if (opponent !== undefined) return { owner: opponent.seat, value: 10 };
  const permanent = view.battlefield.find((p) => p.id === option);
  if (permanent !== undefined) {
    return { owner: permanent.controller, value: permanentValue(permanent, ctx) };
  }
  const stack = view.stack.find((s) => s.id === option);
  if (stack !== undefined) return { owner: stack.controller, value: 5 };
  if (view.hand.some((c) => c.id === option) || view.graveyard.some((c) => c.id === option)) {
    const card =
      view.hand.find((c) => c.id === option) ?? view.graveyard.find((c) => c.id === option)!;
    return { owner: view.seat, value: handCardValue(card, ctx) };
  }
  for (const o of view.opponents) {
    const card = o.graveyard.find((c) => c.id === option);
    if (card !== undefined) return { owner: o.seat, value: handCardValue(card, ctx) };
  }
  return { owner: undefined, value: 0 };
}

/** Score one option for a slot of the given polarity: higher is better for us. */
function optionScore(
  option: ObjectId,
  polarity: TargetPolarity,
  ctx: PolicyContext,
  pressure: Map<PlayerId, number>,
  damage: number | null = null,
): number {
  const c = describeOption(option, ctx);
  const mine = c.owner === ctx.view.seat;
  if (polarity === 'hostile') {
    if (mine) return -c.value - 100;
    if (c.owner === undefined) return 0;
    // Damage that leaves a creature alive takes only a sliver of its worth (Bolt on a 10/10).
    const creature =
      damage === null ? undefined : ctx.view.battlefield.find((p) => p.id === option);
    const share =
      creature !== undefined && isCreaturePermanent(creature) && !damageKills(creature, damage!)
        ? P.nonlethalDamageShare
        : 1;
    return c.value * share + (pressure.get(c.owner) ?? 0) * P.targetPressureWeight;
  }
  if (polarity === 'friendly') {
    if (mine) return c.value;
    return -c.value - 50;
  }
  return 0;
}

function needsDistinctTargets(action: LegalAction): boolean {
  return (action.targets?.length ?? 0) > 1 && /\banother target\b/i.test(action.description);
}

/** Whether every slot can get a different object (a small bipartite matching). */
function distinctAssignmentExists(action: LegalAction): boolean {
  const slots = action.targets ?? [];
  const owner = new Map<string, number>();
  const tryAssign = (i: number, seen: Set<string>): boolean => {
    for (const option of slots[i]!.options) {
      if (seen.has(option)) continue;
      seen.add(option);
      const holder = owner.get(option);
      if (holder === undefined || tryAssign(holder, seen)) {
        owner.set(option, i);
        return true;
      }
    }
    return false;
  };
  return slots.every((_, i) => tryAssign(i, new Set()));
}

/** Choose a target for every slot of `action` by polarity, threat and steering. */
export function chooseTargets(action: LegalAction, ctx: PolicyContext): TargetChoice[] {
  const pressure = opponentPressure(ctx);
  const taken = new Set<string>();
  const distinct = needsDistinctTargets(action);
  const slots = action.targets ?? [];
  // Fill the most constrained slots first, so a slot with one option keeps it.
  const order = slots
    .map((_, i) => i)
    .sort((a, b) => slots[a]!.options.length - slots[b]!.options.length);
  const chosen: TargetChoice[] = new Array<TargetChoice>(slots.length);
  for (const i of order) {
    const slot = slots[i]!;
    chosen[i] = pickForSlot(slot);
  }
  return chosen;

  function pickForSlot(slot: (typeof slots)[number]): TargetChoice {
    // CR 115.3 lets one object fill several "target" words; only "another target" forbids it,
    // and the menu cannot say which applies. So prefer an option no earlier slot took (two
    // removal slots hit two threats), but for a slot that may repeat, never let that push a
    // hostile slot onto our own permanent or a friendly one onto an opponent's.
    const fresh = slot.options.filter((o) => !taken.has(o));
    const polarity = slot.options.length <= 1 ? 'neutral' : slotPolarity(action, slot.slot, ctx);
    const damage = slotDamage(action, slot.slot, ctx);
    const pick = (options: readonly string[]): { option: string; score: number } => {
      let option = options[0] as string;
      let score = polarity === 'neutral' ? 0 : -Infinity;
      if (polarity !== 'neutral') {
        for (const o of options) {
          const value = optionScore(o, polarity, ctx, pressure, damage);
          if (value > score) {
            score = value;
            option = o;
          }
        }
      }
      return { option, score };
    };
    const any = pick(slot.options);
    let best = any.option;
    if (fresh.length > 0) {
      const spread = pick(fresh);
      const wrongSide = spread.score < 0 && spread.score < any.score;
      if (distinct || !wrongSide) best = spread.option;
    }
    taken.add(best);
    return { slot: slot.slot, choice: best };
  }
}

/** The best a hostile slot of this action can do, or null when the action has no hostile slot. */
function bestHostileTargetValue(action: LegalAction, ctx: PolicyContext): number | null {
  return bestTargetValue(action, ctx, 'hostile');
}

function bestTargetValue(
  action: LegalAction,
  ctx: PolicyContext,
  polarity: 'hostile' | 'friendly',
): number | null {
  const pressure = opponentPressure(ctx);
  let best: number | null = null;
  // A modal action leaves inactive slots out of the menu, so look polarity up by the slot's own
  // number, not its position.
  (action.targets ?? []).forEach((slot) => {
    if (slotPolarity(action, slot.slot, ctx) !== polarity) return;
    const damage = slotDamage(action, slot.slot, ctx);
    const value = Math.max(
      ...slot.options.map((o) => optionScore(o, polarity, ctx, pressure, damage)),
    );
    best = best === null ? value : Math.max(best, value);
  });
  return best;
}

// --- Attacks ---------------------------------------------------------------------------------

interface AttackSubject {
  subjectId: string;
  power: number;
  toughness: number;
  mustAttack: boolean;
  hasTriggers: boolean;
}

function attackSubjects(action: LegalAction): AttackSubject[] {
  const raw = action.data?.['subjects'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is AttackSubject =>
      typeof s === 'object' && s !== null && typeof (s as AttackSubject).subjectId === 'string',
  );
}

/** Untapped creatures `seat` could block with. */
function potentialBlockers(seat: PlayerId, view: PlayerView): PermanentView[] {
  return view.battlefield.filter(
    (p) => p.controller === seat && !p.tapped && isCreaturePermanent(p),
  );
}

function hasKeyword(p: PermanentView | undefined, keyword: string): boolean {
  return (p?.keywords ?? []).some((k) => k.toLowerCase() === keyword);
}

/**
 * Whether an attacker is safe into `defender`'s untapped creatures: none can block it, or none
 * that can block it would kill it without dying.
 */
function attackIsSafe(
  attacker: PermanentView | undefined,
  subject: AttackSubject,
  blockers: PermanentView[],
): boolean {
  const flying = hasKeyword(attacker, 'flying');
  const able = blockers.filter((b) => !flying || hasKeyword(b, 'flying') || hasKeyword(b, 'reach'));
  return able.every((b) => {
    const kills = (b.power ?? 0) >= subject.toughness || hasKeyword(b, 'deathtouch');
    const dies = (b.toughness ?? 0) <= subject.power || hasKeyword(attacker, 'deathtouch');
    return !kills || dies;
  });
}

/** Per-slot attack choices, shaped by aggression and target order. */
export function chooseAttacks(action: LegalAction, ctx: PolicyContext): TargetChoice[] {
  const { view, steering } = ctx;
  const aggression = clamp01(steering?.aggression ?? P.defaultAggression);
  const subjects = attackSubjects(action);
  const pressure = opponentPressure(ctx);
  const permanents = new Map(view.battlefield.map((p) => [p.id, p]));
  const seatOf = (option: string): PlayerId | undefined => {
    if (view.opponents.some((o) => o.seat === option)) return option;
    return permanents.get(option)?.controller;
  };
  const ownCreatures = view.battlefield.filter(
    (p) => p.controller === view.seat && isCreaturePermanent(p),
  );
  // In danger: keep the best blocker home unless steering says to race.
  const threatened = view.life <= WEIGHTS.dangerousLifeThreshold * 1.5 && aggression < 0.8;
  const reserve =
    threatened && ownCreatures.length > 1
      ? ownCreatures.reduce((a, b) => ((a.toughness ?? 0) >= (b.toughness ?? 0) ? a : b)).id
      : null;

  return (action.targets ?? []).map((slot, i) => {
    const subject = subjects[i];
    const real = slot.options.filter((o) => o !== NO_ATTACK_TARGET);
    const stay = slot.options.includes(NO_ATTACK_TARGET);
    if (real.length === 0) return { slot: slot.slot, choice: slot.options[0] as string };
    if (subject === undefined) return { slot: slot.slot, choice: real[0] as string };
    const attacker = permanents.get(subject.subjectId);

    let best: string | null = null;
    let bestScore = -Infinity;
    for (const option of real) {
      const seat = seatOf(option);
      if (seat === undefined) continue;
      const safe = attackIsSafe(attacker, subject, potentialBlockers(seat, view));
      const opponentLife = view.opponents.find((o) => o.seat === seat)?.life ?? 40;
      let score = (pressure.get(seat) ?? 0) + (safe ? P.safeAttackBonus : 0);
      if (opponentLife <= subject.power) score += P.lethalAttackBonus;
      if (option !== seat) score -= P.planeswalkerAttackDiscount; // attacking a planeswalker
      if (score > bestScore) {
        bestScore = score;
        best = option;
      }
    }
    if (best === null) best = real[0] as string;
    if (!stay || subject.mustAttack) return { slot: slot.slot, choice: best };

    const seat = seatOf(best)!;
    const safe = attackIsSafe(attacker, subject, potentialBlockers(seat, view));
    const worth = subject.power > 0 || subject.hasTriggers;
    const attack =
      worth &&
      subject.subjectId !== reserve &&
      (safe ? aggression >= P.safeAttackAggression : aggression >= P.riskyAttackAggression);
    return { slot: slot.slot, choice: attack ? best : NO_ATTACK_TARGET };
  });
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : P.defaultAggression;
}

// --- Action values ---------------------------------------------------------------------------

const PROTECTIVE_OR_PUMP: ReadonlySet<CardRole> = new Set(['pump', 'protection']);

/**
 * Whether a counter has an opponent's spell or ability to hit. With target slots, any option that
 * is an opponent's stack object counts (so a counter war over our own spell, or a spell below the
 * top, is seen); without them, the top of the stack, which is the LAST element of `view.stack`.
 */
function opponentObjectOnStack(view: PlayerView, action: LegalAction): boolean {
  const theirs = new Set(view.stack.filter((s) => s.controller !== view.seat).map((s) => s.id));
  const options = (action.targets ?? []).flatMap((t) => t.options);
  if (options.length > 0) return options.some((o) => theirs.has(o));
  const top = view.stack.at(-1);
  return top !== undefined && top.controller !== view.seat;
}

/** Whether any target option of `action` is an object on the stack. */
function targetsStack(view: PlayerView, action: LegalAction): boolean {
  const onStack = new Set(view.stack.map((s) => s.id));
  return (action.targets ?? []).some((t) => t.options.some((o) => onStack.has(o)));
}

/** The printed type line split into its types and supertypes, and its subtypes. */
function typeLineParts(p: PermanentView): { types: string[]; subtypes: string[] } | undefined {
  if (p.typeLine === undefined) return undefined;
  const [left, right] = p.typeLine.split(/\s+[—-]\s+/);
  const words = (text: string | undefined): string[] =>
    (text ?? '')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => w.toLowerCase());
  return { types: words(left), subtypes: words(right) };
}

/**
 * Evaluate a sweeper's selector against a permanent: true or false where every leaf it needs is
 * one the view can answer, undefined otherwise (an unknown leaf, a face-down permanent). Callers
 * treat undefined as "affected", which is how the bot valued every sweeper before.
 */
export function matchesSelector(
  selector: WipeSelector | undefined,
  p: PermanentView,
  seat: PlayerId,
): boolean | undefined {
  if (selector === undefined) return undefined;
  const children = (): readonly WipeSelector[] =>
    selector.of === undefined
      ? []
      : Array.isArray(selector.of)
        ? selector.of
        : [selector.of as WipeSelector];
  const value = (selector.value ?? '').toLowerCase();
  switch (selector.kind) {
    case 'type':
      // The type line is the printed one; a crewed Vehicle or an animated land is a creature now.
      if (value === 'creature') return isCreaturePermanent(p);
      return typeLineParts(p)?.types.includes(value);
    case 'supertype':
      return typeLineParts(p)?.types.includes(value);
    case 'subtype':
      return typeLineParts(p)?.subtypes.includes(value);
    case 'name':
      return p.name.toLowerCase() === value;
    case 'controller':
      if (selector.who === 'you') return p.controller === seat;
      if (selector.who === 'opponents') return p.controller !== seat;
      return undefined;
    case 'tapped':
      return p.tapped;
    case 'hasKeyword':
      return p.keywords?.some((k) => k.toLowerCase() === (selector.keyword ?? '').toLowerCase());
    case 'powerAtLeast':
      return p.power == null || selector.n === undefined ? undefined : p.power >= selector.n;
    case 'powerAtMost':
      return p.power == null || selector.n === undefined ? undefined : p.power <= selector.n;
    case 'toughnessAtLeast':
      return p.toughness == null || selector.n === undefined
        ? undefined
        : p.toughness >= selector.n;
    case 'not': {
      const inner = matchesSelector(children()[0], p, seat);
      return inner === undefined ? undefined : !inner;
    }
    case 'allOf': {
      let unknown = false;
      for (const child of children()) {
        const r = matchesSelector(child, p, seat);
        if (r === false) return false;
        if (r === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case 'anyOf': {
      let unknown = false;
      for (const child of children()) {
        const r = matchesSelector(child, p, seat);
        if (r === true) return true;
        if (r === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    default:
      return undefined;
  }
}

function roleValue(roles: readonly CardRole[], action: LegalAction, ctx: PolicyContext): number {
  const { view } = ctx;
  let value = 0;
  for (const role of roles) {
    switch (role) {
      case 'counter':
        // A modal card's roles are the union of its modes. A mode with no stack target (Mystic
        // Confluence's draw, Izzet Charm's damage) counters nothing, so it is neither scored nor
        // penalized as a counterspell.
        if (action.data?.['modeLabel'] !== undefined && !targetsStack(view, action)) break;
        value += opponentObjectOnStack(view, action) ? P.roles.counterAnswer : P.roles.counterIdle;
        break;
      case 'removal': {
        const best = bestHostileTargetValue(action, ctx);
        value += best === null ? P.roles.removal : Math.min(best, 30) * P.removalTargetShare;
        break;
      }
      case 'wipe': {
        // Only the creatures the sweep would actually remove count, on either side.
        const traits = traitsFor(ctx, sourceNameOf(action, view));
        const lost = (p: PermanentView): boolean =>
          isCreaturePermanent(p) &&
          matchesSelector(traits?.wipeSelector, p, view.seat) !== false &&
          (traits?.wipeDamage === undefined || damageKills(p, traits.wipeDamage));
        const mine = view.battlefield
          .filter((p) => p.controller === view.seat && lost(p))
          .reduce((s, p) => s + permanentValue(p, ctx), 0);
        const theirs = view.battlefield
          .filter((p) => p.controller !== view.seat && lost(p))
          .reduce((s, p) => s + permanentValue(p, ctx), 0);
        value += (theirs - mine * P.wipeOwnLossWeight) * P.wipeNetShare;
        break;
      }
      default:
        value += P.roles[role];
    }
  }
  return value;
}

/** Instants that only matter in response or in combat score below pass when idle. */
function idleReactivePenalty(
  roles: readonly CardRole[],
  action: LegalAction,
  ctx: PolicyContext,
): number {
  const { request, view } = ctx;
  // A sorcery-speed pump (Overrun) can only be cast now, so there is nothing to hold it for.
  if (action.type === 'castSpell' && action.data?.['instantSpeed'] !== true) return 0;
  const inCombat = request.phase === 'combat';
  const responding = view.stack.length > 0;
  if (roles.length > 0 && roles.every((r) => PROTECTIVE_OR_PUMP.has(r))) {
    return inCombat || responding ? 0 : P.idleTrickPenalty;
  }
  return 0;
}

/** Does casting this at sorcery speed break the strategist's hold-up-mana knob? */
function holdUpPenalty(mv: number, action: LegalAction, ctx: PolicyContext): number {
  const want = ctx.steering?.holdUpMana ?? 0;
  if (want <= 0 || action.data?.['instantSpeed'] === true) return 0;
  // Each source row is one permanent. Its `count` sums every alternative mana ability, so a
  // row that makes several kinds of mana (Aether Hub, Command Tower) usually yields one per
  // tap; only a single-symbol row (Forest, Sol Ring) is taken at its count. That undercounts a
  // few big multi-color rocks, which errs toward keeping mana up. `availableMana` folds these
  // sources in per symbol, so adding it would count them twice.
  const untapped = ctx.view.manaSources.reduce(
    (sum, m) => sum + (m.symbols.length <= 1 ? m.count : 1),
    0,
  );
  return untapped - mv < want ? P.holdUpPenalty : 0;
}

/**
 * Card-aware value for a cast or activation, replacing the flat per-type tempo bonus. Returns
 * `null` for an action this module has no opinion on, so the caller keeps its default.
 */
export function actionValue(action: LegalAction, ctx: PolicyContext): number | null {
  const { view, steering } = ctx;
  if (action.type === 'playLand') return P.playLand;

  if (
    action.type === 'activateManaAbility' ||
    (action.type === 'activateAbility' && action.data?.['producesMana'] === true)
  ) {
    // Auto-pay taps sources when a cost needs them; floating mana on purpose wastes it.
    return P.floatManaPenalty;
  }

  if (action.type !== 'castSpell' && action.type !== 'activateAbility') return null;

  const name = sourceNameOf(action, view);
  const traits = traitsFor(ctx, name);
  let value: number;
  if (action.type === 'castSpell') {
    const shownCost = action.data?.['manaCost'];
    // The engine shows the cost actually paid ("{0}" after affinity), so that drives hold-up;
    // the printed mana value stands in for impact when the shown cost is zero or missing.
    const paid = typeof shownCost === 'string' ? manaValueOfCost(shownCost) : undefined;
    const mv = paid || (traits?.manaValue ?? 0);
    const roles = traits?.roles ?? [];
    value = P.castBase + mv * P.castPerManaValue + roleValue(roles, action, ctx);
    if (traits?.types.includes('Creature') === true) {
      value += Math.max(0, traits.power ?? 0) * P.creaturePowerOnCast;
      if (steering?.avoidOverextending === true) {
        const creatures = view.battlefield.filter(
          (p) => p.controller === view.seat && isCreaturePermanent(p),
        ).length;
        if (creatures >= P.overextendCreatures) value -= P.overextendPenalty;
      }
    }
    value -= idleReactivePenalty(roles, action, ctx);
    value -= holdUpPenalty(paid ?? mv, action, ctx);
  } else {
    const index = abilityIndexOf(action);
    const roles = index === undefined ? [] : (traits?.abilityRoles?.[index] ?? []);
    value = WEIGHTS.tempo.activateAbility + roleValue(roles, action, ctx);
    // A sorcery-speed ability (a planeswalker's pump) cannot be held for combat either.
    const sorcery = index !== undefined && traits?.abilitySorcery?.[index] === true;
    if (!sorcery) value -= idleReactivePenalty(roles, action, ctx);
    const misuse = attachOrCrewPenalty(action, ctx);
    if (misuse !== null) return misuse;
  }

  // A hostile-only action whose best target is our own stuff is a misplay, whatever its roles.
  const hostile = bestHostileTargetValue(action, ctx);
  if (hostile !== null && hostile < 0) value += hostile;
  // And a friendly-only action (a pump, a +1/+1 counter) whose only targets are theirs.
  const friendly = bestTargetValue(action, ctx, 'friendly');
  if (friendly !== null && friendly < 0) value += friendly;

  // "Another target" (CR 115.3) with too few objects to go round: the menu offers it because it
  // checks each slot alone, but no choice is legal, so never pick it.
  if (needsDistinctTargets(action) && !distinctAssignmentExists(action)) return P.impossibleTargets;

  if (namedIn(steering?.prioritize, name)) value += P.prioritizeBonus;
  if (namedIn(steering?.hold, name)) value -= P.holdPenalty;
  return value;
}

const EQUIP = /^(Equip|Reconfigure)\b/i;
/** "Equip {2}" or "Equip—Pay 3 life", not a restricted "Equip commander {3}". */
const UNRESTRICTED_EQUIP = /^(Equip|Reconfigure)\s*(\{|\d|—|-|:|$)/i;
const CREW = /^Crew\b/i;

/**
 * Equip and crew have no effect op worth a role, so the flat activation bonus made the bot move
 * equipment back and forth between its own creatures and crew a vehicle that was already crewed.
 * Returns the action's value when it is one of these, or null to leave the default.
 */
function attachOrCrewPenalty(action: LegalAction, ctx: PolicyContext): number | null {
  const ability = String(action.data?.['abilityDescription'] ?? '');
  const { view, request } = ctx;
  const repeats = ctx.repeatCount?.(action) ?? 0;
  if (EQUIP.test(ability)) {
    // Once a turn is enough: a second equip of the same source only moves it again.
    if (repeats > 0) return P.pointlessActivation;
    const options = (action.targets ?? []).flatMap((t) => t.options);
    const offered = new Set(options);
    const own = view.battlefield.filter(
      (p) => p.controller === view.seat && isCreaturePermanent(p),
    );
    const best = (list: PermanentView[]): number =>
      list.reduce((m, p) => Math.max(m, permanentValue(p, ctx)), Number.NEGATIVE_INFINITY);
    // The view does not show attachments, but an unrestricted equip menu offers every creature
    // you control except the one it is already on. When exactly one is missing and it is the
    // best, moving the equipment is a downgrade. A restricted equip ("Equip commander") leaves
    // creatures out for other reasons, so nothing can be inferred from its menu.
    if (!UNRESTRICTED_EQUIP.test(ability) || options.length === 0) return null;
    const missing = own.filter((p) => !offered.has(p.id));
    if (missing.length !== 1) return null;
    const bestOffered = best(own.filter((p) => offered.has(p.id)));
    if (best(missing) >= bestOffered) return P.pointlessActivation;
    return null;
  }
  if (CREW.test(ability)) {
    const sourceId = (action.interaction as { sourceId?: unknown } | undefined)?.sourceId;
    const vehicle = view.battlefield.find((p) => p.id === sourceId);
    const crewed = vehicle !== undefined && vehicle.power !== undefined && vehicle.power !== null;
    const beforeOwnCombat =
      request.activePlayer === view.seat &&
      (request.phase === 'precombatMain' || request.step === 'beginCombat');
    // Crewing after attackers are declared lets the Vehicle block.
    const beforeBlocks =
      request.activePlayer !== view.seat &&
      request.step === 'declareAttackers' &&
      vehicle !== undefined &&
      !vehicle.tapped;
    if (repeats > 0 || crewed || !(beforeOwnCombat || beforeBlocks)) return P.pointlessActivation;
    return null;
  }
  return null;
}

// --- Choices outside the priority menu --------------------------------------------------------

/** Mulligan: keep a hand with a workable land count, and stop mulliganing after two. */
export function mulliganChoice(ctx: PolicyContext): 'keep' | 'mulligan' {
  const hand = ctx.view.hand;
  const lands = hand.filter((c) => isLandType(c.typeLine)).length;
  const taken = ctx.mulligansTaken ?? 0;
  if (taken >= 2) return lands >= 1 || taken >= 3 ? 'keep' : 'mulligan';
  const cheapSpells = hand.filter(
    (c) => !isLandType(c.typeLine) && manaValueOfCost(c.manaCost) <= 3,
  ).length;
  if (lands < P.mulliganMinLands || lands > P.mulliganMaxLands) return 'mulligan';
  if (lands === P.mulliganMinLands && cheapSpells === 0) return 'mulligan';
  return 'keep';
}

/** Action types that give a subject up: lower value is the better choice. */
const LOSS_CHOICES: ReadonlySet<string> = new Set([
  'sacrifice',
  'discard',
  'exile',
  'bottomCard',
  'tapCost',
]);
/** Action types that gain a subject: higher value is the better choice. */
const GAIN_CHOICES: ReadonlySet<string> = new Set([
  'findCard',
  'search',
  'returnToHand',
  'castFree',
]);
/** Opt-out choices that score below opting in. */
const DECLINES: ReadonlySet<string> = new Set([
  'findNothing',
  'decline',
  'declineTrigger',
  'declineGift',
]);

/**
 * The card an option is about. A menu built by the engine's `chooseCard` (discard, sacrifice,
 * return from graveyard) carries no payload, so its interaction has no subject id; the card is
 * named only in the option's presentation, which the deciding seat is shown anyway.
 */
function presentedCardOf(action: LegalAction, ctx: PolicyContext) {
  const subject = ctx.request.presentation?.actions?.[action.id]?.subjects[0];
  return subject?.kind === 'card' ? subject.card : undefined;
}

function subjectOf(action: LegalAction, ctx: PolicyContext): ObjectId | undefined {
  const interaction = action.interaction as { subjectId?: unknown } | undefined;
  if (typeof interaction?.subjectId === 'string') return interaction.subjectId;
  return presentedCardOf(action, ctx)?.objectId;
}

function subjectValue(id: ObjectId, action: LegalAction, ctx: PolicyContext): number | null {
  const permanent = ctx.view.battlefield.find((p) => p.id === id);
  if (permanent !== undefined) return permanentValue(permanent, ctx);
  const card =
    ctx.view.hand.find((c) => c.id === id) ?? ctx.view.graveyard.find((c) => c.id === id);
  if (card !== undefined) return handCardValue(card, ctx);
  // A card from a hidden zone (a library search, exile) is known only by its presentation.
  const presented = presentedCardOf(action, ctx);
  if (presented !== undefined && presented.objectId === id) {
    return handCardValue({ id, name: presented.name, typeLine: presented.typeLine }, ctx);
  }
  return null;
}

/** Value for a resolution-time choice, or null when this module has no opinion. */
export function choiceValue(action: LegalAction, ctx: PolicyContext): number | null {
  if (action.type === 'keep' || action.type === 'mulligan') {
    return mulliganChoice(ctx) === action.type ? 1 : 0;
  }
  if (action.type === 'bottomCard') {
    const id = subjectOf(action, ctx);
    const card = ctx.view.hand.find((c) => c.id === id);
    if (card === undefined) return null;
    const hand = ctx.view.hand;
    const lands = hand.filter((c) => isLandType(c.typeLine)).length;
    const landHeavy = lands / Math.max(1, hand.length) > P.bottomLandShare;
    // Higher is more worth bottoming: a land from a land-heavy hand, else the priciest spell.
    if (isLandType(card.typeLine)) return landHeavy ? 20 : -5;
    return manaValueOfCost(card.manaCost);
  }
  if (action.type === 'acceptTrigger') return P.acceptOptional;
  if (DECLINES.has(action.type)) return 0;
  if (action.type === 'promiseGift') return -1;
  const id = subjectOf(action, ctx);
  if (id !== undefined) {
    const value = subjectValue(id, action, ctx);
    if (value !== null && LOSS_CHOICES.has(action.type)) return P.choiceBase - value;
    if (value !== null && GAIN_CHOICES.has(action.type)) return P.choiceBase + value;
  }
  if (GAIN_CHOICES.has(action.type)) return P.choiceBase;
  return null;
}
