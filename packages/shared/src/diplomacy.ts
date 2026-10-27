/**
 * Table diplomacy (ADR 0031): structured messages and two-party deals.
 *
 * Everything here is typed rather than free text so a bot can read and answer it without a model
 * call, and so every deal can be checked mechanically against the decisions players submit. A
 * template turns a message into a sentence for display.
 */

import type { PlayerId } from './ids';

/**
 * One promise owed by one seat (`by`). Obligations only ever name seats, never cards, so a deal
 * cannot carry hidden information (ADR 0031 decision 23).
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
  /** Rounds the deal lasts once accepted; one round is one turn for each living player. */
  rounds: number;
  /** Last game turn (inclusive) the deal covers. Set when the deal is accepted. */
  untilTurn?: number;
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

/** One line of table talk (ADR 0031 decision 2). */
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
      /** Why the breaker broke it, when it says: e.g. `'lethal'`. */
      reason?: 'lethal' | 'worthIt';
    }
  | {
      kind: 'dealEnded';
      turn: number;
      dealId: string;
      outcome: 'kept' | 'void';
    };

export type TableMessageKind = TableMessage['kind'];
