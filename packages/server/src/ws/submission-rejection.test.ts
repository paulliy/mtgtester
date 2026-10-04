import { describe, expect, it, vi } from 'vitest';
import { GameServer } from './server';
import type { GameServerDeps } from './server';

function serverSeam() {
  const socket = { send: vi.fn() };
  const session = { submitPlayerAction: vi.fn(), getGameMode: vi.fn(() => 'singlePlayer') };
  const server = new GameServer({} as GameServerDeps) as unknown as {
    playerSocket: typeof socket;
    session: typeof session;
    handleMessage(socketArg: typeof socket, raw: string): Promise<void>;
  };
  server.playerSocket = socket;
  server.session = session;
  return { server, socket, session };
}

describe('invalid submitPlayerAction frames', () => {
  it('rejects an empty requestId without dispatch or correlation fields', async () => {
    const { server, socket, session } = serverSeam();
    await server.handleMessage(
      socket,
      JSON.stringify({
        type: 'submitPlayerAction',
        payload: { requestId: '', revision: 3, actionId: 2 },
      }),
    );

    expect(session.submitPlayerAction).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toEqual({
      type: 'error',
      payload: { message: 'Unrecognised message.' },
    });
  });

  it('rejects an unsupported field without dispatch and echoes only validated IDs', async () => {
    const { server, socket, session } = serverSeam();
    await server.handleMessage(
      socket,
      JSON.stringify({
        type: 'submitPlayerAction',
        payload: {
          requestId: 'request-1',
          revision: 3,
          actionId: 2,
          manaSplit: { G: 1 },
        },
      }),
    );

    expect(session.submitPlayerAction).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toEqual({
      type: 'error',
      payload: { message: 'Unrecognised message.', requestId: 'request-1', revision: 3 },
    });
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'another message type',
      JSON.stringify({
        type: 'yieldPlayerAbility',
        payload: { requestId: 'request-1', revision: 3, actionId: 'bad' },
      }),
    ],
    [
      'invalid request ID',
      JSON.stringify({
        type: 'submitPlayerAction',
        payload: { requestId: 1, revision: 3, actionId: 2 },
      }),
    ],
    [
      'invalid revision',
      JSON.stringify({
        type: 'submitPlayerAction',
        payload: { requestId: 'request-1', revision: -1, actionId: 2 },
      }),
    ],
  ])('does not correlate %s', async (_case, raw) => {
    const { server, socket, session } = serverSeam();
    await server.handleMessage(socket, raw);

    expect(session.submitPlayerAction).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
    const message = JSON.parse(socket.send.mock.calls[0]![0] as string);
    expect(message.type).toBe('error');
    expect(message.payload).toEqual({ message: expect.any(String) });
  });
});

describe('ambiguous inbound frames', () => {
  const VALID_TAIL = '"requestId":"request-1","revision":3,"actionId":2';

  it.each([
    [
      'a repeated envelope type',
      `{"type":"abandonGame","type":"submitPlayerAction","payload":{${VALID_TAIL}}}`,
    ],
    [
      'a repeated envelope payload',
      `{"type":"submitPlayerAction","payload":{"requestId":"other","revision":9,"actionId":7},"payload":{${VALID_TAIL}}}`,
    ],
    [
      'a repeated actionId',
      `{"type":"submitPlayerAction","payload":{"requestId":"request-1","revision":3,"actionId":7,"actionId":2}}`,
    ],
    [
      'a repeated correlation field',
      `{"type":"submitPlayerAction","payload":{"requestId":"other","requestId":"request-1","revision":3,"actionId":2}}`,
    ],
    [
      'a repeated target key',
      `{"type":"submitPlayerAction","payload":{${VALID_TAIL},"targets":[{"slot":0,"slot":1,"choice":"obj-a"}]}}`,
    ],
    [
      'an escaped alias of a key it already carries',
      `{"type":"submitPlayerAction","payload":{"requestId":"request-1","revision":3,"action\u0049d":7,"actionId":2}}`,
    ],
  ])('never dispatches or correlates %s', async (_case, raw) => {
    const { server, socket, session } = serverSeam();
    await server.handleMessage(socket, raw);

    expect(session.submitPlayerAction).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledOnce();
    const message = JSON.parse(socket.send.mock.calls[0]![0] as string);
    expect(message.type).toBe('error');
    expect(message.payload).toEqual({ message: expect.any(String) });
    expect(message.payload.message).not.toContain('request-1');
  });

  it('dispatches a valid submission exactly once', async () => {
    const { server, socket, session } = serverSeam();
    await server.handleMessage(
      socket,
      JSON.stringify({
        type: 'submitPlayerAction',
        payload: {
          requestId: 'request-1',
          revision: 3,
          actionId: 2,
          targets: [
            { slot: 0, choice: 'obj-a' },
            { slot: 1, choice: 'obj-b' },
          ],
        },
      }),
    );

    expect(socket.send).not.toHaveBeenCalled();
    expect(session.submitPlayerAction).toHaveBeenCalledExactlyOnceWith({
      requestId: 'request-1',
      revision: 3,
      actionId: 2,
      targets: [
        { slot: 0, choice: 'obj-a' },
        { slot: 1, choice: 'obj-b' },
      ],
    });
  });
});
