import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ preview: vi.fn(), setup: vi.fn(), construct: vi.fn() }));
vi.mock('../match/preview', () => ({ previewMatchup: mocks.preview }));
vi.mock('../match/setup', () => ({ setupSeats: mocks.setup }));
vi.mock('../match/session', () => ({
  MatchSession: class {
    constructor(...args: unknown[]) {
      mocks.construct(...args);
    }
  },
}));
import { GameServer } from './server';
import type { GameServerDeps } from './server';

const request = {
  seats: Array.from({ length: 4 }, () => ({ kind: 'pool' as const })),
  seed: 'fixed',
  providerKind: 'random' as const,
  gameMode: 'singlePlayer' as const,
  humanSeat: 'P1' as const,
};
const seam = () =>
  new GameServer({} as GameServerDeps) as unknown as {
    setupPreviews: Map<string, { request: typeof request; createdAt: number }>;
    handleMessage(socket: unknown, raw: string): Promise<void>;
    handleSetupPreview(request: Request): Promise<Response>;
  };

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.setup.mockReset();
  mocks.construct.mockReset();
});

describe('preview-bound start', () => {
  it.each(['close', 'abandon'])(
    'cancels before setup when %s occurs during revalidation',
    async (interruption) => {
      const server = seam();
      server.setupPreviews.set('token', { request, createdAt: Date.now() });
      let release!: (value: { blockers: string[] }) => void;
      mocks.preview.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const socket = { send: vi.fn() };
      const pending = server.handleMessage(
        socket,
        JSON.stringify({ type: 'startGame', payload: { ...request, previewId: 'token' } }),
      );
      if (interruption === 'close') {
        (server as unknown as { onSocketClose(socket: unknown): void }).onSocketClose(socket);
      } else {
        await server.handleMessage(socket, JSON.stringify({ type: 'abandonGame', payload: {} }));
      }
      release({ blockers: [] });
      await pending;
      expect(mocks.setup).not.toHaveBeenCalled();
      expect(mocks.construct).not.toHaveBeenCalled();
    },
  );
  it('rejects changed selections before any setup write', async () => {
    const server = seam();
    server.setupPreviews.set('token', { request, createdAt: Date.now() });
    const socket = { send: vi.fn() };
    await server.handleMessage(
      socket,
      JSON.stringify({
        type: 'startGame',
        payload: { ...request, seed: 'changed', previewId: 'token' },
      }),
    );
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('selections changed'));
  });

  it('revalidates model blockers before setup or game construction', async () => {
    const server = seam();
    server.setupPreviews.set('token', { request, createdAt: Date.now() });
    mocks.preview.mockResolvedValue({ blockers: ['P1: Deck is no longer fully modeled.'] });
    const socket = { send: vi.fn() };
    await server.handleMessage(
      socket,
      JSON.stringify({ type: 'startGame', payload: { ...request, previewId: 'token' } }),
    );
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
    // The blocker list is per-seat free text naming unmodeled cards, and a blocker gives no way
    // to tell the requester's own seat from an opponent's, so a single-player refusal reports
    // that setup failed and nothing more. The revalidation itself is asserted above.
    expect(socket.send).toHaveBeenCalledOnce();
    const frame = String(socket.send.mock.calls[0]![0]);
    expect(frame).not.toContain('no longer fully modeled');
    expect(JSON.parse(frame)).toEqual({
      type: 'error',
      payload: { message: expect.any(String) },
    });
  });

  it('still reports blockers to a spectator, who is hidden from no seat', async () => {
    const server = seam();
    const spectatorRequest = {
      seats: request.seats,
      seed: request.seed,
      providerKind: request.providerKind,
      gameMode: 'spectator' as const,
    };
    server.setupPreviews.set('token', {
      request: spectatorRequest as unknown as typeof request,
      createdAt: Date.now(),
    });
    mocks.preview.mockResolvedValue({ blockers: ['P1: Deck is no longer fully modeled.'] });
    const socket = { send: vi.fn() };
    await server.handleMessage(
      socket,
      JSON.stringify({ type: 'startGame', payload: { ...spectatorRequest, previewId: 'token' } }),
    );
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('no longer fully modeled'));
  });
});

/**
 * `/api/setup-preview` is the one setup entry point that never crosses `/ws`, so the strict
 * inbound parser had to be wired to it separately. These cases post *raw text*, not an object:
 * a duplicate key cannot survive `JSON.stringify`, so a test that builds its body from a literal
 * proves nothing about the endpoint. Each ambiguous body must be refused before `previewMatchup`
 * runs, before setup or a session is constructed, and before anything enters the preview cache —
 * a cached preview is a token the caller can later start a game from.
 */
