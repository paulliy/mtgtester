/**
 * SHA-256 of a string's UTF-8 bytes, as lowercase hex (FIPS 180-4). Synchronous and free of
 * runtime APIs, so code that runs both in Bun and in a browser can hash the same way: Web Crypto
 * is asynchronous, and `node:crypto` does not exist in a browser. The digest equals
 * `createHash('sha256').update(text).digest('hex')`, which `sha256.test.ts` checks.
 */

// The package's TypeScript build has no DOM or Node library; every runtime it serves has this.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 bytes of `text`. A lone surrogate becomes U+FFFD, as `TextEncoder` and Node do. */
function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** One 64-byte block at `offset` of `block` into the running hash `h`, using scratch `w`. */
function compress(h: Uint32Array, w: Uint32Array, block: ArrayLike<number>, offset: number): void {
  for (let t = 0; t < 16; t++) {
    const at = offset + t * 4;
    w[t] =
      ((block[at] ?? 0) << 24) |
      ((block[at + 1] ?? 0) << 16) |
      ((block[at + 2] ?? 0) << 8) |
      (block[at + 3] ?? 0);
  }
  for (let t = 16; t < 64; t++) {
    const w15 = w[t - 15] ?? 0;
    const w2 = w[t - 2] ?? 0;
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
    w[t] = (w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1;
  }
  let a = h[0] ?? 0;
  let b = h[1] ?? 0;
  let c = h[2] ?? 0;
  let d = h[3] ?? 0;
  let e = h[4] ?? 0;
  let f = h[5] ?? 0;
  let g = h[6] ?? 0;
  let hh = h[7] ?? 0;
  for (let t = 0; t < 64; t++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0] ?? 0) + a;
  h[1] = (h[1] ?? 0) + b;
  h[2] = (h[2] ?? 0) + c;
  h[3] = (h[3] ?? 0) + d;
  h[4] = (h[4] ?? 0) + e;
  h[5] = (h[5] ?? 0) + f;
  h[6] = (h[6] ?? 0) + g;
  h[7] = (h[7] ?? 0) + hh;
}

export function sha256Hex(text: string): string {
  const message = utf8(text);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  // The length as a 64-bit big-endian integer; strings here never reach 2^32 bits.
  const high = Math.floor(bitLength / 0x100000000);
  message.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  message.push(
    (bitLength >>> 24) & 0xff,
    (bitLength >>> 16) & 0xff,
    (bitLength >>> 8) & 0xff,
    bitLength & 0xff,
  );

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < message.length; offset += 64) compress(h, w, message, offset);
  return hexOf(h);
}

function hexOf(h: Uint32Array): string {
  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** A running SHA-256, fed in pieces: the same digest as `createHash('sha256')` fed the same pieces. */
export interface Sha256 {
  /** Add a string's UTF-8 bytes (each piece encoded alone, as `node:crypto` does). */
  update(text: string): Sha256;
  /** The digest as lowercase hex. The hash takes no more input after this. */
  digestHex(): string;
}

/**
 * A streaming SHA-256 for long inputs, such as a benchmark game's whole transcript, that should
 * not be held in memory at once. Pieces are encoded with `TextEncoder`, which every browser and
 * Bun has, and which turns a lone surrogate into U+FFFD exactly as `sha256Hex` does.
 */
export function createSha256(): Sha256 {
  const h = new Uint32Array(INITIAL);
  const w = new Uint32Array(64);
  const pending = new Uint8Array(64);
  const encoder = new TextEncoder();
  let filled = 0;
  let length = 0;
  let done = false;
  const hash: Sha256 = {
    update(text) {
      if (done) throw new Error('This SHA-256 has already been digested.');
      const bytes = encoder.encode(text);
      length += bytes.length;
      let at = 0;
      if (filled > 0) {
        const take = Math.min(64 - filled, bytes.length);
        pending.set(bytes.subarray(0, take), filled);
        filled += take;
        at = take;
        if (filled < 64) return hash;
        compress(h, w, pending, 0);
        filled = 0;
      }
      for (; at + 64 <= bytes.length; at += 64) compress(h, w, bytes, at);
      pending.set(bytes.subarray(at), 0);
      filled = bytes.length - at;
      return hash;
    },
    digestHex() {
      if (done) throw new Error('This SHA-256 has already been digested.');
      done = true;
      const bitLength = length * 8;
      const tail = [...pending.subarray(0, filled), 0x80];
      while (tail.length % 64 !== 56) tail.push(0);
      const high = Math.floor(bitLength / 0x100000000);
      tail.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
      tail.push(
        (bitLength >>> 24) & 0xff,
        (bitLength >>> 16) & 0xff,
        (bitLength >>> 8) & 0xff,
        bitLength & 0xff,
      );
      for (let offset = 0; offset < tail.length; offset += 64) compress(h, w, tail, offset);
      return hexOf(h);
    },
  };
  return hash;
}
