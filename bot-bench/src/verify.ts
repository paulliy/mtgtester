/**
 * Checks that a case's reference still agrees with the engine: the position opens, the best
 * answer is legal, every reviewed option and line is reachable, and the grades and scores do not
 * contradict each other. Run by the test suite and by `bot-bench verify`, so a change to the
 * engine, the cards or the heuristic bot that invalidates a reference fails loudly.
 */
import { analyzeCase } from './analysis';
import { GRADE_POINTS, type BenchCase, type SingleReference } from './case';

/** The problems found in one case; empty when its reference holds. */
export async function verifyCase(benchCase: BenchCase): Promise<string[]> {
  const problems: string[] = [];
  const analysis = await analyzeCase(benchCase);
  if (analysis.focus.request.decidingPlayer !== benchCase.actor)
    problems.push("the decision under test is not the tested seat's");

  if (analysis.scope === 'single') {
    const reference = benchCase.reference as SingleReference;
    if (!analysis.exhaustive)
      problems.push('too many legal answers to enumerate; narrow the decision');
    for (const option of reference.options)
      if (!analysis.options.some((row) => row.graded.label === option.label))
        problems.push(`no legal answer matches the reviewed option "${option.label}"`);
    const best = analysis.options.filter((row) => row.graded.grade === 'best');
    if (best.length === 0) problems.push('no legal answer is graded best');
    for (const row of best)
      if (!row.legal) problems.push(`the best answer "${row.action}" is refused by the engine`);
    return problems;
  }

  for (const line of analysis.lines) {
    const name = `line "${line.line.id}"`;
    if (line.termination !== 'complete')
      problems.push(`${name} ended ${line.termination}: ${line.error ?? ''}`);
    if (line.unused.length > 0)
      problems.push(
        `${name} never reached ${line.unused.length} step(s), first "${line.unused[0]?.choose}"`,
      );
    if (line.line.grade === 'best' && line.score.score < 1)
      problems.push(
        `${name} is graded best but meets ${Math.round(line.score.score * 100)}% of the objectives`,
      );
    if (line.line.grade !== 'best' && line.score.score >= 1)
      problems.push(`${name} is graded ${line.line.grade} but meets every objective`);
  }
  for (const better of analysis.lines)
    for (const worse of analysis.lines)
      if (
        GRADE_POINTS[better.line.grade] > GRADE_POINTS[worse.line.grade] &&
        better.score.score < worse.score.score
      )
        problems.push(
          `line "${better.line.id}" (${better.line.grade}) scores below "${worse.line.id}" (${worse.line.grade})`,
        );
  return problems;
}
