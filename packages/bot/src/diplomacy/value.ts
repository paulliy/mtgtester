import type { Deal, DealObligation, PlayerId } from '@mtg/shared';
import { Rng } from '../rng';
import { WEIGHTS } from '../weights';
import {
  attackPreference,
  couldKill,
  damageValue,
  inDanger,
  lifeLoss,
  type TableEstimate,
} from './estimate';
import type { TrustLedger } from './trust';

const D = WEIGHTS.deals;

export interface DealContext {
  table: TableEstimate;
  trust: TrustLedger;
  /** Deals already in force, for the portfolio checks (decision 15). */
  activeDeals: readonly Deal[];
  turn: number;
  /** Seats the game started with: rounds are counted against this, so deaths do not skew them. */
  startingSeats: number;
  /** Game seed; with the deal id it seeds the threshold noise. */
  seed: string;
}

export type DealVeto =
  /** Not a well-formed two-party deal: see `validateDeal`. */
  | 'malformed'
  | 'tooLong'
  /** More obligations on one side than `maxObligationsPerSide`: padding. */
  | 'padded'
  /** An obligation contradicts another in this deal or in one already in force. */
  | 'conflicting'
  /** We would promise not to target or counter without the same promise back, or for long. */
  | 'unmirroredInteraction'
  /** We would protect the table leader while not in danger ourselves. */
  | 'protectsLeader'
  /** The counterparty has broken too many deals. */
  | 'untrusted'
  | 'noTargetsLeft';

export interface DealValuation {
  /** V from decision 11, after trust and temptation. */
  value: number;
  /** What each party's own promises cost it (LEP, ≥ 0): the most trust keeping them can earn. */
  ownCost: Map<PlayerId, number>;
  /** Size of the deal in LEP: half the total position it moves, before trust. */
  stake: number;
  /** Probability the counterparty keeps it, at this stake. */
  pKeep: number;
  vetoes: DealVeto[];
}

export function isContinuous(o: DealObligation): boolean {
  return o.kind !== 'attackPlayer';
}

/** The seat an obligation protects or points at. */
export function obligationSubject(o: DealObligation): PlayerId {
  return o.kind === 'attackPlayer' ? o.target : o.against;
}

export function counterpartyOf(deal: Deal, seat: PlayerId): PlayerId {
  return deal.parties[0] === seat ? deal.parties[1] : deal.parties[0];
}

/** Canonical key of one obligation: a deal may hold each at most once. */
export function obligationKey(o: DealObligation): string {
  return `${o.kind}:${o.by}>${obligationSubject(o)}`;
}

/**
 * Structural checks any deal must pass before it is valued, whoever proposes it (decision 15).
 * A deal from a human or a model is untrusted input: it is closed against duplicated or padded
 * obligations, impossible lengths, obligations owed by or about seats outside the game, and
 * contradictions.
 */
export function validateDeal(deal: Deal, livingSeats: ReadonlySet<PlayerId>): DealVeto[] {
  const vetoes = new Set<DealVeto>();
  const [a, b] = deal.parties;
  if (a === b || !livingSeats.has(a) || !livingSeats.has(b)) vetoes.add('malformed');
  if (!Number.isInteger(deal.rounds) || deal.rounds < 1) vetoes.add('malformed');
  else if (deal.rounds > D.maxRounds) vetoes.add('tooLong');
  if (deal.obligations.length === 0) vetoes.add('malformed');

  const keys = new Set<string>();
  const perSide = new Map<PlayerId, number>();
  for (const o of deal.obligations) {
    const subject = obligationSubject(o);
    if ((o.by !== a && o.by !== b) || subject === o.by || !livingSeats.has(subject)) {
      vetoes.add('malformed');
    }
    const key = obligationKey(o);
    if (keys.has(key)) vetoes.add('padded');
    keys.add(key);
    perSide.set(o.by, (perSide.get(o.by) ?? 0) + 1);
  }
  for (const count of perSide.values()) {
    if (count > D.maxObligationsPerSide) vetoes.add('padded');
  }
  if (conflicts(deal.obligations)) vetoes.add('conflicting');
  return [...vetoes];
}

/**
 * Obligations that cannot all be kept: attacking a seat one has promised to leave alone, or
 * being bound to attack two different seats.
 */
