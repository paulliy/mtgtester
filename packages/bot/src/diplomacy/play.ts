import type {
  DealObligation,
  LegalAction,
  ObjectId,
  PlayerId,
  PlayerView,
  TargetChoice,
} from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import { WEIGHTS } from '../weights';
import { forbidsOption, ownerLookup, stackLookup, type OwnerOf } from './compliance';
import { damageValue, estimateTable, type TableEstimate } from './estimate';

/** One of this seat's own obligations, with the deal it belongs to. */
export interface ActiveObligation {
  dealId: string;
  obligation: DealObligation;
}

/** Why a seat broke a deal, as it announces it. */
export type BreachReason = 'lethal' | 'worthIt';

/**
 * What a seat's decisions need from the diplomacy table (ADR 0031 decisions 16 and 17). Present
 * only when diplomacy is on; its presence is also what switches on threat-aware attack targets.
 */
export interface DiplomacyPlay {
  /** This seat's obligations currently in force. */
  obligations(): readonly ActiveObligation[];
  /** Opponents this seat started the game with, for the late-game reputation discount. */
  startingOpponents: number;
  /** Told when a decision deliberately breaks a deal, so the table can announce why. */
  reportBreach?(dealId: string, reason: BreachReason): void;
}

/**
 * Reputation cost of one breach (decision 17). Trust matters less as players are eliminated, so
 * the cost shrinks with the share of starting opponents still alive.
 */
export function breachCost(dip: DiplomacyPlay, view: PlayerView): number {
  const share = dip.startingOpponents > 0 ? view.opponents.length / dip.startingOpponents : 1;
  return WEIGHTS.deals.breakPenalty * share;
}

function forbiddingObligations(
  obligations: readonly ActiveObligation[],
  option: ObjectId,
  ownerOf: OwnerOf,
  isStack: (id: ObjectId) => boolean,
): ActiveObligation[] {
  return obligations.filter((a) => forbidsOption(a.obligation, option, ownerOf, isStack));
}

/**
 * Targets for a non-combat action that honor this seat's `noTarget`/`noCounter` obligations: the
 * first complying option in each slot, or the first option when none complies.
 */
export function complyingTargets(
  action: LegalAction,
  view: PlayerView,
  dip: DiplomacyPlay,
): TargetChoice[] {
  const ownerOf = ownerLookup(view);
  const isStack = stackLookup(view);
  const obligations = dip.obligations();
  return (action.targets ?? []).map((slot) => {
    const ok = slot.options.find(
      (o) => forbiddingObligations(obligations, o, ownerOf, isStack).length === 0,
    );
    return { slot: slot.slot, choice: (ok ?? slot.options[0]) as string };
  });
}

/**
 * Score penalty for a voluntary (priority) action that can only be taken by breaking a deal: some
 * slot has no complying option. Forced decisions are never penalized: there is no choice to make,
 * and compliance excuses them.
 */
export function targetBreachPenalty(
  action: LegalAction,
  view: PlayerView,
  dip: DiplomacyPlay,
): number {
  if (action.type === 'attackDeclaration' || action.type === 'blockDeclaration') return 0;
  const obligations = dip.obligations();
  if (obligations.length === 0) return 0;
  const ownerOf = ownerLookup(view);
  const isStack = stackLookup(view);
  const stuck = (action.targets ?? []).some(
    (slot) =>
      slot.options.length > 0 &&
      slot.options.every((o) => forbiddingObligations(obligations, o, ownerOf, isStack).length > 0),
  );
  return stuck ? breachCost(dip, view) : 0;
}

interface AttackSlot {
  slot: number;
  power: number;
  options: ObjectId[];
}

interface AttackPlan {
  choices: Map<number, ObjectId>;
  value: number;
  /** Damage per defending seat, planeswalkers counted at their controller. */
  damage: Map<PlayerId, number>;
}

