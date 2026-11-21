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
  StackObjectView,
  TargetChoice,
} from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type {
  CardKnowledge,
  CardRole,
  CardTraits,
  StatBoost,
  TargetPolarity,
  WipeSelector,
} from './card-knowledge';
import type { PolicyFix } from './fixes';
import {
  bestCastingOrder,
  combatBody,
  damageThrough,
  incomingDamage,
  manaUnitsOf,
  parseCost,
  pendingOwnDamage,
  producedThisTurn,
  readyAttackers,
  untappedCreatures,
  type CastCandidate,
  type CombatBody,
} from './tactics';
import { lastAnswerKinds, publicLethal, type AnswerKind } from './answers';
import { roleScale, styleProfile } from './styles';
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
  /** ADR 0043's policy fixes in force. Absent is none, the bot as it was before them. */
  fixes?: ReadonlySet<PolicyFix>;
}

function fixOn(ctx: PolicyContext, fix: PolicyFix): boolean {
  return ctx.fixes?.has(fix) === true;
}

/** Per-decision memo: a context is built once per decision and read for every action. */
const memo = new WeakMap<PolicyContext, Map<string, unknown>>();
function once<T>(ctx: PolicyContext, key: string, compute: () => T): T {
  let entries = memo.get(ctx);
  if (entries === undefined) {
    entries = new Map();
    memo.set(ctx, entries);
  }
  if (!entries.has(key)) entries.set(key, compute());
  return entries.get(key) as T;
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
  return (
    permanentBaseValue(p, ctx) + (isCommanderName(p.name, ctx) ? P.commanderPermanentBonus : 0)
  );
}

/**
 * `commanderValue`: whether `name` is a commander at this table, ours or an opponent's, so worth
 * more than its body: it comes back taxed, and it is what the deck is built around.
 */
function isCommanderName(name: string, ctx: PolicyContext): boolean {
  return fixOn(ctx, 'commanderValue') && commanderNamed(name, ctx);
}

/** Whether `name` is a commander at this table, whatever the fixes. */
function commanderNamed(name: string, ctx: PolicyContext): boolean {
  const names = once(ctx, 'commanderNames', () => {
    const { view } = ctx;
    return new Set([
      ...(view.commanders ?? []).map((c) => c.name),
      ...view.opponents.flatMap((o) => (o.commanders ?? []).map((c) => c.name)),
    ]);
  });
  return names.has(name);
}

