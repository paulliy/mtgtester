/**
 * The few requests the tester makes besides its game socket. The server answers them over HTTP;
 * in a local-games build (ADR 0053) the game worker answers the same requests with the same
 * bodies, so the views read one shape either way.
 */

import { LOCAL_GAMES } from './localMode';

export interface ApiReply {
  ok: boolean;
  status: number;
  body: unknown;
}

type LocalOp = 'setupPreview' | 'gameReport' | 'knownDecks';

async function fromWorker(op: LocalOp, body?: unknown): Promise<ApiReply> {
  const { workerRequest } = await import('./localEngine');
  const reply = await workerRequest(op, body);
  return { ok: reply.status >= 200 && reply.status < 300, ...reply };
}

async function fromServer(path: string, body?: unknown): Promise<ApiReply> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  return { ok: response.ok, status: response.status, body: await response.json() };
}

/** The modeled decks the deck chooser offers: `{ decks }`. */
export function requestKnownDecks(): Promise<ApiReply> {
  return LOCAL_GAMES ? fromWorker('knownDecks') : fromServer('/api/known-decks');
}

/** Check a setup and draw its generated decks: a `SetupPreview`, or `{ message }`. */
export function requestSetupPreview(body: object): Promise<ApiReply> {
  return LOCAL_GAMES ? fromWorker('setupPreview', body) : fromServer('/api/setup-preview', body);
}

/** The bug report for a player session: a `GameReport`, or `{ message }`. */
export function requestGameReport(body: { sessionToken: string }): Promise<ApiReply> {
  return LOCAL_GAMES ? fromWorker('gameReport', body) : fromServer('/api/game-report', body);
}
