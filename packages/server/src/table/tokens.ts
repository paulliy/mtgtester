/**
 * Secrets, comparison, throttling and display-name hygiene for table servers (ADR 0031
 * decision 6, plan M3 task 1).
 *
 * - Every secret and id comes from `crypto.getRandomValues`, base64url-encoded: host secret,
 *   host token and seat token at 256 bits, invite code and table id at 128.
 * - Comparison of a presented secret never short-circuits on content or length.
 * - A failed attempt *delays* the next one from the same client address. It never locks the
 *   address out: after the delay the correct secret works.
 * - Display names are compared after lookalike characters are folded away, so `Bоb` (Cyrillic
 *   о) cannot sit beside `Bob`.
 */

// ── Randomness ──────────────────────────────────────────────────────────────────────────────

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url. 32 bytes encode to 43 characters, 16 to 22. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL[b0 >> 2];
    out += BASE64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += BASE64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += BASE64URL[b2 & 0x3f];
  }
  return out;
}

/** Lowercase hex, two digits per byte. A 32-byte game key is 64 digits. */
export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export const HOST_SECRET_BYTES = 32;
export const HOST_TOKEN_BYTES = 32;
export const SEAT_TOKEN_BYTES = 32;
export const INVITE_CODE_BYTES = 16;
export const TABLE_ID_BYTES = 16;
export const CLAIM_ID_BYTES = 12;

const token = (bytes: number): string => base64url(randomBytes(bytes));

/** Printed once at startup; used only to create a table. */
export const generateHostSecret = (): string => token(HOST_SECRET_BYTES);
/** Table-scoped; held by the host's lobby connection. */
export const generateHostToken = (): string => token(HOST_TOKEN_BYTES);
/** The seat's identity on every message after approval. */
export const generateSeatToken = (): string => token(SEAT_TOKEN_BYTES);
export const generateInviteCode = (): string => token(INVITE_CODE_BYTES);
export const generateTableId = (): string => token(TABLE_ID_BYTES);
export const RNG_KEY_BYTES = 32;
/** A fresh `chacha20` game key: 32 bytes as 64 hex digits. Secret until the game is over. */
export const generateRngKey = (): string => hex(randomBytes(RNG_KEY_BYTES));
export const generateClaimId = (): string => token(CLAIM_ID_BYTES);
/** Opaque id for one start attempt. */
export const generateAttemptId = (): string => token(INVITE_CODE_BYTES);

/** No 0/O, 1/I/L or U/V pairs: the code is read aloud or compared by eye. */
const VERIFICATION_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

/**
 * A short code for one claim, such as `K7M-2XQ`. The host and the claimant both see it, so the
 * host can tell the person who asked from someone using their name. It is not a secret; about
 * 30 bits is plenty for that. Rejection sampling keeps the alphabet unbiased.
 */
