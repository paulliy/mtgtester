import { readFileSync } from 'node:fs';
import { interpretCard } from '../packages/engine/src/cards/interpret';
const [file, name] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file!, 'utf8'));
for (const c of d.cards) if (c.card.name === name) { const def = interpretCard(c.card); console.log(def.modeled, def.unmodeledReasons); }
