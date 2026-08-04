/**
 * Post-game AI self-reflection (ADR 0022 §7, reversing brief §15's cut).
 *
 * One call per AI seat, made strictly **after** `Engine.getResult()`. Three properties hold, and
 * each is load-bearing:
 *
 *   1. **It never blocks the results screen.** The caller fires this without awaiting; `gameOver`
 *      has already gone out. A slow or dead model costs the user nothing but absent commentary.
 *   2. **It never sees more than its seat did.** The prompt is built from that seat's `PlayerView`
 *      and a log already filtered to what it could legally see, so the review is about decisions
 *      the seat could actually have made differently.
 *   3. **Every failure is silent and local.** Bad JSON, a timeout, a seat's whole call failing —
 *      all return `null`, and the other seats still publish. There is no game state left to
 *      corrupt, so there is nothing worth throwing for.
 */

import type { AiReflection, PlayerId, ReflectionMoment, SpectatorLogLine } from '@mtg/shared';
import type { AiClient } from './client';
import { assembleReflectionPrompt, type ReflectionContext } from './context';
import type { AiCallLogger } from './logger';

interface QueueLike {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

/** Clamps, in the spirit of `cleanPlan()`: a model that rambles is trimmed, never trusted. */
const MAX_SUMMARY = 600;
const MAX_MOMENT = 240;
const MAX_THREAT_READ = 300;
const MAX_MISTAKES = 5;
const MAX_PLAYS = 3;

/** Public log lines given to a reflection. Enough to reconstruct a game, not enough to bore it. */
export const MAX_REFLECTION_LOG_LINES = 80;

function clampString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
}

function cleanMoments(raw: unknown, limit: number, turnCount: number): ReflectionMoment[] {
  if (!Array.isArray(raw)) return [];
  const moments: ReflectionMoment[] = [];
  for (const candidate of raw.slice(0, limit)) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const entry = candidate as { turn?: unknown; what?: unknown; better?: unknown };
    const what = clampString(entry.what, MAX_MOMENT);
    if (what.length === 0) continue;
    // The turn is a jump link in the UI, so a hallucinated turn 900 would be a dead control.
    // Clamping to the game's real length keeps every link landing somewhere that exists.
    const rawTurn = typeof entry.turn === 'number' && Number.isFinite(entry.turn) ? entry.turn : 0;
    const turn = Math.min(Math.max(0, Math.round(rawTurn)), Math.max(0, turnCount));
    const better = clampString(entry.better, MAX_MOMENT);
    moments.push({ turn, what, ...(better.length > 0 ? { better } : {}) });
  }
  return moments;
}

/**
 * Validate a reflection response. Fails closed to `null` — a reflection with no summary has
 * nothing to show, and half a parsed object on a results screen is worse than an honest blank.
 */
export function validateReflection(
  raw: unknown,
  turnCount: number,
): Omit<AiReflection, 'seat' | 'position' | 'model'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as {
    summary?: unknown;
    keyMistakes?: unknown;
    keyPlays?: unknown;
    threatRead?: unknown;
  };

  const summary = clampString(value.summary, MAX_SUMMARY);
  if (summary.length === 0) return null;

  return {
    summary,
    keyMistakes: cleanMoments(value.keyMistakes, MAX_MISTAKES, turnCount),
    keyPlays: cleanMoments(value.keyPlays, MAX_PLAYS, turnCount),
    threatRead: clampString(value.threatRead, MAX_THREAT_READ),
  };
}

/**
 * The public log one seat may be shown, condensed.
 *
 * `lines` must already be that seat's own hidden-information-safe log (`formatPlayerLog`), not the
 * spectator one — this function narrows for relevance, and is not the anti-cheat boundary. It
 * keeps the seat's own actions plus every elimination, because "who died, and when" is the shape
 * of a Commander game and is public to everyone at the table.
 */
export function condenseSeatLog(
  lines: readonly SpectatorLogLine[],
  seat: PlayerId,
  limit = MAX_REFLECTION_LOG_LINES,
): string[] {
  return lines
    .filter((line) => line.actorSeat === seat || line.emphasis === 'elimination')
    .slice(-limit)
    .map((line) => `T${line.turn} ${line.actorSeat ?? '--'} ${line.text}`);
}

export interface ReflectionDeps {
  gameId: string;
  /** Reflection calls are billed, so they are recorded like any other (ADR 0022 §8). */
  logger?: AiCallLogger | undefined;
}

/**
 * Ask one seat to review its game. Returns `null` whenever there is nothing worth showing, which
 * includes every error path.
 */
export async function runReflection(
  client: AiClient | null,
  queue: QueueLike,
  context: ReflectionContext,
  deps: ReflectionDeps,
): Promise<AiReflection | null> {
  if (client === null) return null;

  const prompt = assembleReflectionPrompt(context);
  // A synthetic request: the logger, the client, and the cost counters are all keyed on one, and
  // there is no engine decision here to borrow. `planTurn`-style single-option menu, for the same
  // reason the strategist uses one.
  const request = {
    requestId: `${deps.gameId}-${context.seat}-reflection`,
    gameId: deps.gameId,
    turn: context.turnCount,
    activePlayer: context.seat,
    decidingPlayer: context.seat,
    phase: 'ending' as const,
    step: null,
    decisionType: 'general' as const,
    prompt: 'Review the game you just played.',
    legalActions: [{ id: 0, type: 'reflect', description: 'Return the post-game review' }],
  };

  try {
    const result = await queue.enqueue(() => client.requestDecision(prompt, request));
    deps.logger?.log(request, result, false, false, 'reflection');
    // The review rides on the raw body, not on a decision-shaped field, so parse it directly.
    const parsed: unknown = JSON.parse(result.meta.rawResponse);
    const reflection = validateReflection(parsed, context.turnCount);
    if (reflection === null) return null;
    return {
      seat: context.seat,
      position: context.position,
      model: result.meta.model,
      ...reflection,
    };
  } catch {
    // The game is already over and already reported. Commentary is the only thing lost.
    return null;
  }
}

/**
 * Run every seat's review, publishing after each one lands rather than batching at the end — one
 * slow seat must not hold up the other three on the results screen.
 *
 * `onProgress` is always called at least once, with `complete: true`, even when nothing came back.
 * A seat that failed and a seat still thinking are indistinguishable to a client otherwise, and a
 * dead provider would leave the screen showing "writing…" forever.
 */
export async function publishReflections(
  contexts: readonly ReflectionContext[],
  run: (context: ReflectionContext) => Promise<AiReflection | null>,
  onProgress: (reflections: readonly AiReflection[], complete: boolean) => void,
): Promise<AiReflection[]> {
  const landed: AiReflection[] = [];

  await Promise.all(
    contexts.map(async (context) => {
      let reflection: AiReflection | null = null;
      try {
        reflection = await run(context);
      } catch {
        // `runReflection` already swallows its own failures; this covers a caller's persistence
        // or bookkeeping throwing, which must not cost the other seats their reviews.
        reflection = null;
      }
      if (reflection === null) return;
      landed.push(reflection);
      onProgress(landed, false);
    }),
  );

  onProgress(landed, true);
  return landed;
}