function conflicts(obligations: readonly DealObligation[]): boolean {
  const attackTargets = new Map<PlayerId, Set<PlayerId>>();
  const spared = new Map<PlayerId, Set<PlayerId>>();
  for (const o of obligations) {
    if (o.kind === 'attackPlayer') {
      const set = attackTargets.get(o.by) ?? new Set<PlayerId>();
      set.add(o.target);
      attackTargets.set(o.by, set);
    } else if (o.kind === 'noAttack') {
      const set = spared.get(o.by) ?? new Set<PlayerId>();
      set.add(o.against);
      spared.set(o.by, set);
    }
  }
  for (const [by, targets] of attackTargets) {
    if (targets.size > 1) return true;
    for (const t of targets) if (spared.get(by)?.has(t) === true) return true;
  }
  return false;
}

/** Sum of `roundDiscount^r` for r in [from, rounds). */
function roundWeight(from: number, rounds: number): number {
  let sum = 0;
  for (let r = from; r < rounds; r++) sum += D.roundDiscount ** r;
  return sum;
}

function addInto(into: Map<PlayerId, number>, from: Map<PlayerId, number>, scale = 1): void {
  for (const [seat, v] of from) into.set(seat, (into.get(seat) ?? 0) + v * scale);
}

/**
 * One round of everything `by` owes on offense, priced jointly (decision 10), on top of what `by`
 * already owes in deals in force (`baseline`), so chained deals cannot each pretend the seat still
 * attacks the others. Its attack goes where its preferences send it with the spared seats
 * removed, and, when it owes an attack on a target, `attackPlayerShare` of it goes there instead.
 * Each other seat gains the position it no longer loses. `by` pays the value of the best attack
 * it gives up: its best defender before against its best one still allowed, and the share it must
 * send at a worse target. That cost is never negative (a promise is never a payment) and is zero
 * when another target is just as good.
 */
function attackRound(
  table: TableEstimate,
  by: PlayerId,
  baseline: ReadonlySet<PlayerId>,
  spared: ReadonlySet<PlayerId>,
  target: PlayerId | null,
): Map<PlayerId, number> {
  const delta = new Map<PlayerId, number>();
  const seat = table.bySeat.get(by);
  if (seat === undefined || seat.attackPower <= 0) return delta;
  if (spared.size === 0 && target === null) return delta;
  const power = seat.attackPower;
  const allSpared = new Set([...baseline, ...spared]);
  const before = attackPreference(table, by, baseline);
  const after = new Map(attackPreference(table, by, allSpared));
  if (target !== null) {
    for (const [d, w] of after) after.set(d, w * (1 - D.attackPlayerShare));
    after.set(target, (after.get(target) ?? 0) + D.attackPlayerShare);
  }
  const best = (seats: Iterable<PlayerId>) =>
    Math.max(0, ...[...seats].map((d) => damageValue(table, d, power)));
  for (const s of table.seats) {
    if (s.seat === by) continue;
    const wb = before.get(s.seat) ?? 0;
    const wa = after.get(s.seat) ?? 0;
    delta.set(s.seat, lifeLoss(s.life, power * wb) - lifeLoss(s.life, power * wa));
  }
  const bestBefore = best(before.keys());
  const bestAllowed = best(attackPreference(table, by, allSpared).keys());
  let cost = Math.max(0, bestBefore - bestAllowed);
  if (target !== null) {
    cost += D.attackPlayerShare * Math.max(0, bestAllowed - damageValue(table, target, power));
  }
  delta.set(by, -cost);
  return delta;
}

/**
 * One round of `by`'s promises not to target (or counter) some seats. Worth only as much as `by`
 * can actually interact, measured by hand size; the protected seats gain it, the others take it
 * instead, and `by` gives up `interactionForegoneShare` of what it moved.
 */
function interactionRound(
  table: TableEstimate,
  by: PlayerId,
  protectedSeats: ReadonlySet<PlayerId>,
  flatValue: number,
): Map<PlayerId, number> {
  const delta = new Map<PlayerId, number>();
  const seat = table.bySeat.get(by);
  if (seat === undefined || protectedSeats.size === 0) return delta;
  const k = flatValue * Math.min(1, seat.handSize / D.fullInteractionHandSize);
  if (k <= 0) return delta;
  const before = attackPreference(table, by);
  const after = attackPreference(table, by, protectedSeats);
  let moved = 0;
  for (const s of table.seats) {
    if (s.seat === by) continue;
    const change = (before.get(s.seat) ?? 0) - (after.get(s.seat) ?? 0);
    delta.set(s.seat, k * change);
    if (change > 0) moved += change;
  }
  delta.set(by, -k * D.interactionForegoneShare * moved);
  return delta;
}

