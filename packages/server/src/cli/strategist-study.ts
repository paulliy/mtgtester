/**
 * ADR 0045's study over one captured game (`strategist-capture`): mark turns, run the knob grid
 * as bot arms over rollout seeds, keep the turns where the bot arms disagree, and on those run the
 * tactician (with and without the strategist's context) and the reviewer's reference line.
 *
 *   bun run strategist-study --capture F --mark-only [--sample-rate 0.1] [--max-turns 10] [--out F]
 *   bun run strategist-study --capture F [--seeds 3] [--sample-rate 0.1] [--margin 2]
 *        [--evaluator own-position-v1] [--max-turns 10] [--lines lines.json]
 *        [--arms id,id] [--disagree hash-or-gap|gap] [--disagree-margin 4] [--tactician] [--trials 3] [--max-usd 2] [--out report.json]
 *
 * Bot arms cost nothing. `--tactician` is PAID: it uses the tactician from `.env` on turns that
 * pass the disagreement filter, K trials each, and stops at `--max-usd`. `--lines` holds the
 * reviewer's reference line and judgements per marked turn, keyed by fork decision index:
 * `{"123": {"steps": [{"choose": "Cast Overrun"}], "evaluator": "eliminations-v1",
 *   "judgement": {"namingArm": "aggression-1", "ruleCouldFind": {"value": false, "reason": "..."}}}}`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlayerId } from '@mtg/shared';
import { Rng } from '@mtg/bot';
import { configForRole, loadAiConfig } from '../ai/config';
import { OpenAiCompatibleClient } from '../ai/client';
import type { CounterfactualEvaluator } from '../benchmark/counterfactual';
import {
  referenceArm,
  tacticianArm,
  type LineStep,
  type StudyContext,
} from '../benchmark/turn-arms';
import {
  runArm,
  seedVariationTooNarrow,
  type ArmRun,
  type TurnFork,
  type TurnPolicyFactory,
} from '../benchmark/turn-counterfactual';
import {
  botArmsDisagree,
  pairwiseArms,
  ELIMINATIONS,
  GAME_RESULT,
  knobGrid,
  OWN_POSITION,
  pressureOn,
  sampledTurns,
  SURVIVAL,
  seatTurns,
  swingTurns,
  verdictFor,
  type SeatTurn,
  type VerdictJudgement,
  type VerdictResult,
} from '../benchmark/turn-study';
import { budgetedFetch, counting, emptyTally, type Budget } from './ai-mode-duel';
import type { StrategistCapture } from './strategist-capture';
import { seatDiplomacyContext } from '../ai/diplomacy-context';

export const STUDY_EVALUATORS: readonly CounterfactualEvaluator[] = [
  OWN_POSITION,
  SURVIVAL,
  ELIMINATIONS,
  GAME_RESULT,
];

export interface MarkedTurnReport {
  forkDecisionIndex: number;
  turn: number;
  seat: PlayerId;
  why: Array<'swing' | 'sample'>;
  arms: ArmRun[];
  disagree: boolean;
  /** Tactician trials not credited: the fallback bot played a decision, or the cap was hit. */
  discardedTrials: number;
  /** Runs cut off by the decision limit or an illegal answer, kept out of every comparison. */
  incompleteRuns: number;
  verdict?: VerdictResult & { evaluator: string };
}

export interface StudyReport {
  schemaVersion: 1;
  kind: 'strategist-study';
  capture: string;
  seeds: string[];
  margin: number;
  markedTurns: MarkedTurnReport[];
  /** ADR 0045 decision 1.3: true when hidden-zone re-sampling has to be built. */
  seedVariationTooNarrow: boolean;
}

interface LineEntry {
  steps: LineStep[];
  evaluator?: string;
  judgement?: VerdictJudgement;
  context?: StudyContext;
}

