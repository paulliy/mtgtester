/**
 * Rank card compiler refusals by the deck slots each missing IR feature would unlock.
 *
 *   bun run primitive-backlog            # write the queue and the report
 *   bun run primitive-backlog --check    # fail if either is out of date
 *   bun run primitive-backlog --json     # print the queue to stdout, write nothing
 *
 * Reads the hand-edited groups file, the frozen EDHREC ranking, the modeled-card list and the
 * compiled-card review queue. A refused card that is modeled now, or whose patch is in the queue as
 * `compiled-checked` or `provisional`, leaves the ranking. Never uses the network.
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
const JSON_PATH = 'packages/server/fixtures/primitive-backlog.json';
const MARKDOWN_PATH = 'docs/plans/primitive-backlog.md';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), 'utf8')) as T;

function unblockedCards(): Map<string, UnblockedBy> {
  const unblocked = new Map<string, UnblockedBy>();
  for (const name of readJson<{ modeled: string[] }>(MODELED_PATH).modeled) {
    unblocked.set(name, 'modeled');
  }
  if (existsSync(resolve(QUEUE_PATH))) {
    const queue = readJson<{ cards: { name: string; status: string }[] }>(QUEUE_PATH);
    for (const card of queue.cards) {
      if (unblocked.has(card.name)) continue;
      if (card.status === 'compiled-checked' || card.status === 'provisional') {
        unblocked.set(card.name, card.status);
      }
    }
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
