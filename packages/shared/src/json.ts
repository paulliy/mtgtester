/**
 * Strict JSON parsing for untrusted inbound text (agent stdin, inbound WebSocket frames).
 *
 * `JSON.parse` resolves a repeated object key by last-wins, silently. A frame such as
 * `{"actionId":0,"actionId":9}` therefore reaches shape validation as a single, legal-looking
 * value, and whichever half of the wire a reader looked at disagrees with what was dispatched.
 * Validating *after* `JSON.parse` cannot recover that: the first value no longer exists. Nor can
 * a reviver — it is invoked once per surviving key — or a regex, which cannot tell a key from
 * key-shaped text inside a string.
 *
 * So the raw text is scanned before it is parsed:
 *
 * 1. A single bounded left-to-right pass builds no values. It tracks only string boundaries,
 *    object/array nesting, and the decoded key names seen in *each* object, with a separate key
 *    set per object — sibling and nested objects may of course reuse a name. Any repeat, same
 *    value or not, rejects the whole text.
 * 2. Only then does `JSON.parse` run, so syntax validation and value semantics (escapes, `\uXXXX`,
 *    number forms) stay exactly native. This module never re-implements them.
 *
 * The scan is iterative and depth-bounded, which also keeps a deeply nested text from reaching
 * `JSON.parse` at all. There is deliberately **no byte-length cap here**: a `startGame` frame
 * legitimately carries four plaintext decklists, and a cap sized for a submission would break
 * setup. Transport-level limits belong to the transport.
 */

/** Why a text was refused. Callers map this to their own fixed, safe wire message. */
export type StrictJsonFailure = 'duplicateKey' | 'tooDeep' | 'malformed';

export type StrictJsonResult =
  { ok: true; value: unknown } | { ok: false; reason: StrictJsonFailure };

/**
 * Deepest object/array nesting accepted. The protocol's own frames nest a handful of levels
 * (`startGame` → `payload` → `seats[]` → seat), so this is far above anything legitimate and far
 * below what would trouble the native parser's recursion.
 */
export const STRICT_JSON_MAX_DEPTH = 64;

/** What the scanner concluded. `malformed` is advisory: `JSON.parse` has the final say. */
type ScanVerdict = 'clean' | 'duplicateKey' | 'tooDeep' | 'malformed';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * One pass over the raw text, building nothing.
 *
 * Structural bookkeeping is only as precise as duplicate detection requires: literals, numbers
 * and unknown bytes are stepped over one character at a time and never inspected, because
 * `JSON.parse` re-reads the same text immediately afterwards. When the scan sees something it
 * cannot account for it stops and answers `malformed` rather than guessing; the native parse then
 * rejects the text for the real reason.
 */
function scan(text: string, maxDepth: number): ScanVerdict {
  /** One entry per open object (its decoded keys) or array (`null`). */
  const stack: Array<Set<string> | null> = [];
  /** True when the next string token is a key: directly inside an object, after `{` or `,`. */
  let expectKey = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    switch (code) {
      case 0x20: // space
      case 0x09: // tab
      case 0x0a: // newline
      case 0x0d: // carriage return
        continue;
      case 0x7b: {
        // {
        const keys = new Set<string>();
        stack.push(keys);
        if (stack.length > maxDepth) return 'tooDeep';
        expectKey = true;
        continue;
      }
      case 0x5b: // [
        stack.push(null);
        if (stack.length > maxDepth) return 'tooDeep';
        expectKey = false;
        continue;
      case 0x7d: // }
      case 0x5d: // ]
        if (stack.length === 0) return 'malformed';
        stack.pop();
        expectKey = false;
        continue;
      case 0x2c: // ,
        expectKey = stack[stack.length - 1] instanceof Set;
        continue;
      case 0x3a: // :
        expectKey = false;
        continue;
      case QUOTE: {
        const end = stringEnd(text, i);
        if (end === -1) return 'malformed';
        if (expectKey) {
          const top = stack[stack.length - 1];
          if (!(top instanceof Set)) return 'malformed';
          let key: unknown;
          try {
            // Decoded, so `"actionId"` and `"action\u0049d"` are recognised as one key.
            key = JSON.parse(text.slice(i, end + 1));
          } catch {
            return 'malformed';
          }
          if (typeof key !== 'string') return 'malformed';
          if (top.has(key)) return 'duplicateKey';
          top.add(key);
          expectKey = false;
        }
        i = end;
        continue;
      }
      default:
        // A number, `true`, `false`, `null`, or junk. Nothing here can open a scope or a string,
        // so stepping one character at a time is enough and costs one comparison.
        continue;
    }
  }
  return 'clean';
}

/** Index of the closing quote of the string starting at `open`, or -1 if it never closes. */
function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === BACKSLASH) {
      i++; // Skip the escaped character, so `\"` does not close and `\` does not escape on.
      continue;
    }
    if (code === QUOTE) return i;
  }
  return -1;
}

/**
 * Parse `text` as JSON, refusing any object that repeats a key.
 *
 * Failure is a single verdict with no echo of the input: a caller reporting a refusal over the
 * wire has nothing ambiguous to quote back, and no field of an ambiguous text may be treated as
 * correlation.
 */
export function parseStrictJson(
  text: string,
  options: { maxDepth?: number } = {},
): StrictJsonResult {
  const maxDepth = options.maxDepth ?? STRICT_JSON_MAX_DEPTH;
  const verdict = scan(text, maxDepth);
  if (verdict === 'duplicateKey') return { ok: false, reason: 'duplicateKey' };
  if (verdict === 'tooDeep') return { ok: false, reason: 'tooDeep' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
