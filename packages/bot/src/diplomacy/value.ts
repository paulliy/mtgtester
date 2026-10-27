import type { Deal, DealObligation, PlayerId } from '@mtg/shared';
import { Rng } from '../rng';
import { WEIGHTS } from '../weights';
import { attackPreference, couldKill, inDanger, lifeLoss, type TableEstimate } from './estimate';
import type { TrustLedger } from './trust';

const D = WEIGHTS.deals;

export interface DealContext {
  table: TableEstimate;
  trust: TrustLedger;
  /** Deals already in force, for the portfolio check (decision 15). */
  activeDeals: readonly Deal[];
  turn: number;
  /** Game seed; with the deal id it seeds the threshold noise. */
  seed: string;
}

export type DealVeto =
  'malformed' | 'tooLong' | 'leaderCounterparty' | 'protectsLeader' | 'noTargetsLeft';

export interface DealValuation {
  /** V from decision 11, after trust, temptation and delivery order. */
  value: number;
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

/** Sum of `roundDiscount^r` for r in [0, rounds): what a continuous obligation is worth. */
function roundWeight(rounds: number): number {
  let sum = 0;
  for (let r = 0; r < rounds; r++) sum += D.roundDiscount ** r;
  return sum;
}

/**
 * Position change for every seat over one round of one obligation (decision 10). Positive is a
 * gain. Obligations move pressure rather than remove it: a seat that may not attack one player
 * attacks the others more.
 */
export function obligationRoundDelta(
  table: TableEstimate,
  o: DealObligation,
): Map<PlayerId, number> {
  const delta = new Map<PlayerId, number>();
  const by = table.bySeat.get(o.by);
  if (by === undefined) return delta;
  const before = attackPreference(table, o.by);

  if (o.kind === 'noTarget' || o.kind === 'noCounter') {
    const k = o.kind === 'noTarget' ? D.targetInteractionValue : D.counterInteractionValue;
    const after = attackPreference(table, o.by, new Set([o.against]));
    for (const s of table.seats) {
      if (s.seat === o.by) continue;
      delta.set(s.seat, k * ((before.get(s.seat) ?? 0) - (after.get(s.seat) ?? 0)));
    }
    return delta;
  }

  const power = by.attackPower;
  let after: Map<PlayerId, number>;
  if (o.kind === 'noAttack') {
    after = attackPreference(table, o.by, new Set([o.against]));
  } else {
    after = new Map([[o.target, 1]]);
  }
  for (const s of table.seats) {
    if (s.seat === o.by) continue;
    const lossBefore = lifeLoss(s.life, power * (before.get(s.seat) ?? 0));
    const lossAfter = lifeLoss(s.life, power * (after.get(s.seat) ?? 0));
    delta.set(s.seat, lossBefore - lossAfter);
  }
  return delta;
}

/** Each obligation's position change over the whole deal, rounds discounted. */
export function dealDeltas(
  table: TableEstimate,
  deal: Deal,
): { obligation: DealObligation; delta: Map<PlayerId, number> }[] {
  const rounds = Math.max(1, deal.rounds);
  return deal.obligations.map((obligation) => {
    const weight = isContinuous(obligation) ? roundWeight(rounds) : 1;
    const round = obligationRoundDelta(table, obligation);
    return {
      obligation,
      delta: new Map([...round].map(([seat, v]) => [seat, v * weight])),
    };
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
  const other = counterpartyOf(deal, me);
  const vetoes: DealVeto[] = [];
  const parties = new Set(deal.parties);
  if (
    deal.parties[0] === deal.parties[1] ||
    !parties.has(me) ||
    deal.obligations.length === 0 ||
    deal.obligations.some((o) => !parties.has(o.by) || o.by === obligationSubject(o))
  ) {
    vetoes.push('malformed');
  }
  if (deal.rounds > D.maxRounds) vetoes.push('tooLong');

  const danger = inDanger(table, me);
  const leader = table.leader;
  if (!danger && leader === other) vetoes.push('leaderCounterparty');
  if (
    !danger &&
    leader !== null &&
    leader !== me &&
    deal.obligations.some((o) => o.by === me && o.kind === 'noAttack' && o.against === leader)
  ) {
    vetoes.push('protectsLeader');
  }

  const protectedFromMe = new Set<PlayerId>();
  for (const d of [...ctx.activeDeals, deal]) {
    for (const o of d.obligations) {
      if (o.by === me && o.kind === 'noAttack') protectedFromMe.add(o.against);
    }
  }
  const opponents = table.seats.filter((s) => s.seat !== me);
  if (opponents.length > 0 && opponents.every((s) => protectedFromMe.has(s.seat))) {
    vetoes.push('noTargetsLeft');
  }
  return vetoes;
}

/**
 * What `deal` is worth to `me` (decisions 11-14). Also used to predict whether a counterparty
 * would accept, by valuing the same deal from its seat on the same public estimate.
 */
export function valueDeal(deal: Deal, me: PlayerId, ctx: DealContext): DealValuation {
  const { table } = ctx;
  const other = counterpartyOf(deal, me);
  const parts = dealDeltas(table, deal);

  let stake = 0;
  for (const { delta } of parts) {
    for (const v of delta.values()) stake += Math.abs(v);
  }
  stake /= 2;

  const pKeep = ctx.trust.pKeep(other, stake);
  const theirs = deal.obligations.filter((o) => o.by === other);
  // Decision 14: when both sides owe only continuous terms, either can stop once the other
  // breaks, so our own continuing costs are at risk exactly as much as their promise is.
  const bothContinuous = theirs.length > 0 && deal.obligations.every(isContinuous);

  let value = 0;
  for (const { obligation, delta } of parts) {
    let multiplier = 1;
    if (obligation.by === other) {
      multiplier = pKeep;
      // Decision 13: a promise not to attack us is worthless when they could kill us instead.
      if (
        obligation.kind === 'noAttack' &&
        obligation.against === me &&
        couldKill(table, other, me)
      ) {
        multiplier = 0;
      }
    } else if (bothContinuous) {
      multiplier = pKeep;
    }
    value += multiplier * weightedValue(table, me, delta);
  }

  return { value, stake, pKeep, vetoes: vetoesFor(deal, me, ctx) };
}

/** The game round a turn falls in, counting living seats. */
export function roundOf(turn: number, livingSeats: number): number {
  return Math.ceil(turn / Math.max(1, livingSeats));
}

/** Seeded noise in `[-thresholdNoise, +thresholdNoise]` for one seat's view of one deal. */
export function thresholdNoise(seed: string, dealId: string, me: PlayerId): number {
  const u = new Rng(`${seed}|${dealId}|${me}`).nextInt(1_000_001) / 1_000_000;
  return (2 * u - 1) * D.thresholdNoise;
}

/**
 * The bar a deal's value must clear for `me` (decision 15). `noise` is false when predicting a
 * counterparty, whose noise a seat cannot know.
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
  const early = roundOf(ctx.turn, ctx.table.seats.length) <= D.investmentRounds;
  if (early && ctx.table.leader !== other) bar -= D.investmentAllowance;
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
