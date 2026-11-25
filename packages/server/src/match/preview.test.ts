import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { previewMatchup, resolveSavedSeat, type PreviewDeps } from './preview';
import { makeOracleCard, forest } from '../test-factory';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { parseBannedList } from '../decks/banned';

describe('matchup preview', () => {
  it('rehydrates a stable snapshot ID and checks current legality and model status', () => {
    const commander = makeOracleCard({
      name: 'Test General',
      typeLine: 'Legendary Creature — Elf',
      supertypes: ['Legendary'],
      types: ['Creature'],
      colorIdentity: ['G'],
    });
    const land = forest();
    const cards = [commander, land];
    const snapshot = {
      snapshotId: 'stable',
      name: 'My deck',
      commanderNames: ['Test General'],
      colorIdentity: ['G'],
      archetypeTag: 'Lands',
      companionOracleId: null,
      cards: [
        { oracleId: commander.oracleId, name: commander.name, quantity: 1 },
        { oracleId: land.oracleId, name: land.name, quantity: 99 },
      ],
    };
    const deps = {
      store: { savedSnapshot: () => snapshot },
      index: { getByOracleId: (id: string) => cards.find((card) => card.oracleId === id) ?? null },
      banned: parseBannedList(''),
    } as unknown as PreviewDeps;
    const valid = resolveSavedSeat('P1', 'stable', deps);
    expect('config' in valid).toBe(true);
    if ('config' in valid) expect(valid.config.cards).toHaveLength(99);
    const missing = resolveSavedSeat('P1', 'stable', {
      ...deps,
      index: { getByOracleId: () => null },
    } as unknown as PreviewDeps);
    expect('message' in missing && missing.message).toMatch(
      /missing from the current Oracle index/,
    );
    const illegal = resolveSavedSeat('P1', 'stable', {
      ...deps,
      banned: parseBannedList('#### Test General'),
    } as PreviewDeps);
    expect('message' in illegal && illegal.message).toMatch(/no longer Commander legal/);
    const renamed = { ...commander, name: 'Renamed General' };
    const current = resolveSavedSeat('P1', 'stable', {
      ...deps,
      store: { savedSnapshot: () => ({ ...snapshot, commanderOracleIds: [commander.oracleId] }) },
      index: { getByOracleId: (id: string) => (id === commander.oracleId ? renamed : land) },
    } as unknown as PreviewDeps);
    expect('summary' in current && current.summary.commanderNames).toEqual(['Renamed General']);
  });
  it('uses one seed and named generated pod without writing snapshots or leaking decklists', async () => {
    const write = vi.fn(() => {
      throw new Error('preview wrote to DB');
    });
    const deps = {
      pool: { cards: [] },
      index: {},
      banned: {},
      store: { insertDeck: write, insertSnapshot: write },
    } as unknown as PreviewDeps;
    const result = await previewMatchup(
      {
        seats: Array.from({ length: 4 }, () => ({ kind: 'pool' as const })),
        seed: 'fixed',
        providerKind: 'random',
        gameMode: 'singlePlayer',
        humanSeat: 'P1',
      },
      deps,
    );
    expect(result.seed).toBe('fixed');
    expect(result.seats).toHaveLength(4);
    expect(result.seats[0]?.controller).toBe('human');
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/cards|decklist|oracleId/i);
    expect(write).not.toHaveBeenCalled();
  });

  it('shows every human seat of a table preview as human', async () => {
    const deps = { pool: { cards: [] }, index: {}, banned: {} } as unknown as PreviewDeps;
    const result = await previewMatchup(
      {
        seats: Array.from({ length: 4 }, () => ({ kind: 'pool' as const })),
        seed: 'fixed',
        providerKind: 'random',
        gameMode: 'table',
        seatControllers: { P1: 'human', P2: 'random', P3: 'human', P4: 'random' },
      },
      deps,
    );
    expect(result.seats.map((seat) => seat.controller)).toEqual([
      'human',
      'random',
      'human',
      'random',
    ]);
  });

  it('marks missing saved snapshots as blocked and disables them without DB', async () => {
    const input = {
      seats: [
        { kind: 'snapshot' as const, snapshotId: 'missing' },
        ...Array.from({ length: 3 }, () => ({ kind: 'pool' as const })),
      ],
      seed: 'fixed',
      providerKind: 'random' as const,
      gameMode: 'singlePlayer' as const,
      humanSeat: 'P1' as const,
    };
    const deps = { pool: { cards: [] }, index: {}, banned: {} } as unknown as PreviewDeps;
    const result = await previewMatchup(input, deps);
    expect(result.blockers[0]).toMatch(/saved decks.*disabled/i);
    expect(result.seats[0]?.modeled).toBe(false);
  });
});