export function generateVerificationCode(length = 6): string {
  const limit = 256 - (256 % VERIFICATION_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += VERIFICATION_ALPHABET[byte % VERIFICATION_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  const half = Math.floor(length / 2);
  return `${out.slice(0, half)}-${out.slice(half)}`;
}

// ── Comparison ──────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/**
 * Constant-time string equality. The loop always runs over the longer input (the shorter is
 * zero-padded), and the length difference is folded into the result instead of returning early,
 * so unequal lengths neither throw (as `crypto.timingSafeEqual` does) nor finish sooner.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

// ── Throttle ────────────────────────────────────────────────────────────────────────────────

export interface AttemptThrottleOptions {
  /** Injected for tests. Milliseconds on any monotonic-enough clock. */
  now?: () => number;
  /** Delay after the first failure. Doubles with each further failure. */
  baseDelayMs?: number;
  /** The delay never grows past this, so a correct secret is never locked out. */
  maxDelayMs?: number;
  /** A client with no failure for this long starts over. */
  forgetAfterMs?: number;
  /** Bound on tracked addresses; the oldest entries go first. */
  maxTracked?: number;
}

interface FailureRecord {
  failures: number;
  lastFailureAt: number;
}

/**
 * Per-client-address delay for failed secret attempts.
 *
 * Usage: `const wait = throttle.check(address)`. If `wait > 0`, do not evaluate the attempt;
 * tell the client to retry after `wait` ms. Otherwise evaluate it, then call `fail(address)` or
 * `succeed(address)`. Attempts made inside the delay are not evaluated and not counted, so
 * hammering cannot push the delay past `maxDelayMs`, and a patient client always gets through.
 */
export class AttemptThrottle {
  private readonly now: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly forgetAfterMs: number;
  private readonly maxTracked: number;
  private readonly records = new Map<string, FailureRecord>();

  constructor(options: AttemptThrottleOptions = {}) {
    this.now = options.now ?? Date.now;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.forgetAfterMs = options.forgetAfterMs ?? 10 * 60_000;
    this.maxTracked = options.maxTracked ?? 10_000;
  }

  /** Milliseconds this address must still wait before an attempt is evaluated; 0 when free. */
  check(address: string): number {
    const record = this.records.get(address);
    if (record === undefined) return 0;
    const elapsed = this.now() - record.lastFailureAt;
    if (elapsed >= this.forgetAfterMs) {
      this.records.delete(address);
      return 0;
    }
    return Math.max(0, this.delayFor(record.failures) - elapsed);
  }

  /** Record a failed attempt that `check` let through. */
  fail(address: string): void {
    const now = this.now();
    const previous = this.records.get(address);
    const failures =
      previous !== undefined && now - previous.lastFailureAt < this.forgetAfterMs
        ? previous.failures + 1
        : 1;
    this.records.delete(address); // re-insert so Map order is least-recently-failed first
    this.records.set(address, { failures, lastFailureAt: now });
    while (this.records.size > this.maxTracked) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      this.records.delete(oldest.value);
    }
  }

  /** A correct secret clears the address's history. */
  succeed(address: string): void {
    this.records.delete(address);
  }

  private delayFor(failures: number): number {
    // Cap the exponent before shifting so a long run of failures cannot overflow.
    const exponent = Math.min(Math.max(failures - 1, 0), 30);
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** exponent);
  }
}

// ── Display names ───────────────────────────────────────────────────────────────────────────

export const DISPLAY_NAME_MAX_CHARS = 24;

/** Zero-width, bidi-control, soft-hyphen, joiner and variation-selector characters. */
/* eslint-disable no-misleading-character-class -- the class lists invisible code points on purpose */
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/gu;
/* eslint-enable no-misleading-character-class */
const CONTROL = /\p{Cc}/gu;

/**
 * Lookalike letters mapped to one canonical letter. Applied after NFKC, lowercasing and mark
 * stripping, so only lowercase forms are listed. `i`, `l`, `1` and `|` share one class because
 * capital I and lowercase l are the same shape in most sans-serif fonts.
 */
export const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'l',
  ї: 'l',
  ј: 'j',
  һ: 'h',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ӏ: 'l',
  ѡ: 'w',
  // Greek
  α: 'a',
  β: 'b',
  γ: 'y',
  ε: 'e',
  ι: 'l',
  κ: 'k',
  μ: 'u',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  // Latin look-alikes and digits
  ı: 'l',
  ł: 'l',
  ø: 'o',
  đ: 'd',
  i: 'l',
  '1': 'l',
  '|': 'l',
  '0': 'o',
  '5': 's',
  $: 's',
  '@': 'a',
};

/**
 * Fold a display name to the form used to decide whether two names are the same. NFKC (so
 * fullwidth and compatibility forms collapse), case-fold, drop invisible characters, drop
 * combining marks, map the {@link CONFUSABLES}, then drop spaces and separators.
 */
export function normalizeDisplayName(name: string): string {
  const folded = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/ς/gu, 'σ')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  let out = '';
  for (const char of folded) out += CONFUSABLES[char] ?? char;
  return out.replace(/[\s_.\-·•]+/gu, '');
}

/**
 * The display form of a name: invisible, bidi and control characters removed, runs of spaces
 * collapsed, trimmed. Returns `null` when nothing is left or the result exceeds
 * {@link DISPLAY_NAME_MAX_CHARS} characters (counted by code point).
 */
export function cleanDisplayName(name: string): string | null {
  const cleaned = name
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '' || [...cleaned].length > DISPLAY_NAME_MAX_CHARS) return null;
  // A name made only of characters the fold erases would equal every other such name.
  if (normalizeDisplayName(cleaned) === '') return null;
  return cleaned;
}
