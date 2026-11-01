import { writeFileSync } from 'node:fs';
import { SLUG_FILE, collectCardNames } from './contracts/card-names';
import { SLUG_FILE_NOTE, slugTable, type SlugFile } from './contracts/ratchets';

// Regenerates scripts/card-name-slugs.json from the pinned Oracle fixtures and the verification
// manifest. Run it after a card batch adds a fixture; check-ratchets warns when the file is stale.
const names = collectCardNames(process.cwd());
const file: SlugFile = { schemaVersion: 1, note: SLUG_FILE_NOTE, slugs: slugTable(names) };
writeFileSync(SLUG_FILE, `${JSON.stringify(file, null, 2)}\n`);
console.log(`${SLUG_FILE}: ${Object.keys(file.slugs).length} slugs from ${names.size} card names`);
