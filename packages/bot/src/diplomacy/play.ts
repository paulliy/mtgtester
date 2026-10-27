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
import {
  attackSlotPowers,
  forbidsOption,
  ownerLookup,
  requiredAttackPower,
  stackLookup,
  type OwnerOf,
} from './compliance';
import {
  couldKill,
  damageValue,
  estimateTable,
  unblockedPower,
  type TableEstimate,
} from './estimate';

/** One of this seat's own obligations, with the deal it belongs to. */
export interface ActiveObligation {
  dealId: string;
  obligation: DealObligation;
}

/** Why a seat broke a deal, as it announces it. */
export type BreachReason = 'lethal' | 'worthIt' | 'selfDefense';

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

/**
 * A promise not to target or counter a seat stops binding once that seat leads the table or
 * could kill us: no deal stops a seat from answering what is about to beat it. Attack promises
 * are not released this way; breaking them goes through the reputation comparison instead.
 */
function released(o: DealObligation, table: TableEstimate): boolean {
  if (o.kind !== 'noTarget' && o.kind !== 'noCounter') return false;
  return table.leader === o.against || couldKill(table, o.against, table.viewer);
}

interface TargetContext {
  ownerOf: OwnerOf;
  isStack: (id: ObjectId) => boolean;
  binding: ActiveObligation[];
  releasedOnes: ActiveObligation[];
}

function targetContext(view: PlayerView, dip: DiplomacyPlay): TargetContext {
  const table = estimateTable(view);
  const targeting = dip
    .obligations()
    .filter((a) => a.obligation.kind === 'noTarget' || a.obligation.kind === 'noCounter');
  return {
    ownerOf: ownerLookup(view),
    isStack: stackLookup(view),
    binding: targeting.filter((a) => !released(a.obligation, table)),
    releasedOnes: targeting.filter((a) => released(a.obligation, table)),
  };
}

function forbiddenBy(
  obligations: readonly ActiveObligation[],
  option: ObjectId,
  ctx: TargetContext,
): ActiveObligation[] {
  return obligations.filter((a) => forbidsOption(a.obligation, option, ctx.ownerOf, ctx.isStack));
}

/**
 * Targets for a non-combat action that honor this seat's `noTarget`/`noCounter` obligations. The
 * plain bot's choice (the first option) stands when it complies; otherwise the first complying
 * option, or the first option when none complies. Choosing a seat whose protection was released
 * is announced as self-defense.
 */
