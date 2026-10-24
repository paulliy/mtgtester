import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOracleIndex } from './oracle-index';
import type { RawScryfallCard } from './scryfall';
import { listKnownDecks } from './known-decks';

const raw = (
  partial: Partial<RawScryfallCard> & { name: string; oracle_id: string },
): RawScryfallCard => ({
  id: partial.oracle_id,
  mana_cost: '',
  cmc: 0,
  colors: [],
  color_identity: [],
  type_line: 'Creature',
  oracle_text: '',
  keywords: [],
  legalities: { commander: 'legal' },
  ...partial,
});

const index = buildOracleIndex([
  raw({
    name: 'Test Commander',
    oracle_id: 'test-commander',
    mana_cost: '{2}{W}',
    cmc: 3,
    colors: ['W'],
    color_identity: ['W'],
    type_line: 'Legendary Creature — Human',
    power: '2',
    toughness: '2',
  }),
  raw({
    name: 'Plains',
    oracle_id: 'plains',
    color_identity: ['W'],
    type_line: 'Basic Land — Plains',
  }),
  raw({
    name: 'Mystery Device',
    oracle_id: 'mystery-device',
    mana_cost: '{1}',
    cmc: 1,
    type_line: 'Artifact',
    oracle_text: 'The moon eats seven sandwiches.',
  }),
]);

const banned = { names: [], isBanned: () => false };
const tempDirs: string[] = [];

function fixture(name: string, deckLines: string[]): void {
  const dir = tempDirs.at(-1);
  if (dir === undefined) throw new Error('Test fixture directory was not created.');
  writeFileSync(
    join(dir, `${name}.txt`),
    ['Commander', '1 Test Commander', '', 'Deck', ...deckLines, ''].join(String.fromCharCode(10)),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('listKnownDecks', () => {
  it('offers only legal, fully modeled Commander decks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mtg-known-decks-'));
    tempDirs.push(dir);
    fixture('playable', ['99 Plains']);
    fixture('wrong-card-count', ['101 Plains']);
    fixture('contains-unmodeled-card', ['98 Plains', '1 Mystery Device']);

    const decks = await listKnownDecks(index, banned, dir);

    expect(decks.map((deck) => deck.slug)).toEqual(['playable']);
    expect(decks[0]).toMatchObject({
      commanderNames: ['Test Commander'],
      commanderScryfallIds: ['test-commander'],
      uniqueCards: 2,
      modeledCards: 2,
    });
  });
});
