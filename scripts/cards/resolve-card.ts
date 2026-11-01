/**
 * Finding a card's Oracle object for the authoring commands: the pin store, then the committed
 * pool, then the Scryfall bulk file when it is present. Each command says which source it used.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { OracleCard } from '../../packages/shared/src';
import { pinStore } from '../../packages/engine/tests/scenario/pin-store';
import { toOracleCard, type RawScryfallCard } from '../../packages/server/src/cards/scryfall';

export const COVERAGE_ORACLE = 'packages/server/fixtures/coverage-oracle.json';
export const BULK = 'data/scryfall-oracle-cards.json';

export interface FoundCard {
  card: OracleCard;
  source: 'pin store' | 'coverage pool' | 'Scryfall bulk';
}

let bulk: RawScryfallCard[] | null | undefined;

export function findCard(name: string): FoundCard | null {
  if (pinStore.has(name)) return { card: pinStore.get(name), source: 'pin store' };
  const pool = JSON.parse(readFileSync(COVERAGE_ORACLE, 'utf8')) as OracleCard[];
  const pooled = pool.find((card) => card.name === name);
  if (pooled !== undefined) return { card: pooled, source: 'coverage pool' };
  if (bulk === undefined)
    bulk = existsSync(BULK) ? (JSON.parse(readFileSync(BULK, 'utf8')) as RawScryfallCard[]) : null;
  const raw = bulk?.find((card) => card.name === name);
  const converted = raw === undefined ? null : toOracleCard(raw);
  return converted === null ? null : { card: converted, source: 'Scryfall bulk' };
}
