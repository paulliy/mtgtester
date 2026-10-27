import type {
  Deal,
  DealObligation,
  DecisionRequest,
  DecisionResponse,
  PlayerId,
  PlayerView,
  TableMessage,
  ThreatReason,
} from '@mtg/shared';
import { WEIGHTS } from '../weights';
import { judgeDecision, offeredBreach, ownerLookup, stackLookup } from './compliance';
import { couldKill, estimateTable, type TableEstimate } from './estimate';
import { released, type ActiveObligation, type BreachReason, type DiplomacyPlay } from './play';
import { bestDealWith, rankedProposals } from './propose';
import { TrustLedger, type TrustRecord } from './trust';
import {
  answerDeal,
  roundOf,
  validateDeal,
  valueDeal,
  type DealContext,
  type DealValuation,
} from './value';

const D = WEIGHTS.deals;

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
  /**
   * How many attack declarations the engine has repaired so far (its public
   * `attackDeclarationRepaired` events). A repaired declaration is the engine's choice, not the
   * seat's, so it is never judged. Without this, a held declaration is judged as submitted.
   */
  repairedAttacks?: () => number;
}

export interface DiplomacyStats {
  proposals: number;
  accepted: number;
  counters: number;
  kept: number;
  broken: number;
  voided: number;
}

/** The terms a proposer offers: the table supplies the id, the turn and the status. */
export interface OfferTerms {
  proposer: PlayerId;
  to: PlayerId;
  obligations: DealObligation[];
  rounds: number;
}

/** What became of an offer made through `offer`. */
export type OfferOutcome =
  | { kind: 'accepted'; deal: Deal }
  | { kind: 'declined'; counter?: Deal }
  /** Not considered: invalid, rate-limited, or the same terms declined too recently. */
  | { kind: 'refused'; reason: 'invalid' | 'rateLimited' | 'cooldown' | 'notNegotiating' };

interface DealRecord {
  deal: Deal;
  /**
   * Trust each party can earn by keeping the deal: what its own promises cost it, capped by the
   * deal's size, as priced at acceptance. Zero when keeping was free.
   */
  credit: Map<PlayerId, number>;
  /** One-shot obligations already met, by index in `deal.obligations`. */
  met: Set<number>;
  /** The leader when the deal started; the escape clause fires only on a party BECOMING leader. */
  leaderAtStart: PlayerId | null;
  /** Turns each party has started since the deal was accepted, the accepting turn included. */
  turnsTaken: Map<PlayerId, number>;
  /** Parties that were offered a way to break the deal and did not take it. */
  tested: Set<PlayerId>;
  /** Parties freed from their side because the other party became the leader. */
  freed: Set<PlayerId>;
  /** Parties owing an attack that started a turn inside the deal with attackers on board. */
  couldAttack: Set<PlayerId>;
}

interface PairEnd {
  round: number;
  /** Rounds the pair waits before another deal: longer after a breach. */
  cooldown: number;
}

interface Decline {
  proposer: PlayerId;
  to: PlayerId;
  terms: string;
  round: number;
}

/** An attack declaration held back from judgment until the engine has accepted it. */
interface HeldAttack {
  request: DecisionRequest;
  response: DecisionResponse;
  /** The deciding seat's view when it decided: owners and the table are read from it. */
  view: PlayerView;
  repairedBefore: number;
}

/** Version of `DiplomacyState`; bumped on any change to its shape. */
export const DIPLOMACY_STATE_VERSION = 1;

/**
 * Everything a `DiplomacyTable` knows, as plain JSON (ADR 0031 decision 22). A table rebuilt from
 * it with `DiplomacyTable.fromState` and the same options continues exactly as the original would
 * have, so a game can be saved and resumed in the middle of a negotiation.
 */
export interface DiplomacyState {
  version: typeof DIPLOMACY_STATE_VERSION;
  trust: Record<PlayerId, TrustRecord>;
  records: Array<{
    deal: Deal;
    credit: Array<[PlayerId, number]>;
    met: number[];
    leaderAtStart: PlayerId | null;
    turnsTaken: Array<[PlayerId, number]>;
    tested: PlayerId[];
    freed: PlayerId[];
    couldAttack: PlayerId[];
  }>;
  declines: Decline[];
  lastEnded: Array<[string, PairEnd]>;
  proposedThisTurn: PlayerId[];
  log: TableMessage[];
  pendingBreach: Array<[string, BreachReason]>;
  heldAttack: HeldAttack | null;
  drained: number;
  nextDealId: number;
  turnSeen: number;
  activeNow: PlayerId | null;
  announcedLeader: PlayerId | null;
  stats: DiplomacyStats;
}

