/**
 * What a connection declares in `startCardTestScenario` and `resumeGame` decides whether the legal
 * actions it receives carry raw `data` (ADR 0032 decision 7). The tester's other start message,
 * `startGame`, goes through the same path; its frames are pinned by the wire transcripts, and the
 * agent client's by its own tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionRequest, ServerToClientMessage } from '@mtg/shared';
import { GameServer, type GameServerDeps } from './server';

interface Seam {
  onSocketOpen(socket: unknown): void;
  handleMessage(socket: unknown, raw: string): Promise<void>;
  sendTo(socket: unknown, message: ServerToClientMessage): void;
  broadcast(message: ServerToClientMessage): void;
  session: { abandon(): void; settled(): Promise<void> } | null;
}

function connect(server: GameServer) {
  const frames: ServerToClientMessage[] = [];
  const socket = {
    send: (frame: string) => frames.push(JSON.parse(frame) as ServerToClientMessage),
  };
  (server as unknown as Seam).onSocketOpen(socket);
  return { socket, frames };
}

const send = (server: GameServer, socket: unknown, message: unknown) =>
  (server as unknown as Seam).handleMessage(socket, JSON.stringify(message));

type ActionRequired = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;
const required = (frames: ServerToClientMessage[]) =>
  frames.filter((m): m is ActionRequired => m.type === 'playerActionRequired');

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !done(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(done()).toBe(true);
}

const SCENARIO = 'kogla-viewer-bounce-and-attack';
const hasData = (request: DecisionRequest) =>
  request.legalActions.some((action) => 'data' in action && action.data !== undefined);

describe('GameServer capabilities', () => {
  let server: GameServer | null = null;
  afterEach(async () => {
    const session = (server as unknown as Seam | null)?.session;
    session?.abandon();
    await session?.settled();
    server = null;
  });

  it('sends no data to a player who declared nothing, or declared rawActionData false', async () => {
    for (const capabilities of [undefined, {}, { rawActionData: false }]) {
      server = new GameServer({ cardTestLab: true } as GameServerDeps);
      const { socket, frames } = connect(server);
      await send(server, socket, {
        type: 'startCardTestScenario',
        payload: { scenarioId: SCENARIO, ...(capabilities !== undefined && { capabilities }) },
      });
      await until(() => required(frames).length > 0);
      expect(hasData(required(frames)[0]!.payload.request)).toBe(false);
      (server as unknown as Seam).session?.abandon();
    }
  });

  it('keeps data for a player who asked for it', async () => {
    server = new GameServer({ cardTestLab: true } as GameServerDeps);
    const { socket, frames } = connect(server);
    await send(server, socket, {
      type: 'startCardTestScenario',
      payload: { scenarioId: SCENARIO, capabilities: { rawActionData: true } },
    });
    await until(() => required(frames).length > 0);
    expect(hasData(required(frames)[0]!.payload.request)).toBe(true);
  });

  it('reads the capability again on resume, from the resuming connection', async () => {
    for (const [first, second] of [
      [true, false],
      [false, true],
    ] as const) {
      server = new GameServer({ cardTestLab: true } as GameServerDeps);
      const original = connect(server);
      await send(server, original.socket, {
        type: 'startCardTestScenario',
        payload: { scenarioId: SCENARIO, capabilities: { rawActionData: first } },
      });
      await until(() => required(original.frames).length > 0);
      expect(hasData(required(original.frames)[0]!.payload.request)).toBe(first);
      const started = original.frames.find((m) => m.type === 'gameStarted');
      if (started?.type !== 'gameStarted') throw new Error('no gameStarted');
      const sessionToken = started.payload.sessionToken!;

      const resumed = connect(server);
      await send(server, resumed.socket, {
        type: 'resumeGame',
        payload: { sessionToken, capabilities: { rawActionData: second } },
      });
      await until(() => required(resumed.frames).length > 0);
      expect(hasData(required(resumed.frames)[0]!.payload.request)).toBe(second);

      // A resume that declares nothing is a connection that asked for nothing.
      const bare = connect(server);
      await send(server, bare.socket, { type: 'resumeGame', payload: { sessionToken } });
      await until(() => required(bare.frames).length > 0);
      expect(hasData(required(bare.frames)[0]!.payload.request)).toBe(false);
      (server as unknown as Seam).session?.abandon();
    }
  });

  it('refuses a malformed declaration without starting anything', async () => {
    server = new GameServer({ cardTestLab: true } as GameServerDeps);
    const { socket, frames } = connect(server);
    await send(server, socket, {
      type: 'startCardTestScenario',
      payload: { scenarioId: SCENARIO, capabilities: { rawActionData: 'yes' } },
    });
    expect(frames.map((m) => m.type)).toEqual(['error']);
    expect((server as unknown as Seam).session).toBeNull();
  });

  it('strips a held decision per connection: spectators see data only if they asked', () => {
    server = new GameServer({} as GameServerDeps);
    const request = {
      requestId: 'r',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass', data: { x: 1 } }],
    } as unknown as DecisionRequest;
    const message: ServerToClientMessage = {
      type: 'decisionPending',
      payload: { request, invalidResponse: 'bad', timeoutMs: 1 },
    };
    const plain = connect(server);
    (server as unknown as Seam).sendTo(plain.socket, message);
    const held = plain.frames[0];
    if (held?.type !== 'decisionPending') throw new Error('no decisionPending');
    expect(hasData(held.payload.request)).toBe(false);
    expect(held.payload.invalidResponse).toBe('bad');
    // The request itself is not changed for anyone else.
    expect(hasData(request)).toBe(true);

    const asked = connect(server);
    (
      server as unknown as { capabilities: WeakMap<object, { rawActionData: boolean }> }
    ).capabilities.set(asked.socket, { rawActionData: true });
    (server as unknown as Seam).broadcast(message);
    const kept = asked.frames[0];
    if (kept?.type !== 'decisionPending') throw new Error('no decisionPending');
    expect(hasData(kept.payload.request)).toBe(true);
    // A broadcast frames each connection for itself.
    expect(plain.frames).toHaveLength(2);
    const second = plain.frames[1];
    if (second?.type !== 'decisionPending') throw new Error('no decisionPending');
    expect(hasData(second.payload.request)).toBe(false);
  });
});