export interface StudyOptions {
  capture: StrategistCapture;
  captureName: string;
  seeds: string[];
  sampleRate: number;
  margin: number;
  evaluator: string;
  maxTurns: number;
  lines: Record<string, LineEntry>;
  tactician?: {
    arm: (context: StudyContext | null) => TurnPolicyFactory;
    trials: number;
    /** Whether the spend cap has been reached: later trials are all-bot and not credited. */
    capped?: () => boolean;
  };
  /** The disagreement filter: the ADR's hash-or-gap (default), or the evaluator gap alone. */
  disagree?: 'hash-or-gap' | 'gap';
  /** The filter's evaluator margin; defaults to `margin`, the verdicts' margin. */
  disagreeMargin?: number;
  share?: number;
  /**
   * Only these grid arms, by id (`aggression-1`, `hold-Negate`, ...); the strategist's own knobs
   * are always kept. For a focused follow-up on the knob a line names, or a cheap smoke run.
   */
  gridArms?: readonly string[];
  /** Decisions a rollout may take before it is cut off as incomplete (the counterfactual's default otherwise). */
  maxDecisions?: number;
}

/** Which turns to examine: swings first, then the seeded sample, without repeats. */
export function markTurns(
  capture: StrategistCapture,
  sampleRate: number,
  seed: string,
): Array<SeatTurn & { why: Array<'swing' | 'sample'> }> {
  const turns = seatTurns(capture.transcript);
  const marked = new Map<number, SeatTurn & { why: Array<'swing' | 'sample'> }>();
  for (const turn of swingTurns(turns))
    marked.set(turn.forkDecisionIndex, { ...turn, why: ['swing'] });
  for (const turn of sampledTurns(turns, sampleRate, seed)) {
    const existing = marked.get(turn.forkDecisionIndex);
    if (existing !== undefined) existing.why.push('sample');
    else marked.set(turn.forkDecisionIndex, { ...turn, why: ['sample'] });
  }
  return [...marked.values()].sort((a, b) => a.forkDecisionIndex - b.forkDecisionIndex);
}

/**
 * At most `max` marked turns, drawn with a seeded shuffle rather than the first ones, so a cap
 * does not drop late-game swings first. Returned in game order.
 */
export function capTurns<T extends { forkDecisionIndex: number }>(
  turns: readonly T[],
  max: number,
  seed: string,
): T[] {
  if (turns.length <= max) return [...turns];
  const rng = new Rng(`${seed}:cap`);
  const pool = [...turns];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, max).sort((a, b) => a.forkDecisionIndex - b.forkDecisionIndex);
}

/**
 * The evaluator a name stands for: one of the fixed evaluators, or `pressure-on-<seat>-v1` for a
 * seat. An unknown name throws rather than scoring every arm 0 (which reads as "no gap").
 */
export function resolveEvaluator(name: string): CounterfactualEvaluator {
  const fixed = STUDY_EVALUATORS.find((evaluator) => evaluator.version === name);
  if (fixed !== undefined) return fixed;
  const pressure = /^pressure-on-(P[1-4])-v1$/.exec(name);
  if (pressure !== null) return pressureOn(pressure[1]!);
  throw new Error(
    `unknown evaluator "${name}"; use ${STUDY_EVALUATORS.map((e) => e.version).join(', ')} or pressure-on-<seat>-v1`,
  );
}

/**
 * A run that reached the horizon or ended the game legitimately. A rollout cut off by the
 * decision limit, ended by an answer the engine refused, stopped by an engine halt, or a reviewer
 * line that could not be played as written, stopped at an arbitrary point: its values are not
 * comparable with completed ones.
 */
