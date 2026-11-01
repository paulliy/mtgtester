/**
 * Decision scripts (ADR 0034 decision 9): a test lists the unforced decisions it expects, in
 * order, each matched by its prompt and answered by naming an option. A decision the script did
 * not expect, an option no entry names, or an entry left over at the end fails the test with the
 * prompt and options printed, so a test never passes by guessing.
 */
import type { DecisionOutcome, PendingDecision } from '../src/decisions';

export interface ScriptStep {
  /** The decision's prompt: a substring, or a pattern. */
  prompt: string | RegExp;
  /** The option to choose, by its description: a substring, or a pattern. Exactly one may match. */
  choose?: string | RegExp;
  /** Answers the decision itself, for targets, splits or anything `choose` cannot say. */
  answer?: (decision: PendingDecision) => DecisionOutcome;
  /** Names the step in failures. */
  label?: string;
}

const SCRIPT = Symbol('decision script');

export interface DecisionScript {
  (decision: PendingDecision, count: number): DecisionOutcome;
  readonly [SCRIPT]: true;
  /** The steps not yet used. */
  remaining(): readonly ScriptStep[];
  /** Throws when a step was never used. */
  assertDone(): void;
}

export function isScript(answer: unknown): answer is DecisionScript {
  return typeof answer === 'function' && SCRIPT in answer;
}

const matches = (pattern: string | RegExp, text: string): boolean =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

/** The decision as a failure message shows it. */
export function describeDecision(decision: PendingDecision): string {
  const options = decision.options
    .map((option, index) => `    [${index}] ${option.description}`)
    .join('\n');
  return `${decision.player}: "${decision.prompt}"\n${options}`;
}

const stepName = (step: ScriptStep): string => step.label ?? String(step.prompt);

export function script(steps: readonly ScriptStep[]): DecisionScript {
  let next = 0;
  const answer = (decision: PendingDecision): DecisionOutcome => {
    const step = steps[next];
    if (step === undefined)
      throw new Error(`The script has no step for this decision:\n${describeDecision(decision)}`);
    if (!matches(step.prompt, decision.prompt))
      throw new Error(
        `Script step ${next + 1} (${stepName(step)}) expected a different decision:\n${describeDecision(decision)}`,
      );
    next += 1;
    if (step.answer !== undefined) return step.answer(decision);
    if (step.choose === undefined)
      throw new Error(`Script step ${next} (${stepName(step)}) names no option to choose`);
    const chosen = decision.options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => matches(step.choose!, option.description));
    if (chosen.length !== 1)
      throw new Error(
        `Script step ${next} (${stepName(step)}) chooses "${String(step.choose)}", which matches ${chosen.length} options:\n${describeDecision(decision)}`,
      );
    return { index: chosen[0]!.index, targets: new Map() };
  };
  return Object.assign(answer, {
    [SCRIPT]: true as const,
    remaining: () => steps.slice(next),
    assertDone: () => {
      if (next < steps.length)
        throw new Error(
          `The script ended with ${steps.length - next} unused step(s): ${steps
            .slice(next)
            .map(stepName)
            .join('; ')}`,
        );
    },
  });
}
