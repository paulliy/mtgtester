/**
 * The browser worker's message loop, driven through a fake scope over card files built in memory
 * from the committed Oracle fixture. A pasted decklist is seated from the memory deck store, and
 * a game against bots runs to its end, all without a server or a database.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OracleCard, ServerToClientMessage } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { buildSiteCards } from '../cards/site-cards';
import { parseBannedList } from '../decks/banned';
import { serveWorker, type PageToWorker, type WorkerToPage } from './worker-core';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const cards = JSON.parse(read('packages/server/fixtures/coverage-oracle.json')) as OracleCard[];
const banned = parseBannedList(read('docs/rules/commander-banned-list.md'));
const { files } = buildSiteCards({
  cards,
  bannedNames: banned.names,
  decks: [],
  sourceSha256: '0'.repeat(64),
  engine: { version: 'test', commit: null },
});
const DECK = read('packages/server/fixtures/coverage-decks/white-black-control.txt');

function worker() {
  const out: WorkerToPage[] = [];
  let listener: ((event: { data: PageToWorker }) => void) | null = null;
  serveWorker(
    {
      postMessage: (message) => out.push(message),
      addEventListener: (_type, next) => {
        listener = next;
      },
    },
    {
      fetchText: () => async (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`404 ${path}`);
        return text;
      },
    },
  );
  const post = (data: PageToWorker) => listener?.({ data });
  const frames = () =>
    out
      .filter((m): m is Extract<WorkerToPage, { kind: 'frame' }> => m.kind === 'frame')
      .map((m) => JSON.parse(m.text) as ServerToClientMessage);
  return { out, post, frames };
}

async function until(check: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('browser worker loop', () => {
  it('answers pings at once and refuses requests until the cards are read', async () => {
    const { out, post } = worker();
    post({ kind: 'ping', id: 1 });
    expect(out).toEqual([{ kind: 'pong', id: 1 }]);
    post({ kind: 'request', id: 2, op: 'knownDecks' });
    await until(() => out.length === 2);
    expect(out[1]).toMatchObject({ kind: 'reply', id: 2, status: 503 });
  });

  it('reads the card files, then plays a pasted deck against bots to the end', async () => {
    const { out, post, frames } = worker();
    post({ kind: 'init', cardsUrl: 'https://example.test/cards/' });
    await until(() => out.some((m) => m.kind === 'ready'));
    expect(out.find((m) => m.kind === 'ready')).toMatchObject({ cards: cards.length });

    post({
      kind: 'frame',
      text: JSON.stringify({
        type: 'startGame',
        payload: {
          seats: [
            { kind: 'plaintext', text: DECK },
            { kind: 'pool' },
            { kind: 'pool' },
            { kind: 'pool' },
          ],
          providerKind: 'random',
          seed: 'worker-test',
          paceMs: 0,
        },
      }),
    });
    await until(() =>
      frames().some((frame) => frame.type === 'gameOver' || frame.type === 'computeHalted'),
    );
    const started = frames().find((frame) => frame.type === 'gameStarted');
    // The pasted deck sits in P1, seated through the memory deck store.
    expect(started?.type === 'gameStarted' && started.payload.seats[0]?.commanderNames).toEqual([
      'Breena, the Demagogue',
    ]);
    expect(frames().filter((frame) => frame.type === 'error')).toEqual([]);
  }, 90_000);

  it('previews a pasted deck and lists the bot decks', async () => {
    const { out, post } = worker();
    post({ kind: 'init', cardsUrl: 'https://example.test/cards/' });
    post({
      kind: 'request',
      id: 7,
      op: 'setupPreview',
      body: JSON.stringify({
        seats: [
          { kind: 'plaintext', text: DECK },
          { kind: 'pool' },
          { kind: 'pool' },
          { kind: 'pool' },
        ],
        providerKind: 'random',
      }),
    });
    post({ kind: 'request', id: 8, op: 'knownDecks' });
    await until(() => out.filter((m) => m.kind === 'reply').length === 2);
    const preview = out.find((m) => m.kind === 'reply' && m.id === 7);
    expect(preview).toMatchObject({ status: 200, body: { blockers: [] } });
    expect(out.find((m) => m.kind === 'reply' && m.id === 8)).toEqual({
      kind: 'reply',
      id: 8,
      status: 200,
      body: { decks: [] },
    });
  });
});
