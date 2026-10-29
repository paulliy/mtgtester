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

/** Found entries of `head` that `base` does not have, counting repeats. */
function added(head: Found[], base: Found[]): Found[] {
  const remaining = new Map<string, number>();
  for (const entry of base) remaining.set(entry.text, (remaining.get(entry.text) ?? 0) + 1);
  return head.filter((entry) => {
    const left = remaining.get(entry.text) ?? 0;
    if (left === 0) return true;
    remaining.set(entry.text, left - 1);
    return false;
  });
}

export function strictPumpErrors(files: readonly ChangedTestFile[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    const head = scan(file.path, file.head);
    const base = file.base === undefined ? { pumps: [], guesses: [] } : scan(file.path, file.base);
    for (const call of added(head.pumps, base.pumps).filter((entry) => !entry.ok))
      errors.push(
        `${file.path}:${call.line}: a new or changed pump() call needs a script([...]) answer or { strict: true } (or use pumpStrict)`,
      );
    for (const guess of added(head.guesses, base.guesses))
      errors.push(
        `${file.path}:${guess.line}: () => ({ index: 0 }) guesses the first option; name the choice with script([...])`,
      );
  }
  return errors;
}