/** Canonical form of a deal's terms and length, for the re-proposal cooldown. */
function termsKey(deal: Pick<Deal, 'obligations' | 'rounds'>): string {
  const terms = deal.obligations
    .map((o) =>
      o.kind === 'attackPlayer'
        ? `${o.kind}:${o.by}>${o.target}`
        : `${o.kind}:${o.by}>${o.against}`,
    )
    .sort()
    .join('|');
  return `${terms}#${deal.rounds}`;
}

const pairKey = (a: PlayerId, b: PlayerId) => [a, b].sort().join('+');

/** A deep copy for the message log, so later status changes never rewrite what was said. */
const snapshot = (deal: Deal): Deal => structuredClone(deal);

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
 * `beforeDecision` and `afterDecision` around every surfaced decision, `flush` when the game
 * ends, and gives each bot seat `playFor(seat)`. Everything is synchronous and seeded, so it adds
 * no latency and keeps fixed-seed games reproducible.
 */
export class DiplomacyTable {
  private readonly opts: DiplomacyTableOptions;
  private trust = new TrustLedger();
  private readonly records: DealRecord[] = [];
  private readonly declines: Decline[] = [];
  private readonly lastEnded = new Map<string, PairEnd>();
  private readonly proposedThisTurn = new Set<PlayerId>();
  private readonly log: TableMessage[] = [];
  private readonly pendingBreach = new Map<string, BreachReason>();
  private heldAttack: HeldAttack | null = null;
  private drained = 0;
  private nextDealId = 1;
  private turnSeen = -1;
  private activeNow: PlayerId | null = null;
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

  /** The table's whole state as plain, versioned JSON. */
  toState(): DiplomacyState {
    return structuredClone({
      version: DIPLOMACY_STATE_VERSION,
      trust: this.trust.toJSON(),
      records: this.records.map((r) => ({
        deal: r.deal,
        credit: [...r.credit],
        met: [...r.met],
        leaderAtStart: r.leaderAtStart,
        turnsTaken: [...r.turnsTaken],
        tested: [...r.tested],
        freed: [...r.freed],
        couldAttack: [...r.couldAttack],
      })),
      declines: this.declines,
      lastEnded: [...this.lastEnded],
      proposedThisTurn: [...this.proposedThisTurn],
      log: this.log,
      pendingBreach: [...this.pendingBreach],
      heldAttack: this.heldAttack,
      drained: this.drained,
      nextDealId: this.nextDealId,
      turnSeen: this.turnSeen,
      activeNow: this.activeNow,
      announcedLeader: this.announcedLeader,
      stats: this.stats,
    });
  }

