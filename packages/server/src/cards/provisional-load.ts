/**
 * Load the provisional card catalog (H1) from the review queue on disk. The admission rules are
 * described in `provisional.ts`; this module is the file-reading half, kept apart so the catalog
 * types and the helpers a game uses stay free of Node APIs.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { interpretProvisional, type CardDefinition } from '@mtg/engine';
import type { ProvisionalCatalog } from './provisional';

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
