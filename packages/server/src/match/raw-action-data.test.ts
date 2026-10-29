/**
 * Raw `LegalAction.data` reaches a player only on request (ADR 0032 decision 7): the session
 * strips it from the legal actions it sends to a seat whose connection did not ask, remembers the
 * choice per seat, and re-reads it on resume. The game report carries none either way.
 */

import { describe, expect, it } from 'vitest';
import type { LegalAction, ServerToClientMessage } from '@mtg/shared';
import { createCardTestScenario } from '../cards/card-test-scenarios';
import { testerPolicy } from './disclosure';
import { withoutActionData } from './presentation';
import { MatchSession } from './session';

type ActionRequired = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;

const CONTEXT = {
  build: { commit: 'abc123', branch: 'feature', dirty: false },
  cardData: { source: null, sha256: null, entries: 0 },
  startedAt: null,
  sources: [],
  cardTestScenarioId: null,
};

/** A lab scenario whose first human decision is a priority menu with `data` on its actions. */
function labSession(sent: ServerToClientMessage[]): MatchSession {
  const scenario = createCardTestScenario('kogla-viewer-bounce-and-attack', 'g-raw-data');
  if (scenario === null) throw new Error('missing scenario');
  return new MatchSession({
    disclosure: testerPolicy('singlePlayer'),
    gameId: 'g-raw-data',
    seed: scenario.seed,
    seats: scenario.seats,
    providerKind: 'random',
    gameMode: 'singlePlayer',
    humanSeat: 'P1',
    livePaceMs: 0,
    engine: scenario.engine,
    ...(scenario.decisionProviderOverrides !== undefined
      ? { decisionProviderOverrides: scenario.decisionProviderOverrides }
      : {}),
    send: (message) => sent.push(message),
  });
}

const required = (sent: ServerToClientMessage[]) =>
  sent.filter((m): m is ActionRequired => m.type === 'playerActionRequired');

async function firstRequest(sent: ServerToClientMessage[]): Promise<ActionRequired> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = required(sent)[0];
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no playerActionRequired');
}

const hasData = (action: LegalAction) => 'data' in action && action.data !== undefined;

describe('raw action data capability', () => {
  it('strips data from every legal action unless the seat asked, keeping the presentation', async () => {
    const sent: ServerToClientMessage[] = [];
    const match = labSession(sent);
    match.start();
    const { request } = (await firstRequest(sent)).payload;
    expect(request.legalActions.length).toBeGreaterThan(0);
    expect(request.legalActions.some(hasData)).toBe(false);
    expect(JSON.stringify(request)).not.toContain('"data"');
    // What the browser renders is built from `data` before it is stripped.
    expect(request.presentation?.playerPrompt).toBeTruthy();
    expect(Object.keys(request.presentation?.actions ?? {}).length).toBeGreaterThan(0);
    match.abandon();
    await match.settled();
  });

  it('keeps data when the seat asked for it, and sends the same menu and presentation', async () => {
    const plain: ServerToClientMessage[] = [];
    const asked: ServerToClientMessage[] = [];
    const without = labSession(plain);
    const raw = labSession(asked);
    raw.setRawActionData('P1', true);
    without.start();
    raw.start();
    const a = (await firstRequest(plain)).payload.request;
    const b = (await firstRequest(asked)).payload.request;
    expect(b.legalActions.some(hasData)).toBe(true);
    expect(withoutActionData(b)).toEqual(a);
    without.abandon();
    raw.abandon();
    await Promise.all([without.settled(), raw.settled()]);
  });

  it('re-reads the capability on resume, before the pending request is resent', async () => {
    const sent: ServerToClientMessage[] = [];
    const match = labSession(sent);
    match.start();
    await firstRequest(sent);
    expect(required(sent)).toHaveLength(1);

    // A resumed connection that asks for data gets it on the resent request ...
    match.setRawActionData('P1', true);
    match.setPlayerConnected('P1', true);
    const resumedRaw = required(sent).at(-1)!;
    expect(required(sent)).toHaveLength(2);
    expect(resumedRaw.payload.request.legalActions.some(hasData)).toBe(true);

    // ... and a later one that does not, loses it again: nothing carries over.
    match.setRawActionData('P1', false);
    match.setPlayerConnected('P1', true);
    const resumedPlain = required(sent).at(-1)!;
    expect(required(sent)).toHaveLength(3);
    expect(resumedPlain.payload.request.legalActions.some(hasData)).toBe(false);
    expect(resumedPlain.payload.request.requestId).toBe(resumedRaw.payload.request.requestId);

    match.abandon();
    await match.settled();
  });

  it('still answers an action by id when the menu it was sent has no data', async () => {
    const sent: ServerToClientMessage[] = [];
    const match = labSession(sent);
    match.start();
    const first = await firstRequest(sent);
    const pass = first.payload.request.legalActions.find((action) => action.type === 'pass');
    expect(pass).toBeDefined();
    match.submitPlayerAction('P1', {
      requestId: first.payload.request.requestId,
      revision: first.payload.revision,
      actionId: pass!.id,
    });
    // The provider resolves the id against the request it holds, which still has its data.
    for (let attempt = 0; attempt < 300; attempt++) {
      if (match.gameReport(CONTEXT).lastSubmittedAction !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(match.gameReport(CONTEXT).lastSubmittedAction?.requestId).toBe(
      first.payload.request.requestId,
    );
    expect(sent.some((m) => m.type === 'error')).toBe(false);
    match.abandon();
    await match.settled();
  });

  it('does not change the request the engine and the provider hold', () => {
    const request = {
      requestId: 'r',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass', data: { x: 1 } }],
    } as unknown as Parameters<typeof withoutActionData>[0];
    const stripped = withoutActionData(request);
    expect(stripped.legalActions[0]).toEqual({ id: 0, type: 'pass', description: 'Pass' });
    expect(request.legalActions[0]?.data).toEqual({ x: 1 });
  });

  it('carries no raw data in the game report, with the capability or without', async () => {
    for (const asked of [false, true]) {
      const sent: ServerToClientMessage[] = [];
      const match = labSession(sent);
      match.setRawActionData('P1', asked);
      match.start();
      const { request } = (await firstRequest(sent)).payload;
      expect(request.legalActions.some(hasData)).toBe(asked);
      const report = match.gameReport(CONTEXT);
      // The pending choice is the request's id, type, prompt and option descriptions, nothing more.
      expect(Object.keys(report.pendingChoice ?? {}).sort()).toEqual([
        'decisionType',
        'options',
        'prompt',
        'requestId',
      ]);
      const walk = (value: unknown, path: string): void => {
        if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
        else if (typeof value === 'object' && value !== null) {
          for (const [key, child] of Object.entries(value)) {
            expect(key, path).not.toBe('data');
            expect(key, path).not.toBe('legalActions');
            walk(child, `${path}.${key}`);
          }
        }
      };
      walk(report, 'report');
      match.abandon();
      await match.settled();
    }
  });
});
