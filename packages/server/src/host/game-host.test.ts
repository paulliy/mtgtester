/**
 * The game host with no socket and no server: a connection is any object with `send`, as a
 * browser worker's port will be. A watch game against bots runs to its end, and a game with
 * model seats is refused when the host was given no model services.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OracleCard, ServerToClientMessage } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { buildSupportedPool } from '../cards/pool';
import { parseBannedList } from '../decks/banned';
import { GameHost, type HostConnection } from './game-host';

const ROOT = resolve(__dirname, '../../../..');
const cards = JSON.parse(
  readFileSync(join(ROOT, 'packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const deps = {
  index: buildOracleIndexFromCards(cards),
  pool: buildSupportedPool(cards),
  banned: parseBannedList(readFileSync(join(ROOT, 'docs/rules/commander-banned-list.md'), 'utf8')),
};

function client(): HostConnection & { frames: ServerToClientMessage[] } {
  const frames: ServerToClientMessage[] = [];
  return { frames, send: (frame: string) => frames.push(JSON.parse(frame)) };
}

const start = (providerKind: 'random' | 'ai') =>
  JSON.stringify({
    type: 'startGame',
    payload: {
      seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
      providerKind,
      seed: 'host-test',
      paceMs: 0,
    },
  });

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('GameHost without a server', () => {
  it('plays a watch game against bots to its end through a plain connection', async () => {
    const host = new GameHost(deps);
    const viewer = client();
    host.open(viewer);
    await host.receive(viewer, start('random'));

    expect(viewer.frames[0]?.type).toBe('gameStarted');
    const ended = () =>
      viewer.frames.some((frame) => frame.type === 'gameOver' || frame.type === 'computeHalted');
    await until(ended, 60_000);
    expect(viewer.frames.some((frame) => frame.type === 'stateSnapshot')).toBe(true);
    expect(viewer.frames.filter((frame) => frame.type === 'error')).toEqual([]);

    await host.receive(viewer, JSON.stringify({ type: 'abandonGame', payload: {} }));
    host.close(viewer);
  }, 90_000);

  it('refuses model seats when it has no model services', async () => {
    const host = new GameHost(deps);
    const viewer = client();
    host.open(viewer);
    await host.receive(viewer, start('ai'));
    expect(viewer.frames.map((frame) => frame.type)).toEqual(['error']);
  });

  it('has no Card Test Lab of its own', async () => {
    const host = new GameHost({ ...deps, cardTestLab: true });
    const viewer = client();
    host.open(viewer);
    await host.receive(
      viewer,
      JSON.stringify({
        type: 'startCardTestScenario',
        payload: { scenarioId: 'anything' },
      }),
    );
    expect(viewer.frames).toEqual([
      { type: 'error', payload: { message: 'Unknown Card Test Lab scenario: anything' } },
    ]);
  });
});
