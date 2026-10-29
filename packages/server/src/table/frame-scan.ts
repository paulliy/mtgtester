/**
 * The table frame scan (plan M3 tests): every frame a table sent a player, checked against what
 * a live player frame may not carry. It reads only the frames, so it runs over real worker
 * traffic (`scripted-run.ts`) as well as over fakes.
 *
 * Rules, each with the frame and seat that broke it:
 *
 * - `key`: the game's RNG key outside the post-game record.
 * - `seed`: a non-empty seed in `gameStarted` or a board.
 * - `fullState`: a spectator-shaped or full-state frame before that seat saw `gameOver`.
 * - `forbiddenType`: debug, AI cost, a bot's legal menu or an unknown frame type.
 * - `noteKey`: a `note` key anywhere (AI reasoning).
 * - `rawHaltText`: a halt line other than the fixed player text.
 * - `engineRequestId`: an engine request id (`<game>-t<turn>-d<n>`) instead of a seat's own.
 * - `requestOrder`: a seat's request ids not counting `q1`, `q2`, ... in order.
 * - `otherSeatHand`: an object id that was in another seat's hand when the frame was sent.
 * - `rawData`: a legal action's raw `data` sent to a seat that did not ask for it.
 */

import { PLAYER_HALT_TEXT } from '@mtg/engine';
import type { PlayerId } from '@mtg/shared';

export interface RecordedFrame {
  /** The receiving seat, or `host` for a lobby-only host socket. */
  to: PlayerId | 'host';
  text: string;
  /** Arrival order across every socket of the run. */
  order: number;
}

export type FrameScanRule =
  | 'key'
  | 'seed'
  | 'fullState'
  | 'forbiddenType'
  | 'noteKey'
  | 'rawHaltText'
  | 'engineRequestId'
  | 'requestOrder'
  | 'otherSeatHand'
  | 'rawData';

export interface FrameScanViolation {
  rule: FrameScanRule;
  to: PlayerId | 'host';
  order: number;
  detail: string;
}

export interface FrameScanReport {
  framesScanned: number;
  /** Distinct hand object ids the scan learned, so a scan that saw no hand is visible. */
  handIdsTracked: number;
  violations: FrameScanViolation[];
}

export interface FrameScanOptions {
  rngKey: string;
  protocolVersion: number;
  /** Seats that declared the `rawActionData` capability. Default: every seat. */
  rawActionDataSeats?: ReadonlySet<PlayerId>;
}

/** Live player frames a table may send. Anything else before `gameOver` is a violation. */
const LIVE_TYPES = new Set([
  'tableState',
  'claimPending',
  'seatGranted',
  'deckProblems',
  'seatTakenOver',
  'protocolMismatch',
  'tableClosed',
  'gameStarted',
  'eventBatch',
  'computeHalted',
  'playerStateSnapshot',
  'playerActionRequired',
  'sessionPaused',
  'gameOver',
  'error',
]);

/** Full-state frames: allowed only after the seat's own `gameOver`. */
const POST_GAME_TYPES = new Set(['replayUnlocked', 'replayTurnState', 'tableResults']);