describe('setup-preview HTTP body parsing', () => {
  const raw = (body: string) =>
    new Request('http://127.0.0.1:3001/api/setup-preview', { method: 'POST', body });
  const valid = JSON.stringify(request);

  async function refused(body: string): Promise<Response> {
    const server = seam();
    const response = await server.handleSetupPreview(raw(body));
    expect(response.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(server.setupPreviews.size).toBe(0);
    return response;
  }

  it('refuses a body that repeats a top-level key instead of taking the last value', async () => {
    const response = await refused(
      '{"seats":[{"kind":"pool"},{"kind":"pool"},{"kind":"pool"},{"kind":"pool"}],' +
        '"seed":"fixed","providerKind":"random","gameMode":"singlePlayer",' +
        '"humanSeat":"P1","humanSeat":"P2"}',
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body['message']).toBe('string');
    // Nothing from an unreadable body may be quoted back, so neither disputed value appears.
    expect(JSON.stringify(body)).not.toContain('P1');
    expect(JSON.stringify(body)).not.toContain('P2');
  });

  it('refuses an escaped alias of a key it already saw', async () => {
    await refused(
      '{"seats":[{"kind":"pool"},{"kind":"pool"},{"kind":"pool"},{"kind":"pool"}],' +
        '"seed":"fixed","providerKind":"random","gameMode":"singlePlayer",' +
        '"humanSeat":"P1","human\u0053eat":"P2"}',
    );
  });

  it('refuses a duplicate nested inside an object inside the seats array', async () => {
    await refused(
      '{"seats":[{"kind":"pool","kind":"pool"},{"kind":"pool"},{"kind":"pool"},{"kind":"pool"}],' +
        '"seed":"fixed","providerKind":"random","gameMode":"singlePlayer","humanSeat":"P1"}',
    );
  });

  it('refuses duplicate prototype-related keys', async () => {
    await refused(
      '{"__proto__":{"a":1},"__proto__":{"b":2},' +
        '"seats":[{"kind":"pool"},{"kind":"pool"},{"kind":"pool"},{"kind":"pool"}],' +
        '"seed":"fixed","providerKind":"random","gameMode":"singlePlayer","humanSeat":"P1"}',
    );
    await refused(
      '{"seats":[{"kind":"pool"},{"kind":"pool"},{"kind":"pool"},{"kind":"pool"}],' +
        '"seed":"fixed","providerKind":"random","gameMode":"singlePlayer","humanSeat":"P1",' +
        '"constructor":1,"constructor":2}',
    );
  });

  it('refuses a malformed body', async () => {
    await refused('{"seats":[{"kind":"pool"}');
    await refused('not json at all');
  });

  it('refuses a body nested past the depth bound', async () => {
    await refused('['.repeat(70) + ']'.repeat(70));
  });

  it('answers every unreadable body with the same fixed message', async () => {
    const messages = await Promise.all(
      ['{"a":1,"a":2}', '{"seats":', '['.repeat(70) + ']'.repeat(70)].map(async (body) => {
        const server = seam();
        const response = await server.handleSetupPreview(raw(body));
        return ((await response.json()) as { message?: unknown })['message'];
      }),
    );
    expect(new Set(messages).size).toBe(1);
  });

  it('still previews and caches a legitimate body', async () => {
    const server = seam();
    mocks.preview.mockResolvedValue({ seed: 'fixed', seats: [], blockers: [] });
    const response = await server.handleSetupPreview(raw(valid));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(typeof body['previewId']).toBe('string');
    expect(body['blockers']).toEqual([]);
    expect(server.setupPreviews.size).toBe(1);
    expect([...server.setupPreviews.keys()]).toEqual([body['previewId']]);
  });

  it('keeps the existing schema and seat-count refusals', async () => {
    const server = seam();
    const bad = await server.handleSetupPreview(raw('{"seats":[]}'));
    expect(bad.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
    const short = await server.handleSetupPreview(
      raw(JSON.stringify({ ...request, seats: [{ kind: 'pool' }] })),
    );
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ message: 'Exactly four seats are required.' });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(server.setupPreviews.size).toBe(0);
  });
});

