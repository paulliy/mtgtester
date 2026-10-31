/**
 * ADR 0034 decision 9: test drivers never guess. A `pump()` call that is new or changed against
 * the base must answer with a `script([...])` or pass `{ strict: true }`, and no new answer may be
 * `() => ({ index: 0 })`. Calls are compared by their text with whitespace and trailing commas
 * removed, so prettier rewrapping a call does not count as changing it. Existing calls are
 * untouched and no per-file counts are kept.
 */
import ts from 'typescript';

export interface ChangedTestFile {
  path: string;
  /** The file at the base (its old path for a rename), or undefined when it is new. */
  base: string | undefined;
  head: string;
}

const normalize = (text: string): string => text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');

function isScriptCall(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'script'
  );
}

function isStrictOptions(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'strict' &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    )
  );
}

/** `() => ({ index: 0 })`, with or without `targets`: the answer that guesses the first option. */
function isFirstOptionAnswer(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) || node.parameters.length > 0) return false;
  let body: ts.Node = node.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body)) return false;
  return body.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'index' &&
      ts.isNumericLiteral(property.initializer) &&
      property.initializer.text === '0',
  );
}

interface Found {
  text: string;
  line: number;
  ok: boolean;
}

function scan(path: string, source: string): { pumps: Found[]; guesses: Found[] } {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const pumps: Found[] = [];
  const guesses: Found[] = [];
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pump'
    )
      pumps.push({
        text: normalize(node.getText(file)),
        line: line(node),
        ok: isScriptCall(node.arguments[1]) || isStrictOptions(node.arguments[2]),
      });
    if (isFirstOptionAnswer(node))
      guesses.push({ text: normalize(node.getText(file)), line: line(node), ok: false });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { pumps, guesses };
}

/** Beyond this many differing lines a file is not diffed line by line (see `lineMatches`). */
const DIFF_LIMIT = 2000;

/**
 * Head line numbers (1-based) mapped to the base line (1-based) they are unchanged from, by a
 * line diff ignoring indentation. Empty past `DIFF_LIMIT` differing lines, which leaves the
 * matching to the by-text fallback in `added`.
 */
function lineMatches(base: string, head: string): Map<number, number> {
  const split = (text: string) => text.split(/\r?\n/).map((line) => line.trim());
  const a = split(base);
  const b = split(head);
  const matches = new Map<number, number>();
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    matches.set(prefix + 1, prefix + 1);
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    matches.set(b.length - suffix, a.length - suffix);
    suffix += 1;
  }
  // Myers' O(ND) diff of what lies between the common ends.
  const x0 = a.slice(prefix, a.length - suffix);
  const y0 = b.slice(prefix, b.length - suffix);
  const n = x0.length;
  const m = y0.length;
  const max = Math.min(n + m, DIFF_LIMIT);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && x0[x] === y0[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) found = d;
    }
  }
  if (found === -1) return matches;
  let x = n;
  let y = m;
  const pair = () => matches.set(prefix + y + 1, prefix + x + 1);
  for (let d = found; d > 0; d -= 1) {
    const saved = trace[d]!;
    const at = (k: number) => saved[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    const startX = down ? previousX : previousX + 1;
    const startY = down ? previousY + 1 : previousY;
    while (x > startX && y > startY) {
      x -= 1;
      y -= 1;
      pair();
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    pair();
  }
  return matches;
}

/**
 * Found entries of `head` that `base` does not have. A call on a line the diff keeps is the base's
 * call on that line, so a new call identical to an old one is reported at the new line. Calls the
 * diff does not pair (rewrapped, moved) are compared by text, counting repeats.
 */
function added(head: Found[], base: Found[], baseSource: string, headSource: string): Found[] {
  const kept = lineMatches(baseSource, headSource);
  const taken = new Set<Found>();
  const unpaired = head.filter((entry) => {
    const baseLine = kept.get(entry.line);
    const twin = base.find(
      (candidate) =>
        candidate.line === baseLine && candidate.text === entry.text && !taken.has(candidate),
    );
    if (twin === undefined) return true;
    taken.add(twin);
    return false;
  });
  const remaining = new Map<string, number>();
  for (const entry of base)
    if (!taken.has(entry)) remaining.set(entry.text, (remaining.get(entry.text) ?? 0) + 1);
  return unpaired.filter((entry) => {
    const left = remaining.get(entry.text) ?? 0;
    if (left === 0) return true;
    remaining.set(entry.text, left - 1);
    return false;
  });
}

/**
 * The unit test of `pump` itself, which must call it without `strict` to pin the non-strict
 * default. Test drivers elsewhere are held to the rule.
 */
export const PUMP_UNIT_TEST = 'packages/engine/tests/script.test.ts';

export function strictPumpErrors(files: readonly ChangedTestFile[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    if (file.path.replace(/\\/g, '/') === PUMP_UNIT_TEST) continue;
    const head = scan(file.path, file.head);
    const baseSource = file.base ?? '';
    const base = file.base === undefined ? { pumps: [], guesses: [] } : scan(file.path, file.base);
    for (const call of added(head.pumps, base.pumps, baseSource, file.head).filter(
      (entry) => !entry.ok,
    ))
      errors.push(
        `${file.path}:${call.line}: a new or changed pump() call needs a script([...]) answer or { strict: true } (or use pumpStrict)`,
      );
    for (const guess of added(head.guesses, base.guesses, baseSource, file.head))
      errors.push(
        `${file.path}:${guess.line}: () => ({ index: 0 }) guesses the first option; name the choice with script([...])`,
      );
  }
  return errors;
}