describe('unmodeled cards in a preview (ADR 0054)', () => {
  const general = makeOracleCard({
    name: 'Test General',
    typeLine: 'Legendary Creature \u2014 Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    colorIdentity: ['G'],
  });
  const odd = makeOracleCard({
    name: 'Mystery Engine',
    typeLine: 'Artifact',
    types: ['Artifact'],
    oracleText: 'Whenever the moon is full, flarb the zonk.',
  });
  const land = forest();
  const cards = [general, odd, land];
  const index = buildOracleIndexFromCards(cards);
  const base = {
    seed: 'fixed',
    providerKind: 'random' as const,
    gameMode: 'singlePlayer' as const,
    humanSeat: 'P1' as const,
  };
  const pool = (n: number) => Array.from({ length: n }, () => ({ kind: 'pool' as const }));

  it('names the unsupported cards of a pasted list, with a hash and no status it did not earn', async () => {
    const deps = {
      pool: { cards: [] },
      index,
      banned: parseBannedList(''),
      store: {},
    } as unknown as PreviewDeps;
    const text = 'Commander\n1 Test General\n\nDeck\n1 Mystery Engine\n10 Forest';
    const result = await previewMatchup(
      { ...base, seats: [{ kind: 'plaintext', text }, ...pool(3)] },
      deps,
    );
    const seat = result.seats[0]!;
    expect(seat.modeled).toBe(false);
    expect(result.blockers).toContain('P1: Deck is not fully modeled.');
    expect(seat.unmodeledCards).toEqual([
      {
        name: 'Mystery Engine',
        oracleSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: 'unsupported',
      },
    ]);
    // A generated seat sends no card names at all.
    expect(result.seats[1]).not.toHaveProperty('unmodeledCards');
  });

  it('sends no card names for a fully modeled pasted list', async () => {
    const deps = {
      pool: { cards: [] },
      index,
      banned: parseBannedList(''),
      store: {},
    } as unknown as PreviewDeps;
    const text = 'Commander\n1 Test General\n\nDeck\n10 Forest';
    const result = await previewMatchup(
      { ...base, seats: [{ kind: 'plaintext', text }, ...pool(3)] },
      deps,
    );
    expect(result.seats[0]?.modeled).toBe(true);
    expect(result.seats[0]).not.toHaveProperty('unmodeledCards');
  });

  it('marks an admitted provisional card provisional and does not block on it', async () => {
    const provisional = { definitions: new Map([[odd.oracleId, {}]]) };
    const deps = {
      pool: { cards: [], provisional },
      index,
      banned: parseBannedList(''),
      store: {},
    } as unknown as PreviewDeps;
    const text = 'Commander\n1 Test General\n\nDeck\n1 Mystery Engine\n10 Forest';
    const result = await previewMatchup(
      { ...base, seats: [{ kind: 'plaintext', text }, ...pool(3)] },
      deps,
    );
    expect(result.seats[0]?.modeled).toBe(true);
    expect(result.seats[0]?.unmodeledCards?.map((card) => [card.name, card.status])).toEqual([
      ['Mystery Engine', 'provisional'],
    ]);
  });

  it('names the unsupported cards of a saved deck that is no longer fully modeled', async () => {
    const snapshot = {
      snapshotId: 'stable',
      name: 'My deck',
      commanderNames: ['Test General'],
      colorIdentity: ['G'],
      archetypeTag: 'Lands',
      companionOracleId: null,
      cards: [
        { oracleId: general.oracleId, name: general.name, quantity: 1 },
        { oracleId: odd.oracleId, name: odd.name, quantity: 1 },
        { oracleId: land.oracleId, name: land.name, quantity: 98 },
      ],
    };
    const deps = {
      pool: { cards: [] },
      store: { savedSnapshot: () => snapshot },
      index,
      banned: parseBannedList(''),
    } as unknown as PreviewDeps;
    const result = await previewMatchup(
      { ...base, seats: [{ kind: 'snapshot', snapshotId: 'stable' }, ...pool(3)] },
      deps,
    );
    expect(result.blockers[0]).toMatch(/no longer fully modeled/);
    expect(result.seats[0]?.modeled).toBe(false);
    expect(result.seats[0]?.unmodeledCards?.map((card) => [card.name, card.status])).toEqual([
      ['Mystery Engine', 'unsupported'],
    ]);
  });
});

