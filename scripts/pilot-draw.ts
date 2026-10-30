/**
 * Draw the phase 6 pilot cards from the Scryfall bank (`scripts/cards/pilot-draw.ts` has the rule)
 * and record the draw, with the bank's hash, in `docs/reviews/card-authoring-pilot-draw.json`.
 *
 *   bun run pilot:draw [--bank data/scryfall-oracle-cards.json]
 *
 * Then pin each drawn card with `bun run pin-store add "<name>"`. The draw leaves pinned cards out,
 * so run it before pinning: afterwards it draws the next 20.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pinStore } from '../packages/engine/tests/scenario/pin-store';
import type { RawScryfallCard } from '../packages/server/src/cards/scryfall';
import { drawPilot, PILOT_SEED } from './cards/pilot-draw';

const OUT = 'docs/reviews/card-authoring-pilot-draw.json';
const argv = process.argv.slice(2);
const bankAt = argv.indexOf('--bank');
const bankPath = bankAt >= 0 ? argv[bankAt + 1]! : 'data/scryfall-oracle-cards.json';

/** Every card name a committed Oracle fixture or the pin store holds. */
function pinnedNames(): Set<string> {
  const names = new Set(pinStore.names());
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record['oracleId'] === 'string' && typeof record['name'] === 'string')
        names.add(record['name']);
      else Object.values(record).forEach(collect);
    }
  };
  for (const directory of ['packages/engine/tests/fixtures', 'packages/server/fixtures'])
    for (const file of readdirSync(directory))
      if (file.endsWith('.json')) collect(JSON.parse(readFileSync(join(directory, file), 'utf8')));
  return names;
}

const bytes = readFileSync(bankPath);
const cards = drawPilot(JSON.parse(bytes.toString('utf8')) as RawScryfallCard[], pinnedNames());
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      seed: PILOT_SEED,
      bankSha256: createHash('sha256').update(bytes).digest('hex'),
      cards,
    },
    null,
    2,
  )}\n`,
);
execFileSync('npx', ['prettier', '--write', OUT], { stdio: 'ignore' });
for (const card of cards) console.log(`${card.arm.padEnd(7)} ${card.edhrecRank}\t${card.name}`);
console.log(`pilot:draw: ${cards.length} card(s) recorded in ${OUT}`);
