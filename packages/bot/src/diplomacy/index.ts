import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import type { DiplomacyTable } from './table';

export { DiplomacyTable } from './table';
export { DIPLOMACY_STATE_VERSION } from './table';
export type {
  DiplomacyState,
  DiplomacyStats,
  DiplomacyTableOptions,
  OfferOutcome,
  OfferTerms,
} from './table';
export type { ActiveObligation, BreachReason, DiplomacyPlay } from './play';
export { Exploiter, MAX_CONCESSION_PER_DEAL, summarizeExploits } from './exploiter';
export type { ExploitRecord, ExploitSummary, ExploitTactic } from './exploiter';
export { estimateTable } from './estimate';
export type { SeatEstimate, TableEstimate } from './estimate';
export { describeMessage, describeObligation } from './render';
export type { SeatName } from './render';

/**
 * Route one seat's decisions through the table (ADR 0035 decision 20): the turn's negotiation
 * window opens before the first decision of a turn, and every submitted decision is judged for
 * compliance. Works for any synchronous provider, including seats that do not negotiate.
 */
export function withDiplomacy<P extends { decide(request: DecisionRequest): DecisionResponse }>(
  table: DiplomacyTable,
  provider: P,
): { decide(request: DecisionRequest): DecisionResponse } {
  return {
    decide(request) {
      table.beforeDecision(request);
      const response = provider.decide(request);
      table.afterDecision(request, response);
      return response;
    },
  };
}

/** `withDiplomacy` for providers that answer asynchronously: a human, a model, a socket. */
export function withDiplomacyAsync<
  P extends { decide(request: DecisionRequest): Promise<DecisionResponse> },
>(
  table: DiplomacyTable,
  provider: P,
): { decide(request: DecisionRequest): Promise<DecisionResponse> } {
  return {
    async decide(request) {
      table.beforeDecision(request);
      const response = await provider.decide(request);
      table.afterDecision(request, response);
      return response;
    },
  };
}