/**
 * The write-free guarantee against a real SQLite store (Phase 9.1). The fake-store test above can
 * only prove that two named methods went uncalled, and its empty pool blocks every seat before the
 * interesting code runs. Here a real GameStore holds a real saved snapshot, the preview succeeds on
 * all four seats, and every row of every table is compared before and after.
 *
 * Vitest runs under Node; `bun:sqlite` needs Bun, so the scenario runs in a Bun subprocess exactly
 * as `db/batches-recovery.test.ts` does.
 */
describe('preview against a real store', () => {
  it('resolves a saved snapshot and a generated pod without writing a single row', () => {
    const output = execFileSync(
      'bun',
      [
        '-e',
        `
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { Database } from 'bun:sqlite';
    import { GameStore } from './packages/server/src/db/index.ts';
    import { buildSupportedPool } from './packages/server/src/cards/pool.ts';
    import { buildOracleIndex } from './packages/server/src/cards/oracle-index.ts';
    import { toOracleCard } from './packages/server/src/cards/scryfall.ts';
    import { parseBannedList } from './packages/server/src/decks/banned.ts';
    import { previewMatchup } from './packages/server/src/match/preview.ts';

    const spell = (over) => ({
      id: 'scry-' + over.oracle_id, layout: 'normal', mana_cost: '{1}{G}', cmc: 2,
      colors: ['G'], color_identity: ['G'], type_line: 'Creature \u2014 Bear', oracle_text: '',
      power: '2', toughness: '2', legalities: { commander: 'legal' }, ...over,
    });
    const basic = (oracleId, name, color) => ({
      id: 'scry-' + oracleId, oracle_id: oracleId, name, layout: 'normal', mana_cost: '', cmc: 0,
      colors: [], color_identity: [color], type_line: 'Basic Land \u2014 ' + name,
      oracle_text: '', legalities: { commander: 'legal' },
    });

    const raws = [
      spell({ oracle_id: 'cmd-1', name: 'Phase Test General', mana_cost: '{2}{G}', cmc: 3,
              type_line: 'Legendary Creature \u2014 Bear Captain' }),
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

    const dir = mkdtempSync(join(tmpdir(), 'mtg-preview-nowrite-'));
    const path = join(dir, 'preview.sqlite');
    const store = new GameStore(path);
    const deck = store.insertDeck({
      name: 'Saved Phase Test Deck', sourceUrl: null, sourceType: 'plaintext', archetypeTag: 'Lands',
    });
    const snapshot = store.insertSnapshot({
      deckId: deck.id,
      commanderOracleIds: ['cmd-1'],
      commanderNames: ['Phase Test General'],
      companionOracleId: null,
      colorIdentity: ['G'],
      cards: [
        { oracleId: 'cmd-1', name: 'Phase Test General', quantity: 1 },
        { oracleId: 'forest-1', name: 'Forest', quantity: 99 },
      ],
    });

    // A second connection to the same file, so "no writes" is measured from the database itself
    // rather than from spies on the two methods a preview is already known not to call.
    const reader = new Database(path);
    const tables = reader
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => row.name);
    const dump = () => tables.map((table) => [table, reader.query('SELECT * FROM ' + table).all()]);
    const rowCount = (snap) => snap.reduce((total, entry) => total + entry[1].length, 0);

    const before = dump();
    const result = await previewMatchup(
      {
        seats: [
          { kind: 'snapshot', snapshotId: snapshot.id },
          { kind: 'pool', seed: 'phase9-pod-P2' },
          { kind: 'pool', seed: 'phase9-pod-P3' },
          { kind: 'pool', seed: 'phase9-pod-P4' },
        ],
        seed: 'phase91-fixed', providerKind: 'random', gameMode: 'singlePlayer', humanSeat: 'P1',
      },
      { pool, index, banned, store },
    );
    const after = dump();

    console.log(JSON.stringify({
      blockers: result.blockers,
      seatCount: result.seats.length,
      modeled: result.seats.filter((seat) => seat.modeled).length,
      controllers: result.seats.map((seat) => seat.controller),
      savedCommanders: result.seats[0].commanderNames,
      savedArchetype: result.seats[0].archetypeTag,
      seed: result.seed,
      tables: tables.length,
      rowsBefore: rowCount(before),
      unchanged: JSON.stringify(before) === JSON.stringify(after),
      leaksDecklist: /oracleId|decklist/i.test(JSON.stringify(result)),
    }));
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  `,
      ],
      { encoding: 'utf8' },
    );
    const observed = JSON.parse(output) as Record<string, unknown>;

    expect(observed).toMatchObject({
      blockers: [],
      seatCount: 4,
      modeled: 4,
      controllers: ['human', 'random', 'random', 'random'],
      savedCommanders: ['Phase Test General'],
      savedArchetype: 'Lands',
      seed: 'phase91-fixed',
      unchanged: true,
      leaksDecklist: false,
    });
    // The dump has teeth only if the store really held rows to change.
    expect(observed['rowsBefore']).toBeGreaterThan(0);
  });
});

