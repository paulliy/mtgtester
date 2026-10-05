import { describe, expect, it, vi } from 'vitest';
import { GameServer } from './server';
import type { GameServerDeps } from './server';

/** `POST /api/game-report`: only the player's own reconnect token exports a game. */
function seam(session: unknown, sessionToken: string | null, build?: GameServerDeps['build']) {
  const server = new GameServer({ ...(build !== undefined && { build }) } as GameServerDeps);
  Object.assign(server as object, {
    session,
    sessionToken,
    startedPayload: { startedAt: '2026-10-05T00:00:00.000Z' },
    reportSources: { sources: [{ kind: 'pool' }], cardTestScenarioId: null },
  });
  return server as unknown as { handleGameReport(request: Request): Promise<Response> };
}

const post = (body: string) =>
  new Request('http://localhost:3001/api/game-report', { method: 'POST', body });

function playerSession() {
  return {
    getGameMode: () => 'singlePlayer',
    gameReport: vi.fn((context: unknown) => ({ schemaVersion: 1, context })),
  };
}

describe('POST /api/game-report', () => {
  it('builds the report for the matching session token, with the server build and setup', async () => {
    const session = playerSession();
    const build = { commit: 'abc', branch: 'main', dirty: false };
    const response = await seam(session, 'tok', build).handleGameReport(
      post(JSON.stringify({ sessionToken: 'tok' })),
    );
    expect(response.status).toBe(200);
    expect(session.gameReport).toHaveBeenCalledWith({
      build,
      startedAt: '2026-10-05T00:00:00.000Z',
      sources: [{ kind: 'pool' }],
      cardTestScenarioId: null,
    });
  });

  it('refuses a wrong, missing or malformed token without building anything', async () => {
    const session = playerSession();
    const server = seam(session, 'tok');
    for (const body of [
      JSON.stringify({ sessionToken: 'other' }),
      JSON.stringify({}),
      '{"sessionToken":"tok","sessionToken":"tok"}',
      'not json',
    ]) {
      const response = await server.handleGameReport(post(body));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(session.gameReport).not.toHaveBeenCalled();
  });

  it('has nothing to export for a spectator game', async () => {
    const session = { ...playerSession(), getGameMode: () => 'spectator' };
    const response = await seam(session, null).handleGameReport(
      post(JSON.stringify({ sessionToken: 'tok' })),
    );
    expect(response.status).toBe(404);
    expect(session.gameReport).not.toHaveBeenCalled();
  });
});
