import scryfallCards from '../data/scryfall-oracle-cards.json' assert { type: 'json' };
import { toOracleCard } from '../packages/server/src/cards/scryfall';
import type { RawScryfallCard } from '../packages/server/src/cards/scryfall';
import { interpretCard } from '../packages/engine/src/cards/interpret';

const names = [
  'Aura Mutation',
  'Blossoming Sands',
  'Camaraderie',
  'Canopy Vista',
  'Citywide Bust',
  'Collective Unconscious',
  'Command Tower',
  'Elfhame Palace',
  'Eternal Witness',
  'Graypelt Refuge',
  'Holdout Settlement',
  'Hour of Reckoning',
  'Temple of Plenty',
  'Tranquil Expanse',
  'Vitu-Ghazi, the City-Tree',
];

for (const name of names) {
  const raw = (scryfallCards as unknown as RawScryfallCard[]).find((c) => c.name === name);
  if (!raw) {
    console.log(name, 'NOT FOUND IN SCRYFALL');
    continue;
  }
  const card = toOracleCard(raw);
  if (!card) {
    console.log(name, 'toOracleCard FAILED');
    continue;
  }
  const def = interpretCard(card);
  console.log('===', name, 'modeled:', def.modeled, '===');
  console.log('  oracle:', JSON.stringify(card.oracleText));
  console.log('  keys:', Object.keys(def));
}
