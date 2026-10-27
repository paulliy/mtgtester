import type {
  Deal,
  DealObligation,
  DecisionRequest,
  DecisionResponse,
  ObjectId,
  PlayerId,
  PlayerView,
  TableMessage,
  ThreatReason,
} from '@mtg/shared';
import { judgeDecision, ownerLookup, stackLookup, type OwnerOf } from './compliance';
import { estimateTable, type TableEstimate } from './estimate';
import type { ActiveObligation, BreachReason, DiplomacyPlay } from './play';
import { bestDealWith, chooseProposal } from './propose';
import { TrustLedger } from './trust';
import { answerDeal, valueDeal, type DealContext } from './value';
import { WEIGHTS } from '../weights';

export interface DiplomacyTableOptions {
  /** Game seed; seeds every threshold's noise, so a fixed-seed game negotiates the same way. */
  seed: string;
  /** Every seat in the game, in turn order. */
  seats: readonly PlayerId[];
  /** The current `PlayerView` for a seat. Only public fields of it are used. */
  viewOf: (seat: PlayerId) => PlayerView;
  /**
   * Whether a seat negotiates through this table. Seats that do not (a human, until ADR 0031's
   * phase 3) are never offered deals, but their decisions are still observed.
   */
  negotiates: (seat: PlayerId) => boolean;
}

export interface DiplomacyStats {
  proposals: number;
  accepted: number;
  counters: number;
  kept: number;
  broken: number;
  voided: number;
}

interface DealRecord {
  deal: Deal;
  /** Stake at acceptance, credited to both parties' trust when the deal is kept. */
  stake: number;
  /** One-shot obligations already met, by index in `deal.obligations`. */
  met: Set<number>;
  /** The leader when the deal started; the escape clause fires only on a party BECOMING leader. */
  leaderAtStart: PlayerId | null;
}

/** An attack declaration held back from judgment until the engine has accepted it. */
interface HeldAttack {
  request: DecisionRequest;
  response: DecisionResponse;
  ownerOf: OwnerOf;
  isStack: (id: ObjectId) => boolean;
}

interface Decline {
  proposer: PlayerId;
  to: PlayerId;
  terms: string;
  round: number;
}

/** Canonical form of a deal's terms, ignoring length and ids, for the re-proposal cooldown. */
function termsKey(deal: Deal): string {
  return deal.obligations
    .map((o) =>
      o.kind === 'attackPlayer'
        ? `${o.kind}:${o.by}>${o.target}`
        : `${o.kind}:${o.by}>${o.against}`,
    )
    .sort()
    .join('|');
}

/** Short public reasons a seat leads, for a threat call. */
function threatReasons(table: TableEstimate, leader: PlayerId): ThreatReason[] {
  const s = table.bySeat.get(leader);
  if (s === undefined) return [];
  const others = table.seats.filter((o) => o.seat !== leader);
  const reasons: ThreatReason[] = [];
  if (others.every((o) => s.life >= o.life)) {
    reasons.push({ kind: 'life', detail: `${s.life} life` });
  }
  if (others.every((o) => s.boardValue >= o.boardValue)) {
    reasons.push({
      kind: 'board',
      detail: s.attackPower > 0 ? `the biggest board, ${s.attackPower} power` : 'the biggest board',
    });
  }
  if (others.every((o) => s.handSize >= o.handSize) && s.handSize > 0) {
    reasons.push({ kind: 'cards', detail: `${s.handSize} cards in hand` });
  }
  return reasons;
}

/**
 * One game's deals, trust and table talk (ADR 0031 decision 20). Pure logic: the driver calls
 * `beforeDecision` and `afterDecision` around every surfaced decision and gives each bot seat
 * `playFor(seat)`. Everything is synchronous and seeded, so it adds no latency and keeps fixed-seed
 * games reproducible.
 */
export class DiplomacyTable {
  private readonly opts: DiplomacyTableOptions;
  private readonly trust = new TrustLedger();
  private readonly records: DealRecord[] = [];
  private readonly declines: Decline[] = [];
  private readonly log: TableMessage[] = [];
  private readonly pendingBreach = new Map<string, BreachReason>();
  private heldAttack: HeldAttack | null = null;
  private drained = 0;
  private nextDealId = 1;
  private turnSeen = -1;
  private announcedLeader: PlayerId | null = null;
  readonly stats: DiplomacyStats = {
    proposals: 0,
    accepted: 0,
    counters: 0,
    kept: 0,
    broken: 0,
    voided: 0,
  };

  constructor(opts: DiplomacyTableOptions) {
    this.opts = opts;
  }

  /** Every message so far. */
  messages(): readonly TableMessage[] {
    return this.log;
  }

  /** Messages since the last call. */
  drain(): TableMessage[] {
    const fresh = this.log.slice(this.drained);
    this.drained = this.log.length;
    return fresh;
  }

  /** Deals currently in force. */
  activeDeals(): Deal[] {
    return this.records.filter((r) => r.deal.status === 'active').map((r) => r.deal);
  }

