/**
 * The reference investigation of a case, done with the engine rather than by assertion. For a
 * one-decision case every legal answer is played out and its consequences recorded beside the
 * reviewer's grade; for a whole-turn case every reviewed line is replayed and scored. A judge
 * reads this to see what each choice actually leads to, and the test suite reads it to catch a
 * reference the engine no longer agrees with.
 */
import type { DecisionRequest, DecisionResponse, PlayerView } from '../../packages/shared/src';
import { describeAnswer, enumerateAnswers, type Names } from './answers';
import type {
  AnswerSpec,
  BenchCase,
  ReferenceLine,
  Seat,
  SingleReference,
  TurnReference,
} from './case';
import {
  fixedAnswerActor,
  openCase,
  playCase,
  scriptedActor,
  type CaseRun,
  type Snapshot,
} from './play';
import { gradeAnswer, scoreRun, type CaseScore, type GradedAnswer } from './score';

/** Answers played out per one-decision case before the table is cut to the reviewed ones. */
export const ENUMERATION_LIMIT = 300;

function multisetDiff(before: readonly string[], after: readonly string[]) {
  const remaining = [...before];
  const gained: string[] = [];
  for (const name of after) {
    const index = remaining.indexOf(name);
    if (index === -1) gained.push(name);
    else remaining.splice(index, 1);
  }
  return { gained, lost: remaining };
}

/** What changed between two snapshots, one line per fact, the tested seat's hand included. */
export function describeChanges(before: Snapshot, after: Snapshot, actor: Seat): string[] {
  const lines: string[] = [];
  for (const now of after) {
    const then = before.find((entry) => entry.seat === now.seat);
    if (then === undefined) continue;
    if (then.alive && !now.alive) {
      // An eliminated seat's permanents and hand leave with it; listing them says nothing more.
      lines.push(`${now.seat} is ELIMINATED (life ${then.life} → ${now.life})`);
      continue;
    }
    if (then.life !== now.life) lines.push(`${now.seat} life ${then.life} → ${now.life}`);
    const board = multisetDiff(then.battlefield, now.battlefield);
    if (board.gained.length > 0)
      lines.push(`${now.seat} battlefield gains ${board.gained.join(', ')}`);
    if (board.lost.length > 0) lines.push(`${now.seat} battlefield loses ${board.lost.join(', ')}`);
    if (now.seat === actor) {
      const hand = multisetDiff(then.hand, now.hand);
      if (hand.lost.length > 0) lines.push(`${now.seat} hand uses ${hand.lost.join(', ')}`);
      if (hand.gained.length > 0) lines.push(`${now.seat} hand gains ${hand.gained.join(', ')}`);
    } else if (then.hand.length !== now.hand.length) {
      lines.push(`${now.seat} hand ${then.hand.length} → ${now.hand.length} cards`);
    }
  }
  return lines.length === 0 ? ['nothing changes'] : lines;
}

export interface OptionRow {
  /** The answer without object ids. */
  key: string;
  action: string;
  response: DecisionResponse;
  graded: GradedAnswer;
  /** False when the engine refused the answer. */
  legal: boolean;
  /** What the rest of the run looked like after this answer. */
  changes: string[];
  log: string[];
}

export interface SingleAnalysis {
  scope: 'single';
  focus: { request: DecisionRequest; view: PlayerView; names: Record<string, string> };
  /** True when `options` is every legal answer; false when only reviewed answers were played. */
  exhaustive: boolean;
  options: OptionRow[];
}

export interface LineAnalysis {
  line: ReferenceLine;
  actions: string[];
  score: CaseScore;
  changes: string[];
  log: string[];
  /** Steps the engine never reached: a stale or mis-ordered line. */
  unused: AnswerSpec[];
  termination: CaseRun['termination'];
  error?: string;
}

export interface TurnAnalysis {
  scope: 'turn';
  focus: { request: DecisionRequest; view: PlayerView; names: Record<string, string> };
  lines: LineAnalysis[];
}

export type CaseAnalysis = SingleAnalysis | TurnAnalysis;

/** One answer to a one-decision case, played to the end of the arranged window. */
export async function playAnswer(
  benchCase: BenchCase,
  response: DecisionResponse,
): Promise<OptionRow> {
  const run = await playCase(benchCase, fixedAnswerActor(response));
  const names: Names = new Map(Object.entries(run.focus.names));
  const described = describeAnswer(run.focus.request, response, names);
  const decision = run.decisions[0];
  return {
    key: described.key,
    action: described.text,
    response,
    graded: gradeAnswer(benchCase.reference as SingleReference, run.focus.request, response, names),
    legal: decision !== undefined && decision.invalid === undefined && run.termination !== 'error',
    changes: describeChanges(run.before, run.after, benchCase.actor),
    log: run.log,
  };
}

const GRADE_ORDER = { best: 0, good: 1, weak: 2, blunder: 3 } as const;

async function analyzeSingle(benchCase: BenchCase): Promise<SingleAnalysis> {
  const opened = openCase(benchCase);
  const answers = enumerateAnswers(opened.request, ENUMERATION_LIMIT);
  const rows = new Map<string, OptionRow>();
  for (const response of answers ?? []) {
    const row = await playAnswer(benchCase, response);
    if (!rows.has(row.key)) rows.set(row.key, row);
  }
  const options = [...rows.values()].sort(
    (left, right) =>
      GRADE_ORDER[left.graded.grade] - GRADE_ORDER[right.graded.grade] ||
      left.action.localeCompare(right.action),
  );
  return {
    scope: 'single',
    focus: { request: opened.request, view: opened.view, names: opened.names },
    exhaustive: answers !== null,
    options,
  };
}

async function analyzeTurn(benchCase: BenchCase): Promise<TurnAnalysis> {
  const reference = benchCase.reference as TurnReference;
  const lines: LineAnalysis[] = [];
  let focus: TurnAnalysis['focus'] | undefined;
  for (const line of reference.lines) {
    const scripted = scriptedActor(line.steps);
    const run = await playCase(benchCase, scripted.factory);
    focus ??= run.focus;
    lines.push({
      line,
      actions: run.decisions.map((decision) => decision.action),
      score: scoreRun(benchCase, run),
      changes: describeChanges(run.before, run.after, benchCase.actor),
      log: run.log,
      unused: scripted.unused(),
      termination: run.termination,
      ...(run.error !== undefined && { error: run.error }),
    });
  }
  if (focus === undefined) throw new Error(`${benchCase.id}: no reference line`);
  return { scope: 'turn', focus, lines };
}

export function analyzeCase(benchCase: BenchCase): Promise<CaseAnalysis> {
  return benchCase.scope === 'single' ? analyzeSingle(benchCase) : analyzeTurn(benchCase);
}
