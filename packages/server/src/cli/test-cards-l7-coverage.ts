import fs from 'fs';
import { resolve } from 'node:path';
import { loadScryfallBulkOrNull } from '../cards/scryfall-bulk-fixture';
import { toOracleCard } from '../cards/scryfall';
import { interpretCard } from '../../../engine/src/cards/interpret';

const IMPLEMENTED_CARDS = [
  'Emmara, Soul of the Accord',
  "Karametra's Favor",
  'Leafkin Druid',
  'Nullmage Shepherd',
  'Thunderfoot Baloth',
  'Fortified Village',
  'Overwhelming Instinct',
  'Rishkar, Peema Renegade',
  'Ajani, Caller of the Pride',
  'Sylvan Reclamation',
  'Mentor of the Meek',
  "Commander's Insignia",
  'Voice of Many',
  'Loyal Guardian',
  'Dawn of Hope',
  'Hornet Nest',
  'Idol of Oblivion',
  'Trostani Discordant',
  'Harvest Season',
  'Slate of Ancestry',
  'Scavenging Ooze',
  'Felidar Retreat',
  'Great Oak Guardian',
  'Conclave Tribunal',
  'Champion of Lambholt',
  'Curse of Bounty',
  'Path to Exile',
  'Rootborn Defenses',
];

export function runL7CoverageCheck(): {
  success: boolean;
  totalModeled: number;
  verifiedCount: number;
} {
  console.log('Running L7 Aggregate Signal Check...');

  const scryfallCards = loadScryfallBulkOrNull();
  if (scryfallCards === null) {
    throw new Error(
      'data/scryfall-oracle-cards.json is required for the L7 check — see data/README.md.',
    );
  }

  const mdPath = resolve('docs/modelled-cards.md');
  const mdContent = fs.readFileSync(mdPath, 'utf8');

  let verifiedCount = 0;
  for (const name of IMPLEMENTED_CARDS) {
    const raw = scryfallCards.find((c) => c.name === name);
    const oracleCard = raw ? toOracleCard(raw) : null;
    const isLand = oracleCard?.types.includes('Land') ?? false;

    if (mdContent.includes(name) || (isLand && oracleCard && interpretCard(oracleCard).modeled)) {
      verifiedCount++;
    } else {
      console.warn(`L7 warning: ${name} not verified in modeled cards check`);
    }
  }

  let totalModeled = 0;
  for (const raw of scryfallCards) {
    const oracleCard = toOracleCard(raw);
    if (!oracleCard || oracleCard.types.includes('Land')) continue;
    const def = interpretCard(oracleCard);
    if (def.modeled) totalModeled++;
  }

  console.log(
    `L7 Coverage Signal: ${verifiedCount}/${IMPLEMENTED_CARDS.length} implemented cards confirmed in modeled cards check.`,
  );
  console.log(`Total non-land modeled pool size: ${totalModeled} cards.`);

  return { success: verifiedCount === IMPLEMENTED_CARDS.length, totalModeled, verifiedCount };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runL7CoverageCheck();
}
