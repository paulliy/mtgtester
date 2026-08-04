/**
 * Archetype backfill (ADR 0022 §6).
 *
 *   bun run retag                 # dry run — prints every change, writes nothing
 *   bun run retag --write         # apply, to rows whose tag was defaulted
 *   bun run retag --write --force # also re-score rows already tagged by the heuristic
 *
 * Rebuilds each deck's card list from its latest snapshot via `card_cache`, so this needs no
 * network and no Scryfall bulk file.
 *
 * ⚠️ `stats.ts` groups the "who beats me" view by `archetype_tag`, so retagging **changes how
 * historical results aggregate**. No game data is lost — only the label results are grouped
 * under. That is why writing is opt-in and a dry run is the default.
 *
 * A `manual` tag is never touched, at any flag combination. A person typed it.
 */

import type { OracleCard } from '@mtg/shared';
import { inferArchetype } from '../decks/archetype';
import { GameStore } from '../db';

const DB_PATH = 'data/decks.sqlite';

interface Options {
  write: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    write: argv.includes('--write'),
    force: argv.includes('--force'),
  };
}

interface DeckRowForRetag {
  id: string;
  name: string | null;
  archetype_tag: string;
  archetype_source: string;
  card_list_json: string | null;
  commander_names: string | null;
  color_identity: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  const store = new GameStore(DB_PATH);

  // Latest snapshot per deck: re-importing creates a new snapshot rather than mutating one
  // (§8.2), so an old row would classify a list the deck no longer is.
  const rows = store.raw
    .query(
      `SELECT d.id, d.name, d.archetype_tag, d.archetype_source,
              s.card_list_json, s.commander_names, s.color_identity
         FROM decks d
         LEFT JOIN deck_snapshots s ON s.id = (
           SELECT id FROM deck_snapshots WHERE deck_id = d.id ORDER BY imported_at DESC LIMIT 1
         )
        ORDER BY d.created_at`,
    )
    .all() as DeckRowForRetag[];

  const rewritable = new Set(options.force ? ['default', 'heuristic'] : ['default']);
  let considered = 0;
  let changed = 0;
  let skippedManual = 0;

  for (const row of rows) {
    if (row.archetype_source === 'manual') {
      skippedManual++;
      continue;
    }
    if (!rewritable.has(row.archetype_source)) continue;
    if (row.card_list_json === null) {
      console.log(`  ${row.name ?? row.id}: no snapshot — skipped`);
      continue;
    }

    const entries = parseJson<Array<{ oracleId: string; quantity: number }>>(row.card_list_json, []);
    const commanderNames = new Set(parseJson<string[]>(row.commander_names, []));

    const commanders: OracleCard[] = [];
    const cards: Array<{ card: OracleCard; quantity: number }> = [];
    let missing = 0;
    for (const entry of entries) {
      const card = store.getCard(entry.oracleId);
      if (card === null) {
        missing++;
        continue;
      }
      if (commanderNames.has(card.name)) commanders.push(card);
      else cards.push({ card, quantity: entry.quantity });
    }

    if (commanders.length === 0 || missing > 0) {
      console.log(
        `  ${row.name ?? row.id}: ${missing} card(s) not in cache${commanders.length === 0 ? ', no commander' : ''} — skipped`,
      );
      continue;
    }

    considered++;
    const result = inferArchetype({
      commanders,
      cards,
      colorIdentity: parseJson(row.color_identity, []),
    });
    if (result.tag === row.archetype_tag) continue;

    changed++;
    console.log(`  ${row.name ?? row.id}\n    ${row.archetype_tag}\n    -> ${result.tag}`);

    if (options.write) {
      store.raw
        .query(
          `UPDATE decks SET archetype_tag = ?, archetype_source = 'heuristic',
                            archetype_features_json = ?
            WHERE id = ?`,
        )
        .run(result.tag, JSON.stringify(result.features), row.id);
    }
  }

  console.log(
    `\n${considered} deck(s) re-scored, ${changed} would change, ${skippedManual} manual tag(s) left alone.`,
  );
  if (!options.write && changed > 0) {
    console.log('Dry run — nothing written. Re-run with --write to apply.');
    console.log('Note: this regroups the "who beats me" stats view, which keys on archetype_tag.');
  }

  store.close();
  return 0;
}

if (import.meta.main) process.exit(main());
