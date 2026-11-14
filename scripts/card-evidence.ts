/**
 * `bun run card:evidence <card> [viewer evidence options]`: refresh one card's committed evidence
 * (`docs/reviews/<card>-verification.json` and `<card>-gameplay-ai.json`).
 *
 * One entry point for the per-card generators, so nobody has to know their file names. It runs
 * `scripts/generate-<card>-evidence.ts` as its own process, unchanged, so the generator's import
 * walk and the sources it hashes (`scripts/card-evidence-sources.ts`) are exactly what they were.
 * Options after the card name are passed through to the generator's viewer evidence loader.
 */
import { spawnSync } from 'node:child_process';
import { GENERATORS } from './card-evidence-input';

const [card, ...rest] = process.argv.slice(2);
const known: readonly string[] = GENERATORS;

if (card === undefined || card === '--help' || card === '-h' || !known.includes(card)) {
  if (card !== undefined && card !== '--help' && card !== '-h') {
    console.error(`unknown card "${card}"`);
  }
  console.error(
    `usage: bun run card:evidence <card> [viewer evidence options]\ncards: ${known.join(', ')}`,
  );
  process.exit(card === '--help' || card === '-h' ? 0 : 1);
}

const result = spawnSync(
  process.execPath,
  ['run', `scripts/generate-${card}-evidence.ts`, ...rest],
  {
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