  /** Rebuild a table from `toState`. Options are not state: pass the same ones the game uses. */
  static fromState(opts: DiplomacyTableOptions, saved: DiplomacyState): DiplomacyTable {
    if (saved.version !== DIPLOMACY_STATE_VERSION) {
      throw new Error(`unsupported diplomacy state version ${String(saved.version)}`);
    }
    const state = structuredClone(saved);
    const table = new DiplomacyTable(opts);
    table.trust = TrustLedger.fromJSON(state.trust);
    for (const r of state.records) {
      table.records.push({
        deal: r.deal,
        credit: new Map(r.credit),
        met: new Set(r.met),
        leaderAtStart: r.leaderAtStart,
        turnsTaken: new Map(r.turnsTaken),
        tested: new Set(r.tested),
        freed: new Set(r.freed),
        couldAttack: new Set(r.couldAttack),
      });
    }
    table.declines.push(...state.declines);
    for (const [key, end] of state.lastEnded) table.lastEnded.set(key, end);
    for (const seat of state.proposedThisTurn) table.proposedThisTurn.add(seat);
    table.log.push(...state.log);
    for (const [dealId, reason] of state.pendingBreach) table.pendingBreach.set(dealId, reason);
    table.heldAttack = state.heldAttack;
    table.drained = state.drained;
    table.nextDealId = state.nextDealId;
    table.turnSeen = state.turnSeen;
    table.activeNow = state.activeNow;
    table.announcedLeader = state.announcedLeader;
    Object.assign(table.stats, state.stats);
    return table;
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
      if (r.freed.has(seat)) continue;
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
      startingSeats: this.opts.seats.length,
      seed: this.opts.seed,
    };
  }

  private round(turn: number): number {
    return roundOf(turn, this.opts.seats.length);
  }

  /** Call before a seat answers any surfaced decision. Opens the turn's negotiation window. */
  beforeDecision(request: DecisionRequest): void {
    if (this.heldAttack !== null && !this.isRetryOfHeld(request)) this.flush();
    if (request.turn < 1 || request.turn === this.turnSeen) return;
    this.turnSeen = request.turn;
    this.activeNow = request.activePlayer;
    this.proposedThisTurn.clear();
    this.openWindow(request.turn, request.activePlayer);
  }

  /**
   * Call with the decision a seat submitted, before the engine applies it. An attack declaration
   * is held until the next decision shows the engine accepted it: a rejected one is asked again,
   * and one the engine repairs after two rejections is not the seat's choice and is not judged.
   */
  afterDecision(request: DecisionRequest, response: DecisionResponse): void {
    if (this.records.every((r) => r.deal.status !== 'active')) {
      this.pendingBreach.clear();
      return;
    }
    const view = this.opts.viewOf(request.decidingPlayer);
    if (request.decisionType === 'declareAttackers') {
      this.heldAttack = {
        request,
        response,
        view,
        repairedBefore: this.opts.repairedAttacks?.() ?? 0,
      };
      return;
    }
    this.judge(request, response, view);
  }

  /** Judge a held attack declaration now. Drivers call this once the game is over. */
  flush(): void {
    const held = this.heldAttack;
    if (held === null) return;
    this.heldAttack = null;
    const repaired = (this.opts.repairedAttacks?.() ?? 0) > held.repairedBefore;
    if (repaired) {
      this.pendingBreach.clear();
      return;
    }
    this.judge(held.request, held.response, held.view);
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

  private judge(request: DecisionRequest, response: DecisionResponse, view: PlayerView): void {
    const ownerOf = ownerLookup(view);
    const isStack = stackLookup(view);
    const estimate = estimateTable(view);
    for (const record of this.records) {
      if (record.deal.status !== 'active') continue;
      for (let i = 0; i < record.deal.obligations.length; i++) {
        if (record.met.has(i)) continue;
        const obligation = record.deal.obligations[i]!;
        if (record.freed.has(obligation.by)) continue;
        const verdict = judgeDecision(obligation, request, response, ownerOf, isStack);
        if (verdict === 'violated') {
          // Answering a seat that now leads or threatens lethal is not a breach (decision 17):
          // the same release test the bot used ends the deal without charging anyone.
          if (released(obligation, estimate)) this.end(record, 'void', request.turn, 'selfDefense');
          else this.breach(record, obligation, request.turn);
          break;
        }
        if (verdict === 'kept' && obligation.kind === 'attackPlayer') {
          record.met.add(i);
          record.tested.add(obligation.by);
        } else if (offeredBreach(obligation, request, ownerOf, isStack)) {
          record.tested.add(obligation.by);
        }
      }
    }
    this.pendingBreach.clear();
  }

  private breach(record: DealRecord, obligation: DealObligation, turn: number): void {
    record.deal.status = 'broken';
    record.deal.breachedBy = obligation.by;
    this.trust.recordBroken(obligation.by);
    this.stats.broken++;
    this.lastEnded.set(pairKey(...record.deal.parties), {
      round: this.round(turn),
      cooldown: Math.max(D.pairCooldownRounds, D.reproposeCooldownRounds),
    });
    const reason = this.pendingBreach.get(record.deal.id);
    this.log.push({
      kind: 'breach',
      turn,
      from: obligation.by,
      dealId: record.deal.id,
      obligation: { ...obligation },
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  private openWindow(turn: number, activePlayer: PlayerId): void {
    const view = this.opts.viewOf(activePlayer);
    const living = new Set([view.seat, ...view.opponents.map((o) => o.seat)]);
    const table = estimateTable(view);

    for (const record of this.records) {
      if (record.deal.status !== 'active') continue;
      const deal = record.deal;
      if (!deal.parties.every((p) => living.has(p))) {
        this.end(record, 'void', turn, 'partyLeft');
        continue;
      }
      // A party that became the leader frees the other party; its own promises stand, so taking
      // the lead is no way out of a deal (decision 5).
      const leader = table.leader;
      if (leader !== null && leader !== record.leaderAtStart && deal.parties.includes(leader)) {
        const other = deal.parties[0] === leader ? deal.parties[1] : deal.parties[0];
        if (!record.freed.has(other)) {
          record.freed.add(other);
          this.log.push({ kind: 'released', turn, dealId: deal.id, seat: other, reason: 'leader' });
        }
      }
      // Deals do not survive lethal: once a promiser could kill the seat it promised to spare,
      // the deal is called off in the open rather than broken by surprise.
      if (
        deal.obligations.some(
          (o) =>
            o.kind === 'noAttack' && !record.freed.has(o.by) && couldKill(table, o.by, o.against),
        )
      ) {
        this.end(record, 'void', turn, 'lethal');
        continue;
      }
      if (deal.parties.every((p) => (record.turnsTaken.get(p) ?? 0) >= deal.rounds)) {
        const unmet = deal.obligations.find(
          (o, i) => o.kind === 'attackPlayer' && !record.met.has(i) && !record.freed.has(o.by),
        );
        // A promised attack skipped by a seat that had attackers is a breach: holding creatures
        // back, or tapping them before combat, is not a way out. One that could never be made
        // ends the deal void.
        if (unmet !== undefined && record.couldAttack.has(unmet.by)) {
          this.breach(record, unmet, turn);
        } else if (unmet !== undefined) {
          this.end(record, 'void', turn, 'unmet');
        } else {
          this.end(record, 'kept', turn);
        }
        continue;
      }
      if (deal.parties.includes(activePlayer)) {
        record.turnsTaken.set(activePlayer, (record.turnsTaken.get(activePlayer) ?? 0) + 1);
        const owesAttack = deal.obligations.some(
          (o, i) => o.kind === 'attackPlayer' && o.by === activePlayer && !record.met.has(i),
        );
        if (owesAttack && (table.bySeat.get(activePlayer)?.attackPower ?? 0) > 0) {
          record.couldAttack.add(activePlayer);
        }
      }
    }

    this.callThreat(table, turn, activePlayer);

    if (this.opts.negotiates(activePlayer)) this.negotiate(activePlayer, turn);
  }

  private end(
    record: DealRecord,
    outcome: 'kept' | 'void',
    turn: number,
    reason?: 'partyLeft' | 'lethal' | 'unmet' | 'selfDefense',
  ): void {
    record.deal.status = outcome;
    if (outcome === 'kept') {
      // Keeping a deal one was never tempted to break, or that cost nothing to keep, proves
      // nothing, so it earns nothing; otherwise it earns at most what keeping it cost.
      for (const party of record.deal.parties) {
        const credit = record.credit.get(party) ?? 0;
        if (record.tested.has(party) && !record.freed.has(party) && credit >= D.minTrustCost) {
          this.trust.recordKept(party, credit);
        }
      }
      this.stats.kept++;
    } else {
      this.stats.voided++;
    }
    this.lastEnded.set(pairKey(...record.deal.parties), {
      round: this.round(turn),
      cooldown: D.pairCooldownRounds,
    });
    this.log.push({
      kind: 'dealEnded',
      turn,
      dealId: record.deal.id,
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    });
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

  private canDeal(a: PlayerId, b: PlayerId, turn: number): boolean {
    if (this.activeDeals().some((d) => d.parties.includes(a) && d.parties.includes(b))) {
      return false;
    }
    const ended = this.lastEnded.get(pairKey(a, b));
    return ended === undefined || this.round(turn) - ended.round >= ended.cooldown;
  }

  private recentlyDeclined(proposer: PlayerId, to: PlayerId, terms: string, turn: number): boolean {
    const round = this.round(turn);
    return this.declines.some(
      (d) =>
        d.proposer === proposer &&
        d.to === to &&
        d.terms === terms &&
        round - d.round < D.reproposeCooldownRounds,
    );
  }

  /**
   * Offer a deal to `to`, who answers at once (decisions 15 and 18). Every proposer goes through
   * here, so the limits hold for whoever offers: one offer per proposer per turn, no repeat of
   * declined terms inside the cooldown, the pair cooldown between deals, and the structural checks.
   * Only the terms are taken from the caller; the turn is the table's own, so no caller can claim
   * the early-game allowance or step around a cooldown. A bot that declines counters with its own
   * best terms, and the proposer, if it negotiates here, answers that counter in turn.
   */
  offer(terms: OfferTerms): OfferOutcome {
    const turn = this.turnSeen;
    const { proposer, to } = terms;
    if (!this.opts.negotiates(to)) return { kind: 'refused', reason: 'notNegotiating' };
    if (this.proposedThisTurn.has(proposer)) return { kind: 'refused', reason: 'rateLimited' };
    const probe: Deal = {
      id: 'probe',
      proposer,
      parties: [proposer, to],
      obligations: structuredClone(terms.obligations),
      proposedTurn: turn,
      rounds: terms.rounds,
      status: 'proposed',
    };
    const living = new Set(estimateTable(this.opts.viewOf(to)).seats.map((s) => s.seat));
    if (turn < 1 || validateDeal(probe, living).length > 0) {
      return { kind: 'refused', reason: 'invalid' };
    }
    if (!this.canDeal(proposer, to, turn)) return { kind: 'refused', reason: 'cooldown' };
    const key = termsKey(probe);
    if (this.recentlyDeclined(proposer, to, key, turn)) {
      return { kind: 'refused', reason: 'cooldown' };
    }

    this.proposedThisTurn.add(proposer);
    const deal: Deal = { ...probe, id: `deal-${this.nextDealId++}` };
    this.stats.proposals++;
    this.log.push({ kind: 'proposal', turn, from: proposer, to, deal: snapshot(deal) });

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
      this.activate(deal, answer.valuation, theirCtx.table);
      return { kind: 'accepted', deal };
    }

    deal.status = 'declined';
    this.declines.push({ proposer, to, terms: key, round: this.round(turn) });
    const counter = bestDealWith(to, proposer, theirCtx, `t${turn}-${to}-counter`);
    if (counter === null || termsKey(counter.deal) === key) {
      this.log.push({
        kind: 'response',
        turn,
        from: to,
        to: proposer,
        dealId: deal.id,
        answer: 'decline',
      });
      return { kind: 'declined' };
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
      counter: snapshot(counterDeal),
    });
    if (!this.opts.negotiates(proposer)) return { kind: 'declined', counter: counterDeal };

    const ctx = this.contextFor(proposer, turn);
    const back = answerDeal(counterDeal, proposer, ctx);
    this.log.push({
      kind: 'response',
      turn,
      from: proposer,
      to,
      dealId: counterDeal.id,
      answer: back.accept ? 'accept' : 'decline',
    });
    if (back.accept) {
      this.activate(counterDeal, back.valuation, ctx.table);
      return { kind: 'accepted', deal: counterDeal };
    }
    counterDeal.status = 'declined';
    // A declined counter is on the same cooldown as any declined offer, so counters cannot be used
    // to keep re-asking.
    this.declines.push({
      proposer: to,
      to: proposer,
      terms: termsKey(counterDeal),
      round: this.round(turn),
    });
    return { kind: 'declined', counter: counterDeal };
  }

  /** The active bot's one proposal for the turn: its best candidate not recently declined. */
  private negotiate(proposer: PlayerId, turn: number): void {
    const ctx = this.contextFor(proposer, turn);
    const ranked = rankedProposals(
      proposer,
      ctx,
      (other) => this.opts.negotiates(other) && this.canDeal(proposer, other, turn),
      `t${turn}-${proposer}`,
    );
    for (const candidate of ranked) {
      const to = candidate.deal.parties[1];
      if (this.recentlyDeclined(proposer, to, termsKey(candidate.deal), turn)) continue;
      this.offer({
        proposer,
        to,
        obligations: candidate.deal.obligations,
        rounds: candidate.deal.rounds,
      });
      return;
    }
  }

  private activate(deal: Deal, valuation: DealValuation, table: TableEstimate): void {
    deal.status = 'active';
    const turnsTaken = new Map<PlayerId, number>(deal.parties.map((p) => [p, 0]));
    // The accepting turn counts for whichever party is taking it.
    if (this.activeNow !== null && turnsTaken.has(this.activeNow)) {
      turnsTaken.set(this.activeNow, 1);
    }
    const credit = new Map(
      deal.parties.map((p) => [p, Math.min(valuation.stake, valuation.ownCost.get(p) ?? 0)]),
    );
    this.records.push({
      deal,
      credit,
      met: new Set(),
      leaderAtStart: table.leader,
      turnsTaken,
      tested: new Set(),
      freed: new Set(),
      couldAttack: new Set(),
    });
    this.stats.accepted++;
  }

  /** A seat's public record of deals kept and broken. */
  trustRecord(seat: PlayerId): { kept: number; broken: number; biggestKept: number } {
    return this.trust.snapshot(seat);
  }

  /** A seat's value for a deal right now, for reports and tests. */
  valueFor(seat: PlayerId, deal: Deal, turn: number): number {
    return valueDeal(deal, seat, this.contextFor(seat, turn)).value;
  }
}
