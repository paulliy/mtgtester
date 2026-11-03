/**
 * The one-line probe corpus and its outcome snapshot (ADR 0038 decision 5).
 *
 * Each row is a ready-list card reduced to the single rules line that blocks it, placed on a
 * synthetic card. `oneLineOutcomes` runs every row through the production `interpretCard` and
 * records, per row, whether the line is still blocked and a hash of the whole definition. A
 * parser refactor must leave the outcomes unchanged; a coverage change shows up as rows that
 * turned `modeled`, which is that change's measured yield.
 */

import { createHash } from 'node:crypto';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { canonicalDefinition } from '../packages/engine/src/cards/interpret-snapshot';
import {
  corpusCard,
  ONE_LINE_CORPUS_PATH,
  probeTypeLine,
  type OneLineCorpusRow,
} from '../packages/server/src/cards/one-line-corpus';

export { ONE_LINE_CORPUS_PATH, probeTypeLine, type OneLineCorpusRow };

export const ONE_LINE_OUTCOMES_PATH = 'packages/engine/tests/fixtures/one-line-outcomes.tsv';

/**
 * One TSV row per corpus row, in rank order: rank, outcome, definition hash. The outcome is
 * `blocked` when the only reason is the corpus line itself, `modeled` when there are no reasons,
 * and the reasons as JSON otherwise.
 */
export function oneLineOutcomes(rows: readonly OneLineCorpusRow[]): string {
  const out = ['rank\toutcome\tdefinition'];
  for (const row of [...rows].sort((a, b) => a.rank - b.rank)) {
    const def = interpretCard(corpusCard(row));
    const reasons = def.unmodeledReasons;
    const outcome =
      reasons.length === 0
        ? 'modeled'
        : reasons.length === 1 && reasons[0] === `unrecognized rules text: "${row.line}"`
          ? 'blocked'
          : JSON.stringify(reasons);
    const hash = createHash('sha256')
      .update(JSON.stringify(canonicalDefinition(def)))
      .digest('hex')
      .slice(0, 16);
    out.push(`${row.rank}\t${outcome}\t${hash}`);
  }
  return `${out.join('\n')}\n`;
}
