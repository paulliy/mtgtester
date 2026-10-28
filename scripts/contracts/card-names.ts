import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cardNamesIn } from './ratchets';

export const ENGINE_FIXTURES = 'packages/engine/tests/fixtures';
export const COVERAGE_ORACLE = 'packages/server/fixtures/coverage-oracle.json';
export const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
export const ABILITY_SOURCE = 'packages/engine/src/cards/ability.ts';
export const SLUG_FILE = 'scripts/card-name-slugs.json';

/** Every card name in the pinned Oracle fixtures and the verification manifest. */
export function collectCardNames(root: string): Set<string> {
  const fixtures = [
    ...readdirSync(join(root, ENGINE_FIXTURES))
      .filter((file) => file.endsWith('-oracle.json'))
      .sort()
      .map((file) => `${ENGINE_FIXTURES}/${file}`),
    COVERAGE_ORACLE,
  ];
  const names = new Set<string>();
  for (const file of fixtures) {
    const found = cardNamesIn(JSON.parse(readFileSync(join(root, file), 'utf8')));
    if (found.size === 0) throw new Error(`${file}: no card names found; has its shape changed?`);
    for (const name of found) names.add(name);
  }
  // The manifest keys its cards by Oracle id, so each entry's `name` has no id beside it.
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as {
    cards: Record<string, { name?: unknown }>;
  };
  const declared = Object.values(manifest.cards).flatMap((card) =>
    typeof card.name === 'string' ? [card.name] : [],
  );
  if (declared.length === 0) throw new Error(`${MANIFEST}: no card names found`);
  for (const name of declared) names.add(name);
  return names;
}
