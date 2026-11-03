/**
 * Write the one-line probe corpus: every ready-list card blocked by exactly one unparsed line,
 * as a synthetic card that carries only that line (ADR 0038 decision 5).
 *
 *   bun run scripts/one-line-corpus.ts            # rewrite the corpus from the ready list
 *   bun run scripts/one-line-corpus.ts --check    # fail if the corpus is out of date
 *
 * The Scryfall bank is gitignored and CI has no copy, so the corpus is built from what is
 * committed: the blocking lines in `docs/plans/edhrec-ready-list.md` and the land/nonland kind in
 * the frozen EDHREC ranking. The real type line is not committed, so `probeTypeLine` guesses one
 * from the wording. The guess is frozen into the corpus, so it never changes under a parser
 * refactor; a wrong guess only makes that row a less faithful probe.
 *
 * Regenerate after `bun run edhrec:ready-list` changes the list, then regenerate the outcome
 * snapshot with `bun run scripts/snapshot-interpret-defs.ts` and read its diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { ONE_LINE_CORPUS_PATH, probeTypeLine, type OneLineCorpusRow } from './interpret-corpus';

const READY_LIST = 'docs/plans/edhrec-ready-list.md';
const RANKING = 'packages/server/fixtures/edhrec-ranking.json';

type RankingRow = [name: string, decks: number, kind: 'land' | 'nonland'];

const ranking = JSON.parse(readFileSync(RANKING, 'utf8')) as { cards: RankingRow[] };
const kindByRank = new Map(ranking.cards.map((row, index) => [index + 1, row[2]]));

const text = readFileSync(READY_LIST, 'utf8');
const start = text.indexOf('\n## One line away');
const end = text.indexOf('\n## ', start + 1);
if (start < 0 || end < 0) throw new Error(`${READY_LIST}: no "One line away" section`);

const unescapeName = (name: string): string => name.replace(/\\([\\`*_[\]<>])/g, '$1');
// One entry per line: "- 281. Aetherize (3.74%): `Return all attacking creatures …`". The fence
// is doubled when the line itself holds a backtick (renderReadyList's inlineCode).
const ENTRY = /^- (\d+)\. (.+) \(\d+\.\d+%\): (`+) ?(.*?) ?\3$/;

const rows: OneLineCorpusRow[] = [];
for (const entry of text.slice(start, end).split('\n')) {
  if (!entry.startsWith('- ')) continue;
  const match = ENTRY.exec(entry);
  if (match === null) throw new Error(`${READY_LIST}: unreadable entry: ${entry}`);
  const rank = Number(match[1]);
  const kind = kindByRank.get(rank);
  if (kind === undefined) throw new Error(`${READY_LIST}: rank ${rank} is not in ${RANKING}`);
  const line = match[4]!;
  rows.push({ rank, name: unescapeName(match[2]!), typeLine: probeTypeLine(line, kind), line });
}

// One row per line keeps the diff of a ready-list refresh readable.
const output = `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(ONE_LINE_CORPUS_PATH, 'utf8') !== output) {
    console.error(`${ONE_LINE_CORPUS_PATH} is out of date; run bun run scripts/one-line-corpus.ts`);
    process.exit(1);
  }
  console.log(`${ONE_LINE_CORPUS_PATH} is up to date (${rows.length} lines).`);
} else {
  writeFileSync(ONE_LINE_CORPUS_PATH, output);
  console.log(`wrote ${ONE_LINE_CORPUS_PATH} (${rows.length} lines)`);
}