/**
 * The cases above mock `previewMatchup`, which is exactly what lets them assert *that it never
 * ran*. The leak covered below is inside it, so it needs the real thing: a real `GameStore` holding
 * saved snapshots whose stored metadata is a sentinel, the real preview, and a real HTTP round trip
 * against a listening server. A preview is public — three of its four seats belong to opponents —
 * so the assertion is on the complete response bytes, for every choice of human seat.
 *
 * Vitest runs under Node; `Bun.serve` and `bun:sqlite` need Bun, so the scenario runs in a Bun
 * subprocess exactly as `match/preview.test.ts` does.
 */
const REAL_HTTP_PREVIEW_SCENARIO = `
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { Database } from 'bun:sqlite';
  import { GameStore } from './packages/server/src/db/index.ts';
  import { buildSupportedPool } from './packages/server/src/cards/pool.ts';
  import { buildOracleIndex } from './packages/server/src/cards/oracle-index.ts';
  import { toOracleCard } from './packages/server/src/cards/scryfall.ts';
  import { parseBannedList } from './packages/server/src/decks/banned.ts';
  import { GameServer } from './packages/server/src/ws/server.ts';

  const SENTINEL = 'Zzyzx-Private-Saved-Commander';
  const ARCHETYPE_SENTINEL = 'Zzyzx-Private-Archetype';

  const spell = (over) => ({
    id: 'scry-' + over.oracle_id, layout: 'normal', mana_cost: '{1}{G}', cmc: 2,
    colors: ['G'], color_identity: ['G'], type_line: 'Creature — Bear', oracle_text: '',
    power: '2', toughness: '2', legalities: { commander: 'legal' }, ...over,
  });
  const basic = (oracleId, name, color) => ({
    id: 'scry-' + oracleId, oracle_id: oracleId, name, layout: 'normal', mana_cost: '', cmc: 0,
    colors: [], color_identity: [color], type_line: 'Basic Land — ' + name,
    oracle_text: '', legalities: { commander: 'legal' },
  });

  const raws = [
    spell({ oracle_id: 'cmd-1', name: 'Phase Test General', mana_cost: '{2}{G}', cmc: 3,
            type_line: 'Legendary Creature — Bear Captain' }),
    basic('forest-1', 'Forest', 'G'),
    basic('island-1', 'Island', 'U'),
  ];
  for (let i = 0; i < 140; i++) {
    const green = i % 3 === 0;
    raws.push(spell({ oracle_id: 'bear-' + i, name: 'Phase Test Bear ' + i,
                      colors: green ? ['G'] : [], color_identity: green ? ['G'] : [],
                      mana_cost: green ? '{1}{G}' : '{2}' }));
  }

  const pool = buildSupportedPool(raws.map(toOracleCard).filter((card) => card !== null));
  const index = buildOracleIndex(raws);
  const banned = parseBannedList('');

  const dir = mkdtempSync(join(tmpdir(), 'mtg-preview-http-'));
  const path = join(dir, 'preview.sqlite');
  const store = new GameStore(path);

  // A seat whose saved cards are gone from today's Oracle index: validation fails.
  const goneDeck = store.insertDeck({
    name: 'Saved Gone Deck', sourceUrl: null, sourceType: 'plaintext',
    archetypeTag: ARCHETYPE_SENTINEL,
  });
  const gone = store.insertSnapshot({
    deckId: goneDeck.id, commanderOracleIds: ['missing-oracle'], commanderNames: [SENTINEL],
    companionOracleId: null, colorIdentity: ['B', 'R'],
    cards: [{ oracleId: 'missing-oracle', name: SENTINEL, quantity: 100 }],
  });

  // A seat whose stored card list no longer decodes: the read itself throws.
  const rottenDeck = store.insertDeck({
    name: 'Saved Rotten Deck', sourceUrl: null, sourceType: 'plaintext',
    archetypeTag: ARCHETYPE_SENTINEL,
  });
  const rotten = store.insertSnapshot({
    deckId: rottenDeck.id, commanderOracleIds: ['cmd-1'], commanderNames: [SENTINEL],
    companionOracleId: null, colorIdentity: ['B', 'R'],
    cards: [{ oracleId: 'cmd-1', name: SENTINEL, quantity: 1 },
            { oracleId: 'forest-1', name: 'Forest', quantity: 99 }],
  });

  // A seat that resolves: its commander name and identity are rebuilt from the current index,
  // so a stale saved name must not survive even on the success path.
  const goodDeck = store.insertDeck({
    name: 'Saved Good Deck', sourceUrl: null, sourceType: 'plaintext', archetypeTag: 'Lands',
  });
  const good = store.insertSnapshot({
    deckId: goodDeck.id, commanderOracleIds: ['cmd-1'], commanderNames: [SENTINEL],
    companionOracleId: null, colorIdentity: ['B', 'R'],
    cards: [{ oracleId: 'cmd-1', name: 'Phase Test General', quantity: 1 },
            { oracleId: 'forest-1', name: 'Forest', quantity: 99 }],
  });

  // Corrupt the stored card list through a second connection, so the decode failure is a real one.
  const writer = new Database(path);
  writer.run("UPDATE deck_snapshots SET card_list_json = '{not json' WHERE id = ?", [rotten.id]);
  writer.close();

  const listening = new GameServer({ pool, index, banned, store, port: 0 }).listen();
  const endpoint = 'http://127.0.0.1:' + listening.port + '/api/setup-preview';
  const post = async (body) => {
    const response = await fetch(endpoint, { method: 'POST', body });
    return { status: response.status, text: await response.text() };
  };

  const seats = [
    { kind: 'snapshot', snapshotId: gone.id },
    { kind: 'snapshot', snapshotId: rotten.id },
    { kind: 'snapshot', snapshotId: good.id },
    { kind: 'pool', seed: 'http-pod-P4' },
  ];
  const perSeat = {};
  for (const humanSeat of ['P1', 'P2', 'P3', 'P4']) {
    const answer = await post(JSON.stringify({
      seats, seed: 'http-fixed', providerKind: 'random', gameMode: 'singlePlayer', humanSeat,
    }));
    const parsed = JSON.parse(answer.text);
    const publicFields = (seat) => ({
      commanderNames: seat.commanderNames, colorIdentity: seat.colorIdentity,
      archetypeTag: seat.archetypeTag, modeled: seat.modeled,
    });
    perSeat[humanSeat] = {
      status: answer.status,
      leaksSentinel: answer.text.includes(SENTINEL) || answer.text.includes(ARCHETYPE_SENTINEL),
      leaksCardData: /oracleId|card_list|cardList|decklist|snapshotId/i.test(answer.text),
      blockers: parsed.blockers,
      failedSeats: [publicFields(parsed.seats[0]), publicFields(parsed.seats[1])],
      resolvedSeat: publicFields(parsed.seats[2]),
      controllers: parsed.seats.map((seat) => seat.controller),
      hasPreviewId: typeof parsed.previewId === 'string' && parsed.previewId.length > 0,
    };
  }

  // The same endpoint, over real HTTP, with a body the native parser would resolve last-wins.
  const duplicate = await post(
    '{"seats":' + JSON.stringify(seats) + ',"seed":"http-fixed","providerKind":"random",' +
    '"gameMode":"singlePlayer","humanSeat":"P1","humanSeat":"P4"}',
  );

  console.log(JSON.stringify({ perSeat, duplicate }));
  listening.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
`;

