import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import type { DiplomacyTable } from './table';

export { DiplomacyTable } from './table';
export type { DiplomacyStats, DiplomacyTableOptions } from './table';
export type { ActiveObligation, BreachReason, DiplomacyPlay } from './play';
export { estimateTable } from './estimate';
export type { SeatEstimate, TableEstimate } from './estimate';
export { describeMessage, describeObligation } from './render';
export type { SeatName } from './render';

/**
 * Route one seat's decisions through the table (ADR 0031 decision 20): the turn's negotiation
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
