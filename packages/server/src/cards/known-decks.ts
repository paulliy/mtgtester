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
import { inferArchetype } from '../decks/archetype';
import type { BannedList } from '../decks/banned';
import { validateDeck } from '../decks/validate';

const FIXTURE_DIR = 'packages/server/fixtures/coverage-decks';
/** Precon leftovers that are not coverage/play-list targets. Implemented cards remain in overrides. */
const EXCLUDED_COVERAGE_DECKS = new Set(['counter-intelligence.txt']);

export interface KnownDeckSummary {
  slug: string;
  name: string;
  commanderNames: string[];
  /** One printing per commander, for the setup gallery's art. Same order as `commanderNames`. */
  commanderScryfallIds: string[];
  colorIdentity: Color[];
  uniqueCards: number;
  modeledCards: number;
  /** Inferred archetype (ADR 0022 §5) — what this deck is, not just who its commander is. */
  archetypeTag: string;
  /** Plaintext deck list, verbatim — hand this back as a `{kind:'plaintext'}` seat source. */
  text: string;
}

/**
 * List the committed coverage fixtures that are actually playable.
 *
 * Coverage fixtures may intentionally preserve illegal or partially modeled source lists, so the
 * UI catalog must apply the same legality and ADR 0009 gates as match setup before calling one a
 * modeled deck.
 */
export async function listKnownDecks(
  index: OracleIndex,
  banned: BannedList,
  fixtureDir = FIXTURE_DIR,
): Promise<KnownDeckSummary[]> {
  const dir = resolve(fixtureDir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.txt') && !EXCLUDED_COVERAGE_DECKS.has(f))
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
    if (!validateDeck(resolved, banned).valid) continue;

    const cards: OracleCard[] = [
      ...resolved.commanders,
      ...(resolved.companion === null ? [] : [resolved.companion]),
      ...resolved.cards.map((e) => e.card),
    ];
    const name = resolved.name ?? parsed.name ?? slug;
    const report = measureCoverage([{ name, cards }]);
    const summary = report.decks[0];
    if (summary === undefined || summary.modeled !== summary.uniqueCards) continue;
    const colorIdentity = [...new Set(resolved.commanders.flatMap((c) => c.colorIdentity))];

    out.push({
      slug,
      name,
      commanderNames: resolved.commanders.map((c) => c.name),
      commanderScryfallIds: resolved.commanders.map((c) => c.scryfallId),
      colorIdentity,
      uniqueCards: summary?.uniqueCards ?? cards.length,
      modeledCards: summary?.modeled ?? 0,
      archetypeTag:
        resolved.archetypeTag ??
        inferArchetype({
          commanders: resolved.commanders,
          companion: resolved.companion,
          cards: resolved.cards.map((entry) => ({ card: entry.card, quantity: entry.quantity })),
          colorIdentity,
        }).tag,
      text,
    });
  }
  return out;
}