/**
 * A preview is public: all four seats of it are returned to whoever asked, and three of them are
 * opponents. So the only commander/identity/archetype data a seat may carry is data that came back
 * out of `resolveSavedSeat` — reconstructed from stable Oracle IDs against today's index and
 * checked for legality and model support. When that resolution *fails*, the seat keeps the neutral
 * fields the summary was initialized with. Copying the snapshot's own cached
 * `commanderNames`/`colorIdentity`/`archetypeTag` in as a fallback would publish stored deck
 * metadata that nothing validated, on exactly the path where validation is known to have failed.
 */
describe('failed saved-seat previews', () => {
  const SENTINEL = 'Zzyzx-Private-Saved-Commander';
  const neutral = { commanderNames: [], colorIdentity: [], archetypeTag: '', modeled: false };
  const privateSnapshot = {
    snapshotId: 'saved',
    name: 'Saved deck',
    commanderNames: [SENTINEL],
    colorIdentity: ['B', 'R'],
    archetypeTag: `Aristocrats (${SENTINEL})`,
    companionOracleId: null,
    cards: [{ oracleId: 'gone', name: SENTINEL, quantity: 100 }],
  };
  const input = {
    seats: [
      { kind: 'snapshot' as const, snapshotId: 'saved' },
      ...Array.from({ length: 3 }, () => ({ kind: 'pool' as const })),
    ],
    seed: 'fixed',
    providerKind: 'random' as const,
    gameMode: 'singlePlayer' as const,
    humanSeat: 'P2' as const,
  };

  it('keeps the neutral summary when validation fails, not the unvalidated saved metadata', async () => {
    const deps = {
      pool: { cards: [] },
      index: { getByOracleId: () => null },
      banned: parseBannedList(''),
      store: { savedSnapshot: () => privateSnapshot },
    } as unknown as PreviewDeps;
    const result = await previewMatchup(input, deps);
    expect(result.seats[0]).toMatchObject(neutral);
    expect(result.blockers[0]).toMatch(/missing from the current Oracle index/);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain('Aristocrats');
  });

  it('keeps the neutral summary when the snapshot read itself throws', async () => {
    const deps = {
      pool: { cards: [] },
      index: { getByOracleId: () => null },
      banned: parseBannedList(''),
      store: {
        savedSnapshot: () => {
          throw new Error(`decode failed for ${SENTINEL}`);
        },
      },
    } as unknown as PreviewDeps;
    const result = await previewMatchup(input, deps);
    expect(result.seats[0]).toMatchObject(neutral);
    expect(result.blockers[0]).toBe('P1: Could not inspect the deck.');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('reads the snapshot once per failed seat rather than re-reading it for a fallback', async () => {
    const reads = vi.fn(() => privateSnapshot);
    const deps = {
      pool: { cards: [] },
      index: { getByOracleId: () => null },
      banned: parseBannedList(''),
      store: { savedSnapshot: reads },
    } as unknown as PreviewDeps;
    await previewMatchup(input, deps);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('still publishes commander data rebuilt from the current Oracle index on success', async () => {
    const commander = makeOracleCard({
      name: 'Current General',
      typeLine: 'Legendary Creature — Elf',
      supertypes: ['Legendary'],
      types: ['Creature'],
      colorIdentity: ['G'],
    });
    const land = forest();
    const cards = [commander, land];
    const deps = {
      pool: { cards: [] },
      index: {
        getByOracleId: (id: string) => cards.find((card) => card.oracleId === id) ?? null,
      },
      banned: parseBannedList(''),
      store: {
        savedSnapshot: () => ({
          ...privateSnapshot,
          commanderNames: [SENTINEL],
          commanderOracleIds: [commander.oracleId],
          archetypeTag: 'Lands',
          cards: [
            { oracleId: commander.oracleId, name: commander.name, quantity: 1 },
            { oracleId: land.oracleId, name: land.name, quantity: 99 },
          ],
        }),
      },
    } as unknown as PreviewDeps;
    const result = await previewMatchup(input, deps);
    expect(result.seats[0]).toMatchObject({
      commanderNames: ['Current General'],
      colorIdentity: ['G'],
      archetypeTag: 'Lands',
      modeled: true,
    });
    // The stale cached name is replaced by the current one, not merged with it.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
