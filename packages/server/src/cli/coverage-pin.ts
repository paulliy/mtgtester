/**
 * Pin the EDHREC ready list's Oracle records offline (coverage plan decision D3).
 *
 *   bun run coverage:pin                  # needs data/scryfall-oracle-cards.json: add and refresh pins, then re-ratchet
 *   bun run coverage:pin --bank <file>    # another Scryfall bank
 *   bun run coverage:pin --ratchet        # offline: record which pinned cards model now
 *   bun run coverage:pin --check          # offline: fail on a regressed or unrecorded modeled card
 *
 * See `packages/server/src/cards/edhrec-pins.ts`. Never uses the network.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EdhrecRanking } from '../cards/edhrec-ranking';
import {
  MODELED_RATCHET_PATH,
  PINNED_ORACLE_PATH,
  modeledRatchet,
  pinReadyList,
  ratchetDrift,
  renderPins,
  type ModeledRatchet,
  type PinnedCard,
} from '../cards/edhrec-pins';
import { loadOracleIndexFromFile } from '../cards/oracle-index';

const RANKING_PATH = 'packages/server/fixtures/edhrec-ranking.json';
const DEFAULT_BANK = 'data/scryfall-oracle-cards.json';

function option(name: string): string | undefined {
  const slot = process.argv.indexOf(name);
  if (slot < 0) return undefined;
  const value = process.argv[slot + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

const readPins = (): string =>
  existsSync(resolve(PINNED_ORACLE_PATH))
    ? readFileSync(resolve(PINNED_ORACLE_PATH), 'utf8')
    : '[]';

function writeRatchet(fixtureText: string): ModeledRatchet {
  const ratchet = modeledRatchet(fixtureText);
  writeFileSync(resolve(MODELED_RATCHET_PATH), `${JSON.stringify(ratchet, null, 2)}\n`);
  return ratchet;
}

function main(): void {
  if (process.argv.includes('--check')) {
    const recorded = JSON.parse(
      readFileSync(resolve(MODELED_RATCHET_PATH), 'utf8'),
    ) as ModeledRatchet;
    const drift = ratchetDrift(recorded, modeledRatchet(readPins()));
    for (const name of drift.regressed) console.error(`regressed: ${name} no longer models`);
    for (const name of drift.newlyModeled) console.error(`unrecorded: ${name} now models`);
    if (drift.fixtureChanged)
      console.error(`${PINNED_ORACLE_PATH} changed since the ratchet was recorded`);
    if (drift.regressed.length > 0 || drift.newlyModeled.length > 0 || drift.fixtureChanged) {
      console.error('run bun run coverage:pin --ratchet after reviewing the changes');
      process.exit(1);
    }
    console.log(
      `${recorded.modeled.length}/${recorded.pinned} pinned EDHREC cards model, as recorded.`,
    );
    return;
  }
  if (process.argv.includes('--ratchet')) {
    const ratchet = writeRatchet(readPins());
    console.log(
      `recorded ${ratchet.modeled.length}/${ratchet.pinned} modeled in ${MODELED_RATCHET_PATH}`,
    );
    return;
  }
  const bank = option('--bank') ?? DEFAULT_BANK;
  if (!existsSync(resolve(bank))) {
    console.error(`coverage:pin needs the Scryfall bank at ${bank}; run bun run scryfall:update`);
    process.exit(2);
  }
  const ranking = JSON.parse(readFileSync(resolve(RANKING_PATH), 'utf8')) as EdhrecRanking;
  console.error(`Loading Oracle data from ${bank} …`);
  const index = loadOracleIndexFromFile(resolve(bank));
  const existing = JSON.parse(readPins()) as PinnedCard[];
  const { pins, added, changed, unresolved } = pinReadyList(ranking, index, existing);
  if (unresolved.length > 0)
    console.error(`unresolved in ${bank} (not pinned): ${unresolved.join(', ')}`);
  for (const name of changed) console.error(`changed Oracle record: ${name}`);
  const text = renderPins(pins);
  writeFileSync(resolve(PINNED_ORACLE_PATH), text);
  const ratchet = writeRatchet(text);
  console.log(
    `pinned ${pins.length} cards (${added.length} added, ${changed.length} changed); ${ratchet.modeled.length} model`,
  );
}

main();
