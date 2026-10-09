import { readFileSync } from 'node:fs';
import { interpretCard } from '../packages/engine/src/cards/interpret';
const cards = JSON.parse(readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'));
const c = cards.find((x: any) => x.name === process.argv[2]);
console.log(JSON.stringify(interpretCard(c).statics ?? interpretCard(c), null, 1).slice(0, 3000));
