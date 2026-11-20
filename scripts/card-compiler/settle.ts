/**
 * How many compiled patches the free text check (`render.ts`) settles, measured over the patches
 * the committed compiler trials produced. A settled patch skips the model back-translation and
 * judge, so the settled count is what this check saves; a wrong patch that settles would reach the
 * review queue marked as checked, so every settled patch must also appear in the hand audit list
 * (`settle-audit.json`), and none may be one a hand audit found wrong.
 *
 * `bun run scripts/card-compiler/settle.ts` prints the count, the settled names, and the most
 * common reasons the rest do not settle.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { behaviorOf, cardByName, pinnedPool } from './lib';
import { textCheck, type TextCheck } from './render';

export const TRIAL_DIRS = [
  'docs/reviews/card-compiler-trial-01',
  'docs/reviews/card-compiler-trial-02',
] as const;

export const AUDIT_PATH = 'scripts/card-compiler/settle-audit.json';

export interface TrialPatch {
  trial: string;
  name: string;
  handledLines: string[];
  def: Partial<CardDefinition>;
  oracleText: string;
  /** The trial's model-check outcome: `compiled-checked`, `meaning-differs` or `smoke-failed`. */
  outcome: string;
}

export interface AuditEntry {
  name: string;
  /** `correct`: the patch does what the Oracle lines say. `wrong`: it must never settle. */
  verdict: 'correct' | 'wrong';
  note: string;
}

export function trialPatches(): TrialPatch[] {
  const out: TrialPatch[] = [];
  for (const dir of TRIAL_DIRS) {
    const results = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8')) as {
      cards: Array<{ name: string; outcome: string }>;
    };
    const outcome = new Map(results.cards.map((card) => [card.name, card.outcome]));
    for (const file of readdirSync(`${dir}/patches`).sort()) {
      const patch = JSON.parse(readFileSync(`${dir}/patches/${file}`, 'utf8')) as {
        name: string;
        handledLines: string[];
        def: Partial<CardDefinition>;
      };
      out.push({
        trial: dir.slice(-2),
        name: patch.name,
        handledLines: patch.handledLines,
        def: patch.def,
        oracleText: cardByName(patch.name).oracleText ?? '',
        outcome: outcome.get(patch.name) ?? 'unknown',
      });
    }
  }
  return out;
}

export function checkPatch(patch: TrialPatch): TextCheck {
  return textCheck(patch.def, patch.handledLines, patch.name, patch.oracleText);
}

export interface SettleReport {
  patches: number;
  settled: string[];
  unrendered: Map<string, number>;
  mismatched: string[];
}

export function measureSettle(patches: TrialPatch[] = trialPatches()): SettleReport {
  const report: SettleReport = {
    patches: patches.length,
    settled: [],
    unrendered: new Map(),
    mismatched: [],
  };
  for (const patch of patches) {
    const result = checkPatch(patch);
    if (result.verdict === 'match') report.settled.push(patch.name);
    else if (result.verdict === 'mismatch') report.mismatched.push(patch.name);
    else report.unrendered.set(result.node, (report.unrendered.get(result.node) ?? 0) + 1);
  }
  return report;
}

/**
 * Modeled pinned-pool cards whose parsed behavior renders to exactly their Oracle text: the same
 * check run on the parser's IR. It moves with renderer coverage, and future patches look like
 * these lines.
 */
export function poolTextMatches(): number {
  let matches = 0;
  for (const { card } of pinnedPool()) {
    const oracleText = card.oracleText ?? '';
    if (oracleText === '') continue;
    const definition = interpretCard(card);
    if (!definition.modeled) continue;
    const behavior = behaviorOf(definition) as Partial<CardDefinition>;
    if (textCheck(behavior, oracleText.split('\n'), card.name, oracleText).verdict === 'match')
      matches++;
  }
  return matches;
}

export function auditList(): AuditEntry[] {
  return JSON.parse(readFileSync(AUDIT_PATH, 'utf8')) as AuditEntry[];
}

if (import.meta.main) {
  const patches = trialPatches();
  const report = measureSettle(patches);
  console.log(`settled ${report.settled.length} of ${report.patches} trial patches`);
  for (const name of report.settled) console.log(`  ${name}`);
  console.log(`mismatched (rendered, text differs): ${report.mismatched.length}`);
  if (process.argv.includes('--mismatches'))
    for (const name of report.mismatched) {
      const patch = patches.find((p) => p.name === name)!;
      const result = checkPatch(patch);
      console.log(`  ${name}\n    oracle:   ${patch.handledLines.join(' | ')}`);
      if (result.verdict === 'mismatch')
        console.log(`    rendered: ${result.rendered.join(' | ')}`);
    }
  console.log('unrendered, by first node the renderer cannot say:');
  for (const [node, count] of [...report.unrendered].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(count).padStart(4)}  ${node}`);
}
