import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildOracleIndex, buildOracleIndexFromCards } from './oracle-index';
import type { RawScryfallCard } from './scryfall';
import {
  convertBulkCards,
  loadTableCards,
  serializeTableCards,
  TABLE_CARDS_FORMAT,
} from './table-cards';

const raw: RawScryfallCard[] = [
  {
    id: 's1',
    oracle_id: 'o1',
    name: "Yawgmoth's Bargain",
    type_line: 'Enchantment',
    mana_cost: '{4}{B}{B}',
    cmc: 6,
    color_identity: ['B'],
    legalities: { commander: 'banned' },
  },
  {
    id: 's2',
    oracle_id: 'o2',
    name: 'Fire // Ice',
    layout: 'split',
    type_line: 'Instant // Instant',
    legalities: { commander: 'legal' },
    card_faces: [
      {
        name: 'Fire',
        type_line: 'Instant',
        mana_cost: '{1}{R}',
        oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.',
      },
      {
        name: 'Ice',
        type_line: 'Instant',
        mana_cost: '{1}{U}',
        oracle_text: 'Tap target permanent.\nDraw a card.',
      },
    ],
  },
  {
    id: 's3',
    oracle_id: 'o3',
    name: 'Soldier',
    layout: 'token',
    type_line: 'Token Creature — Soldier',
    legalities: {},
  },
  {
    id: 's4',
    oracle_id: 'o4',
    name: 'Nazgûl',
    type_line: 'Creature — Wraith Knight',
    legalities: { commander: 'legal' },
  },
] as RawScryfallCard[];

const dir = mkdtempSync(join(tmpdir(), 'table-cards-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('prebuilt table card file', () => {
  it('converts the bulk cards toOracleCard keeps, dropping tokens', () => {
    const cards = convertBulkCards(raw);
    expect(cards.map((card) => card.oracleId)).toEqual(['o1', 'o2', 'o4']);
  });

  it('round-trips the converted cards exactly and records the source hash', () => {
    const cards = convertBulkCards(raw);
    const path = join(dir, 'cards.json');
    writeFileSync(path, serializeTableCards(cards, 'abc123'));
    const loaded = loadTableCards(path);
    expect(loaded.cards).toEqual(cards);
    expect(loaded.sourceSha256).toBe('abc123');
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves names exactly as the index built from the bulk file does', () => {
    const path = join(dir, 'index.json');
    writeFileSync(path, serializeTableCards(convertBulkCards(raw), 'x'));
    const fromFile = buildOracleIndexFromCards(loadTableCards(path).cards);
    const fromBulk = buildOracleIndex(raw);
    expect(fromFile.size).toBe(fromBulk.size);
    for (const name of [
      "Yawgmoth's Bargain",
      'yawgmoth’s bargain',
      'Fire',
      'Fire // Ice',
      'Nazgul',
      'Soldier',
    ]) {
      expect(fromFile.resolve(name)).toEqual(fromBulk.resolve(name));
    }
  });

  it('refuses a file of another format, such as the raw bulk array', () => {
    const path = join(dir, 'bulk.json');
    writeFileSync(path, JSON.stringify(raw));
    expect(() => loadTableCards(path)).toThrow(TABLE_CARDS_FORMAT);
  });

  it('refuses a damaged file', () => {
    const path = join(dir, 'damaged.json');
    writeFileSync(path, JSON.stringify({ format: TABLE_CARDS_FORMAT, cards: 'nope' }));
    expect(() => loadTableCards(path)).toThrow('damaged');
  });
});
