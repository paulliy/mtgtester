/**
 * The sampled audit of provisional cards (H1): draw cards from the review queue by seed, show each
 * card's Oracle text beside its patch rendered back into English, and record a reviewer's verdict.
 *
 *   bun run scripts/card-compiler/run.ts audit [--seed S] [--count 10] [--all]
 *   bun run scripts/card-compiler/run.ts audit-verdict "<card name>" <source> accepted|rejected --by <who> [--note "..."]
 *
 * `audit` draws from the entries the server could admit as provisional (`compiled-checked`, no
 * verdict yet, no `differs` cross-check, not demoted by fuzz) unless `--all` asks for every checked
 * entry. `audit-verdict` is named apart from PR #72's `review` command; when that lands, the two
 * write the same `review` field and this one can go. The draw depends only on the seed and
 * the queue, so two people with the same seed see the same cards. `review` writes the verdict into
 * the queue's `review` field; `queue` keeps it while the patch's bytes are unchanged, and a
 * `rejected` verdict takes the card out of provisional play.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { cardByName } from './lib';
import { renderBehavior, Unrendered } from './render';

export const QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';
export const DEMOTED_PATH = 'docs/reviews/provisional-demoted.json';

/** `oracleId|patchSha256` of each patch fuzz demoted (H1). */
function demotedKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const cards =
    (
      JSON.parse(readFileSync(path, 'utf8')) as {
        cards?: Array<{ oracleId: string; patchSha256: string }>;
      }
    ).cards ?? [];
  return new Set(cards.map((card) => `${card.oracleId}|${card.patchSha256}`));
}

interface AuditEntry {
  name: string;
  oracleId: string;
  source: string;
  status: string;
  crossCheck?: { source: string; verdict: string };
  handledLines: string[];
  patch: string | null;
  patchSha256: string | null;
  review: { verdict: 'accepted' | 'rejected'; by: string; note?: string } | null;
}

function readQueue(path: string): { schemaVersion: number; cards: AuditEntry[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number; cards: AuditEntry[] };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** Entries in a seeded order: each keyed by sha256(seed | name | source). */
export function drawSample<T extends { name: string; source: string }>(
  entries: readonly T[],
  seed: string,
  count: number,
): T[] {
  const key = (entry: T): string =>
    createHash('sha256').update(`${seed}|${entry.name}|${entry.source}`).digest('hex');
  return [...entries].sort((a, b) => key(a).localeCompare(key(b))).slice(0, count);
}

function rendered(def: Partial<CardDefinition>): string[] {
  try {
    return renderBehavior(def);
  } catch (error) {
    if (error instanceof Unrendered)
      return [
        `(the renderer cannot say this patch in English: ${error.message}; the IR follows)`,
        ...JSON.stringify(def, null, 1)
          .split('\n')
          .map((line) => line.replace(/^ +/, (indent) => '  '.repeat(indent.length))),
      ];
    throw error;
  }
}

export function audit(args: string[], queuePath = QUEUE_PATH): void {
  const seed = flag(args, '--seed') ?? new Date().toISOString().slice(0, 10);
  const count = Number.parseInt(flag(args, '--count') ?? '10', 10);
  const all = args.includes('--all');
  const demoted = demotedKeys(DEMOTED_PATH);
  const candidates = readQueue(queuePath).cards.filter(
    (entry) =>
      entry.status === 'compiled-checked' &&
      (all ||
        (entry.review === null &&
          entry.crossCheck?.verdict !== 'differs' &&
          !demoted.has(`${entry.oracleId}|${entry.patchSha256 ?? ''}`))),
  );
  const sample = drawSample(candidates, seed, count);
  console.log(
    `Audit sample: ${sample.length} of ${candidates.length} ${all ? 'checked' : 'unreviewed'} entries, seed "${seed}"\n`,
  );
  for (const [index, entry] of sample.entries()) {
    const card = (() => {
      try {
        return cardByName(entry.name);
      } catch {
        return null;
      }
    })();
    const patch =
      entry.patch !== null && existsSync(entry.patch)
        ? (JSON.parse(readFileSync(entry.patch, 'utf8')) as { def: Partial<CardDefinition> })
        : null;
    console.log(`${index + 1}. ${entry.name}  [${entry.source}]`);
    console.log('   Oracle text:');
    for (const line of (card?.oracleText ?? '(card not in the pinned pool)').split('\n'))
      console.log(`     ${line}`);
    console.log('   Lines the patch implements:');
    for (const line of entry.handledLines) console.log(`     ${line}`);
    console.log('   The patch, rendered back into English:');
    for (const line of patch === null ? ['(patch file missing)'] : rendered(patch.def))
      console.log(`     ${line}`);
    console.log(`   Patch JSON: ${entry.patch ?? '(none)'}`);
    console.log(
      `   Record: bun run scripts/card-compiler/run.ts audit-verdict ${JSON.stringify(entry.name)} ${entry.source} accepted|rejected --by <you> [--note "..."]\n`,
    );
  }
}

export function review(args: string[], queuePath = QUEUE_PATH): void {
  const [name, source, verdict] = args;
  const by = flag(args, '--by');
  const note = flag(args, '--note');
  if (
    name === undefined ||
    source === undefined ||
    (verdict !== 'accepted' && verdict !== 'rejected') ||
    by === undefined
  )
    throw new Error(
      'usage: run.ts audit-verdict "<card name>" <source> accepted|rejected --by <who> [--note "..."]',
    );
  const queue = readQueue(queuePath);
  const entry = queue.cards.find((card) => card.name === name && card.source === source);
  if (entry === undefined) throw new Error(`no queue entry for ${name} from ${source}`);
  entry.review = { verdict, by, ...(note !== undefined && { note }) };
  writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  console.log(`${name} [${source}]: ${verdict} by ${by}`);
}
