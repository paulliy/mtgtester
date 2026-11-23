/**
 * Triage the EDHREC ready list: the grammar slot that failed in each one-line card (ADR 0038).
 *
 *   bun run edhrec:triage                       # offline, from the one-line probe corpus
 *   bun run edhrec:triage --check               # fail if the committed triage is out of date
 *   bun run edhrec:triage --bank <file> --out <dir>
 *                                               # real Oracle text from a Scryfall bank
 *
 * Offline mode reads the committed corpus (`scripts/one-line-corpus.ts`), so it runs in CI and
 * writes the committed `packages/server/fixtures/edhrec-triage.json` and
 * `docs/plans/edhrec-triage.md`. Bank mode re-measures every ranked card against real Oracle text
 * and writes the same two files into `--out`, never over the committed ones, because the
 * committed pair must stay reproducible without the bank. Never uses the network.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { interpretCardWithDiagnostics } from '@mtg/engine';
import { loadOracleIndexFromFile } from '../cards/oracle-index-file';
import { readiness, type EdhrecRanking } from '../cards/edhrec-ranking';
import {
  renderTriageJson,
  renderTriageMarkdown,
  triageRecord,
  type TriageRecord,
} from '../cards/edhrec-triage';
import { corpusCard, ONE_LINE_CORPUS_PATH, type OneLineCorpusRow } from '../cards/one-line-corpus';

const RANKING_PATH = 'packages/server/fixtures/edhrec-ranking.json';
const JSON_PATH = 'packages/server/fixtures/edhrec-triage.json';
const MARKDOWN_PATH = 'docs/plans/edhrec-triage.md';

function option(name: string): string | undefined {
  const slot = process.argv.indexOf(name);
  if (slot < 0) return undefined;
  const value = process.argv[slot + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function fromCorpus(ranking: EdhrecRanking): TriageRecord[] {
  const rows = JSON.parse(
    readFileSync(resolve(ONE_LINE_CORPUS_PATH), 'utf8'),
  ) as OneLineCorpusRow[];
  return rows.map((row) => {
    const ranked = ranking.cards[row.rank - 1];
    if (ranked === undefined || ranked[0] !== row.name) {
      throw new Error(
        `${ONE_LINE_CORPUS_PATH}: rank ${row.rank} is not ${row.name} in the ranking`,
      );
    }
    const { failures } = interpretCardWithDiagnostics(corpusCard(row));
    return triageRecord({
      rank: row.rank,
      name: row.name,
      decks: ranked[1],
      line: row.line,
      failures,
    });
  });
}

function fromBank(ranking: EdhrecRanking, bank: string): TriageRecord[] {
  console.error(`Loading Oracle data from ${bank} …`);
  const index = loadOracleIndexFromFile(resolve(bank));
  const records: TriageRecord[] = [];
  ranking.cards.forEach(([name, decks], position) => {
    const card = index.resolve(name);
    if (card === null) return;
    const { definition, failures } = interpretCardWithDiagnostics(card);
    const ready = readiness({ modeled: definition.modeled, reasons: definition.unmodeledReasons });
    if (ready?.status !== 'one-line') return;
    records.push(triageRecord({ rank: position + 1, name, decks, line: ready.line, failures }));
  });
  return records;
}

function main(): void {
  const ranking = JSON.parse(readFileSync(resolve(RANKING_PATH), 'utf8')) as EdhrecRanking;
  const bank = option('--bank');
  const out = option('--out');
  if (bank !== undefined && out === undefined) {
    throw new Error('--bank writes into --out <dir>, never over the committed offline triage');
  }
  const records = bank === undefined ? fromCorpus(ranking) : fromBank(ranking, bank);
  const json = renderTriageJson(records);
  const markdown = renderTriageMarkdown({
    records,
    totalSlots: ranking.totalSlots,
    source:
      bank === undefined
        ? 'the one-line probe corpus (synthetic cards carrying only the blocking line)'
        : `\`${bank}\``,
  });

  if (process.argv.includes('--check')) {
    const stale = [JSON_PATH, MARKDOWN_PATH].filter(
      (path, i) => readFileSync(resolve(path), 'utf8') !== [json, markdown][i],
    );
    if (stale.length > 0) {
      console.error(`out of date: ${stale.join(', ')}; run bun run edhrec:triage`);
      process.exit(1);
    }
    console.log(`edhrec triage is up to date (${records.length} cards).`);
    return;
  }
  const jsonPath = out === undefined ? JSON_PATH : join(out, 'edhrec-triage.json');
  const markdownPath = out === undefined ? MARKDOWN_PATH : join(out, 'edhrec-triage.md');
  if (out !== undefined) mkdirSync(resolve(out), { recursive: true });
  writeFileSync(resolve(jsonPath), json);
  writeFileSync(resolve(markdownPath), markdown);
  console.log(`wrote ${jsonPath} and ${markdownPath} (${records.length} cards)`);
}

main();
