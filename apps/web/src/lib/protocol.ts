/**
 * The browser's view of the wire protocol (ADR 0032 decisions 7 and 9).
 *
 * The browser never asks for `rawActionData`, so the server sends it no `LegalAction.data`. These
 * types say so: a web read of an action's `data` fails typecheck. Everything the browser shows from
 * rules or engine data arrives in the typed `presentation` fields instead.
 *
 * Import `LegalAction`, `DecisionRequest`, the two payloads that carry them and
 * `ServerToClientMessage` from here, not from `@mtg/shared`.
 */
import type {
  DecisionPendingPayload as WireDecisionPendingPayload,
  DecisionRequest as WireDecisionRequest,
  LegalAction as WireLegalAction,
  PlayerActionRequiredPayload as WirePlayerActionRequiredPayload,
  ServerToClientMessage as WireServerToClientMessage,
} from '@mtg/shared';

/** A legal action as the browser receives it: no `data`. */
export type LegalAction = Omit<WireLegalAction, 'data'>;

export type DecisionRequest = Omit<WireDecisionRequest, 'legalActions'> & {
  legalActions: LegalAction[];
};

export type PlayerActionRequiredPayload = Omit<WirePlayerActionRequiredPayload, 'request'> & {
  request: DecisionRequest;
};

export type DecisionPendingPayload = Omit<WireDecisionPendingPayload, 'request'> & {
  request: DecisionRequest;
};

/** Every server message, with the two that carry legal actions retyped without `data`. */
export type ServerToClientMessage =
  | Exclude<WireServerToClientMessage, { type: 'playerActionRequired' | 'decisionPending' }>
  | { type: 'playerActionRequired'; payload: PlayerActionRequiredPayload }
  | { type: 'decisionPending'; payload: DecisionPendingPayload };
