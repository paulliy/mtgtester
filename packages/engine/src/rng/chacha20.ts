/**
 * ChaCha20 (RFC 8439) as the engine's random source for table games (ADR 0031 decision 4).
 *
 * The legacy `Prng` derives its whole state from a 32-bit hash of the seed string, so a player who
 * knows their own deck and opening hand can search every game offline. This stream is keyed by a
 * 256-bit key that never enters game state, and each consumer (the game, each bot seat, each
 * generated deck) reads its own stream through a distinct nonce.
 *
 * Pure TypeScript because the engine is synchronous and free of platform I/O, and WebCrypto's
 * cipher API is asynchronous. Every mutable field is a plain number or a plain `number[]`: the
 * casting checkpoint rewinds `ctx.rng` by walking and reassigning its own properties
 * (`casting/checkpoint.ts`), which typed arrays and `#private` fields would escape.
 */
import type { EngineRng } from './engine-rng';
import { nextIntFrom, shuffleWith } from './engine-rng';

const CONSTANTS = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function quarterRound(s: number[], a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl(s[b]! ^ s[c]!, 7);
}

/** The ChaCha20 block function (RFC 8439 §2.3): 16 little-endian output words. */
export function chacha20Block(
  key: readonly number[],
  counter: number,
  nonce: readonly number[],
): number[] {
  const input = [...CONSTANTS, ...key, counter >>> 0, ...nonce];
  const state = [...input];
  for (let round = 0; round < 10; round++) {
    quarterRound(state, 0, 4, 8, 12);
    quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14);
    quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15);
    quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13);
    quarterRound(state, 3, 4, 9, 14);
  }
  return state.map((word, i) => (word + input[i]!) >>> 0);
}

/** Little-endian 32-bit words of a byte sequence whose length is a multiple of 4. */
export function wordsOf(bytes: readonly number[]): number[] {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4)
    words.push(
      (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0,
    );
  return words;
}

/** Bytes of a hex string, which must be exactly `length` bytes long. */
export function bytesOfHex(hex: string, length: number): number[] {
  if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex))
    throw new RangeError(`expected ${length * 2} hex digits`);
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

export class ChaCha20Rng implements EngineRng {
  private key: number[];
  private nonce: number[];
  private counter: number;
  private block: number[];
  private position: number;

  /**
   * `key` is 32 bytes. `nonce` is the 96-bit nonce as three little-endian words; a consumer
   * stream passes `streamNonce(id)`. `counter` is the first block's counter (RFC 8439 uses 1
   * for encryption; a random stream starts at 0).
   */
  constructor(key: readonly number[], nonce: readonly number[], counter = 0) {
    if (key.length !== 32 || key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      throw new RangeError('ChaCha20 key must be 32 bytes');
    if (nonce.length !== 3) throw new RangeError('ChaCha20 nonce must be three 32-bit words');
    this.key = wordsOf(key);
    this.nonce = nonce.map((word) => word >>> 0);
    this.counter = counter >>> 0;
    this.block = [];
    this.position = 16;
  }

  /** An independent stream at the current position, as `Prng.clone` is. */
  clone(): ChaCha20Rng {
    const copy = new ChaCha20Rng(new Array<number>(32).fill(0), [0, 0, 0]);
    copy.key = [...this.key];
    copy.nonce = [...this.nonce];
    copy.counter = this.counter;
    copy.block = [...this.block];
    copy.position = this.position;
    return copy;
  }

  nextUint32(): number {
    if (this.position >= 16) {
      // 2^32 blocks is 2^36 draws, far past any game; wrapping would repeat the stream.
      if (this.counter > 0xffffffff) throw new RangeError('ChaCha20 stream exhausted');
      this.block = chacha20Block(this.key, this.counter, this.nonce);
      this.counter += 1;
      this.position = 0;
    }
    const word = this.block[this.position]!;
    this.position += 1;
    return word;
  }

  nextInt(bound: number): number {
    return nextIntFrom(this, bound, 'ChaCha20Rng');
  }

  shuffle<T>(items: T[]): void {
    shuffleWith(this, items);
  }
}

/** The nonce of consumer stream `id` (ADR 0031 decision 4: the game is 0, each bot seat 1 + seat, …). */
export function streamNonce(id: number): number[] {
  if (!Number.isSafeInteger(id) || id < 0 || id > 0xffffffff)
    throw new RangeError('stream id must be a 32-bit unsigned integer');
  return [0, 0, id];
}
