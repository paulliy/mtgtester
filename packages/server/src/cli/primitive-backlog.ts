/**
 * Rank card compiler refusals by the deck slots each missing IR feature would unlock.
 *
 *   bun run primitive-backlog            # write the queue and the report
 *   bun run primitive-backlog --check    # fail if either is out of date
 *   bun run primitive-backlog --json     # print the queue to stdout, write nothing
 *
 * Reads the hand-edited groups file, the frozen EDHREC ranking, the modeled-card list and the
 * compiled-card review queue. A refused card that is modeled now, or whose queue entry the
 * provisional tier would admit, leaves the ranking. Never uses the network.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EdhrecRanking } from '../cards/edhrec-ranking';
import {
  buildPrimitiveBacklog,
  renderBacklogJson,
  renderBacklogMarkdown,
  type BacklogGroupsFile,
  PRIMITIVE_BACKLOG_GROUPS_PATH as GROUPS_PATH,
  type UnblockedBy,
} from '../cards/primitive-backlog';

const RANKING_PATH = 'packages/server/fixtures/edhrec-ranking.json';
const MODELED_PATH = 'packages/server/fixtures/edhrec-modeled.json';
const QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';
const DEMOTED_PATH = 'docs/reviews/provisional-demoted.json';
const JSON_PATH = 'packages/server/fixtures/primitive-backlog.json';
const MARKDOWN_PATH = 'docs/plans/primitive-backlog.md';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;

interface QueueCard {
  name: string;
  oracleId: string;
  status: string;
  patchSha256: string | null;
  review?: { verdict: string } | null;
  crossCheck?: { verdict: string };
}

/**
 * Cards that left the backlog: modeled now, or a review-queue entry that the provisional tier
 * would admit (`compiled-checked`, not rejected, cross-check not `differs`, not demoted by fuzz).
 * The demotion file may not exist yet; then nothing is demoted.
 */
function unblockedCards(): Map<string, UnblockedBy> {
  const unblocked = new Map<string, UnblockedBy>();
  for (const name of readJson<{ modeled: string[] }>(MODELED_PATH).modeled) {
    unblocked.set(name, 'modeled');
  }
  if (!existsSync(resolve(QUEUE_PATH))) return unblocked;
  const demoted = new Set(
    existsSync(resolve(DEMOTED_PATH))
      ? readJson<{ cards: { oracleId: string; patchSha256: string }[] }>(DEMOTED_PATH).cards.map(
          (card) => `${card.oracleId}|${card.patchSha256}`,
        )
      : [],
  );
  for (const card of readJson<{ cards: QueueCard[] }>(QUEUE_PATH).cards) {
    if (unblocked.has(card.name)) continue;
    if (card.status !== 'compiled-checked') continue;
    if (card.review?.verdict === 'rejected') continue;
    if (card.crossCheck?.verdict === 'differs') continue;
    if (demoted.has(`${card.oracleId}|${card.patchSha256}`)) continue;
    unblocked.set(card.name, 'review-queue');
  }
  return unblocked;
}

function main(): void {
  const backlog = buildPrimitiveBacklog({
    groups: readJson<BacklogGroupsFile>(GROUPS_PATH),
    ranking: readJson<EdhrecRanking>(RANKING_PATH),
    unblocked: unblockedCards(),
  });
  const json = renderBacklogJson(backlog);
  const markdown = renderBacklogMarkdown(backlog);

  if (process.argv.includes('--json')) {
    process.stdout.write(json);
    return;
  }
  if (process.argv.includes('--check')) {
    const stale = [JSON_PATH, MARKDOWN_PATH].filter(
      (path, i) =>
        !existsSync(resolve(path)) || readFileSync(resolve(path), 'utf8') !== [json, markdown][i],
    );
    if (stale.length > 0) {
      console.error(`out of date: ${stale.join(', ')}; run bun run primitive-backlog`);
      process.exit(1);
    }
    console.log(`primitive backlog is up to date (${backlog.features.length} features).`);
    return;
  }
  writeFileSync(resolve(JSON_PATH), json);
  writeFileSync(resolve(MARKDOWN_PATH), markdown);
  console.log(
    `wrote ${JSON_PATH} and ${MARKDOWN_PATH} (${backlog.features.length} features, ${backlog.ungrouped.length} ungrouped)`,
  );
}

main();