export function completed(run: ArmRun): boolean {
  return (
    run.termination === 'horizon' ||
    run.termination === 'game_over' ||
    run.termination === 'seat_eliminated'
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function runStudy(options: StudyOptions): Promise<StudyReport> {
  const { capture } = options;
  // Every evaluator a line may name is checked before any arm runs.
  resolveEvaluator(options.evaluator);
  for (const line of Object.values(options.lines))
    if (line.evaluator !== undefined) resolveEvaluator(line.evaluator);
  const reports: MarkedTurnReport[] = [];
  const limit = options.maxDecisions === undefined ? {} : { maxDecisions: options.maxDecisions };
  const marked = capTurns(
    markTurns(capture, options.sampleRate, options.captureName),
    options.maxTurns,
    options.captureName,
  );
  const botRuns: ArmRun[][] = [];
  const botArmIds = new Set<string>();
  for (const turn of marked) {
    const context = capture.turns.find((t) => t.decisionIndex === turn.forkDecisionIndex);
    // The reviewer's line names the turn's class and so its evaluator; the filter uses it too.
    const line = options.lines[String(turn.forkDecisionIndex)];
    const evaluator = line?.evaluator ?? options.evaluator;
    const evaluators = STUDY_EVALUATORS.some((e) => e.version === evaluator)
      ? STUDY_EVALUATORS
      : [...STUDY_EVALUATORS, resolveEvaluator(evaluator)];
    const fork: TurnFork = {
      transcript: capture.transcript,
      forkDecisionIndex: turn.forkDecisionIndex,
      seat: turn.seat,
      knobsBySeat: context?.knobs ?? {},
      // The deals the captured bots enforced, held the same way in every rollout.
      ...(context?.obligations === undefined ? {} : { obligationsBySeat: context.obligations }),
    };
    const view = capture.transcript.decisions[turn.forkDecisionIndex]!.observerView;
    const opponents = view.opponents.filter((o) => o.life > 0).map((o) => o.seat);
    const grid = knobGrid(
      context?.knobs[turn.seat],
      opponents,
      view.hand.map((card) => card.name),
    ).filter(
      (arm) =>
        options.gridArms === undefined ||
        arm.id === 'strategist' ||
        options.gridArms.includes(arm.id),
    );
    const arms: ArmRun[] = [];
    for (const arm of grid)
      for (const seed of options.seeds)
        arms.push(
          await runArm(
            fork,
            {
              kind: 'bot',
              id: arm.id,
              steering: arm.steering,
              ...(arm.knob === undefined ? {} : { knob: arm.knob }),
            },
            { rolloutSeed: seed, evaluators, ...limit },
          ),
        );
    const botIds = new Set(grid.map((arm) => arm.id));
    for (const id of botIds) botArmIds.add(id);
    const complete = arms.filter(completed);
    botRuns.push([...complete]);
    const disagree = botArmsDisagree(
      complete,
      botIds,
      evaluator,
      options.disagreeMargin ?? options.margin,
      options.disagree ?? 'hash-or-gap',
    );
    const deals =
      context?.deals?.[turn.seat] === undefined || context.deals[turn.seat]!.length === 0
        ? undefined
        : (seatDiplomacyContext(
            turn.seat,
            {
              deals: context.deals[turn.seat]!,
              records: [],
              canPropose: false,
              maxRounds: 2,
              maxObligationsPerSide: 2,
            },
            'tactician',
          ) ?? undefined);
    const tacticianValues: number[] = [];
    let discarded = 0;
    let incomplete = arms.length - complete.length;
    if (disagree && options.tactician !== undefined) {
      const studyContext: StudyContext = line?.context ?? {
        intent: 'from the capture',
        ...(context?.knobs[turn.seat] === undefined ? {} : { steering: context.knobs[turn.seat]! }),
      };
      for (const [id, armContext] of [
        ['tactician', null],
        ['tactician-context', { ...studyContext, ...(deals === undefined ? {} : { deals }) }],
      ] as const) {
        for (let trial = 0; trial < options.tactician.trials; trial++) {
          const run = await runArm(
            fork,
            {
              kind: 'tactician',
              id,
              policyFor: options.tactician.arm(armContext),
              withContext: armContext !== null,
            },
            { rolloutSeed: options.seeds[trial % options.seeds.length]!, evaluators, ...limit },
          );
          arms.push(run);
          // ADR 0045 decision 1.4: a trial where the fallback bot played any of the model's
          // decisions (a failed answer, or the spend cap) is not credited to the model, and a
          // trial that never reached the horizon is not compared at all.
          const credited =
            completed(run) && run.handedToBot === 0 && options.tactician.capped?.() !== true;
          if (!completed(run)) incomplete++;
          if (!credited) discarded++;
          else if (id === 'tactician-context') tacticianValues.push(run.values[evaluator] ?? 0);
        }
      }
    }
    let verdict: MarkedTurnReport['verdict'];
    if (line !== undefined) {
      const reference: number[] = [];
      let referenceIncomplete = 0;
      let referenceError: string | undefined;
      for (const seed of options.seeds) {
        const run = await runArm(
          fork,
          { kind: 'reference', id: 'reference', policyFor: referenceArm(line.steps) },
          { rolloutSeed: seed, evaluators, ...limit },
        );
        arms.push(run);
        if (completed(run)) reference.push(run.values[evaluator] ?? 0);
        else {
          referenceIncomplete++;
          referenceError ??= `${run.termination}${run.error === undefined ? '' : `: ${run.error}`}`;
        }
      }
      incomplete += referenceIncomplete;
      const gridMeans: Record<string, number> = {};
      const gridHashes: Record<string, string> = {};
      for (const arm of grid) {
        const runs = complete.filter((run) => run.arm === arm.id);
        // An arm none of whose runs reached the horizon is left out of the comparison.
        if (runs.length === 0) continue;
        gridMeans[arm.id] = mean(runs.map((run) => run.values[evaluator] ?? 0));
        gridHashes[arm.id] = runs[0]!.finalStateHash;
      }
      if (referenceIncomplete > 0 || gridMeans['strategist'] === undefined) {
        // A reference line the engine refused (or that never reached the horizon) is not a
        // target; neither is a grid with no completed arm.
        verdict = {
          evaluator,
          verdict: null,
          needs: 'completedRuns',
          tacticianReaches: false,
          bestGrid: { arm: '', value: 0 },
          reason:
            referenceIncomplete > 0
              ? `the reference line did not complete on ${referenceIncomplete} seed(s) (${referenceError})`
              : "the strategist's own knobs never reached the horizon, so no arm has a baseline",
        };
      } else {
        // ADR 0045 decision 3: before a "knob missing" or "needs the tactician" verdict, try the
        // pairs of the single knobs that moved the evaluator. Bot arms only, so it costs nothing.
        const referenceMean = mean(reference);
        const bestSingle = Math.max(...Object.values(gridMeans));
        if (referenceMean > bestSingle + options.margin) {
          const baseline = gridMeans['strategist'];
          const moved = new Set(
            grid
              .filter(
                (arm) =>
                  arm.knob !== undefined &&
                  gridMeans[arm.id] !== undefined &&
                  Math.abs(gridMeans[arm.id]! - baseline) > options.margin,
              )
              .map((arm) => arm.id),
          );
          for (const pair of pairwiseArms(grid, moved)) {
            const runs: ArmRun[] = [];
            for (const seed of options.seeds)
              runs.push(
                await runArm(
                  fork,
                  {
                    kind: 'bot',
                    id: pair.id,
                    steering: pair.steering,
                    ...(pair.knob === undefined ? {} : { knob: pair.knob }),
                  },
                  { rolloutSeed: seed, evaluators, ...limit },
                ),
              );
            arms.push(...runs);
            const done = runs.filter(completed);
            incomplete += runs.length - done.length;
            if (done.length === 0) continue;
            gridMeans[pair.id] = mean(done.map((run) => run.values[evaluator] ?? 0));
            gridHashes[pair.id] = done[0]!.finalStateHash;
          }
        }
        verdict = {
          evaluator,
          ...verdictFor({
            evaluator,
            margin: options.margin,
            share: options.share ?? 2 / 3,
            grid: gridMeans,
            gridHashes,
            reference: referenceMean,
            tactician: tacticianValues,
            judgement: line.judgement ?? {},
          }),
        };
      }
    }
    reports.push({
      forkDecisionIndex: turn.forkDecisionIndex,
      turn: turn.turn,
      seat: turn.seat,
      why: turn.why,
      arms,
      disagree,
      discardedTrials: discarded,
      incompleteRuns: incomplete,
      ...(verdict === undefined ? {} : { verdict }),
    });
  }
  return {
    schemaVersion: 1,
    kind: 'strategist-study',
    capture: options.captureName,
    seeds: options.seeds,
    margin: options.margin,
    markedTurns: reports,
    seedVariationTooNarrow: seedVariationTooNarrow(botRuns, botArmIds),
  };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const capturePath = arg(argv, '--capture');
  if (capturePath === undefined) throw new Error('strategist-study needs --capture <file>');
  const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as StrategistCapture;
  if (argv.includes('--mark-only')) {
    // ADR 0045 decision 1.5: the reviewer writes each marked turn's line from the seat's view at
    // the fork, before any arm runs. This writes those views and runs nothing.
    const marked = capTurns(
      markTurns(capture, Number(arg(argv, '--sample-rate') ?? 0.1), capturePath),
      Number(arg(argv, '--max-turns') ?? 10),
      capturePath,
    );
    const markedOut = arg(argv, '--out') ?? capturePath.replace(/\.json$/, '') + '.marked.json';
    writeFileSync(
      markedOut,
      JSON.stringify(
        marked.map((turn) => ({
          forkDecisionIndex: turn.forkDecisionIndex,
          turn: turn.turn,
          seat: turn.seat,
          why: turn.why,
          knobs: capture.turns.find((t) => t.decisionIndex === turn.forkDecisionIndex)?.knobs[
            turn.seat
          ],
          view: capture.transcript.decisions[turn.forkDecisionIndex]!.observerView,
        })),
        null,
        2,
      ),
    );
    console.log(`${marked.length} marked turns and their fork views written to ${markedOut}`);
    return;
  }
  const seeds = Array.from(
    { length: Number(arg(argv, '--seeds') ?? 3) },
    (_, i) => `rollout-${i + 1}`,
  );
  const linesPath = arg(argv, '--lines');
  const lines =
    linesPath === undefined
      ? {}
      : (JSON.parse(readFileSync(linesPath, 'utf8')) as Record<string, LineEntry>);
  let tactician: StudyOptions['tactician'];
  let spend: { budget: Budget; tally: ReturnType<typeof emptyTally> } | undefined;
  if (argv.includes('--tactician')) {
    const base = loadAiConfig(process.env);
    if (!base.apiKey) throw new Error('--tactician needs an AI API key in the environment or .env');
    const budget: Budget = {
      maxUsd: Number(arg(argv, '--max-usd') ?? 2),
      maxCalls: 2_000,
      spentUsd: 0,
      calls: 0,
      capped: false,
    };
    const tally = emptyTally();
    spend = { budget, tally };
    const client = counting(
      new OpenAiCompatibleClient(configForRole(base, 'tactician'), budgetedFetch(budget)),
      'tactician',
      () => 'all' as const,
      { all: tally },
      budget,
    );
    tactician = {
      arm: (context) => tacticianArm(client, base, context),
      trials: Number(arg(argv, '--trials') ?? 3),
      capped: () => budget.capped,
    };
  }
  const report = await runStudy({
    capture,
    captureName: capturePath,
    seeds,
    sampleRate: Number(arg(argv, '--sample-rate') ?? 0.1),
    margin: Number(arg(argv, '--margin') ?? 2),
    evaluator: arg(argv, '--evaluator') ?? OWN_POSITION.version,
    maxTurns: Number(arg(argv, '--max-turns') ?? 10),
    ...(arg(argv, '--arms') === undefined
      ? {}
      : {
          gridArms: arg(argv, '--arms')!
            .split(',')
            .map((id) => id.trim()),
        }),
    disagree: arg(argv, '--disagree') === 'gap' ? 'gap' : 'hash-or-gap',
    ...(arg(argv, '--disagree-margin') === undefined
      ? {}
      : { disagreeMargin: Number(arg(argv, '--disagree-margin')) }),
    lines,
    ...(tactician === undefined ? {} : { tactician }),
  });
  const out = arg(argv, '--out') ?? `${capturePath.replace(/\.json$/, '')}.study.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  for (const turn of report.markedTurns)
    console.log(
      `decision ${turn.forkDecisionIndex} (turn ${turn.turn}, ${turn.seat}, ${turn.why.join('+')}): ${turn.disagree ? 'bot arms DISAGREE' : 'bot arms agree'}` +
        (turn.verdict === undefined
          ? ''
          : `; verdict ${turn.verdict.verdict ?? `needs ${turn.verdict.needs}`}`),
    );
  console.log(`seed variation too narrow: ${report.seedVariationTooNarrow}; written to ${out}`);
  if (spend !== undefined)
    console.log(
      `tactician spend $${spend.tally.costUsd.toFixed(4)} over ${spend.budget.calls} requests` +
        `${spend.tally.costKnown ? '' : ' (some attempts unpriced)'}` +
        `${spend.budget.capped ? '; CAPPED: later trials were not credited' : ''}`,
    );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  void main();
}