function permanentBaseValue(p: PermanentView, ctx: PolicyContext): number {
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

/** Fixed boost the IR says this slot gives, or null. */
function slotPump(action: LegalAction, slot: number, ctx: PolicyContext): StatBoost | null {
  if (action.type !== 'castSpell') return null;
  return traitsFor(ctx, sourceNameOf(action, ctx.view))?.spellPump?.[slot] ?? null;
}

function slotContext(action: LegalAction, slot: number, ctx: PolicyContext): SlotContext {
  return {
    damage: slotDamage(action, slot, ctx),
    pump: slotPump(action, slot, ctx),
    action,
  };
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

/** What else a slot's score depends on beyond the option itself (ADR 0043 fixes). */
interface SlotContext {
  /** Fixed damage the slot deals, or null. */
  damage: number | null;
  /** Fixed boost the slot gives, or null. */
  pump: StatBoost | null;
  /** The action the slot belongs to, for the mana it would spend. */
  action?: LegalAction;
}

/** Score one option for a slot of the given polarity: higher is better for us. */
function optionScore(
  option: ObjectId,
  polarity: TargetPolarity,
  ctx: PolicyContext,
  pressure: Map<PlayerId, number>,
  slot: SlotContext = { damage: null, pump: null },
): number {
  const c = describeOption(option, ctx);
  const mine = c.owner === ctx.view.seat;
  const damage = slot.damage;
  if (polarity === 'hostile') {
    if (mine) return -c.value - 100;
    if (c.owner === undefined) return 0;
    // ADR 0043: damage this seat already has on the stack. A player it already kills, or a
    // creature it already kills, is a wasted target.
    const pending = fixOn(ctx, 'ownStack') ? (pendingDamage(ctx).get(option) ?? 0) : 0;
    const player = ctx.view.opponents.find((o) => o.seat === option);
    if (player !== undefined && pending > 0 && player.life - pending <= 0) return -1;
    // Damage that leaves the player alive is worth the damage, not a whole player: two points at
    // someone on 30 life must not outrank killing a creature. Aggression scales it for racing.
    if (
      player !== undefined &&
      damage !== null &&
      fixOn(ctx, 'faceDamage') &&
      damage + pending < player.life
    ) {
      const aggression = clamp01(ctx.steering?.aggression ?? P.defaultAggression);
      return (
        damage *
          P.faceDamagePerLife *
          styleProfile(ctx.steering?.style).faceDamage *
          (0.5 + aggression) +
        (pressure.get(c.owner) ?? 0) * P.targetPressureWeight
      );
    }
    // Damage that leaves a creature alive takes only a sliver of its worth (Bolt on a 10/10).
    const creature = ctx.view.battlefield.find((p) => p.id === option);
    let share = 1;
    if (creature !== undefined && isCreaturePermanent(creature)) {
      if (pending > 0 && damageKills(creature, pending)) share = P.nonlethalDamageShare / 2;
      else if (damage !== null && !damageKills(creature, damage + pending))
        share = P.nonlethalDamageShare;
    }
    let score = c.value * share + (pressure.get(c.owner) ?? 0) * P.targetPressureWeight;
    if (creature !== undefined && share === 1 && fixOn(ctx, 'lethalTargets'))
      score += lethalRemovalBonus(creature, ctx, slot.action);
    return score;
  }
  if (polarity === 'friendly') {
    if (mine) {
      let score = c.value;
      if (slot.pump !== null && fixOn(ctx, 'lethalTargets'))
        score += lethalPumpBonus(option, slot.pump, ctx);
      return score;
    }
    return -c.value - 50;
  }
  return 0;
}

// --- ADR 0043: counting lethal -----------------------------------------------------------------

function pendingDamage(ctx: PolicyContext): Map<string, number> {
  return once(ctx, 'pendingDamage', () => pendingOwnDamage(ctx.view, ctx.knowledge));
}

/**
 * Removing `creature` is worth more when it is what kills this seat (an attacker whose damage
 * makes the incoming total lethal), or when it is the blocker that stops this seat's kill.
 */
function lethalRemovalBonus(
  creature: PermanentView,
  ctx: PolicyContext,
  action: LegalAction | undefined,
): number {
  const { view } = ctx;
  const incoming = once(ctx, 'incoming', () => incomingDamage(view));
  const total = [...incoming.values()].reduce((sum, d) => sum + d, 0);
  const own = incoming.get(creature.id) ?? 0;
  if (total >= view.life && own > 0) {
    return total - own < view.life ? P.saveFromLethalBonus : own * P.lethalThreatPerDamage;
  }
  if (creature.controller === view.seat) return 0;
  return clearsKill(creature, ctx, action) ? P.clearBlockerBonus : 0;
}

/** Whether removing `blocker` turns this seat's attack this turn into a kill of its controller. */
function clearsKill(
  blocker: PermanentView,
  ctx: PolicyContext,
  action: LegalAction | undefined,
): boolean {
  const { view, request } = ctx;
  const beforeAttacks =
    request.activePlayer === view.seat &&
    (request.phase === 'precombatMain' || request.step === 'beginCombat');
  if (!beforeAttacks || blocker.tapped || !isCreaturePermanent(blocker)) return false;
  const defender = view.opponents.find((o) => o.seat === blocker.controller);
  if (defender === undefined) return false;
  const spend = new Set<string>(paymentIds(action));
  const attackers = readyAttackers(view, spend).map((p) => combatBody(p));
  const blockers = untappedCreatures(view, defender.seat).map((p) => combatBody(p));
  const reach = pumpReach(ctx, action, spend);
  const without = damageThrough(
    attackers,
    blockers.filter((b) => b.id !== blocker.id),
  );
  const withIt = damageThrough(attackers, blockers);
  return withIt + reach < defender.life && without + reach >= defender.life;
}

function paymentIds(action: LegalAction | undefined): string[] {
  const ids = action?.data?.['paymentSourceIds'];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Extra damage this seat can add by pumping one ready attacker with a repeatable self-pump
 * (firebreathing), one mana per activation, from the mana `action` leaves untapped.
 */
function pumpReach(
  ctx: PolicyContext,
  action: LegalAction | undefined,
  spend: Set<string>,
): number {
  const { view } = ctx;
  let best = 0;
  for (const p of readyAttackers(view, spend)) {
    const pumps = traitsFor(ctx, p.name)?.abilitySelfPump ?? [];
    for (const pump of pumps) if (pump !== null) best = Math.max(best, pump.power);
  }
  if (best === 0) return 0;
  const untapped = view.manaSources.reduce(
    (sum, m) => sum + (m.symbols.length <= 1 ? m.count : 1),
    0,
  );
  const cost = action === undefined ? 0 : manaValueOfCost(action.data?.['manaCost']);
  return best * Math.max(0, untapped - cost);
}

/**
 * A pump on one of this seat's attackers is worth a kill when it carries unblocked (or trampling)
 * damage over the defending player's life, and a little more on any attacker it adds damage to.
 */
function lethalPumpBonus(option: ObjectId, pump: StatBoost, ctx: PolicyContext): number {
  const { view } = ctx;
  const target = view.battlefield.find((p) => p.id === option);
  if (target?.attacking === undefined || target.attackingPlaneswalker !== undefined) return 0;
  const defender = view.opponents.find((o) => o.seat === target.attacking);
  if (defender === undefined) return 0;
  const byId = new Map(view.battlefield.map((p) => [p.id, p]));
  const through = (p: PermanentView, extra: number): number => {
    const power = Math.max(0, (p.power ?? 0) + extra);
    if ((p.blockedBy ?? []).length === 0) return power;
    if (!hasKeyword(p, 'trample')) return 0;
    const toughness = (p.blockedBy ?? []).reduce(
      (sum, id) => sum + Math.max(0, byId.get(id)?.toughness ?? 0),
      0,
    );
    return Math.max(0, power - toughness);
  };
  const attackers = view.battlefield.filter(
    (p) =>
      p.controller === view.seat &&
      p.attacking === defender.seat &&
      p.attackingPlaneswalker === undefined,
  );
  const now = attackers.reduce((sum, p) => sum + through(p, 0), 0);
  const added = through(target, pump.power) - through(target, 0);
  if (added <= 0) return 0;
  if (now < defender.life && now + added >= defender.life) return P.lethalPumpBonus;
  return added * P.pumpDamageValue;
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
    const slotCtx = slotContext(action, slot.slot, ctx);
    const pick = (options: readonly string[]): { option: string; score: number } => {
      let option = options[0] as string;
      let score = polarity === 'neutral' ? 0 : -Infinity;
      if (polarity !== 'neutral') {
        for (const o of options) {
          const value = optionScore(o, polarity, ctx, pressure, slotCtx);
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
    const slotCtx = slotContext(action, slot.slot, ctx);
    const value = Math.max(
      ...slot.options.map((o) => optionScore(o, polarity, ctx, pressure, slotCtx)),
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

/**
 * An unsafe attack (only made at high aggression) must be worth losing the creature. One with an attack
 * trigger is; a lone attacker, the commander, or a 1-power body with nothing on attack is not.
 */
function weakRiskyAttacker(
  attacker: PermanentView | undefined,
  subject: AttackSubject,
  ownCreatures: number,
  ctx: PolicyContext,
): boolean {
  if (subject.hasTriggers) return false;
  if (ownCreatures <= 1) return true;
  if (attacker !== undefined && commanderNamed(attacker.name, ctx)) return true;
  return subject.power <= P.riskyAttackMinPower;
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
  // In danger: keep the best blocker home unless steering says to race. ADR 0043's
  // `attackReserve` replaces this with a count of next turn's swing, below.
  const threatened = view.life <= WEIGHTS.dangerousLifeThreshold * 1.5 && aggression < 0.8;
  const reserve =
    !fixOn(ctx, 'attackReserve') && threatened && ownCreatures.length > 1
      ? ownCreatures.reduce((a, b) => ((a.toughness ?? 0) >= (b.toughness ?? 0) ? a : b)).id
      : null;

  const choices = (action.targets ?? []).map((slot, i) => {
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
      (safe || !weakRiskyAttacker(attacker, subject, ownCreatures.length, ctx)) &&
      subject.subjectId !== reserve &&
      (safe ? aggression >= P.safeAttackAggression : aggression >= P.riskyAttackAggression);
    return { slot: slot.slot, choice: attack ? best : NO_ATTACK_TARGET };
  });

  let killed: PlayerId | null = null;
  if (fixOn(ctx, 'lethalTargets')) killed = sendEverythingAtAKill(action, subjects, choices, ctx);
  if (fixOn(ctx, 'attackReserve') && aggression < 0.8)
    keepEnoughBlockers(action, subjects, choices, ctx, killed);
  return choices;
}

/**
 * ADR 0043: when every attacker that may attack, sent at one opponent, gets enough damage past
 * that opponent's untapped blockers to kill, send them all there. Returns the seat, or null.
 */
function sendEverythingAtAKill(
  action: LegalAction,
  subjects: AttackSubject[],
  choices: TargetChoice[],
  ctx: PolicyContext,
): PlayerId | null {
  const { view } = ctx;
  const slots = action.targets ?? [];
  let target: { seat: PlayerId; margin: number } | null = null;
  for (const opponent of view.opponents) {
    if (opponent.life <= 0) continue;
    const able = slots
      .map((slot, i) => ({ slot, subject: subjects[i] }))
      .filter(({ slot }) => slot.options.includes(opponent.seat));
    if (able.length === 0) continue;
    const attackers = able.flatMap(({ subject }) => {
      const p =
        subject === undefined
          ? undefined
          : view.battlefield.find((b) => b.id === subject.subjectId);
      return p === undefined ? [] : [combatBody(p)];
    });
    const blockers = untappedCreatures(view, opponent.seat).map((p) => combatBody(p));
    const margin = damageThrough(attackers, blockers) - opponent.life;
    if (margin < 0 || (target !== null && margin <= target.margin)) continue;
    // A kill that leaves this seat dead to the others' swing next turn is not taken.
    const sent = new Set(attackers.map((a) => a.id));
    const kept = untappedCreatures(view, view.seat)
      .filter((p) => !sent.has(p.id) || hasKeyword(p, 'vigilance'))
      .map((p) => combatBody(p));
    const threats = view.battlefield
      .filter(
        (p) =>
          p.controller !== view.seat && p.controller !== opponent.seat && isCreaturePermanent(p),
      )
      .map((p) => combatBody(p));
    if (damageThrough(threats, kept) >= view.life) continue;
    target = { seat: opponent.seat, margin };
  }
  if (target === null) return null;
  slots.forEach((slot, i) => {
    if (slot.options.includes(target.seat)) choices[i] = { slot: slot.slot, choice: target.seat };
  });
  return target.seat;
}

/**
 * ADR 0043: before attacking, count the swing every opponent could make before this seat's next
 * turn (all their creatures untap) against this seat's life and the blockers it keeps: creatures
 * that do not attack, and attackers with vigilance. A lethal swing outweighs any attack, even one
 * that kills a player; at low life, life given away also counts against the damage an attack
 * deals. Attackers are called back one at a time, best first, while that improves the count.
 * When the swing is still lethal and no single recall helps (it takes two blockers to survive),
 * attackers are called back, the biggest cut in the swing first, until it is not, and that plan
 * is kept if it beats attacking.
 */
function keepEnoughBlockers(
  action: LegalAction,
  subjects: AttackSubject[],
  choices: TargetChoice[],
  ctx: PolicyContext,
  killed: PlayerId | null,
): void {
  const { view } = ctx;
  const slots = action.targets ?? [];
  const live = (seat: PlayerId): boolean =>
    view.opponents.some((o) => o.seat === seat && o.life > 0);
  const threatsFor = (dead: PlayerId | null) =>
    view.battlefield
      .filter(
        (p) =>
          p.controller !== view.seat &&
          p.controller !== dead &&
          isCreaturePermanent(p) &&
          live(p.controller),
      )
      .map((p) => combatBody(p));
  if (threatsFor(null).length === 0) return;
  const lowLife = view.life <= WEIGHTS.dangerousLifeThreshold * 1.5;
  const lifeWeight =
    view.life <= WEIGHTS.dangerousLifeThreshold ? WEIGHTS.deals.lowLifeMultiplier : 1;
  const bodyOf = new Map(view.battlefield.map((p) => [p.id, p]));

  /** The attack's value, and the swing this seat would face after it. */
  const assess = (): { gain: number; swing: number } => {
    const bySeat = new Map<PlayerId, CombatBody[]>();
    const attacking = new Set<string>();
    choices.forEach((choice, i) => {
      const subject = subjects[i];
      const p = subject === undefined ? undefined : bodyOf.get(subject.subjectId);
      if (p === undefined || choice.choice === NO_ATTACK_TARGET) return;
      attacking.add(p.id);
      // Only an attack on a player hurts that player; one at a planeswalker is not life lost.
      const seat = view.opponents.some((o) => o.seat === choice.choice) ? choice.choice : undefined;
      if (seat !== undefined) bySeat.set(seat, [...(bySeat.get(seat) ?? []), combatBody(p)]);
    });
    let gain = 0;
    let dead: PlayerId | null = null;
    for (const [seat, attackers] of bySeat) {
      const life = view.opponents.find((o) => o.seat === seat)?.life ?? 40;
      const through = damageThrough(
        attackers,
        untappedCreatures(view, seat).map((p) => combatBody(p)),
      );
      gain += through * WEIGHTS.combat.opponentLifePointValue;
      if (through >= life) {
        gain += P.lethalAttackBonus;
        if (seat === killed) dead = seat;
      }
    }
    const kept = view.battlefield
      .filter(
        (p) =>
          p.controller === view.seat &&
          isCreaturePermanent(p) &&
          !p.tapped &&
          (!attacking.has(p.id) || hasKeyword(p, 'vigilance')),
      )
      .map((p) => combatBody(p));
    return { gain, swing: damageThrough(threatsFor(dead), kept) };
  };
  const worth = (): number => {
    const { gain, swing } = assess();
    if (swing >= view.life) return gain - WEIGHTS.combat.lethalSwingValue * 10;
    return lowLife ? gain - swing * lifeWeight : gain;
  };
  /** The attack slots that could stay home instead: not forced, not vigilant, still attacking. */
  const recallable = (): number[] =>
    slots.flatMap((slot, i) => {
      const subject = subjects[i];
      if (subject === undefined || subject.mustAttack || !slot.options.includes(NO_ATTACK_TARGET))
        return [];
      if (choices[i]!.choice === NO_ATTACK_TARGET) return [];
      const p = bodyOf.get(subject.subjectId);
      return p === undefined || hasKeyword(p, 'vigilance') ? [] : [i];
    });
  const recall = (i: number): void => {
    choices[i] = { slot: slots[i]!.slot, choice: NO_ATTACK_TARGET };
  };

  let current = worth();
  for (;;) {
    let bestIndex = -1;
    let bestWorth = current;
    for (const i of recallable()) {
      const choice = choices[i]!;
      recall(i);
      const after = worth();
      choices[i] = choice;
      if (after > bestWorth) {
        bestWorth = after;
        bestIndex = i;
      }
    }
    if (bestIndex !== -1) {
      recall(bestIndex);
      current = bestWorth;
      continue;
    }
    // No one recall helps. If the swing is still lethal, it may take several blockers to live:
    // call attackers back until it is not, and keep that plan only if it is worth more.
    if (assess().swing < view.life) return;
    const before = choices.slice();
    while (assess().swing >= view.life) {
      let pick = -1;
      let pickSwing = Infinity;
      let pickWorth = -Infinity;
      for (const i of recallable()) {
        const choice = choices[i]!;
        recall(i);
        const { swing } = assess();
        const after = worth();
        choices[i] = choice;
        if (swing < pickSwing || (swing === pickSwing && after > pickWorth)) {
          pick = i;
          pickSwing = swing;
          pickWorth = after;
        }
      }
      if (pick === -1) break;
      recall(pick);
    }
    // The current plan carries the lethal-swing penalty, so this is in effect a survival gate: a
    // plan that lives is kept, even at the cost of a kill the attack would have made.
    const after = worth();
    if (assess().swing < view.life && after > current) {
      current = after;
      continue;
    }
    before.forEach((choice, i) => (choices[i] = choice));
    return;
  }
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
        const scale = roleScale(ctx.steering?.style, 'removal');
        value +=
          (best === null ? P.roles.removal : Math.min(best, 30) * P.removalTargetShare) * scale;
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
        value += P.roles[role] * roleScale(ctx.steering?.style, role);
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
  // ADR 0043: this seat's own spell on the stack is not something to respond to.
  const responding = fixOn(ctx, 'ownStack')
    ? view.stack.some((item) => item.controller !== view.seat)
    : view.stack.length > 0;
  if (roles.length > 0 && roles.every((r) => PROTECTIVE_OR_PUMP.has(r))) {
    return inCombat || responding ? 0 : P.idleTrickPenalty;
  }
  return 0;
}

/** Roles worth keeping mana open for through the opponents' turns. */
const INTERACTION: ReadonlySet<CardRole> = new Set([
  'counter',
  'removal',
  'wipe',
  'burn',
  'protection',
]);

/**
 * The mana the seat's held instant-speed interaction needs, or 0 when it holds none: the dearest
 * play costing at most `holdUpMaxInteractionCost` among instants with an interaction role and
 * flash cards in hand, and instant-speed interaction abilities on the menu.
 */
function heldInteractionCost(ctx: PolicyContext): number {
  const { view, request } = ctx;
  let cost = 0;
  const consider = (mv: number): void => {
    if (mv > 0 && mv <= P.holdUpMaxInteractionCost) cost = Math.max(cost, mv);
  };
  for (const card of view.hand) {
    const traits = traitsFor(ctx, card.name);
    if (traits === undefined) continue;
    const interacts = traits.roles.some((r) => INTERACTION.has(r));
    const flashCreature = traits.flash === true && traits.types.includes('Creature');
    const instantSpeed = traits.types.includes('Instant') || traits.flash === true;
    if ((instantSpeed && interacts) || flashCreature) consider(traits.manaValue);
  }
  for (const action of request.legalActions) {
    if (action.type !== 'activateAbility' || action.data?.['producesMana'] === true) continue;
    const index = abilityIndexOf(action);
    const traits = traitsFor(ctx, sourceNameOf(action, view));
    if (index === undefined || traits === undefined || traits.abilitySorcery?.[index] === true)
      continue;
    if (!(traits.abilityRoles?.[index] ?? []).some((r) => INTERACTION.has(r))) continue;
    const shown = action.data?.['manaCost'];
    if (typeof shown === 'string') consider(manaValueOfCost(shown));
  }
  return cost;
}

/** Lands and other mana-producing permanents the seat controls, tapped or not. */
function manaBase(ctx: PolicyContext): number {
  const { view } = ctx;
  return view.battlefield.filter(
    (p) =>
      p.controller === view.seat &&
      (isLandType(p.typeLine) || (traitsFor(ctx, p.name)?.manaUnits?.length ?? 0) > 0),
  ).length;
}

/**
 * Does casting this at sorcery speed break the strategist's hold-up-mana knob? Only when the seat
 * holds cheap instant-speed interaction to use that mana on, and only once its mana base can keep
 * the reserve and still cast a three-drop, so early development is never held back.
 */
function holdUpPenalty(mv: number, action: LegalAction, ctx: PolicyContext): number {
  const knob = ctx.steering?.holdUpMana ?? 0;
  if (knob <= 0 || action.data?.['instantSpeed'] === true) return 0;
  // The commander is the deck's plan, and a full hand discards what it does not cast.
  if (action.data?.['sourceZone'] === 'command') return 0;
  if (ctx.view.hand.length >= P.holdUpFullHand) return 0;
  const want = Math.min(
    knob,
    once(ctx, 'heldInteraction', () => heldInteractionCost(ctx)),
  );
  if (want <= 0) return 0;
  if (once(ctx, 'manaBase', () => manaBase(ctx)) - want < P.holdUpDevelopMana) return 0;
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
  if (action.type === 'playLand') {
    return P.playLand + (fixOn(ctx, 'landColors') ? landChoiceValue(action, ctx) : 0);
  }
  if (action.type === 'passAndYieldTurn' && fixOn(ctx, 'neverYield') && holdsInstant(ctx)) {
    return WEIGHTS.passBaseline - P.yieldWhileHolding;
  }

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
    if (fixOn(ctx, 'lethalValue') && makesLethal(traits, action, ctx)) value += P.lethalSpellBonus;
    if (fixOn(ctx, 'castOrder') && beginsBestOrder(action, ctx)) value += P.castOrderBonus;
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

  // The last answer of its kind is kept for a real threat. Applied before the strategist's knobs,
  // so a `prioritize` on the card can still spend it.
  if (
    action.type === 'castSpell' &&
    fixOn(ctx, 'scarceAnswer') &&
    wastesLastAnswer(action, name, ctx)
  )
    value = Math.min(value, WEIGHTS.passBaseline - P.scarceAnswer.holdMargin);

  if (namedIn(steering?.prioritize, name)) value += P.prioritizeBonus;
  if (namedIn(steering?.hold, name)) value -= P.holdPenalty;
  return value;
}

// --- Answer discipline (`scarceAnswer`, ADR 0044's `scarce-answer` positions) ------------------

/**
 * Whether casting `action` spends the last counterspell or hard removal of its kind in hand on
 * something below its threshold, with no lethal on the public board. Every last-of-its-kind answer
 * the card would spend must be wasted for it to be held; a target the bot cannot value (an
 * ability on the stack, an unknown card, a spell with no target) is never held.
 */
function wastesLastAnswer(
  action: LegalAction,
  name: string | undefined,
  ctx: PolicyContext,
): boolean {
  const { view, request, knowledge } = ctx;
  if (knowledge === undefined) return false;
  const castId = action.interaction?.kind === 'source' ? action.interaction.sourceId : undefined;
  const last = lastAnswerKinds(name, castId, view, knowledge);
  if (last.length === 0) return false;
  if (once(ctx, 'publicLethal', () => publicLethal(view, request, knowledge))) return false;
  return last.every((kind) => {
    const threat = answerThreat(kind, action, ctx);
    const style = styleProfile(ctx.steering?.style);
    const floor =
      kind === 'counter'
        ? P.scarceAnswer.minCounterThreat * style.counterThreshold
        : P.scarceAnswer.minRemovalThreat * style.removalThreshold;
    return threat !== null && threat < floor;
  });
}

/**
 * What countering an opposing spell protects: when it targets the seat's own spells on the stack
 * (a Negate aimed at our Wrath), the threat of the best of them. A counter war is fought over the
 * spell being countered, not over the counterspell's own size.
 */
function protectedThreat(item: StackObjectView, ctx: PolicyContext): number {
  const { view } = ctx;
  let best = -Infinity;
  for (const id of item.targets) {
    const ours = view.stack.find((entry) => entry.id === id && entry.controller === view.seat);
    if (ours === undefined) continue;
    const traits = traitsFor(ctx, ours.description);
    if (traits === undefined) continue;
    const commander = isCommanderName(ours.description, ctx) ? P.commanderPermanentBonus : 0;
    best = Math.max(best, spellThreat(traits) + commander);
  }
  return best;
}

/** What an answer of `kind` would hit, on its own scale; null when the bot cannot tell. */
function answerThreat(kind: AnswerKind, action: LegalAction, ctx: PolicyContext): number | null {
  const { view } = ctx;
  if (kind === 'counter') {
    // A mode that counters nothing (Izzet Charm's damage) is not spending the counter.
    if (action.data?.['modeLabel'] !== undefined && !targetsStack(view, action)) return null;
    const theirs = view.stack.filter((item) => item.controller !== view.seat);
    const options = new Set((action.targets ?? []).flatMap((t) => t.options));
    const top = view.stack.at(-1);
    const hits =
      options.size > 0
        ? theirs.filter((item) => options.has(item.id))
        : top !== undefined && top.controller !== view.seat
          ? [top]
          : [];
    if (hits.length === 0) return null;
    let best = -Infinity;
    for (const item of hits) {
      // A spell is shown by its card name; an ability's description is not one.
      const traits = traitsFor(ctx, item.description);
      if (traits === undefined) return null;
      const commander = isCommanderName(item.description, ctx) ? P.commanderPermanentBonus : 0;
      best = Math.max(best, spellThreat(traits) + commander, protectedThreat(item, ctx));
    }
    return best;
  }
  if (kind === 'hardRemoval') {
    let best: number | null = null;
    for (const slot of action.targets ?? []) {
      for (const option of slot.options) {
        const p = view.battlefield.find((x) => x.id === option);
        if (p === undefined || p.controller === view.seat) continue;
        const bonus =
          isCreaturePermanent(p) && fixOn(ctx, 'lethalTargets')
            ? lethalRemovalBonus(p, ctx, action)
            : 0;
        const value = permanentValue(p, ctx) + bonus;
        best = best === null ? value : Math.max(best, value);
      }
    }
    return best;
  }
  // A wipe is already valued by what it removes on each side.
  return null;
}

/** A spell's threat: its mana value, plus a bonus for an effect that swings a game at any cost. */
function spellThreat(traits: CardTraits): number {
  const big =
    traits.roles.includes('wipe') ||
    traits.roles.includes('extraTurn') ||
    traits.massPump !== undefined;
  return traits.manaValue + (big ? P.scarceAnswer.bigEffectBonus : 0);
}

// --- ADR 0043: yielding, lethal spells, casting order, land colours ---------------------------

/**
 * Whether the menu holds an instant-speed action the seat could still use this turn: an instant
 * or flash spell, or a non-mana ability that is not limited to sorcery timing.
 */
function holdsInstant(ctx: PolicyContext): boolean {
  return ctx.request.legalActions.some((action) => {
    if (action.type === 'castSpell') return action.data?.['instantSpeed'] === true;
    if (action.type !== 'activateAbility' || action.data?.['producesMana'] === true) return false;
    const index = abilityIndexOf(action);
    const traits = traitsFor(ctx, sourceNameOf(action, ctx.view));
    return !(index !== undefined && traits?.abilitySorcery?.[index] === true);
  });
}

/** Whether casting this team pump before combat turns this turn's attack into a kill. */
function makesLethal(
  traits: CardTraits | undefined,
  action: LegalAction,
  ctx: PolicyContext,
): boolean {
  const pump = traits?.massPump;
  const { view, request } = ctx;
  if (pump === undefined || request.activePlayer !== view.seat) return false;
  if (request.phase !== 'precombatMain' && request.step !== 'beginCombat') return false;
  const spend = new Set(paymentIds(action));
  const ready = readyAttackers(view, spend);
  if (ready.length === 0) return false;
  const plain = ready.map((p) => combatBody(p));
  const pumped = ready.map((p) => combatBody(p, pump, pump.keywords));
  return view.opponents.some((o) => {
    if (o.life <= 0) return false;
    const blockers = untappedCreatures(view, o.seat).map((p) => combatBody(p));
    return damageThrough(plain, blockers) < o.life && damageThrough(pumped, blockers) >= o.life;
  });
}

/**
 * Whether this cast begins a casting order that spends the most mana this turn, among the orders
 * of the castable spells (land drop first, at most four spells). Only on this seat's own main
 * phase with an empty stack, where order is a free choice.
 */
function beginsBestOrder(action: LegalAction, ctx: PolicyContext): boolean {
  const { view, request, knowledge } = ctx;
  if (knowledge === undefined || request.activePlayer !== view.seat || view.stack.length > 0)
    return false;
  if (request.phase !== 'precombatMain' && request.phase !== 'postcombatMain') return false;
  const plan = once(ctx, 'castOrder', () => {
    const casts = request.legalActions.filter((a) => a.type === 'castSpell');
    if (casts.length < 2) return null;
    const pool = manaUnitsOf(view);
    // The land drop comes first whenever one is on the menu (it outscores every spell).
    const land = request.legalActions.find(
      (a) => a.type === 'playLand' && a.data?.['entersTapped'] !== true,
    );
    const landMana = land?.data?.['producesMana'];
    if (Array.isArray(landMana) && landMana.length > 0) pool.push(landMana.map(String));
    const candidates: CastCandidate[] = [];
    for (const cast of casts) {
      const name = sourceNameOf(cast, view);
      const cost = parseCost(
        typeof cast.data?.['manaCost'] === 'string' ? cast.data['manaCost'] : undefined,
      );
      if (name === undefined || cost === null) continue;
      if (candidates.some((c) => c.name === name)) continue; // two copies, or two ways to cast one card
      candidates.push({
        actionId: cast.id,
        name,
        cost,
        manaValue: traitsFor(ctx, name)?.manaValue ?? manaValueOfCost(cast.data?.['manaCost']),
        produces: producedThisTurn({ name }, knowledge),
      });
    }
    if (candidates.length < 2) return null;
    // Prefer the dearest spells when more than four are castable.
    candidates.sort((a, b) => b.manaValue - a.manaValue);
    const order = bestCastingOrder(pool, candidates);
    // No signal when every castable spell begins an equally good order.
    return order.firstActions.size === order.firstValues.size ? null : order.firstActions;
  });
  if (plan === null) return false;
  // Two actions for one card (cast from hand, flashback) share its name; either may begin the order.
  const name = sourceNameOf(action, view);
  return request.legalActions.some(
    (a) => plan.has(a.id) && a.type === 'castSpell' && sourceNameOf(a, view) === name,
  );
}

/** Coloured pips per colour the hand's most demanding spell needs. */
function colourNeeds(view: PlayerView): Map<string, number> {
  const need = new Map<string, number>();
  for (const card of view.hand) {
    if (isLandType(card.typeLine)) continue;
    const cost = parseCost(card.manaCost);
    if (cost === null) continue;
    const pips = new Map<string, number>();
    for (const pip of cost.pips) if (pip !== 'C') pips.set(pip, (pips.get(pip) ?? 0) + 1);
    for (const [colour, n] of pips) need.set(colour, Math.max(need.get(colour) ?? 0, n));
  }
  return need;
}

/**
 * How much better this land is than another: it enters untapped and lets a spell be cast this
 * turn, and it adds colours the hand needs more sources of. On a turn no land unlocks anything,
 * a tapped land costs nothing to play.
 */
function landChoiceValue(action: LegalAction, ctx: PolicyContext): number {
  const { view, request } = ctx;
  const unlocks = (a: LegalAction): boolean =>
    a.data?.['entersTapped'] !== true &&
    Array.isArray(a.data?.['unlocks']) &&
    (a.data['unlocks'] as unknown[]).length > 0;
  const tapped = action.data?.['entersTapped'] === true;
  let value = 0;
  if (unlocks(action)) value += P.landUnlockBonus;
  const anyUnlocks = request.legalActions.some((a) => a.type === 'playLand' && unlocks(a));
  if (tapped && !anyUnlocks) value += P.idleTappedLandBonus;
  const produces = action.data?.['producesMana'];
  if (Array.isArray(produces)) {
    const need = colourNeeds(view);
    for (const colour of new Set(produces.map(String))) {
      const have = view.manaSources.filter((m) => m.symbols.includes(colour)).length;
      if ((need.get(colour) ?? 0) > have) value += P.landColorNeedBonus;
    }
  }
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
/**
 * `costChoices`: a permanent sacrificed to pay an activation cost (Ashnod's Altar's victim) is a
 * loss like any other sacrifice. Without it the bot has no opinion and its seeded tie-break picks.
 */
function isLossChoice(type: string, ctx: PolicyContext): boolean {
  return LOSS_CHOICES.has(type) || (type === 'sacrificeCost' && fixOn(ctx, 'costChoices'));
}

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
    if (value !== null && isLossChoice(action.type, ctx)) return P.choiceBase - value;
    if (value !== null && GAIN_CHOICES.has(action.type)) return P.choiceBase + value;
  }
  if (GAIN_CHOICES.has(action.type)) return P.choiceBase;
  return null;
}