function attackSlots(action: LegalAction, view: PlayerView): AttackSlot[] {
  const subjects = action.data?.['subjects'];
  const powerById = new Map(view.battlefield.map((p) => [p.id, p.power ?? 0]));
  return (action.targets ?? []).map((slot, i) => {
    let power = 0;
    if (Array.isArray(subjects)) {
      const subject = subjects[i] as { power?: unknown; subjectId?: unknown } | undefined;
      if (typeof subject?.power === 'number') power = subject.power;
      else if (typeof subject?.subjectId === 'string')
        power = powerById.get(subject.subjectId) ?? 0;
    }
    return { slot: slot.slot, power: Math.max(0, power), options: slot.options };
  });
}

function planValue(table: TableEstimate, damage: Map<PlayerId, number>, pwValue: number): number {
  let value = pwValue;
  for (const [seat, dmg] of damage) value += damageValue(table, seat, dmg);
  return value;
}

/**
 * Greedy threat-aware attack plan (decision 16): each attacker, largest first, goes at the
 * allowed defender whose marginal `damageValue` is highest. A planeswalker counts as its
 * controller at `planeswalkerFactor` and does not add to the controller's damage.
 */
function greedyPlan(
  table: TableEstimate,
  slots: readonly AttackSlot[],
  ownerOf: OwnerOf,
  allowed: (option: ObjectId) => boolean,
): AttackPlan {
  const pf = WEIGHTS.deals.planeswalkerFactor;
  const damage = new Map<PlayerId, number>();
  const choices = new Map<number, ObjectId>();
  let pwValue = 0;
  const order = [...slots].sort((a, b) => b.power - a.power || a.slot - b.slot);

  // Kills first: one attacker at a time cannot see that two of them together are lethal. While
  // some player can be killed by the attackers still free to reach them, commit the fewest
  // (largest first) to the kill worth most.
  for (;;) {
    const free = order.filter((s) => !choices.has(s.slot));
    let kill: { seat: PlayerId; value: number } | null = null;
    for (const t of table.seats) {
      if (t.seat === table.viewer || damage.has(t.seat)) continue;
      const reach = free
        .filter((s) => s.options.includes(t.seat) && allowed(t.seat))
        .reduce((sum, s) => sum + s.power, 0);
      if (reach < t.life) continue;
      const value = damageValue(table, t.seat, t.life);
      if (kill === null || value > kill.value) kill = { seat: t.seat, value };
    }
    if (kill === null) break;
    let dealt = 0;
    const life = table.bySeat.get(kill.seat)!.life;
    for (const s of free) {
      if (dealt >= life) break;
      if (!s.options.includes(kill.seat)) continue;
      choices.set(s.slot, kill.seat);
      dealt += s.power;
    }
    damage.set(kill.seat, dealt);
  }

  for (const s of order) {
    if (choices.has(s.slot)) continue;
    const real = s.options.filter((o) => o !== NO_ATTACK_TARGET);
    const legal = real.filter(allowed);
    if (legal.length === 0) {
      // Declining keeps the deal; a creature that must attack and has only forbidden defenders
      // attacks anyway, which compliance excuses.
      choices.set(s.slot, s.options.includes(NO_ATTACK_TARGET) ? NO_ATTACK_TARGET : real[0]!);
      if (!s.options.includes(NO_ATTACK_TARGET) && real[0] !== undefined) {
        const seat = ownerOf(real[0]);
        if (seat !== undefined && seat === real[0]) {
          damage.set(seat, (damage.get(seat) ?? 0) + s.power);
        }
      }
      continue;
    }
    let best = legal[0]!;
    let bestGain = -Infinity;
    for (const option of legal) {
      const seat = ownerOf(option);
      if (seat === undefined) continue;
      const isPlayer = seat === option;
      const already = damage.get(seat) ?? 0;
      const gain = isPlayer
        ? damageValue(table, seat, already + s.power) - damageValue(table, seat, already)
        : pf * damageValue(table, seat, s.power);
      if (gain > bestGain) {
        bestGain = gain;
        best = option;
      }
    }
    choices.set(s.slot, best);
    const seat = ownerOf(best);
    if (seat === undefined) continue;
    if (seat === best) damage.set(seat, (damage.get(seat) ?? 0) + s.power);
    else pwValue += pf * damageValue(table, seat, s.power);
  }
  return { choices, value: planValue(table, damage, pwValue), damage };
}

