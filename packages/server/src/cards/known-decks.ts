/**
 * The coverage fixtures (`packages/server/fixtures/coverage-decks/*.txt`) doubling as a
 * ready-to-play deck list. They are plaintext snapshots of real decks that have already been
 * imported and measured for model coverage (`bun run coverage`), so surfacing them as a "known
 * decks" pick list lets a setup screen offer decks with a known, displayed chance of actually
 * being playable — rather than a blind Moxfield URL paste that halts on turn one (ADR 0009).
 *
 * Each file is already in the exact plaintext format `runDeckPipeline` accepts as a
 * `{kind:'plaintext'}` seat source, so picking one from here needs no new import path: the
 * client just hands the file's text back as that seat's source, unchanged.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { Color, OracleCard } from '@mtg/shared';
import type { OracleIndex } from './oracle-index';
import { measureCoverage } from './coverage';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';

const FIXTURE_DIR = 'packages/server/fixtures/coverage-decks';

export interface KnownDeckSummary {
  slug: string;
  name: string;
  commanderNames: string[];
  colorIdentity: Color[];
  uniqueCards: number;
  modeledCards: number;
  /** Plaintext deck list, verbatim — hand this back as a `{kind:'plaintext'}` seat source. */
  text: string;
}

/** List every committed coverage-deck fixture with its model coverage, for a "known decks" pick list. */
export async function listKnownDecks(index: OracleIndex): Promise<KnownDeckSummary[]> {
  const dir = resolve(FIXTURE_DIR);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort();

  const out: KnownDeckSummary[] = [];
  for (const file of files) {
    const slug = basename(file, '.txt');
    const text = readFileSync(join(dir, file), 'utf8');

    let parsed;
    try {
      parsed = await importDeck(text);
    } catch {
      continue; // A malformed fixture should not break the whole list.
    }
    const { resolved } = resolveDeck(parsed, index);
    if (resolved === null) continue;

    const cards: OracleCard[] = [
      ...resolved.commanders,
      ...(resolved.companion === null ? [] : [resolved.companion]),
      ...resolved.cards.map((e) => e.card),
    ];
    const name = resolved.name ?? parsed.name ?? slug;
    const report = measureCoverage([{ name, cards }]);
    const summary = report.decks[0];

    out.push({
      slug,
      name,
      commanderNames: resolved.commanders.map((c) => c.name),
      colorIdentity: [...new Set(resolved.commanders.flatMap((c) => c.colorIdentity))],
      uniqueCards: summary?.uniqueCards ?? cards.length,
      modeledCards: summary?.modeled ?? 0,
      text,
    });
  }
  return out;
}
