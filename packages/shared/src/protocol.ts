/**
 * WebSocket protocol between server and web client (brief §11). The server owns the engine
 * and AI calls; the frontend is a view and receives pushed updates. Payloads are flat and
 * serializable — the frontend needs no engine code to interpret them.
 *
 * TODO(phase-4): replace the generic `payload` with a per-type discriminated union.
 */

/** Server → client message types (brief §11). */
export const SERVER_TO_CLIENT_TYPES = [
  'gameStarted',
  'stateSnapshot',
  'eventBatch',
  'decisionPending',
  'computeHalted',
  'apiWaiting',
  'gameOver',
  'error',
] as const;
export type ServerToClientType = (typeof SERVER_TO_CLIENT_TYPES)[number];

/** Client → server message types (brief §11). */
export const CLIENT_TO_SERVER_TYPES = [
  'startGame',
  'jumpToTurn',
  'setPlaybackMode',
  'resolveHeldDecision',
  'abandonGame',
] as const;
export type ClientToServerType = (typeof CLIENT_TO_SERVER_TYPES)[number];

export interface ServerToClientMessage<T extends ServerToClientType = ServerToClientType> {
  type: T;
  payload: Record<string, unknown>;
}

export interface ClientToServerMessage<T extends ClientToServerType = ClientToServerType> {
  type: T;
  payload: Record<string, unknown>;
}
