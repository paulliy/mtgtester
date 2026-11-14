/**
 * The provisional card catalog (H1): which machine-checked cards from the review queue a game
 * may play when it opts in, built once per process from `docs/reviews/compiled-card-queue.json`.
 *
 * An entry is admitted only when all of these hold:
 *   - its status is `compiled-checked` (validator, smoke games and meaning check all passed);
 *   - the patch file's SHA-256 still matches the queue, so the bytes are the ones checked;
 *   - no reviewer rejected it, its cross-check did not find a different behavior, and the fuzz
 *     demotion list does not name it;
 *   - the engine still cannot model the card on its own, and the patch validates today.
 * Anything else is skipped with a reason and reported, never thrown, so one bad entry cannot stop
 * a server. A card with more than one admissible patch plays the first in queue order.
 *
 * The catalog is opt-in everywhere: nothing loads it unless a caller passes `--provisional`, and
 * the engine refuses its definitions in a game that does not set `allowProvisional`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import {
  interpretProvisional,
  type CardDefinition,
  type EnginePlayerConfig,
  type GameConfig,
} from '@mtg/engine';

export const PROVISIONAL_QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';
export const PROVISIONAL_DEMOTED_PATH = 'docs/reviews/provisional-demoted.json';

/** The fields of a review-queue entry the catalog reads (`QueueEntry` in the compiler's run.ts). */
interface QueueEntry {
  name: string;
  oracleId: string;
  source: string;
  status: string;
  handledLines: string[];
  patch: string | null;
  patchSha256: string | null;
  crossCheck?: { source: string; verdict: string };
  review: { verdict: 'accepted' | 'rejected'; by: string; note?: string } | null;
}

/** One demotion: a patch that halted or broke an invariant in fuzz, pinned to its bytes. */
export interface ProvisionalDemotion {
  oracleId: string;
  name: string;
  patchSha256: string;
  reason: string;
}

export interface ProvisionalAdmission {
  name: string;
  oracleId: string;
  source: string;
  patchSha256: string;
}

export interface ProvisionalSkip {
  name: string;
  oracleId: string;
  source: string;
  reason: string;
}

export interface ProvisionalCatalog {
  /** Provisional definitions by oracle id, each with `trust: 'provisional'`. */
  definitions: Map<string, CardDefinition>;
  admitted: ProvisionalAdmission[];
  skipped: ProvisionalSkip[];
}

export interface ProvisionalLoadOptions {
  /** Repository root the queue's patch paths are relative to. Default: the working directory. */
  root?: string;
  queuePath?: string;
  demotedPath?: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function readDemotions(path: string): ProvisionalDemotion[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cards?: ProvisionalDemotion[] };
  return parsed.cards ?? [];
}

/**
 * Build the catalog for the cards this process knows. `cards` is the loaded Oracle data, as a
 * list or an index; a queue entry whose card is not in it is skipped.
 */