export function complyingTargets(
  action: LegalAction,
  view: PlayerView,
  dip: DiplomacyPlay,
): TargetChoice[] {
  const ctx = targetContext(view, dip);
  return (action.targets ?? []).map((slot) => {
    const ok = slot.options.find((o) => forbiddenBy(ctx.binding, o, ctx).length === 0);
    const choice = (ok ?? slot.options[0]) as string;
    for (const a of forbiddenBy(ctx.releasedOnes, choice, ctx)) {
      dip.reportBreach?.(a.dealId, 'selfDefense');
    }
    return { slot: slot.slot, choice };
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
  if (dip.obligations().length === 0) return 0;
  const ctx = targetContext(view, dip);
  if (ctx.binding.length === 0) return 0;
  const stuck = (action.targets ?? []).some(
    (slot) =>
      slot.options.length > 0 &&
      slot.options.every((o) => forbiddenBy(ctx.binding, o, ctx).length > 0),
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
  /** Powers sent at each defending player (planeswalkers are counted in `walkerValue`). */
  powersAt: Map<PlayerId, number[]>;
  walkerValue: number;
  value: number;
}

/** Creatures that can block right now: the defender's untapped creatures. */
function blockersNow(view: PlayerView): (seat: PlayerId) => number {
  const counts = new Map<PlayerId, number>();
  for (const p of view.battlefield) {
    const creature =
      p.typeLine?.includes('Creature') ?? (p.power !== undefined && p.power !== null);
    if (creature && !p.tapped) counts.set(p.controller, (counts.get(p.controller) ?? 0) + 1);
  }
  return (seat) => counts.get(seat) ?? 0;
}

const sortedDesc = (powers: readonly number[]) => [...powers].sort((a, b) => b - a);

function seatValue(
  table: TableEstimate,
  seat: PlayerId,
  powers: readonly number[],
  blockers: number,
): number {
  return damageValue(table, seat, unblockedPower(sortedDesc(powers), blockers));
}

/**
 * Threat-aware attack plan (decision 16), in three passes:
 *
 * 1. `attackPlayer` promises first, with as little power as meets the requirement, so keeping a
 *    promise never takes a creature out of a kill planned after it.
 * 2. Kills: while some player can be killed by the free attackers that may reach them, after they
 *    block the biggest of those one each, commit attackers largest first to the kill worth most.
 *    One attacker at a time cannot see that two together are lethal.
 * 3. Every other attacker, largest first, to the allowed defender with the best marginal value. A
 *    planeswalker counts as its controller at `planeswalkerFactor`.
 */
function buildPlan(
  table: TableEstimate,
  action: LegalAction,
  slots: readonly AttackSlot[],
  ownerOf: OwnerOf,
  blockers: (seat: PlayerId) => number,
  allowed: (option: ObjectId) => boolean,
  promisedTargets: readonly PlayerId[],
): AttackPlan {
  const pf = WEIGHTS.deals.planeswalkerFactor;
  const choices = new Map<number, ObjectId>();
  const powersAt = new Map<PlayerId, number[]>();
  let walkerValue = 0;
  const send = (s: AttackSlot, option: ObjectId) => {
    choices.set(s.slot, option);
    const seat = ownerOf(option);
    if (seat === undefined) return;
    if (seat === option) powersAt.set(seat, [...(powersAt.get(seat) ?? []), s.power]);
    else walkerValue += pf * damageValue(table, seat, s.power);
  };
  const free = () => slots.filter((s) => !choices.has(s.slot));

  for (const target of promisedTargets) {
    const required = requiredAttackPower(
      action,
      slots.map((s) => s.power),
      target,
      ownerOf,
    );
    const candidates = free()
      .filter((s) => s.options.some((o) => ownerOf(o) === target))
      .sort((a, b) => a.power - b.power || a.slot - b.slot);
    // The smallest single attacker that meets the requirement; failing that, the biggest ones
    // until it is met. Either way as little as possible leaves the kill and greedy passes.
    const single = candidates.find((s) => s.power >= required);
    const use = single !== undefined ? [single] : [...candidates].reverse();
    let sent = 0;
    for (const s of use) {
      if (sent >= required) break;
      send(s, s.options.find((o) => o === target) ?? s.options.find((o) => ownerOf(o) === target)!);
      sent += s.power;
    }
  }

  for (;;) {
    let kill: { seat: PlayerId; value: number; use: AttackSlot[] } | null = null;
    for (const t of table.seats) {
      if (t.seat === table.viewer) continue;
      const already = powersAt.get(t.seat) ?? [];
      if (unblockedPower(sortedDesc(already), blockers(t.seat)) >= t.life) continue;
      const reach = free()
        .filter((s) => s.options.includes(t.seat) && allowed(t.seat) && s.power > 0)
        .sort((a, b) => b.power - a.power || a.slot - b.slot);
      const use: AttackSlot[] = [];
      let enough = false;
      for (const s of reach) {
        use.push(s);
        const powers = [...already, ...use.map((u) => u.power)];
        if (unblockedPower(sortedDesc(powers), blockers(t.seat)) >= t.life) {
          enough = true;
          break;
        }
      }
      if (!enough) continue;
      const value = damageValue(table, t.seat, t.life);
      if (kill === null || value > kill.value) kill = { seat: t.seat, value, use };
    }
    if (kill === null) break;
    for (const s of kill.use) send(s, kill.seat);
  }

  const order = free().sort((a, b) => b.power - a.power || a.slot - b.slot);
  for (const s of order) {
    const real = s.options.filter((o) => o !== NO_ATTACK_TARGET);
    const legal = real.filter(allowed);
    if (legal.length === 0) {
      // Declining keeps every deal. A creature that must attack and has only forbidden defenders
      // attacks anyway, which compliance excuses.
      if (s.options.includes(NO_ATTACK_TARGET)) choices.set(s.slot, NO_ATTACK_TARGET);
      else if (real[0] !== undefined) send(s, real[0]);
      continue;
    }
    let best = legal[0]!;
    let bestGain = -Infinity;
    for (const option of legal) {
      const seat = ownerOf(option);
      if (seat === undefined) continue;
      let gain: number;
      if (seat === option) {
        const already = powersAt.get(seat) ?? [];
        gain =
          seatValue(table, seat, [...already, s.power], blockers(seat)) -
          seatValue(table, seat, already, blockers(seat));
      } else {
        gain = pf * damageValue(table, seat, s.power);
      }
      if (gain > bestGain) {
        bestGain = gain;
        best = option;
      }
    }
    send(s, best);
  }

  let value = walkerValue;
  for (const [seat, powers] of powersAt) value += seatValue(table, seat, powers, blockers(seat));
  return { choices, powersAt, walkerValue, value };
}

export interface AttackDecision {
  targets: TargetChoice[];
  /** Set when the chosen plan deliberately breaks a deal. */
  breach?: { dealId: string; reason: BreachReason };
}

/**
 * Attack targets under diplomacy (decisions 16 and 17). Builds the best plan that keeps every
 * deal and, for each deal this seat owes something on offense, the best plan that ignores only
 * that deal; it breaks the deal when the gain over keeping exceeds the reputation cost, and says
 * "lethal" when the broken plan eliminates someone the kept plan does not.
 */
export function planAttackDeclaration(
  action: LegalAction,
  view: PlayerView,
  dip: DiplomacyPlay,
): AttackDecision {
  const table = estimateTable(view);
  const ownerOf = ownerLookup(view);
  const isStack = stackLookup(view);
  const blockers = blockersNow(view);
  const powers = attackSlotPowers(action, view);
  const slots: AttackSlot[] = (action.targets ?? []).map((slot, i) => ({
    slot: slot.slot,
    power: powers[i] ?? 0,
    options: slot.options,
  }));
  const offense = dip
    .obligations()
    .filter((a) => a.obligation.kind === 'noAttack' || a.obligation.kind === 'attackPlayer');

  const build = (ignoreDeal: string | null) => {
    const live = offense.filter((a) => a.dealId !== ignoreDeal);
    const allowed = (option: ObjectId) =>
      !live.some((a) => forbidsOption(a.obligation, option, ownerOf, isStack));
    const promised = live.flatMap((a) =>
      a.obligation.kind === 'attackPlayer' ? [a.obligation.target] : [],
    );
    return buildPlan(table, action, slots, ownerOf, blockers, allowed, promised);
  };

  const kills = (plan: AttackPlan) =>
    new Set(
      [...plan.powersAt]
        .filter(([seat, p]) => {
          const life = table.bySeat.get(seat)?.life ?? Infinity;
          return unblockedPower(sortedDesc(p), blockers(seat)) >= life;
        })
        .map(([seat]) => seat),
    );

  const breaks = (plan: AttackPlan, dealId: string) =>
    offense
      .filter((a) => a.dealId === dealId)
      .some((a) => {
        const o = a.obligation;
        if (o.kind === 'noAttack') {
          return [...plan.choices.values()].some((c) => ownerOf(c) === o.against);
        }
        if (o.kind !== 'attackPlayer') return false;
        const required = requiredAttackPower(action, powers, o.target, ownerOf);
        let sent = 0;
        slots.forEach((s) => {
          const c = plan.choices.get(s.slot);
          if (c !== undefined && ownerOf(c) === o.target) sent += s.power;
        });
        return required > 0 && sent < required;
      });

  const keep = build(null);
  let chosen = keep;
  let breach: AttackDecision['breach'];
  let bestNet = 0;
  const cost = breachCost(dip, view);
  const keptKills = kills(keep);
  for (const dealId of new Set(offense.map((a) => a.dealId))) {
    const plan = build(dealId);
    const net = plan.value - keep.value - cost;
    if (net <= bestNet || !breaks(plan, dealId)) continue;
    bestNet = net;
    chosen = plan;
    const lethal = [...kills(plan)].some((seat) => !keptKills.has(seat));
    breach = { dealId, reason: lethal ? 'lethal' : 'worthIt' };
  }

  const targets = slots.map((s) => ({
    slot: s.slot,
    choice: chosen.choices.get(s.slot) ?? (s.options[0] as string),
  }));
  return breach === undefined ? { targets } : { targets, breach };
}
