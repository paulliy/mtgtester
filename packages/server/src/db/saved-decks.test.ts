import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('deduplicates equivalent saved snapshots while retaining changed builds and history', () => {
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

    const dir = mkdtempSync(join(tmpdir(), 'mtg-saved-decks-'));
    const path = join(dir, 'saved.sqlite');
    new GameStore(path).close();
    const db = new Database(path);
    const insertDeck = db.query(
      'INSERT INTO decks (id, name, source_url, source_type, archetype_tag, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertSnapshot = db.query(
      'INSERT INTO deck_snapshots (id, deck_id, commander_names, color_identity, card_list_json, imported_at, companion_oracle_id, commander_oracle_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const deck = (id, name = 'My Deck', tag = 'Aggro', source = 'plaintext') =>
      insertDeck.run(id, name, null, source, tag, '2026-01-01');
    const snapshot = (id, deckId, cards, time, commanderIds = ['cmd-1']) =>
      insertSnapshot.run(id, deckId, JSON.stringify(['Test Commander']), JSON.stringify(['G']),
        JSON.stringify(cards), time, null, commanderIds === null ? null : JSON.stringify(commanderIds));
    const card = (oracleId, quantity) => ({ oracleId, name: oracleId, quantity });

    deck('repeat-old');
    snapshot('repeat-old-snapshot', 'repeat-old', [card('card-a', 1), card('card-b', 2)], '2026-01-01');
    deck('repeat-new');
    snapshot('repeat-new-snapshot', 'repeat-new', [card('card-b', 2), card('card-a', 1)], '2026-01-02');

    deck('changed-cards');
    snapshot('changed-cards-snapshot', 'changed-cards', [card('card-a', 1), card('card-b', 1)], '2026-01-03');
    deck('different-name', 'My Deck v2');
    snapshot('different-name-snapshot', 'different-name', [card('card-a', 1), card('card-b', 2)], '2026-01-04');
    deck('different-tag', 'My Deck', 'Control');
    snapshot('different-tag-snapshot', 'different-tag', [card('card-a', 1), card('card-b', 2)], '2026-01-05');

    deck('legacy-old');
    snapshot('legacy-old-snapshot', 'legacy-old', [card('legacy-card', 1)], '2026-01-06', null);
    deck('legacy-new');
    snapshot('legacy-new-snapshot', 'legacy-new', [card('legacy-card', 1)], '2026-01-07', null);

    deck('generated-copy', 'My Deck', 'Aggro', 'generated');
    snapshot('generated-snapshot', 'generated-copy', [card('card-a', 1), card('card-b', 2)], '2026-01-06');

    db.close();
    const store = new GameStore(path);
    const options = store.savedDeckOptions();
    const oldSnapshotStillExists = store.savedSnapshot('repeat-old-snapshot') !== null;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify({ options, oldSnapshotStillExists }));
  `,
    ],
    { encoding: 'utf8' },
  );

  const result = JSON.parse(output) as {
    options: { snapshotId: string; name: string; archetypeTag: string }[];
    oldSnapshotStillExists: boolean;
  };
  expect(result.options.map((option) => option.snapshotId)).toEqual([
    'legacy-new-snapshot',
    'different-tag-snapshot',
    'different-name-snapshot',
    'changed-cards-snapshot',
    'repeat-new-snapshot',
  ]);
  expect(
    result.options.find((option) => option.snapshotId === 'repeat-new-snapshot'),
  ).toMatchObject({
    name: 'My Deck',
    archetypeTag: 'Aggro',
  });
  expect(result.oldSnapshotStillExists).toBe(true);
});
