import type { Deal, DealObligation, PlayerId } from '@mtg/shared';
import { WEIGHTS } from '../weights';
import { inDanger, pressureOn } from './estimate';
import { acceptBar, valueDeal, type DealContext } from './value';

const D = WEIGHTS.deals;

/**
 * The few deal shapes a bot offers `other` (ADR 0035 decision 18), each at every allowed length:
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
 * Every candidate `other` should accept and `me` would accept itself, best for `me` first. The
 * first is also the counter-offer: the bot's terms come from its own best candidate, never from
 * splitting the difference with what it was offered.
 */
export function acceptableDeals(
  me: PlayerId,
  other: PlayerId,
  ctx: DealContext,
  idPrefix: string,
): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  for (const deal of candidateDeals(me, other, ctx, idPrefix)) {
    const mine = valueDeal(deal, me, ctx);
    if (mine.vetoes.length > 0 || mine.value <= acceptBar(deal, me, ctx, { noise: false })) {
      continue;
    }
    const theirs = valueDeal(deal, other, ctx);
    if (theirs.vetoes.length > 0 || theirs.value <= acceptBar(deal, other, ctx, { noise: false })) {
      continue;
    }
    out.push({ deal, value: mine.value, theirValue: theirs.value });
  }
  return out.sort((a, b) => b.value - a.value);
}

/** The best acceptable candidate with `other`, or null. */
export function bestDealWith(
  me: PlayerId,
  other: PlayerId,
  ctx: DealContext,
  idPrefix: string,
): ScoredCandidate | null {
  return acceptableDeals(me, other, ctx, idPrefix)[0] ?? null;
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

/**
 * Everything `me` could propose this window, best first, across every partner it has a reason
 * to deal with. The table proposes the first one not recently declined.
 */
export function rankedProposals(
  me: PlayerId,
  ctx: DealContext,
  eligible: (other: PlayerId) => boolean,
  idPrefix: string,
): ScoredCandidate[] {
  const all: ScoredCandidate[] = [];
  for (const other of proposalPartners(me, ctx)) {
    if (!eligible(other)) continue;
    all.push(...acceptableDeals(me, other, ctx, `${idPrefix}-${other}`));
  }
  return all.sort((a, b) => b.value - a.value);
}
