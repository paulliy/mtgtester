import type { Deal, DealObligation, PlayerId } from '@mtg/shared';
import { WEIGHTS } from '../weights';
import { inDanger, pressureOn } from './estimate';
import { acceptBar, valueDeal, type DealContext } from './value';

const D = WEIGHTS.deals;

/**
 * The few deal shapes a bot offers `other` (ADR 0031 decision 18), each at every allowed length:
 * a mutual truce; a truce where `other` also attacks the leader; and `me` attacking the leader in
 * return for `other` leaving `me` alone.
 */
export function candidateDeals(
  me: PlayerId,
  other: PlayerId,
  ctx: DealContext,
  idPrefix: string,
): Deal[] {
  const leader = ctx.table.leader;
  const shapes: DealObligation[][] = [
    [
      { kind: 'noAttack', by: me, against: other },
      { kind: 'noAttack', by: other, against: me },
    ],
  ];
  if (leader !== null && leader !== me && leader !== other) {
    shapes.push([
      { kind: 'noAttack', by: me, against: other },
      { kind: 'noAttack', by: other, against: me },
      { kind: 'attackPlayer', by: other, target: leader },
    ]);
    shapes.push([
      { kind: 'attackPlayer', by: me, target: leader },
      { kind: 'noAttack', by: other, against: me },
    ]);
  }
  const deals: Deal[] = [];
  shapes.forEach((obligations, shape) => {
    for (let rounds = 1; rounds <= D.maxRounds; rounds++) {
      deals.push({
        id: `${idPrefix}-${shape}-${rounds}`,
        proposer: me,
        parties: [me, other],
        obligations,
        proposedTurn: ctx.turn,
        rounds,
        status: 'proposed',
      });
    }
  });
  return deals;
}

export interface ScoredCandidate {
  deal: Deal;
  /** Value to the proposing seat. */
  value: number;
  /** Predicted value to the counterparty, on the same public estimate. */
  theirValue: number;
}

/**
 * The candidate with the best value for `me` among those `other` should accept and `me` would
 * accept itself. This is also the counter-offer: the bot's terms come from its own best
 * candidate, never from splitting the difference with what it was offered.
 */
export function bestDealWith(
  me: PlayerId,
  other: PlayerId,
  ctx: DealContext,
  idPrefix: string,
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const deal of candidateDeals(me, other, ctx, idPrefix)) {
    const mine = valueDeal(deal, me, ctx);
    if (mine.vetoes.length > 0 || mine.value <= acceptBar(deal, me, ctx, { noise: false })) {
      continue;
    }
    const theirs = valueDeal(deal, other, ctx);
    if (theirs.vetoes.length > 0 || theirs.value <= acceptBar(deal, other, ctx, { noise: false })) {
      continue;
    }
    if (best === null || mine.value > best.value) {
      best = { deal, value: mine.value, theirValue: theirs.value };
    }
  }
  return best;
}

/**
 * Who `me` has a reason to make a deal with this turn (decision 18): a seat whose predicted attack
 * takes a real share of our life, or, when someone leads the table, any other seat that could be
 * pointed at the leader. In the order the view lists them, which is deterministic.
 */
export function proposalPartners(me: PlayerId, ctx: DealContext): PlayerId[] {
  const { table } = ctx;
  const self = table.bySeat.get(me);
  if (self === undefined) return [];
  const partners: PlayerId[] = [];
  for (const s of table.seats) {
    if (s.seat === me) continue;
    if (s.seat === table.leader && !inDanger(table, me)) continue;
    const pressured = pressureOn(table, s.seat, me) >= D.proposePressureShare * self.life;
    const redirectable = table.leader !== null && table.leader !== me;
    if (pressured || redirectable) partners.push(s.seat);
  }
  return partners;
}

/** The single proposal `me` makes this window, if any: its best candidate across partners. */
export function chooseProposal(
  me: PlayerId,
  ctx: DealContext,
  eligible: (other: PlayerId) => boolean,
  idPrefix: string,
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const other of proposalPartners(me, ctx)) {
    if (!eligible(other)) continue;
    const candidate = bestDealWith(me, other, ctx, `${idPrefix}-${other}`);
    if (candidate !== null && (best === null || candidate.value > best.value)) best = candidate;
  }
  return best;
}