  /** The `DiplomacyPlay` a bot seat's provider is given. */
  playFor(seat: PlayerId): DiplomacyPlay {
    return {
      obligations: () => this.obligationsOf(seat),
      startingOpponents: Math.max(0, this.opts.seats.length - 1),
      reportBreach: (dealId, reason) => this.pendingBreach.set(dealId, reason),
    };
  }

  private obligationsOf(seat: PlayerId): ActiveObligation[] {
    const out: ActiveObligation[] = [];
    for (const r of this.records) {
      if (r.deal.status !== 'active') continue;
      r.deal.obligations.forEach((obligation, i) => {
        if (obligation.by === seat && !r.met.has(i)) out.push({ dealId: r.deal.id, obligation });
      });
    }
    return out;
  }

  private contextFor(seat: PlayerId, turn: number): DealContext {
    return {
      table: estimateTable(this.opts.viewOf(seat)),
      trust: this.trust,
      activeDeals: this.activeDeals(),
      turn,
      seed: this.opts.seed,
    };
  }

  /** Call before a seat answers any surfaced decision. Opens the turn's negotiation window. */
  beforeDecision(request: DecisionRequest): void {
    if (this.heldAttack !== null && !this.isRetryOfHeld(request)) this.flush();
    if (request.turn < 1 || request.turn === this.turnSeen) return;
    this.turnSeen = request.turn;
    this.openWindow(request.turn, request.activePlayer);
  }

  /**
   * Call with the decision a seat submitted, before the engine applies it. An attack declaration
   * is held until the next decision shows the engine accepted it: a rejected one is asked again
   * (and after two rejections repaired by the engine), and only what actually happened counts.
   */
  afterDecision(request: DecisionRequest, response: DecisionResponse): void {
    const view = this.opts.viewOf(request.decidingPlayer);
    const ownerOf = ownerLookup(view);
    const isStack = stackLookup(view);
    if (request.decisionType === 'declareAttackers') {
      this.heldAttack = { request, response, ownerOf, isStack };
      return;
    }
    this.judge(request, response, ownerOf, isStack);
  }

  /** Judge a held attack declaration now. Drivers call this once the game is over. */
  flush(): void {
    const held = this.heldAttack;
    if (held === null) return;
    this.heldAttack = null;
    this.judge(held.request, held.response, held.ownerOf, held.isStack);
  }

  private isRetryOfHeld(request: DecisionRequest): boolean {
    const held = this.heldAttack;
    if (held === null || request.decisionType !== 'declareAttackers') return false;
    if (request.decidingPlayer !== held.request.decidingPlayer) return false;
    const presentation = request.presentation;
    // A retry carries the engine's rejection. Without a presentation to read, a second
    // declaration by the same seat in the same turn is taken as one.
    if (presentation === undefined) return request.turn === held.request.turn;
    return presentation.attackDeclaration?.rejection !== undefined;
  }

  private judge(
    request: DecisionRequest,
    response: DecisionResponse,
    ownerOf: OwnerOf,
    isStack: (id: ObjectId) => boolean,
  ): void {
    for (const record of this.records) {
      if (record.deal.status !== 'active') continue;
      for (let i = 0; i < record.deal.obligations.length; i++) {
        if (record.met.has(i)) continue;
        const obligation = record.deal.obligations[i]!;
        const verdict = judgeDecision(obligation, request, response, ownerOf, isStack);
        if (verdict === 'kept' && obligation.kind === 'attackPlayer') record.met.add(i);
        if (verdict === 'violated') {
          this.breach(record, obligation, request.turn);
          break;
        }
      }
    }
  }