describe('setup-preview over real HTTP with a real preview', () => {
  it('publishes no unvalidated saved metadata for a failed seat, for any human seat', () => {
    const output = execFileSync('bun', ['-e', REAL_HTTP_PREVIEW_SCENARIO], { encoding: 'utf8' });
    const observed = JSON.parse(output) as {
      perSeat: Record<string, Record<string, unknown>>;
      duplicate: { status: number; text: string };
    };

    const neutral = { commanderNames: [], colorIdentity: [], archetypeTag: '', modeled: false };
    for (const humanSeat of ['P1', 'P2', 'P3', 'P4']) {
      const seat = observed.perSeat[humanSeat]!;
      expect(seat['status']).toBe(200);
      expect(seat['leaksSentinel']).toBe(false);
      expect(seat['leaksCardData']).toBe(false);
      expect(seat['failedSeats']).toEqual([neutral, neutral]);
      expect(seat['blockers']).toEqual([
        'P1: Saved deck has cards missing from the current Oracle index.',
        'P2: Could not inspect the deck.',
      ]);
      // Valid, resolved public metadata still comes back, rebuilt from the current Oracle index.
      expect(seat['resolvedSeat']).toEqual({
        commanderNames: ['Phase Test General'],
        colorIdentity: ['G'],
        archetypeTag: 'Lands',
        modeled: true,
      });
      expect(seat['hasPreviewId']).toBe(true);
      const controllers = seat['controllers'] as string[];
      expect(controllers[Number(humanSeat.slice(1)) - 1]).toBe('human');
    }

    // The strict read is on the real HTTP path too, not only the in-process seam.
    expect(observed.duplicate.status).toBe(400);
    expect(observed.duplicate.text).not.toContain('P4');
  });
});
