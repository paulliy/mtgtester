/**
 * ADR 0045's study over one captured game (`strategist-capture`): mark turns, run the knob grid
 * as bot arms over rollout seeds, keep the turns where the bot arms disagree, and on those run the
 * tactician (with and without the strategist's context) and the reviewer's reference line.
 *
 *   bun run strategist-study --capture F --mark-only [--sample-rate 0.1] [--max-turns 10] [--out F]
 *   bun run strategist-study --capture F [--seeds 3] [--sample-rate 0.1] [--margin 2]
 *        [--evaluator own-position-v1] [--max-turns 10] [--lines lines.json]
 *        [--disagree hash-or-gap|gap] [--disagree-margin 4] [--tactician] [--trials 3] [--max-usd 2] [--out report.json]
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

export async function runStudy(options: StudyOptions): Promise<StudyReport> {
  const { capture } = options;
  const reports: MarkedTurnReport[] = [];
  const marked = capTurns(
    markTurns(capture, options.sampleRate, options.captureName),
    options.maxTurns,
    options.captureName,
  );
  const botRuns: ArmRun[][] = [];
  const botArmIds = new Set<string>();
  for (const turn of marked) {
    const context = capture.turns.find((t) => t.decisionIndex === turn.forkDecisionIndex);
    const fork: TurnFork = {
      transcript: capture.transcript,
      forkDecisionIndex: turn.forkDecisionIndex,
      seat: turn.seat,
      knobsBySeat: context?.knobs ?? {},
    };
    const view = capture.transcript.decisions[turn.forkDecisionIndex]!.observerView;
    const opponents = view.opponents.filter((o) => o.life > 0).map((o) => o.seat);
    const grid = knobGrid(
      context?.knobs[turn.seat],
      opponents,
      view.hand.map((card) => card.name),
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
            {
              rolloutSeed: seed,
              evaluators: STUDY_EVALUATORS,
            },
          ),
        );
    const botIds = new Set(grid.map((arm) => arm.id));
    for (const id of botIds) botArmIds.add(id);
    botRuns.push([...arms]);
    // The reviewer's line names the turn's class and so its evaluator; the filter uses it too.
    const line = options.lines[String(turn.forkDecisionIndex)];
    const evaluator = line?.evaluator ?? options.evaluator;
    const disagree = botArmsDisagree(
      arms,
      botIds,
      evaluator,
      options.disagreeMargin ?? options.margin,
      options.disagree ?? 'hash-or-gap',
    );
    let tacticianValues: number[] = [];
    let discarded = 0;
    if (disagree && options.tactician !== undefined) {
      for (const [id, studyContext] of [
        ['tactician', null],
        [
          'tactician-context',
          line?.context ?? {
            intent: 'from the capture',
            ...(context?.knobs[turn.seat] === undefined
              ? {}
              : { steering: context.knobs[turn.seat]! }),
          },
        ],
      ] as const) {
        for (let trial = 0; trial < options.tactician.trials; trial++) {
          const run = await runArm(
            fork,
            {
              kind: 'tactician',
              id,
              policyFor: options.tactician.arm(studyContext),
              withContext: studyContext !== null,
            },
            {
              rolloutSeed: options.seeds[trial % options.seeds.length]!,
              evaluators: STUDY_EVALUATORS,
            },
          );
          arms.push(run);
          // ADR 0045 decision 1.4: a trial where the fallback bot played any of the model's
          // decisions (a failed answer, or the spend cap) is not credited to the model.
          const credited = run.handedToBot === 0 && options.tactician.capped?.() !== true;
          if (!credited) discarded++;
          else if (id === 'tactician-context') tacticianValues.push(run.values[evaluator] ?? 0);
        }
      }
    }
    let verdict: MarkedTurnReport['verdict'];
    if (line !== undefined) {
      const reference: number[] = [];
      for (const seed of options.seeds) {
        const run = await runArm(
          fork,
          { kind: 'reference', id: 'reference', policyFor: referenceArm(line.steps) },
          { rolloutSeed: seed, evaluators: STUDY_EVALUATORS },
        );
        arms.push(run);
        reference.push(run.values[evaluator] ?? 0);
      }
      const gridMeans: Record<string, number> = {};
      const gridHashes: Record<string, string> = {};
      for (const arm of grid) {
        const runs = arms.filter((run) => run.arm === arm.id);
        gridMeans[arm.id] =
          runs.reduce((sum, run) => sum + (run.values[evaluator] ?? 0), 0) / runs.length;
        gridHashes[arm.id] = runs[0]!.finalStateHash;
      }
      // ADR 0045 decision 3: before a "knob missing" or "needs the tactician" verdict, try the
      // pairs of the single knobs that moved the evaluator. Bot arms only, so it costs nothing.
      const referenceMean = reference.reduce((sum, value) => sum + value, 0) / reference.length;
      const bestSingle = Math.max(...Object.values(gridMeans));
      if (referenceMean > bestSingle + options.margin) {
        const baseline = gridMeans['strategist'] ?? 0;
        const moved = new Set(
          grid
            .filter(
              (arm) =>
                arm.knob !== undefined &&
                Math.abs((gridMeans[arm.id] ?? 0) - baseline) > options.margin,
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
                { rolloutSeed: seed, evaluators: STUDY_EVALUATORS },
              ),
            );
          arms.push(...runs);
          gridMeans[pair.id] =
            runs.reduce((sum, run) => sum + (run.values[evaluator] ?? 0), 0) / runs.length;
          gridHashes[pair.id] = runs[0]!.finalStateHash;
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
    reports.push({
      forkDecisionIndex: turn.forkDecisionIndex,
      turn: turn.turn,
      seat: turn.seat,
      why: turn.why,
      arms,
      disagree,
      discardedTrials: discarded,
      ...(verdict === undefined ? {} : { verdict }),
    });
    tacticianValues = [];
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