const ENGINE_REQUEST_ID = /"[^"]*-t\d+-d\d+"/;
const HALT_LINE = /ENGINE HALT — ([^"]*)"/g;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The ids in the receiving seat's own hand, from a board it was sent. */
function ownHandIds(payload: Json, seat: PlayerId): string[] | null {
  const state = payload['state'];
  if (!isRecord(state) || !Array.isArray(state['seats'])) return null;
  for (const entry of state['seats'] as unknown[]) {
    if (!isRecord(entry) || entry['seat'] !== seat) continue;
    const hand = entry['hand'];
    if (!Array.isArray(hand)) return null;
    return hand.flatMap((card) =>
      isRecord(card) && typeof card['id'] === 'string' ? [card['id']] : [],
    );
  }
  return null;
}

function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (!isRecord(value)) return false;
  return Object.keys(value).some((k) => k === key || hasKey(value[k], key));
}

export function scanTableFrames(
  frames: readonly RecordedFrame[],
  options: FrameScanOptions,
): FrameScanReport {
  const violations: FrameScanViolation[] = [];
  const add = (frame: RecordedFrame, rule: FrameScanRule, detail: string): void => {
    violations.push({ rule, to: frame.to, order: frame.order, detail });
  };
  const sorted = [...frames].sort((a, b) => a.order - b.order);
  const gameOverSeen = new Set<PlayerId | 'host'>();
  const handOf = new Map<PlayerId, Set<string>>();
  const nextRequest = new Map<PlayerId, number>();
  const lastRequest = new Map<PlayerId, string>();
  const key = options.rngKey.toLowerCase();
  const tracked = new Set<string>();

  for (const frame of sorted) {
    let message: Json;
    try {
      const parsed: unknown = JSON.parse(frame.text);
      if (!isRecord(parsed)) throw new Error('not an object');
      message = parsed;
    } catch {
      add(frame, 'forbiddenType', 'unparseable frame');
      continue;
    }
    const type = String(message['type']);
    const payload = isRecord(message['payload']) ? message['payload'] : {};
    const postGame = POST_GAME_TYPES.has(type);

    if (postGame && !gameOverSeen.has(frame.to)) add(frame, 'fullState', type);
    else if (!postGame && !LIVE_TYPES.has(type)) add(frame, 'forbiddenType', type);

    if (type !== 'tableResults' && frame.text.toLowerCase().includes(key)) {
      add(frame, 'key', type);
    }
    if (type === 'gameStarted' && typeof payload['seed'] === 'string' && payload['seed'] !== '') {
      add(frame, 'seed', 'gameStarted.seed');
    }
    const state = payload['state'];
    if (!postGame && isRecord(state) && typeof state['seed'] === 'string' && state['seed'] !== '') {
      add(frame, 'seed', `${type}.state.seed`);
    }
    if (hasKey(message, 'note')) add(frame, 'noteKey', type);
    for (const match of frame.text.matchAll(HALT_LINE)) {
      if (match[1] !== PLAYER_HALT_TEXT) add(frame, 'rawHaltText', match[1] ?? '');
    }
    if (!postGame && ENGINE_REQUEST_ID.test(frame.text)) add(frame, 'engineRequestId', type);

    if (frame.to !== 'host') {
      const seat = frame.to;
      // Another seat's hand, as of the last board that seat was sent.
      for (const [owner, ids] of handOf) {
        if (owner === seat || postGame) continue;
        for (const id of ids) {
          if (frame.text.includes(`"${id}"`)) add(frame, 'otherSeatHand', `${owner}'s ${id}`);
        }
      }
      if (type === 'playerActionRequired') {
        const request = isRecord(payload['request']) ? payload['request'] : {};
        const requestId = String(request['requestId']);
        if (lastRequest.get(seat) !== requestId) {
          const expected = `q${(nextRequest.get(seat) ?? 0) + 1}`;
          if (requestId !== expected)
            add(frame, 'requestOrder', `${requestId}, expected ${expected}`);
          nextRequest.set(seat, Number(requestId.slice(1)) || 0);
          lastRequest.set(seat, requestId);
        }
        const rawAllowed = options.rawActionDataSeats?.has(seat) ?? true;
        const actions = Array.isArray(request['legalActions']) ? request['legalActions'] : [];
        if (!rawAllowed && actions.some((action) => isRecord(action) && 'data' in action)) {
          add(frame, 'rawData', requestId);
        }
      }
      if (type === 'playerStateSnapshot' || type === 'playerActionRequired') {
        const hand = ownHandIds(payload, seat);
        if (hand !== null) {
          handOf.set(seat, new Set(hand));
          for (const id of hand) tracked.add(id);
        }
      }
      if (type === 'gameOver') gameOverSeen.add(seat);
    }
  }
  return { framesScanned: sorted.length, handIdsTracked: tracked.size, violations };
}
