/**
 * Scoring against a case's reviewed reference. A one-decision case is worth the grade of the
 * answer the seat gave; a whole-turn case is worth the share of its objectives the final position
 * meets. An answer the model never legally produced scores nothing on a one-decision case.
 */
import { scenarioPattern } from '../../packages/engine/src';
import type { DecisionRequest, DecisionResponse } from '../../packages/shared/src';
import { matchesAnswer, type Names } from './answers';
import {
  GRADE_POINTS,
  type BenchCase,
  type Grade,
  type Objective,
  type SingleReference,
  type TurnReference,
} from './case';
import type { CaseRun, Snapshot } from './play';

export interface GradedAnswer {
  grade: Grade;
  points: number;
  /** The reviewed option the answer matched, or "Unlisted answer". */
  label: string;
  why: string;
}

export function gradeAnswer(
  reference: SingleReference,
  request: DecisionRequest,
  response: DecisionResponse,
  names: Names,
): GradedAnswer {
  for (const option of reference.options) {
    if (matchesAnswer(option.when, request, response, names))
      return {
        grade: option.grade,
        points: GRADE_POINTS[option.grade],
        label: option.label,
        why: option.why,
      };
  }
  const { grade, why } = reference.otherwise;
  return { grade, points: GRADE_POINTS[grade], label: 'Unlisted answer', why };
}

export interface ObjectiveResult {
  id: string;
  label: string;
  points: number;
  met: boolean;
}

function hasAll(names: readonly string[], wanted: readonly string[]): boolean {
  const remaining = [...names];
  for (const name of wanted) {
    const index = remaining.indexOf(name);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function objectiveMet(objective: Objective, after: Snapshot, actions: readonly string[]): boolean {
  const { check } = objective;
  const seat = (id: string) => after.find((entry) => entry.seat === id);
  if ('eliminated' in check) return seat(check.eliminated)?.alive === false;
  if ('life' in check) {
    const life = seat(check.life.player)?.life;
    if (life === undefined) return false;
    return (
      (check.life.atLeast === undefined || life >= check.life.atLeast) &&
      (check.life.atMost === undefined || life <= check.life.atMost)
    );
  }
  if ('zone' in check) {
    const names = seat(check.zone.player)?.[check.zone.zone];
    if (names === undefined) return false;
    return (
      hasAll(names, check.zone.has ?? []) &&
      (check.zone.lacks ?? []).every((name) => !names.includes(name))
    );
  }
  const { took, neverTook } = check.action;
  return (
    (took === undefined || actions.some(scenarioPattern(took))) &&
    (neverTook === undefined || !actions.some(scenarioPattern(neverTook)))
  );
}

export function checkObjectives(reference: TurnReference, run: CaseRun): ObjectiveResult[] {
  const actions = run.decisions.map((decision) => decision.action);
  return reference.objectives.map((objective) => ({
    id: objective.id,
    label: objective.label,
    points: objective.points,
    met: objectiveMet(objective, run.after, actions),
  }));
}

export interface CaseScore {
  /** Share of the case's points earned, 0 to 1. */
  score: number;
  /** One-decision cases: the grade of the answer. */
  graded?: GradedAnswer;
  /** Whole-turn cases: each objective and whether the final position meets it. */
  objectives?: ObjectiveResult[];
  /** Things a reader should know before trusting the number. */
  flags: string[];
}

export function scoreRun(benchCase: BenchCase, run: CaseRun): CaseScore {
  const flags: string[] = [];
  if (run.termination === 'error' || run.termination === 'halted')
    flags.push(`run ${run.termination}: ${run.error ?? ''}`.trim());
  if (run.termination === 'decision_cap')
    flags.push(`stopped asking after ${run.decisions.length} decisions`);
  const invalid = run.decisions.filter((decision) => decision.invalid !== undefined).length;
  const fallbacks = run.decisions.filter((decision) => decision.source === 'fallback').length;
  const retries = run.decisions.filter((decision) => decision.source === 'model-retry').length;
  if (invalid > 0) flags.push(`${invalid} answer(s) refused; the table played instead`);
  if (fallbacks > 0) flags.push(`${fallbacks} decision(s) fell back to the heuristic bot`);
  if (retries > 0) flags.push(`${retries} decision(s) needed a corrective retry`);
  const bot = run.decisions.filter((decision) => decision.source === 'bot-handoff').length;
  if (bot > 0)
    flags.push(
      `${bot} decision(s) answered by the heuristic bot: a shape a decision model cannot express`,
    );

  if (benchCase.scope === 'single') {
    const decision = run.decisions[0];
    if (decision === undefined) return { score: 0, flags: [...flags, 'no answer'] };
    const graded = gradeAnswer(
      benchCase.reference as SingleReference,
      run.focus.request,
      decision.response,
      new Map(Object.entries(run.focus.names)),
    );
    // What the table or the fallback bot played is not the model's answer.
    const own = decision.invalid === undefined && decision.source !== 'fallback';
    return { score: own ? graded.points : 0, graded, flags };
  }

  const objectives = checkObjectives(benchCase.reference as TurnReference, run);
  const total = objectives.reduce((sum, objective) => sum + objective.points, 0);
  const earned = objectives.reduce((sum, o) => sum + (o.met ? o.points : 0), 0);
  return { score: total === 0 ? 0 : earned / total, objectives, flags };
}