/**
 * Send one attacker at an `attackPlayer` obligation's target when the plan does not already: the
 * smallest attacker that may, so keeping the promise costs as little as possible.
 */
function honorAttackPlayer(
  plan: AttackPlan,
  slots: readonly AttackSlot[],
  ownerOf: OwnerOf,
  target: PlayerId,
  allowed: (option: ObjectId) => boolean,
): void {
  for (const choice of plan.choices.values()) {
    if (ownerOf(choice) === target) return;
  }
  const candidates = slots
    .filter((s) => s.options.some((o) => ownerOf(o) === target && allowed(o)))
    .sort((a, b) => a.power - b.power || a.slot - b.slot);
  const s = candidates[0];
  if (s === undefined) return;
  const option =
    s.options.find((o) => o === target) ?? s.options.find((o) => ownerOf(o) === target)!;
  plan.choices.set(s.slot, option);
}

export interface AttackDecision {
  targets: TargetChoice[];
  /** Set when the chosen plan deliberately breaks a deal. */
  breach?: { dealId: string; reason: BreachReason };
}

/**
 * Attack targets under diplomacy (decisions 16 and 17). Builds the best plan that keeps every
 * deal and, for each deal with a `noAttack` obligation, the best plan that breaks only that one;
 * a break is chosen when its gain over keeping exceeds the reputation cost.
 */
export function planAttackDeclaration(
  action: LegalAction,
  view: PlayerView,
  dip: DiplomacyPlay,
): AttackDecision {
  const table = estimateTable(view);
  const ownerOf = ownerLookup(view);
  const isStack = stackLookup(view);
  const slots = attackSlots(action, view);
  const obligations = dip.obligations();
  const noAttack = obligations.filter((a) => a.obligation.kind === 'noAttack');

  const allowedExcept = (skipDeal: string | null) => (option: ObjectId) =>
    !noAttack.some(
      (a) => a.dealId !== skipDeal && forbidsOption(a.obligation, option, ownerOf, isStack),
    );

  const finish = (plan: AttackPlan, allowed: (option: ObjectId) => boolean): AttackPlan => {
    for (const a of obligations) {
      if (a.obligation.kind === 'attackPlayer') {
        honorAttackPlayer(plan, slots, ownerOf, a.obligation.target, allowed);
      }
    }
    return plan;
  };

  const keepAllowed = allowedExcept(null);
  let chosen = finish(greedyPlan(table, slots, ownerOf, keepAllowed), keepAllowed);
  let breach: AttackDecision['breach'];

  const cost = breachCost(dip, view);
  const keepValue = chosen.value;
  let bestNet = 0;
  for (const dealId of new Set(noAttack.map((a) => a.dealId))) {
    const allowed = allowedExcept(dealId);
    const plan = finish(greedyPlan(table, slots, ownerOf, allowed), allowed);
    const net = plan.value - keepValue - cost;
    if (net <= bestNet) continue;
    const protectedSeats = noAttack
      .filter((a) => a.dealId === dealId)
      .map((a) => (a.obligation.kind === 'noAttack' ? a.obligation.against : ''));
    const brokeIt = [...plan.choices.values()].some((c) => {
      const seat = ownerOf(c);
      return seat !== undefined && protectedSeats.includes(seat);
    });
    if (!brokeIt) continue;
    bestNet = net;
    chosen = plan;
    const lethal = protectedSeats.some((seat) => {
      const life = table.bySeat.get(seat)?.life ?? Infinity;
      return (plan.damage.get(seat) ?? 0) >= life;
    });
    breach = { dealId, reason: lethal ? 'lethal' : 'worthIt' };
  }

  const targets = slots.map((s) => ({
    slot: s.slot,
    choice: chosen.choices.get(s.slot) ?? (s.options[0] as string),
  }));
  return breach === undefined ? { targets } : { targets, breach };
}
