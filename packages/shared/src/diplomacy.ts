/**
 * Table diplomacy (ADR 0035): structured messages and two-party deals.
 *
 * Everything here is typed rather than free text so a bot can read and answer it without a model
 * call, and so every deal can be checked mechanically against the decisions players submit. A
 * template turns a message into a sentence for display.
 */

import type { PlayerId } from './ids';

/**
 * One promise owed by one seat (`by`). Obligations only ever name seats, never cards, so a deal
 * cannot carry hidden information (ADR 0035 decision 23).
 *
 * None of them constrains blocks: deals cover offense only (decision 4).
 */
export type DealObligation =
  /** `by` declares no attacker at `against` or at a permanent `against` controls. Continuous. */
  | { kind: 'noAttack'; by: PlayerId; against: PlayerId }
  /** `by` chooses no target that is `against`, or a permanent or stack object `against` controls. */
  | { kind: 'noTarget'; by: PlayerId; against: PlayerId }
  /** The stack-object part of `noTarget` only: `by` does not target `against`'s spells. */
  | { kind: 'noCounter'; by: PlayerId; against: PlayerId }
  /** At `by`'s next attack declaration inside the deal, at least one attacker goes at `target`. */
  | { kind: 'attackPlayer'; by: PlayerId; target: PlayerId };

export type DealObligationKind = DealObligation['kind'];

export type DealStatus =
  | 'proposed'
  | 'active'
  | 'declined'
  /** Ran to its last turn with every obligation kept. */
  | 'kept'
  /** A party violated an obligation (see `breachedBy`). */
  | 'broken'
  /** Ended early by its escape clause: a party became the table leader (decision 5). */
  | 'void';

export interface Deal {
  id: string;
  proposer: PlayerId;
  /** The two parties, proposer first. */
  parties: [PlayerId, PlayerId];
  obligations: DealObligation[];
  /** Game turn the deal was proposed on. */
  proposedTurn: number;
  /**
   * How long the deal lasts: until each party has taken this many turns of its own since it was
   * accepted (the accepting turn counts for whoever is active). Counted in turns rather than game
   * turn numbers so eliminations and extra turns cannot stretch or shrink it.
   */
  rounds: number;
  status: DealStatus;
  /** The seat that broke the deal, when `status` is `'broken'`. */
  breachedBy?: PlayerId;
}

/** Why a seat is named the table leader: the public facts behind its win share. */
export interface ThreatReason {
  kind: 'life' | 'board' | 'commanderDamage' | 'cards';
  /** A short, public, number-bearing phrase, e.g. "38 life" or "board worth 41". */
  detail: string;
}

/** One line of table talk (ADR 0035 decision 2). */
export type TableMessage =
  | {
      kind: 'threatCall';
      turn: number;
      from: PlayerId;
      leader: PlayerId;
      reasons: ThreatReason[];
    }
  | { kind: 'proposal'; turn: number; from: PlayerId; to: PlayerId; deal: Deal }
  | {
      kind: 'response';
      turn: number;
      from: PlayerId;
      to: PlayerId;
      dealId: string;
      answer: 'accept' | 'decline';
      /** The responder's own terms, offered instead when it declines. */
      counter?: Deal;
    }
  | {
      kind: 'breach';
      turn: number;
      from: PlayerId;
      dealId: string;
      obligation: DealObligation;
      /** Why the breaker broke it, when it says. */
      reason?: 'lethal' | 'worthIt' | 'selfDefense';
    }
  | {
      /**
       * One party is freed from its side of a deal while the other's promises stand: the freed
       * party's counterpart became the table leader, and nobody owes a leader restraint.
       */
      kind: 'released';
      turn: number;
      dealId: string;
      seat: PlayerId;
      reason: 'leader';
    }
  | {
      kind: 'dealEnded';
      turn: number;
      dealId: string;
      outcome: 'kept' | 'void';
      /**
       * Why a deal was void: a party left the game, one party could now kill the other, a promised
       * attack never came and could not have, or a party answered a seat that now led the table or
       * threatened it with lethal. A void deal credits no trust and charges none.
       */
      reason?: 'partyLeft' | 'lethal' | 'unmet' | 'selfDefense';
    }
  | {
      /**
       * An offer waiting on a seat that answers later (a human) was taken off the table: its turn
       * ended unanswered (`expired`), or by the time it was accepted the deal was no longer valid
       * or the proposer no longer wanted it (`stale`).
       */
      kind: 'withdrawn';
      turn: number;
      from: PlayerId;
      dealId: string;
      reason: 'expired' | 'stale';
    };

export type TableMessageKind = TableMessage['kind'];

/**
 * One line of table talk as the spectator log shows it (ADR 0035 phase 2): the structured message,
 * its sentence, and the `GameEvent.sequence` it sits under, like an AI annotation (ADR 0022).
 * Table talk is public, so unlike reasoning it is never withheld.
 */
export interface TableTalkLine {
  sequence: number;
  turn: number;
  message: TableMessage;
  text: string;
}

/**
 * When a seat may propose (ADR 0035 phase 3): once at the start of a turn, and once more after
 * attackers are declared, when it is clear who is attacking whom.
 */
export type NegotiationSlot = 'turnStart' | 'afterAttackers';

/** The terms of a deal as a proposer writes them: the table supplies the id, turn and status. */
export interface DealTerms {
  to: PlayerId;
  obligations: DealObligation[];
  rounds: number;
}

/** Why an offer was not put to its recipient at all. */
export type OfferRefusal = 'invalid' | 'rateLimited' | 'cooldown' | 'notNegotiating' | 'pending';

/** One seat's public deal record. */
export interface TrustSummary {
  seat: PlayerId;
  kept: number;
  broken: number;
}

/**
 * The table as one seat that answers asynchronously (the human) sees it: its open offers, the
 * deals in force at the table, every seat's record, and whether it may propose now.
 */
export interface DiplomacySeatState {
  turn: number;
  slot: NegotiationSlot;
  /** True when this seat has not yet proposed in the current slot. */
  canPropose: boolean;
  /** Offers waiting on this seat's answer. */
  offers: Deal[];
  /** Every deal in force at the table: deals are public. */
  deals: Deal[];
  trust: TrustSummary[];
  /** Seats this seat could offer a deal to right now (living, negotiating, off cooldown). */
  partners: PlayerId[];
  /** Longest deal a seat may offer, in rounds. */
  maxRounds: number;
  /** Most obligations one side of a deal may carry. */
  maxObligationsPerSide: number;
}
