import scryfallCards from '../data/scryfall-oracle-cards.json' assert { type: 'json' };
import { toOracleCard } from '../packages/server/src/cards/scryfall';
import type { RawScryfallCard } from '../packages/server/src/cards/scryfall';
import { interpretCard } from '../packages/engine/src/cards/interpret';

const names = [
  'Aura Mutation',
  'Camaraderie',
  'Citywide Bust',
  'Collective Unconscious',
  'Eternal Witness',
  'Hour of Reckoning',
];

for (const name of names) {
  const raw = (scryfallCards as unknown as RawScryfallCard[]).find((c) => c.name === name);
  if (!raw) continue;
  const card = toOracleCard(raw);
  const def = interpretCard(card!);
  console.log('===', name, '===');
  console.log('  oracle:', JSON.stringify(card!.oracleText));
  console.log('  unmodeledReasons:', JSON.stringify(def.unmodeledReasons));
}