/** Everything one seat owes in a deal, priced over the deal's length, split by kind. */
export interface ObligorParts {
  by: PlayerId;
  attack: Map<PlayerId, number>;
  interaction: Map<PlayerId, number>;
}

/**
 * Position change for every seat, per obligor, over the whole deal (rounds discounted), on top of
 * the `noAttack` promises each obligor already owes in `inForce`.
 */
export function dealParts(
  table: TableEstimate,
  deal: Deal,
  inForce: readonly Deal[] = [],
): ObligorParts[] {
  const rounds = Math.max(1, Math.min(D.maxRounds, Math.floor(deal.rounds)));
  return deal.parties.map((by) => {
    const baseline = new Set(
      inForce
        .flatMap((d) => d.obligations)
        .filter((o) => o.by === by && o.kind === 'noAttack')
        .map(obligationSubject),
    );
    const owed = deal.obligations.filter((o) => o.by === by);
    const spared = new Set(owed.filter((o) => o.kind === 'noAttack').map(obligationSubject));
    const target = owed.find((o) => o.kind === 'attackPlayer');
    const noTarget = new Set(owed.filter((o) => o.kind === 'noTarget').map(obligationSubject));
    // `noTarget` already covers spells on the stack, so a matching `noCounter` adds nothing.
    const noCounter = new Set(
      owed.filter((o) => o.kind === 'noCounter' && !noTarget.has(o.against)).map(obligationSubject),
    );

    const attack = new Map<PlayerId, number>();
    const owedTarget = target ? obligationSubject(target) : null;
    addInto(attack, attackRound(table, by, baseline, spared, owedTarget));
    addInto(attack, attackRound(table, by, baseline, spared, null), roundWeight(1, rounds));

    const interaction = new Map<PlayerId, number>();
    const weight = roundWeight(0, rounds);
    addInto(interaction, interactionRound(table, by, noTarget, D.targetInteractionValue), weight);
    addInto(interaction, interactionRound(table, by, noCounter, D.counterInteractionValue), weight);
    return { by, attack, interaction };
  });
}

/** Decision 11's weighting: our gain counts once, each opponent's by its share of winning. */
function weightedValue(table: TableEstimate, me: PlayerId, delta: Map<PlayerId, number>): number {
  const n = table.seats.length;
  let value = delta.get(me) ?? 0;
  for (const s of table.seats) {
    if (s.seat === me) continue;
    value -= D.opponentGainWeight * s.winShare * n * (delta.get(s.seat) ?? 0);
  }
  return value;
}

function vetoesFor(deal: Deal, me: PlayerId, ctx: DealContext): DealVeto[] {
  const { table } = ctx;
  const living = new Set(table.seats.map((s) => s.seat));
  const vetoes = new Set<DealVeto>(validateDeal(deal, living));
  if (!deal.parties.includes(me)) vetoes.add('malformed');
  const other = counterpartyOf(deal, me);

  const mine = deal.obligations.filter((o) => o.by === me);
  const theirs = deal.obligations.filter((o) => o.by === other);
  for (const o of mine) {
    if (o.kind !== 'noTarget' && o.kind !== 'noCounter') continue;
    const mirrored = theirs.some((t) => t.kind === o.kind && t.against === me);
    if (!mirrored || deal.rounds > 1) vetoes.add('unmirroredInteraction');
  }

  const leader = table.leader;
  if (
    !inDanger(table, me) &&
    leader !== null &&
    leader !== me &&
    mine.some((o) => o.kind !== 'attackPlayer' && o.against === leader)
  ) {
    vetoes.add('protectsLeader');
  }

  if (ctx.trust.snapshot(other).broken >= D.maxBreachesTolerated) vetoes.add('untrusted');

  const inForce = [...ctx.activeDeals.flatMap((d) => d.obligations), ...deal.obligations];
  if (conflicts(inForce)) vetoes.add('conflicting');
  const spared = new Set(
    inForce.filter((o) => o.by === me && o.kind === 'noAttack').map(obligationSubject),
  );
  // Chained truces must not funnel all of a seat's pressure onto one unaligned player: with three
  // or more opponents, at least two stay open; with fewer, at least one.
  const opponents = table.seats.filter((s) => s.seat !== me);
  const open = opponents.filter((s) => !spared.has(s.seat)).length;
  if (opponents.length > 0 && open < (opponents.length >= 3 ? 2 : 1)) {
    vetoes.add('noTargetsLeft');
  }
  return [...vetoes];
}

