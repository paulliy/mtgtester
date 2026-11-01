import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PIN_STORE_PATH,
  oracleSha256,
  pinStore,
  pinStoreErrors,
  type PinStoreFile,
} from './pin-store';

const file = JSON.parse(readFileSync(PIN_STORE_PATH, 'utf8')) as PinStoreFile;
const manifest = JSON.parse(
  readFileSync(
    new URL('../../../server/fixtures/card-verification-manifest.json', import.meta.url),
    'utf8',
  ),
) as { cards: Record<string, { name: string; oracleSha256: string }> };

describe('the Oracle pin store', () => {
  it('holds every card under one of its hashes, and every name points at its own card', () => {
    expect(pinStoreErrors(file)).toEqual([]);
  });

  it("agrees with the manifest's oracleSha256 for every card both name", () => {
    const disagreements = Object.values(manifest.cards)
      .filter((entry) => pinStore.has(entry.name))
      .filter((entry) => pinStore.shaOf(entry.name) !== entry.oracleSha256)
      .map((entry) => entry.name);
    expect(disagreements).toEqual([]);
    expect(Object.values(manifest.cards).every((entry) => pinStore.has(entry.name))).toBe(true);
  });

  it('returns the pinned card for a name and throws on a name it does not hold', () => {
    expect(pinStore.get('Path to Exile').name).toBe('Path to Exile');
    expect(() => pinStore.get('Path To Exile')).toThrow(/not in the pin store/);
    expect(() => pinStore.bySha('0'.repeat(64))).toThrow(/no pinned card/);
  });

  it('reports a card stored under a hash it does not have, and a name with no card', () => {
    const card = pinStore.get('Path to Exile');
    const tampered: PinStoreFile = {
      schemaVersion: 1,
      names: { 'Path to Exile': oracleSha256(card), Duress: 'f'.repeat(64) },
      cards: { [oracleSha256(card)]: { ...card, oracleText: 'Exile target creature.' } },
    };
    expect(pinStoreErrors(tampered)).toEqual([
      expect.stringContaining('Path to Exile: stored under'),
      expect.stringContaining('Duress: names'),
    ]);
  });
});
