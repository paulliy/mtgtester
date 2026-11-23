import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { loadOracleIndexFromFile } from '../cards/oracle-index-file';

/** The Oracle projection every coverage gate is pinned to; `coverage-contract.json` hashes it. */
export const PINNED_ORACLE_FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const BULK_ORACLE_FILE = 'data/scryfall-oracle-cards.json';

/**
 * Defaults to the pinned fixture so a gate cannot drift with the local Scryfall download.
 * `--bulk` reads that download instead, for checking drift against new Scryfall data.
 */
export function coverageInput(argv: readonly string[]): {
  args: string[];
  path: string;
  index: ReturnType<typeof buildOracleIndexFromCards>;
} {
  const args = [...argv];
  const bulk = args.indexOf('--bulk');
  if (bulk >= 0) {
    args.splice(bulk, 1);
    if (args.includes('--oracle-fixture'))
      throw new Error('--bulk and --oracle-fixture are mutually exclusive');
    return {
      args,
      path: BULK_ORACLE_FILE,
      index: loadOracleIndexFromFile(resolve(BULK_ORACLE_FILE)),
    };
  }
  const slot = args.indexOf('--oracle-fixture');
  if (slot < 0) {
    return {
      args,
      path: PINNED_ORACLE_FIXTURE,
      index: buildOracleIndexFromCards(readPinnedFixture(PINNED_ORACLE_FIXTURE)),
    };
  }
  const path = args[slot + 1];
  if (path === undefined || path.startsWith('--'))
    throw new Error('--oracle-fixture requires a pinned Oracle projection file');
  args.splice(slot, 2);
  if (args.includes('--oracle-fixture')) throw new Error('--oracle-fixture may be specified once');
  return { args, path, index: buildOracleIndexFromCards(readPinnedFixture(path)) };
}

function readPinnedFixture(path: string): OracleCard[] {
  const value: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (
    !Array.isArray(value) ||
    value.some((card: unknown) => {
      if (card === null || typeof card !== 'object') return true;
      const record = card as Record<string, unknown>;
      return (
        typeof record['oracleId'] !== 'string' ||
        typeof record['name'] !== 'string' ||
        typeof record['oracleText'] !== 'string' ||
        !Array.isArray(record['types'])
      );
    })
  )
    throw new Error('Oracle fixture must be an array of complete Oracle card projections');
  return value as OracleCard[];
}