/**
 * What `deal` is worth to `me` (decisions 11-14). Also used to predict whether a counterparty
 * would accept, by valuing the same deal from its seat on the same public estimate.
 *
 * Our own obligations count in full: we keep them until we see a breach, so their cost is real
 * whatever the counterparty does. The counterparty's count at `P(keep)`, and its promise not to
 * attack us counts for nothing while its attack could kill us.
 */
export function valueDeal(deal: Deal, me: PlayerId, ctx: DealContext): DealValuation {
  const { table } = ctx;
  const other = counterpartyOf(deal, me);
  const parts = dealParts(table, deal, ctx.activeDeals);

  let stake = 0;
  for (const part of parts) {
    for (const v of part.attack.values()) stake += Math.abs(v);
    for (const v of part.interaction.values()) stake += Math.abs(v);
  }
  stake /= 2;

  const pKeep = ctx.trust.pKeep(other, stake);
  const tempted =
    couldKill(table, other, me) &&
    deal.obligations.some((o) => o.by === other && o.kind === 'noAttack' && o.against === me);

  let value = 0;
  for (const part of parts) {
    const theirs = part.by === other;
    const attackKeep = theirs ? (tempted ? 0 : pKeep) : 1;
    const interactionKeep = theirs ? pKeep : 1;
    value += attackKeep * weightedValue(table, me, part.attack);
    value += interactionKeep * weightedValue(table, me, part.interaction);
  }

  const ownCost = new Map(
    parts.map((part) => [
      part.by,
      Math.max(0, -((part.attack.get(part.by) ?? 0) + (part.interaction.get(part.by) ?? 0))),
    ]),
  );
  return { value, ownCost, stake, pKeep, vetoes: vetoesFor(deal, me, ctx) };
}

/** The game round a turn falls in, counted against the seats the game started with. */
export function roundOf(turn: number, startingSeats: number): number {
  return Math.ceil(turn / Math.max(1, startingSeats));
}

/** Seeded noise in `[-thresholdNoise, +thresholdNoise]` for one seat's view of one deal. */
export function thresholdNoise(seed: string, dealId: string, me: PlayerId): number {
  const u = new Rng(`${seed}|${dealId}|${me}`).nextInt(1_000_001) / 1_000_000;
  return (2 * u - 1) * D.thresholdNoise;
}

/**
 * The bar a deal's value must clear for `me` (decision 15). `noise` is false when predicting a
 * counterparty, whose noise a seat cannot know. The early-game allowance, which accepts a slightly
 * bad deal to build trust, is only extended to a counterparty with a clean record that also
 * promises something in return.
 */
export function acceptBar(
  deal: Deal,
  me: PlayerId,
  ctx: DealContext,
  opts: { noise: boolean },
): number {
  const other = counterpartyOf(deal, me);
  let bar = D.acceptThreshold;
  if (opts.noise) bar += thresholdNoise(ctx.seed, deal.id, me);
  const early = roundOf(ctx.turn, ctx.startingSeats) <= D.investmentRounds;
  const clean = ctx.trust.snapshot(other).broken === 0;
  // Trust is built by both sides keeping something; a one-sided ask earns us nothing to invest in.
  const reciprocal = deal.obligations.some((o) => o.by === other);
  if (early && clean && reciprocal && ctx.table.leader !== other) bar -= D.investmentAllowance;
  return bar;
}

export interface DealAnswer {
  accept: boolean;
  valuation: DealValuation;
  bar: number;
}

/** Whether `me` accepts `deal`. Any veto refuses it outright. */
export function answerDeal(deal: Deal, me: PlayerId, ctx: DealContext): DealAnswer {
  const valuation = valueDeal(deal, me, ctx);
  const bar = acceptBar(deal, me, ctx, { noise: true });
  return { accept: valuation.vetoes.length === 0 && valuation.value > bar, valuation, bar };
}