export function loadProvisionalCatalog(
  cards: Iterable<OracleCard> | { getByOracleId(oracleId: string): OracleCard | null },
  options: ProvisionalLoadOptions = {},
): ProvisionalCatalog {
  const root = options.root ?? process.cwd();
  const queuePath = resolve(root, options.queuePath ?? PROVISIONAL_QUEUE_PATH);
  const catalog: ProvisionalCatalog = { definitions: new Map(), admitted: [], skipped: [] };
  if (!existsSync(queuePath)) return catalog;

  const queue = (JSON.parse(readFileSync(queuePath, 'utf8')) as { cards: QueueEntry[] }).cards;
  const demoted = new Set(
    readDemotions(resolve(root, options.demotedPath ?? PROVISIONAL_DEMOTED_PATH)).map(
      (d) => `${d.oracleId}|${d.patchSha256}`,
    ),
  );
  const wanted = new Set(queue.map((entry) => entry.oracleId));
  const byOracleId = new Map<string, OracleCard>();
  if (Symbol.iterator in cards) {
    for (const card of cards) if (wanted.has(card.oracleId)) byOracleId.set(card.oracleId, card);
  } else {
    for (const oracleId of wanted) {
      const card = cards.getByOracleId(oracleId);
      if (card !== null) byOracleId.set(oracleId, card);
    }
  }

  for (const entry of queue) {
    const skip = (reason: string): void => {
      catalog.skipped.push({
        name: entry.name,
        oracleId: entry.oracleId,
        source: entry.source,
        reason,
      });
    };
    if (entry.status !== 'compiled-checked') {
      skip(`status ${entry.status}`);
      continue;
    }
    if (catalog.definitions.has(entry.oracleId)) {
      skip('another patch for this card was admitted first');
      continue;
    }
    if (entry.review?.verdict === 'rejected') {
      skip(`rejected by ${entry.review.by}`);
      continue;
    }
    if (entry.crossCheck?.verdict === 'differs') {
      skip(`cross-check against ${entry.crossCheck.source} differs`);
      continue;
    }
    if (entry.patch === null || entry.patchSha256 === null) {
      skip('no patch file');
      continue;
    }
    const patchPath = resolve(root, entry.patch);
    if (!existsSync(patchPath)) {
      skip(`patch file missing: ${entry.patch}`);
      continue;
    }
    const bytes = readFileSync(patchPath);
    if (sha256(bytes) !== entry.patchSha256) {
      skip('patch file changed since it was checked');
      continue;
    }
    if (demoted.has(`${entry.oracleId}|${entry.patchSha256}`)) {
      skip('demoted by fuzz');
      continue;
    }
    const card = byOracleId.get(entry.oracleId);
    if (card === undefined) {
      skip('card not in the loaded Oracle data');
      continue;
    }
    let file: { handledLines?: string[]; def?: Partial<CardDefinition>; source?: string };
    try {
      file = JSON.parse(bytes.toString('utf8')) as typeof file;
    } catch (error) {
      skip(`patch file is not JSON: ${String(error)}`);
      continue;
    }
    if (typeof file.def !== 'object' || file.def === null || Array.isArray(file.def)) {
      skip('patch file has no def');
      continue;
    }
    const result = interpretProvisional(card, {
      handledLines: file.handledLines ?? entry.handledLines,
      def: file.def,
      // The queue's source names the entry reviews and pins refer to, so it is the one recorded.
      source: entry.source,
    });
    if (!result.ok) {
      skip(
        result.kind === 'modeled'
          ? 'the engine now models this card without the patch'
          : `${result.kind}: ${result.issues.slice(0, 3).join('; ')}`,
      );
      continue;
    }
    catalog.definitions.set(entry.oracleId, result.definition);
    catalog.admitted.push({
      name: entry.name,
      oracleId: entry.oracleId,
      source: entry.source,
      patchSha256: entry.patchSha256,
    });
  }
  return catalog;
}

/** Is this card playable: modeled by the engine, or admitted to the catalog? */
export function isProvisional(catalog: ProvisionalCatalog | undefined, card: OracleCard): boolean {
  return catalog?.definitions.has(card.oracleId) === true;
}

/**
 * The `GameConfig` fields that opt a game into the provisional cards its decks hold. Empty when
 * no catalog is given or no deck holds one, so such a game's config is unchanged.
 */
export function provisionalGameConfig(
  catalog: ProvisionalCatalog | undefined,
  players: readonly EnginePlayerConfig[],
): Pick<GameConfig, 'allowProvisional' | 'provisionalDefinitions'> {
  if (catalog === undefined || catalog.definitions.size === 0) return {};
  const used = new Map<string, CardDefinition>();
  for (const player of players) {
    const all = [
      ...player.commanders,
      ...player.cards,
      ...(player.companion ? [player.companion] : []),
    ];
    for (const card of all) {
      const def = catalog.definitions.get(card.oracleId);
      if (def !== undefined) used.set(card.oracleId, def);
    }
  }
  if (used.size === 0) return {};
  return { allowProvisional: true, provisionalDefinitions: [...used.values()] };
}

/** The admitted patches a game's decks use, pinned to their bytes for the replay record. */
export function provisionalReplayPins(
  catalog: ProvisionalCatalog | undefined,
  players: readonly EnginePlayerConfig[],
): Array<{ oracleId: string; source: string; patchSha256: string }> {
  const used = new Set(
    (provisionalGameConfig(catalog, players).provisionalDefinitions ?? []).map((d) => d.oracleId),
  );
  return (catalog?.admitted ?? [])
    .filter((entry) => used.has(entry.oracleId))
    .map(({ oracleId, source, patchSha256 }) => ({ oracleId, source, patchSha256 }));
}

/** One line for a CLI or server log: how many queue cards were admitted and why others were not. */
export function describeCatalog(catalog: ProvisionalCatalog): string {
  const reasons = new Map<string, number>();
  for (const skip of catalog.skipped) {
    const key = skip.reason.replace(/:.*$/, '');
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const parts = [...reasons].map(([reason, n]) => `${n} ${reason}`).join(', ');
  return `provisional cards: ${catalog.definitions.size} admitted${parts ? `; skipped ${parts}` : ''}`;
}