  private breach(record: DealRecord, obligation: DealObligation, turn: number): void {
    record.deal.status = 'broken';
    record.deal.breachedBy = obligation.by;
    this.trust.recordBroken(obligation.by);
    this.stats.broken++;
    const reason = this.pendingBreach.get(record.deal.id);
    this.pendingBreach.delete(record.deal.id);
    this.log.push({
      kind: 'breach',
      turn,
      from: obligation.by,
      dealId: record.deal.id,
      obligation,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  private openWindow(turn: number, activePlayer: PlayerId): void {
    const view = this.opts.viewOf(activePlayer);
    const living = new Set([view.seat, ...view.opponents.map((o) => o.seat)]);
    const table = estimateTable(view);

    for (const record of this.records) {
      const deal = record.deal;
      if (deal.status !== 'active') continue;
      if (!deal.parties.every((p) => living.has(p))) {
        // A party left the game: nothing more is owed, and nobody broke anything.
        this.end(record, 'void', turn);
      } else if (
        table.leader !== null &&
        table.leader !== record.leaderAtStart &&
        deal.parties.includes(table.leader)
      ) {
        this.end(record, 'void', turn);
      } else if (deal.untilTurn !== undefined && turn > deal.untilTurn) {
        this.end(record, 'kept', turn);
      }
    }

    this.callThreat(table, turn, activePlayer);

    if (this.opts.negotiates(activePlayer)) this.negotiate(activePlayer, turn);
  }

  private end(record: DealRecord, outcome: 'kept' | 'void', turn: number): void {
    record.deal.status = outcome;
    if (outcome === 'kept') {
      for (const party of record.deal.parties) this.trust.recordKept(party, record.stake);
      this.stats.kept++;
    } else {
      this.stats.voided++;
    }
    this.log.push({ kind: 'dealEnded', turn, dealId: record.deal.id, outcome });
  }

  /** Name a new leader once, from the first negotiating seat in turn order that is not it. */
  private callThreat(table: TableEstimate, turn: number, activePlayer: PlayerId): void {
    const leader = table.leader;
    if (leader === this.announcedLeader) return;
    this.announcedLeader = leader;
    if (leader === null) return;
    const order = table.seats.map((s) => s.seat);
    const start = Math.max(0, order.indexOf(activePlayer));
    const rotated = [...order.slice(start), ...order.slice(0, start)];
    const caller = rotated.find((s) => s !== leader && this.opts.negotiates(s));
    if (caller === undefined) return;
    this.log.push({
      kind: 'threatCall',
      turn,
      from: caller,
      leader,
      reasons: threatReasons(table, leader),
    });
  }

  private hasActiveDeal(a: PlayerId, b: PlayerId): boolean {
    return this.activeDeals().some((d) => d.parties.includes(a) && d.parties.includes(b));
  }

  private recentlyDeclined(
    proposer: PlayerId,
    to: PlayerId,
    terms: string,
    round: number,
  ): boolean {
    return this.declines.some(
      (d) =>
        d.proposer === proposer &&
        d.to === to &&
        d.terms === terms &&
        round - d.round < WEIGHTS.deals.reproposeCooldownRounds,
    );
  }

  /** The active player's one proposal for the turn, answered at once (decisions 15 and 18). */
  private negotiate(proposer: PlayerId, turn: number): void {
    const ctx = this.contextFor(proposer, turn);
    const round = Math.ceil(turn / Math.max(1, ctx.table.seats.length));
    const chosen = chooseProposal(
      proposer,
      ctx,
      (other) => this.opts.negotiates(other) && !this.hasActiveDeal(proposer, other),
      `t${turn}-${proposer}`,
    );
    if (chosen === null) return;
    const terms = termsKey(chosen.deal);
    const to = chosen.deal.parties[1];
    if (this.recentlyDeclined(proposer, to, terms, round)) return;

    const deal: Deal = { ...chosen.deal, id: `deal-${this.nextDealId++}` };
    this.stats.proposals++;
    this.log.push({ kind: 'proposal', turn, from: proposer, to, deal });

    const theirCtx = this.contextFor(to, turn);
    const answer = answerDeal(deal, to, theirCtx);
    if (answer.accept) {
      this.log.push({
        kind: 'response',
        turn,
        from: to,
        to: proposer,
        dealId: deal.id,
        answer: 'accept',
      });
      this.activate(deal, answer.valuation.stake, turn, theirCtx.table);
      return;
    }

    deal.status = 'declined';
    this.declines.push({ proposer, to, terms, round });
    const counter = bestDealWith(to, proposer, theirCtx, `t${turn}-${to}-counter`);
    if (counter === null || termsKey(counter.deal) === terms) {
      this.log.push({
        kind: 'response',
        turn,
        from: to,
        to: proposer,
        dealId: deal.id,
        answer: 'decline',
      });
      return;
    }
    const counterDeal: Deal = { ...counter.deal, id: `deal-${this.nextDealId++}` };
    this.stats.counters++;
    this.log.push({
      kind: 'response',
      turn,
      from: to,
      to: proposer,
      dealId: deal.id,
      answer: 'decline',
      counter: counterDeal,
    });
    const back = answerDeal(counterDeal, proposer, ctx);
    if (back.accept) {
      this.log.push({
        kind: 'response',
        turn,
        from: proposer,
        to,
        dealId: counterDeal.id,
        answer: 'accept',
      });
      this.activate(counterDeal, back.valuation.stake, turn, ctx.table);
    } else {
      counterDeal.status = 'declined';
      this.log.push({
        kind: 'response',
        turn,
        from: proposer,
        to,
        dealId: counterDeal.id,
        answer: 'decline',
      });
    }
  }

  private activate(deal: Deal, stake: number, turn: number, table: TableEstimate): void {
    deal.status = 'active';
    deal.untilTurn = turn + deal.rounds * table.seats.length - 1;
    this.records.push({ deal, stake, met: new Set(), leaderAtStart: table.leader });
    this.stats.accepted++;
  }

  /** A seat's value for a deal right now, for reports and tests. */
  valueFor(seat: PlayerId, deal: Deal, turn: number): number {
    return valueDeal(deal, seat, this.contextFor(seat, turn)).value;
  }
}
