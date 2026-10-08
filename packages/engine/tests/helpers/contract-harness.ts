import type { ObjectId } from '@mtg/shared';
import type { DecisionOutcome, GameGen, PendingDecision } from '../../src/decisions';
import type { GameContext } from '../../src/state/types';

/** Only settled contexts can be cloned; suspended generators are replayed from their start. */
export function cloneContractContext(context: GameContext): GameContext {
  return {
    state: structuredClone(context.state),
    defs: structuredClone(context.defs),
    rng: context.rng.clone(),
    debugLog: structuredClone(context.debugLog),
  };
}

export interface ContractBounds {
  maxRuns: number;
  maxDecisions: number;
  maxOutcomes: number;
}
const defaultBounds: ContractBounds = { maxRuns: 512, maxDecisions: 24, maxOutcomes: 128 };

function* allocations(amount: number, keys: readonly string[]): Generator<Record<string, number>> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('invalid split amount');
  if (keys.length === 0) {
    if (amount === 0) yield {};
    return;
  }
  const [first, ...rest] = keys;
  for (let value = 0; value <= amount; value++) {
    for (const tail of allocations(amount - value, rest)) yield { [first!]: value, ...tail };
  }
}

/** Enumerate actual responses, never fabricate a target outside its advertised slot. */
export function contractOutcomes(
  decision: PendingDecision,
  limit = defaultBounds.maxOutcomes,
): DecisionOutcome[] {
  const outcomes: DecisionOutcome[] = [];
  const append = (outcome: DecisionOutcome): void => {
    if (outcomes.length >= limit) throw new Error(`contract outcome bound ${limit} exceeded`);
    outcomes.push(outcome);
  };
  for (const [index, option] of decision.options.entries()) {
    let targets: Map<number, ObjectId>[] = [new Map()];
    for (const slot of option.targets ?? []) {
      targets = targets.flatMap((selected) =>
        slot.options.map((id) => new Map([...selected, [slot.slot, id]])),
      );
      if (targets.length > limit) throw new Error(`contract target bound ${limit} exceeded`);
    }
    for (const chosen of targets) {
      if (decision.manaSplit !== undefined) {
        const { amount, colors } = decision.manaSplit;
        for (const manaSplit of allocations(amount, colors))
          append({ index, targets: chosen, manaSplit });
      } else if (decision.combatDamageSplit !== undefined) {
        const { amount, targets: ids } = decision.combatDamageSplit;
        for (const combatDamageSplit of allocations(amount, ids))
          append({ index, targets: chosen, combatDamageSplit });
      } else append({ index, targets: chosen });
    }
  }
  return outcomes;
}

export interface ContinuationFailure {
  prefix: DecisionOutcome[];
  prompt?: string;
  message: string;
}
export interface ContinuationContract {
  runs: number;
  completions: number;
  failures: ContinuationFailure[];
}

/**
 * Replay every advertised continuation from an independent full context. This deliberately
 * rejects a menu containing a dead end, even if choosing its first option happens to work.
 * Bounds failing are failures, not skipped evidence. Callers provide the seed in diagnostics.
 */
export function checkContinuations(
  base: GameContext,
  start: (context: GameContext) => GameGen<unknown>,
  bounds: ContractBounds = defaultBounds,
): ContinuationContract {
  const result: ContinuationContract = { runs: 0, completions: 0, failures: [] };
  const pending: DecisionOutcome[][] = [[]];
  while (pending.length > 0) {
    const prefix = pending.pop()!;
    if (++result.runs > bounds.maxRuns) {
      result.failures.push({ prefix, message: `contract run bound ${bounds.maxRuns} exceeded` });
      break;
    }
    const context = cloneContractContext(base);
    const flow = start(context);
    let prompt: string | undefined;
    try {
      let step = flow.next();
      for (const outcome of prefix) {
        if (step.done) throw new Error('decision replay completed before its recorded prefix');
        prompt = step.value.prompt;
        step = flow.next(outcome);
      }
      if (step.done) {
        result.completions++;
        continue;
      }
      prompt = step.value.prompt;
      if (prefix.length >= bounds.maxDecisions)
        throw new Error(`contract decision bound ${bounds.maxDecisions} exceeded`);
      const choices = contractOutcomes(step.value, bounds.maxOutcomes);
      if (choices.length === 0) throw new Error('advertised decision has no complete response');
      for (const choice of choices.reverse()) pending.push([...prefix, choice]);
    } catch (error) {
      result.failures.push({
        prefix,
        ...(prompt === undefined ? {} : { prompt }),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      flow.return(undefined);
    }
  }
  return result;
}
