import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { buildOracleIndexFromCards, loadOracleIndexFromFile } from '../cards/oracle-index';

/** An explicit pinned population keeps printing drift out of reproducible coverage gates. */
export function coverageInput(argv: readonly string[]): {
  args: string[];
  path: string;
  index: ReturnType<typeof buildOracleIndexFromCards>;
} {
  const args = [...argv];
  const slot = args.indexOf('--oracle-fixture');
  if (slot < 0) {
    const path = 'data/scryfall-oracle-cards.json';
    return { args, path, index: loadOracleIndexFromFile(resolve(path)) };
  }
  const path = args[slot + 1];
  if (path === undefined || path.startsWith('--'))
    throw new Error('--oracle-fixture requires a pinned Oracle projection file');
  args.splice(slot, 2);
  if (args.includes('--oracle-fixture')) throw new Error('--oracle-fixture may be specified once');
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
  return { args, path, index: buildOracleIndexFromCards(value as OracleCard[]) };
}
