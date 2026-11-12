/**
 * The pieces of ADR 0045's strategist study that are arithmetic, not judgement: which turns to
 * examine, the knob grid, the evaluators named per situation class, and the verdict rules. The
 * judgements the ADR keeps on the main thread ("could a knob express this?", "could a rule find
 * it?", which knob names the reference line) are inputs here, recorded with their reason.
 */

import type { Engine } from '@mtg/engine';
import type { BotSteering, GameResult, PlayerId } from '@mtg/shared';
import { Rng } from '@mtg/bot';
import type { CounterfactualEvaluator } from './counterfactual';
import type { ReplayTranscript } from './replay';
import type { ArmRun } from './turn-counterfactual';

// --- Which turns to examine (decision 2) -------------------------------------------------------

/** A seat's turn in a captured game: its first decision and the public totals at that point. */
export interface SeatTurn {
  turn: number;
  seat: PlayerId;
  /** Index of the seat's first decision in its own turn. */
  forkDecisionIndex: number;
  life: Record<PlayerId, number>;
  power: Record<PlayerId, number>;
  alive: PlayerId[];
}

/** Every seat's own turns, from the transcript's recorded observer views. */
export function seatTurns(transcript: ReplayTranscript): SeatTurn[] {
  const turns: SeatTurn[] = [];
  const seen = new Set<string>();
  for (const record of transcript.decisions) {
    const { request, observerView: view } = record;
    if (request.decidingPlayer !== request.activePlayer) continue;
    const key = `${request.turn}:${request.activePlayer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const life: Record<PlayerId, number> = { [view.seat]: view.life };
    for (const opponent of view.opponents) life[opponent.seat] = opponent.life;
    const power: Record<PlayerId, number> = {};
    for (const permanent of view.battlefield)
      if (permanent.power !== undefined && permanent.power !== null)
        power[permanent.controller] =
          (power[permanent.controller] ?? 0) + Math.max(0, permanent.power);
    turns.push({
      turn: request.turn,
      seat: request.activePlayer,
      forkDecisionIndex: record.index,
      life,
      power,
      alive: Object.entries(life)
        .filter(([, value]) => value > 0)
        .map(([seat]) => seat),
    });
  }
  return turns;
}

export interface SwingThresholds {
  /** A life change at least this large on one seat between consecutive turn starts. */
  life: number;
  /** A board power change at least this large on one seat. */
  power: number;
  /** How many of the acting seat's own turns before a swing are marked. */
  lookback: number;
}

export const DEFAULT_SWINGS: SwingThresholds = { life: 10, power: 8, lookback: 2 };

/**
 * The acting seat's own turns before a swing (an elimination or a large change in life or board).
 * The swing usually lands on another player's turn, after the decision that caused it, so the
 * seat's preceding turns are marked, not the swing turn (ADR 0045 decision 2).
 */
export function swingTurns(
  turns: readonly SeatTurn[],
  thresholds: SwingThresholds = DEFAULT_SWINGS,
): SeatTurn[] {
  const marked = new Map<string, SeatTurn>();
  for (let i = 1; i < turns.length; i++) {
    const before = turns[i - 1]!;
    const after = turns[i]!;
    const seats = new Set([...Object.keys(before.life), ...Object.keys(after.life)]);
    const swing = [...seats].some((seat) => {
      const wasAlive = before.alive.includes(seat);
      const isAlive = after.alive.includes(seat);
      if (wasAlive !== isAlive) return true;
      if (Math.abs((after.life[seat] ?? 0) - (before.life[seat] ?? 0)) >= thresholds.life)
        return true;
      return Math.abs((after.power[seat] ?? 0) - (before.power[seat] ?? 0)) >= thresholds.power;
    });
    if (!swing) continue;
    // Each seat's own turns before this swing, most recent first.
    for (const seat of seats) {
      const own = turns.slice(0, i).filter((turn) => turn.seat === seat);
      for (const turn of own.slice(-thresholds.lookback))
        marked.set(`${turn.turn}:${turn.seat}`, turn);
    }
  }
  return [...marked.values()].sort((a, b) => a.forkDecisionIndex - b.forkDecisionIndex);
}

/**
 * Turns sampled regardless of swing at a fixed rate, seeded, for the bot-arm disagreement filter:
 * a missed kill or a missed hold produces no swing at all.
 */
export function sampledTurns(turns: readonly SeatTurn[], rate: number, seed: string): SeatTurn[] {
  const rng = new Rng(seed);
  return turns.filter(() => rng.nextInt(1_000_000) < rate * 1_000_000);
}

/**
 * Whether the bot arms disagree on a turn: on the same rollout seed, two arms reach different final
 * states, or the arms' mean values differ by more than the margin. Comparing within a seed keeps
 * the rollout's own variation from counting as a knob mattering. Only turns that pass this filter
 * get the paid tactician arm.
 */
export function botArmsDisagree(
  runs: readonly ArmRun[],
  botArmIds: ReadonlySet<string>,
  evaluator: string,
  margin: number,
  /**
   * `hash-or-gap` is the ADR's definition. `gap` counts only the evaluator gap: in offline
   * captures almost every knob change alters the final state, so the hash half passes nearly every
   * turn, and the study plan may choose the gap alone to keep the paid arm to turns that matter.
   */
  mode: 'hash-or-gap' | 'gap' = 'hash-or-gap',
): boolean {
  const bots = runs.filter((run) => botArmIds.has(run.arm));
  const bySeed = new Map<string, Set<string>>();
  for (const run of bots)
    bySeed.set(run.rolloutSeed, (bySeed.get(run.rolloutSeed) ?? new Set()).add(run.finalStateHash));
  if (mode === 'hash-or-gap' && [...bySeed.values()].some((hashes) => hashes.size > 1)) return true;
  const means = new Map<string, number[]>();
  for (const run of bots)
    means.set(run.arm, [...(means.get(run.arm) ?? []), run.values[evaluator] ?? 0]);
  const values = [...means.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  return values.length > 1 && Math.max(...values) - Math.min(...values) > margin;
}

// --- The knob grid (decision 3) ------------------------------------------------------------------

export interface GridArm {
  id: string;
  steering: BotSteering | undefined;
  /** The knob this arm changed from the strategist's, for knob-ignored verdicts. */
  knob?: string;
}

/** A large hold-up value standing for "all": the bot holds whatever it has. */
export const HOLD_ALL_MANA = 99;

function same(a: BotSteering | undefined, b: BotSteering | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The arms for one marked turn: the strategist's own knobs, the bot's defaults, and one knob
 * changed at a time from the strategist's (aggression 0, 0.5, 1; each opponent first in the target
 * order; mana held up 0, 2 or all; avoid overextending on or off; one card at a time added to
 * hold or prioritize). Arms that repeat another's knobs are dropped.
 */
export function knobGrid(
  strategist: BotSteering | undefined,
  opponents: readonly PlayerId[],
  handCards: readonly string[],
): GridArm[] {
  const base = strategist ?? {};
  const arms: GridArm[] = [
    { id: 'strategist', steering: strategist },
    { id: 'defaults', steering: undefined },
  ];
  const add = (id: string, knob: string, steering: BotSteering): void => {
    if (arms.some((arm) => same(arm.steering, steering))) return;
    arms.push({ id, steering, knob });
  };
  for (const aggression of [0, 0.5, 1])
    add(`aggression-${aggression}`, 'aggression', { ...base, aggression });
  for (const seat of opponents) {
    const rest = (base.targetOrder ?? opponents).filter((other) => other !== seat);
    add(`target-${seat}`, 'targetOrder', { ...base, targetOrder: [seat, ...rest] });
  }
  for (const [label, mana] of [
    ['0', 0],
    ['2', 2],
    ['all', HOLD_ALL_MANA],
  ] as const)
    add(`hold-up-${label}`, 'holdUpMana', { ...base, holdUpMana: mana });
  for (const flag of [true, false])
    add(`overextend-${flag ? 'avoid' : 'allow'}`, 'avoidOverextending', {
      ...base,
      avoidOverextending: flag,
    });
  for (const card of new Set(handCards)) {
    add(`hold-${card}`, 'hold', { ...base, hold: [...(base.hold ?? []), card] });
    add(`prioritize-${card}`, 'prioritize', {
      ...base,
      prioritize: [...(base.prioritize ?? []), card],
    });
  }
  return arms;
}

/**
 * The pairwise follow-up on one turn before a "knob missing" or "needs the tactician" verdict:
 * every pair of the single-knob arms that moved the evaluator, applied together.
 */
export function pairwiseArms(grid: readonly GridArm[], moved: ReadonlySet<string>): GridArm[] {
  const singles = grid.filter((arm) => arm.knob !== undefined && moved.has(arm.id));
  const strategist = grid.find((arm) => arm.id === 'strategist')?.steering ?? {};
  const pairs: GridArm[] = [];
  for (let i = 0; i < singles.length; i++)
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i]!;
      const b = singles[j]!;
      if (a.knob === b.knob) continue;
      const steering: BotSteering = { ...strategist };
      for (const arm of [a, b]) Object.assign(steering, diff(strategist, arm.steering ?? {}));
      pairs.push({ id: `${a.id}+${b.id}`, steering, knob: `${a.knob}+${b.knob}` });
    }
  return pairs;
}

function diff(base: BotSteering, changed: BotSteering): Partial<BotSteering> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changed))
    if (JSON.stringify(value) !== JSON.stringify((base as Record<string, unknown>)[key]))
      out[key] = value;
  return out as Partial<BotSteering>;
}

// --- Evaluators per situation class (decision 1.6) ---------------------------------------------

function seatOf(engine: Engine, seat: PlayerId) {
  return engine.getState().players.find((player) => player.id === seat);
}

/** Own life and board, without the average over opponents that penalises holding back. */
export const OWN_POSITION: CounterfactualEvaluator = {
  version: 'own-position-v1',
  limitations: ['ignores opponents entirely', 'counts creature power, not card quality'],
  evaluate(engine, actor) {
    const state = engine.getState();
    const player = seatOf(engine, actor);
    if (player === undefined || player.hasLost) return -100;
    const power = state.battlefield
      .filter((p) => p.controllerId === actor && p.typeLine.includes('Creature'))
      .reduce((sum, p) => sum + Math.max(0, p.power ?? 0), 0);
    return player.life + power + player.hand.length;
  },
};

/** Damage done to one named opponent (a political or targeted-pressure class), eliminations weigh. */
export function pressureOn(target: PlayerId): CounterfactualEvaluator {
  return {
    version: `pressure-on-${target}-v1`,
    limitations: ['life only; does not value board damage to the target'],
    evaluate(engine) {
      const player = seatOf(engine, target);
      if (player === undefined || player.hasLost) return 100;
      return -player.life;
    },
  };
}

/** Survival through the horizon: alive and life, for defence and hold classes. */
export const SURVIVAL: CounterfactualEvaluator = {
  version: 'survival-v1',
  limitations: ['binary on elimination, then life'],
  evaluate(engine, actor) {
    const player = seatOf(engine, actor);
    return player === undefined || player.hasLost ? -100 : player.life;
  },
};

/** Opponents eliminated by the horizon, for kill classes. */
export const ELIMINATIONS: CounterfactualEvaluator = {
  version: 'eliminations-v1',
  limitations: ['counts eliminations, not who made them'],
  evaluate(engine, actor) {
    return engine.getState().players.filter((p) => p.id !== actor && p.hasLost).length;
  },
};

/** Game result when the game ended inside the horizon: 1 win, -1 loss, 0 otherwise. */
export const GAME_RESULT: CounterfactualEvaluator = {
  version: 'game-result-v1',
  limitations: ['0 for any game still running at the horizon'],
  evaluate(_engine, actor, result?: GameResult) {
    if (result === undefined) return 0;
    if (result.winnerSeat === actor) return 1;
    return result.winnerSeat === null ? 0 : -1;
  },
};

// --- Verdicts (decision 4) -----------------------------------------------------------------------

export type Verdict =
  | 'knob-ignored'
  | 'bot-rule-missing'
  | 'knob-missing'
  | 'needs-tactician'
  | 'no-gap'
  | 'nobody-finds-it';

/** The main-thread judgements a verdict may need, each with its reason. */
export interface VerdictJudgement {
  /** The grid arm whose knob names the reference line, if one does. */
  namingArm?: string;
  /** Whether a deterministic rule could find the reference line whatever the knobs. */
  ruleCouldFind?: { value: boolean; reason: string };
  /** Whether a new knob could express what the tactician found. */
  knobCouldExpress?: { value: boolean; reason: string };
}

export interface VerdictInput {
  evaluator: string;
  /** Margin in evaluator units, and the share of tactician trials that must clear it. */
  margin: number;
  share: number;
  /** Mean value per grid arm across its trials. */
  grid: Record<string, number>;
  /** Final state hash per grid arm on the first seed, for "the bot's actions do not change". */
  gridHashes: Record<string, string>;
  reference: number;
  /** The tactician arm's value per trial (K trials). */
  tactician: readonly number[];
  judgement: VerdictJudgement;
}

export interface VerdictResult {
  verdict: Verdict | null;
  /**
   * Set when something the rules need is missing and the verdict waits for it: a main-thread
   * judgement, or tactician trials that were never run (or were all discarded).
   */
  needs?: keyof VerdictJudgement | 'tacticianTrials';
  tacticianReaches: boolean;
  bestGrid: { arm: string; value: number };
  reason: string;
}

/**
 * ADR 0045 decision 4. The tactician "reaches" the reference line only when, in at least `share`
 * of its trials, it beats the best grid arm by more than `margin` and comes within `margin` of
 * the reference arm.
 */
export function verdictFor(input: VerdictInput): VerdictResult {
  const entries = Object.entries(input.grid);
  if (entries.length === 0) throw new Error('verdict needs at least one grid arm');
  const [bestArm, bestValue] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const bestGrid = { arm: bestArm, value: bestValue };
  const reaching = input.tactician.filter(
    (value) => value > bestValue + input.margin && value >= input.reference - input.margin,
  ).length;
  const tacticianReaches =
    input.tactician.length > 0 && reaching / input.tactician.length >= input.share;
  const base = { tacticianReaches, bestGrid };

  if (bestValue >= input.reference - input.margin)
    return { ...base, verdict: 'no-gap', reason: `${bestArm} reaches the reference line` };

  const naming = input.judgement.namingArm;
  if (
    naming !== undefined &&
    input.gridHashes[naming] !== undefined &&
    input.gridHashes[naming] === input.gridHashes['strategist']
  )
    return {
      ...base,
      verdict: 'knob-ignored',
      reason: `${naming} sets the knob that names the line, and the bot plays exactly as without it`,
    };

  const rule = input.judgement.ruleCouldFind;
  if (rule === undefined)
    return {
      ...base,
      verdict: null,
      needs: 'ruleCouldFind',
      reason: 'reference beats every grid arm',
    };
  if (rule.value) return { ...base, verdict: 'bot-rule-missing', reason: rule.reason };

  // "Knob missing", "needs the tactician" and "nobody finds it" all turn on what the tactician
  // does; with no trials there is nothing to judge, not a failure to judge.
  if (input.tactician.length === 0)
    return {
      ...base,
      verdict: null,
      needs: 'tacticianTrials',
      reason: 'the reference beats every grid arm, and the tactician arm was not run',
    };

  if (tacticianReaches) {
    const knob = input.judgement.knobCouldExpress;
    if (knob === undefined)
      return {
        ...base,
        verdict: null,
        needs: 'knobCouldExpress',
        reason: 'the tactician reaches it',
      };
    return {
      ...base,
      verdict: knob.value ? 'knob-missing' : 'needs-tactician',
      reason: knob.reason,
    };
  }
  return {
    ...base,
    verdict: 'nobody-finds-it',
    reason: `the tactician reached it in ${reaching} of ${input.tactician.length} trials`,
  };
}
