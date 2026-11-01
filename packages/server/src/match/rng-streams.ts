/**
 * The random streams of a `chacha20` game (ADR 0031 decision 4). One 256-bit key feeds every
 * consumer, each through its own fixed nonce, so reading one stream (a `random` bot's choices are
 * raw draws from it) says nothing about another (the game's shuffles).
 *
 * | consumer                         | stream id (`seat` is 0-based: P1 is 0) |
 * | -------------------------------- | -------------------------------------- |
 * | the game (the engine)            | 0                                      |
 * | each bot seat                    | 1 + seat                               |
 * | each fallback bot                | 5 + seat                               |
 * | each bot seat's generated deck   | 9 + seat                               |
 *
 * The engine builds its own stream 0 from `GameConfig.rngKey` (`createGame`). Nothing here puts the
 * key in game state: it is held by the session and read only to construct these streams.
 */
import type { PlayerId } from '@mtg/shared';
import type { RandomSource } from '@mtg/bot';
import { ChaCha20Rng, streamNonce, type EngineRng } from '@mtg/engine';

/** A table has at most four seats, which the nonce layout above leaves four ids apiece. */
export const MAX_STREAM_SEATS = 4;

export const GAME_STREAM = 0;
const BOT_STREAM_BASE = 1;
const FALLBACK_STREAM_BASE = 5;
const DECK_STREAM_BASE = 9;

/** Which generator a game uses and the key it was given (legacy games have none). */
export interface RngSelection {
  rng?: 'legacy' | 'chacha20' | undefined;
  rngKey?: string | undefined;
}

/** The zero-based index of a seat: `P1` is 0. */
export function seatIndex(seat: PlayerId): number {
  const match = /^P([1-4])$/.exec(seat);
  if (match === null) throw new RangeError(`not a table seat: ${seat}`);
  return Number(match[1]) - 1;
}

function checkedSeat(seat: number): number {
  if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_STREAM_SEATS)
    throw new RangeError(`seat index must be 0 to ${MAX_STREAM_SEATS - 1}, got ${seat}`);
  return seat;
}

export function botStreamId(seat: number): number {
  return BOT_STREAM_BASE + checkedSeat(seat);
}

export function fallbackBotStreamId(seat: number): number {
  return FALLBACK_STREAM_BASE + checkedSeat(seat);
}

export function deckStreamId(seat: number): number {
  return DECK_STREAM_BASE + checkedSeat(seat);
}

/** Every consumer of a game with `seatCount` seats and its stream id, for the uniqueness test. */
export function consumerStreams(
  seatCount = MAX_STREAM_SEATS,
): Array<{ consumer: string; id: number }> {
  const out = [{ consumer: 'game', id: GAME_STREAM }];
  for (let seat = 0; seat < seatCount; seat++) {
    out.push({ consumer: `bot P${seat + 1}`, id: botStreamId(seat) });
    out.push({ consumer: `fallback bot P${seat + 1}`, id: fallbackBotStreamId(seat) });
    out.push({ consumer: `deck P${seat + 1}`, id: deckStreamId(seat) });
  }
  return out;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A fresh 32-byte key as 64 hex digits, from `crypto.getRandomValues`. */
export function newRngKey(): string {
  return hexOf(crypto.getRandomValues(new Uint8Array(32)));
}

/** A random, non-guessable id for a generated deck; never derived from the seed or the key. */
export function newDeckAlias(): string {
  return `pool:${hexOf(crypto.getRandomValues(new Uint8Array(8)))}`;
}

function keyBytes(rngKey: string): number[] {
  if (!/^[0-9a-fA-F]{64}$/.test(rngKey))
    throw new RangeError('an RNG key is 32 bytes as 64 hex digits');
  const bytes: number[] = [];
  for (let i = 0; i < rngKey.length; i += 2)
    bytes.push(Number.parseInt(rngKey.slice(i, i + 2), 16));
  return bytes;
}

/** Stream `id` of `rngKey`, built as the engine builds its own stream 0. */
export function chachaStream(rngKey: string, id: number): ChaCha20Rng {
  return new ChaCha20Rng(keyBytes(rngKey), streamNonce(id));
}

/**
 * Give a keyed stream the bot's own `Rng` contract: a bound of zero or less returns 0 where
 * `ChaCha20Rng.nextInt` throws, so the bot sees the same behavior from either source.
 */
function botContract(stream: ChaCha20Rng): RandomSource {
  return {
    nextInt: (maxExclusive) => (maxExclusive <= 0 ? 0 : stream.nextInt(maxExclusive)),
  };
}

/** The tie-break source of the heuristic bot at a seat. */
export function botRandomSource(rngKey: string, seat: number): RandomSource {
  return botContract(chachaStream(rngKey, botStreamId(seat)));
}

/** The tie-break source of the fallback bot that plays a seat whose player has gone (M4). */
export function fallbackBotRandomSource(rngKey: string, seat: number): RandomSource {
  return botContract(chachaStream(rngKey, fallbackBotStreamId(seat)));
}

/** The stream a bot seat's generated deck is drawn from. */
export function deckRng(rngKey: string, seat: number): EngineRng {
  return chachaStream(rngKey, deckStreamId(seat));
}

/**
 * The key of a game, or `null` for `legacy`. A `chacha20` game without a well-formed key throws,
 * so a missing field cannot downgrade a table game to the predictable generator.
 */
export function resolveRngKey(selection: RngSelection): string | null {
  if ((selection.rng ?? 'legacy') === 'legacy') {
    if (selection.rngKey !== undefined) throw new Error('rngKey is set but the game is legacy');
    return null;
  }
  if (selection.rngKey === undefined) throw new Error('a chacha20 game needs an rngKey');
  keyBytes(selection.rngKey);
  return selection.rngKey;
}
