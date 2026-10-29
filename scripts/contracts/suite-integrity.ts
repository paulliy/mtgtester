import { posix } from 'node:path';
import ts from 'typescript';

/**
 * Suite integrity (ADR 0034 decision 9), after Forge's `TestSuiteIntegrityTest`: a test file no
 * runner picks up, or a card-gate entry that matches nothing, stops proving anything while CI stays
 * green. Everything here is a pure function over file lists and config source text, so the checks
 * can be proven to fire on synthetic repositories.
 *
 * The runner configs are read as source, never imported: `playwright.setup.config.ts` creates a
 * temporary directory when evaluated, and a config that cannot be read statically is an error,
 * not a guess.
 */

export interface VitestRunner {
  kind: 'vitest';
  /** Repo-relative config path. */
  config: string;
  include: string[];
  exclude: string[];
}

export interface PlaywrightRunner {
  kind: 'playwright';
  config: string;
  /** Repo-relative directory, `''` for the repository root. */
  testDir: string;
  testMatch: Pattern[];
  testIgnore: Pattern[];
}

export type Runner = VitestRunner | PlaywrightRunner;
export type Pattern = string | RegExp;

export interface IntegrityInput {
  /** Tracked files, repo-relative with forward slashes (`git ls-files`). */
  files: string[];
  /** Reads a tracked file's text. */
  read: (path: string) => string;
}

export interface IntegrityResult {
  errors: string[];
  testFiles: number;
  runners: string[];
  cardGateEntries: number;
}

const TEST_FILE = /\.(?:test|spec)\.ts$/;
const VITEST_CONFIG = /(?:^|\/)vitest[^/]*\.config\.(?:ts|mts|js|mjs)$/;
const PLAYWRIGHT_CONFIG = /(?:^|\/)playwright[^/]*\.config\.(?:ts|mts|js|mjs)$/;
const VITE_CONFIG = /(?:^|\/)vite\.config\.(?:ts|mts|js|mjs)$/;

// Playwright's documented default, and Vitest's, when a config does not set the option.
const PLAYWRIGHT_DEFAULT_MATCH = '**/*.@(spec|test).?(c|m)[jt]s?(x)';
const VITEST_DEFAULT_INCLUDE = '**/*.{test,spec}.?(c|m)[jt]s?(x)';
const VITEST_DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/**
 * Converts the glob dialect the configs use (`**`, `*`, `?`, `{a,b}`, `[jt]`, and the extglobs
 * `@(a|b)` and `?(x)`) into an anchored regular expression. Anything else is matched literally.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  // One entry per open group: what to emit when it closes.
  const closers: string[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    const next = glob[i + 1];
    if (c === '*' && next === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?' && next === '(') {
      out += '(?:';
      closers.push(')?');
      i += 1;
    } else if (c === '@' && next === '(') {
      out += '(?:';
      closers.push(')');
      i += 1;
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      out += '(?:';
      closers.push(')');
    } else if (c === '}' && closers.length > 0) out += closers.pop()!;
    else if (c === ')' && closers.length > 0) out += closers.pop()!;
    else if ((c === ',' || c === '|') && closers.length > 0) out += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) throw new Error(`Unterminated character class in glob ${glob}`);
      out += glob.slice(i, end + 1);
      i = end;
    } else out += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  if (closers.length > 0) throw new Error(`Unbalanced group in glob ${glob}`);
  return new RegExp(`^${out}$`);
}

export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

// ---------------------------------------------------------------------------
// Reading configs statically
// ---------------------------------------------------------------------------

type Literal = string | RegExp | Literal[];

function configObject(source: ts.SourceFile, path: string): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement)) continue;
    let expression = statement.expression;
    for (;;) {
      if (ts.isCallExpression(expression)) {
        const first = expression.arguments[0];
        if (first === undefined) break;
        expression = first;
      } else if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) {
        // `defineConfig(({ mode }) => ({...}))`: the object the function returns.
        expression = expression.body;
      } else if (
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression) ||
        ts.isParenthesizedExpression(expression)
      )
        expression = expression.expression;
      else break;
    }
    if (ts.isObjectLiteralExpression(expression)) return expression;
  }
  throw new Error(`${path}: no \`export default defineConfig({...})\` object literal to read`);
}

function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    )
      return property.initializer;
  }
  return undefined;
}

function literalOf(node: ts.Expression, path: string, what: string): Literal {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) {
    const end = node.text.lastIndexOf('/');
    return new RegExp(node.text.slice(1, end), node.text.slice(end + 1));
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((element) => literalOf(element, path, what));
  throw new Error(`${path}: \`${what}\` is not a string, regular expression or array literal`);
}

function patternList(value: Literal | undefined, path: string, what: string): Pattern[] {
  if (value === undefined) return [];
  const flat = Array.isArray(value) ? value : [value];
  return flat.map((entry) => {
    if (Array.isArray(entry)) throw new Error(`${path}: \`${what}\` may not contain nested arrays`);
    return entry;
  });
}

function stringList(value: Literal | undefined, path: string, what: string): string[] {
  return patternList(value, path, what).map((entry) => {
    if (typeof entry !== 'string') throw new Error(`${path}: \`${what}\` must hold strings`);
    return entry;
  });
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

export function parseVitestConfig(path: string, source: string): VitestRunner {
  const object = configObject(parse(path, source), path);
  for (const unsupported of ['workspace', 'projects']) {
    if (propertyOf(object, unsupported) !== undefined)
      throw new Error(`${path}: \`${unsupported}\` is not supported by the suite-integrity check`);
  }
  const test = propertyOf(object, 'test');
  if (test === undefined || !ts.isObjectLiteralExpression(test))
    throw new Error(`${path}: no \`test\` object literal`);
  for (const unsupported of ['workspace', 'projects']) {
    if (propertyOf(test, unsupported) !== undefined)
      throw new Error(
        `${path}: \`test.${unsupported}\` is not supported by the suite-integrity check`,
      );
  }
  const include = propertyOf(test, 'include');
  const exclude = propertyOf(test, 'exclude');
  return {
    kind: 'vitest',
    config: path,
    include:
      include === undefined
        ? [VITEST_DEFAULT_INCLUDE]
        : stringList(literalOf(include, path, 'test.include'), path, 'test.include'),
    exclude:
      exclude === undefined
        ? VITEST_DEFAULT_EXCLUDE
        : stringList(literalOf(exclude, path, 'test.exclude'), path, 'test.exclude'),
  };
}

export function parsePlaywrightConfig(path: string, source: string): PlaywrightRunner {
  const object = configObject(parse(path, source), path);
  if (propertyOf(object, 'projects') !== undefined)
    throw new Error(`${path}: \`projects\` is not supported by the suite-integrity check`);
  const dirNode = propertyOf(object, 'testDir');
  const matchNode = propertyOf(object, 'testMatch');
  const ignoreNode = propertyOf(object, 'testIgnore');
  const configDir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  const testDir =
    dirNode === undefined
      ? configDir
      : String(literalOf(dirNode, path, 'testDir')).replace(/^\.\//, '');
  const resolvedDir = posix.normalize(posix.join(configDir, testDir)).replace(/^\.$/, '');
  return {
    kind: 'playwright',
    config: path,
    testDir: resolvedDir,
    testMatch:
      matchNode === undefined
        ? [PLAYWRIGHT_DEFAULT_MATCH]
        : patternList(literalOf(matchNode, path, 'testMatch'), path, 'testMatch'),
    testIgnore:
      ignoreNode === undefined
        ? []
        : patternList(literalOf(ignoreNode, path, 'testIgnore'), path, 'testIgnore'),
  };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

function underDirectory(directory: string, file: string): string | undefined {
  if (directory === '') return file;
  return file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : undefined;
}

function patternMatches(pattern: Pattern, relative: string, full: string): boolean {
  return typeof pattern === 'string' ? globMatches(pattern, relative) : pattern.test(full);
}

/** Whether `runner` would run `file`. */
export function claims(runner: Runner, file: string): boolean {
  if (runner.kind === 'vitest') {
    const root = posix.dirname(runner.config) === '.' ? '' : posix.dirname(runner.config);
    const relative = underDirectory(root, file);
    if (relative === undefined) return false;
    return (
      runner.include.some((glob) => globMatches(glob, relative)) &&
      !runner.exclude.some((glob) => globMatches(glob, relative))
    );
  }
  const relative = underDirectory(runner.testDir, file);
  if (relative === undefined) return false;
  return (
    runner.testMatch.some((pattern) => patternMatches(pattern, relative, file)) &&
    !runner.testIgnore.some((pattern) => patternMatches(pattern, relative, file))
  );
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function discoverRunners(input: IntegrityInput): { runners: Runner[]; errors: string[] } {
  const runners: Runner[] = [];
  const errors: string[] = [];
  for (const path of input.files) {
    try {
      if (VITEST_CONFIG.test(path)) runners.push(parseVitestConfig(path, input.read(path)));
      else if (PLAYWRIGHT_CONFIG.test(path))
        runners.push(parsePlaywrightConfig(path, input.read(path)));
      else if (VITE_CONFIG.test(path)) {
        // A `test` block in a Vite config is a runner this check would not see.
        const object = configObject(parse(path, input.read(path)), path);
        if (propertyOf(object, 'test') !== undefined)
          errors.push(
            `${path}: defines a \`test\` block, which is a Vitest runner the suite-integrity check does not read`,
          );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { runners, errors };
}

/** Test files claimed by zero runners, and by more than one. */
export function claimErrors(files: string[], runners: Runner[]): string[] {
  const errors: string[] = [];
  for (const file of files.filter(isTestFile)) {
    const owners = runners.filter((runner) => claims(runner, file)).map((r) => r.config);
    if (owners.length === 0)
      errors.push(`${file}: not claimed by any Vitest or Playwright config, so it never runs`);
    else if (owners.length > 1)
      errors.push(`${file}: claimed by more than one runner (${owners.join(', ')})`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Card gate
// ---------------------------------------------------------------------------

/** The committed card-gate list (ADR 0033 decision 1), read by `scripts/card-gate.ts`. */
export const CARD_GATE_LIST = 'scripts/card-gate.txt';

/**
 * The card gate's entries: each line that is not blank or a `#` comment. An entry is a test file
 * or a path prefix; like a Vitest filter, it runs every test file whose path contains it.
 */
export function cardGateEntries(listText: string): string[] {
  return listText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The Vitest test files the gate runs: each claimed file whose path contains an entry. */
export function cardGateFiles(entries: string[], files: string[], runners: Runner[]): string[] {
  const vitestRunners = runners.filter((runner) => runner.kind === 'vitest');
  return files.filter(
    (file) =>
      isTestFile(file) &&
      vitestRunners.some((runner) => claims(runner, file)) &&
      entries.some((entry) => file.includes(entry)),
  );
}

/** Entries that no vitest-run test file path contains. */
export function cardGateErrors(entries: string[], files: string[], runners: Runner[]): string[] {
  const vitestRunners = runners.filter((runner) => runner.kind === 'vitest');
  const runnable = files.filter(
    (file) => isTestFile(file) && vitestRunners.some((runner) => claims(runner, file)),
  );
  return entries
    .filter((entry) => !runnable.some((file) => file.includes(entry)))
    .map(
      (entry) =>
        `${CARD_GATE_LIST} entry \`${entry}\` matches no tracked Vitest test file, so the gate would silently skip it`,
    );
}

export function checkSuiteIntegrity(input: IntegrityInput): IntegrityResult {
  const { runners, errors } = discoverRunners(input);
  const entries = cardGateEntries(input.read(CARD_GATE_LIST));
  errors.push(...claimErrors(input.files, runners));
  errors.push(...cardGateErrors(entries, input.files, runners));
  return {
    errors,
    testFiles: input.files.filter(isTestFile).length,
    runners: runners.map((runner) => runner.config),
    cardGateEntries: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** Tests each runner collected, by repository-relative file path. */
export type CollectedTests = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * Test files whose own runner collects no test from them (ADR 0034 decision 9): an empty suite,
 * a `describe` with every test removed, or a file whose tests all sit behind a condition that is
 * false where the suite runs. Each passes silently, so a test that stopped running looks green.
 */
export function emptySuiteErrors(
  files: string[],
  runners: Runner[],
  collected: CollectedTests,
  missingRequirement: (file: string) => string | null = () => null,
): { errors: string[]; excused: string[] } {
  const errors: string[] = [];
  const excused: string[] = [];
  for (const file of files.filter(isTestFile)) {
    const owner = runners.find((runner) => claims(runner, file));
    if (owner === undefined) continue;
    const count = collected.get(owner.config)?.get(file) ?? 0;
    if (count > 0) continue;
    const missing = missingRequirement(file);
    if (missing !== null) excused.push(`${file}: needs ${missing}, which is not present`);
    else errors.push(`${file}: ${owner.config} collects no test from it`);
  }
  return { errors, excused };
}

/**
 * The files a test file declares it needs (`// suite-requires: <path>` at the start of a line):
 * data that is not tracked, such as the Scryfall bulk file. While one is missing, the file may
 * collect nothing; once present, it must collect.
 */
export function suiteRequirements(source: string): string[] {
  return [...source.matchAll(/^\/\/ suite-requires: (\S+)\s*$/gm)].map((match) => match[1]!);
}

/** `vitest list --json` output: one entry per test, with its absolute file path. */
export function countVitestList(json: string, root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of JSON.parse(json) as Array<{ file: string }>) {
    const file = posix.relative(root, entry.file.replaceAll('\\', '/'));
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

interface PlaywrightSuite {
  file?: string;
  specs?: Array<{ file: string; tests?: unknown[] }>;
  suites?: PlaywrightSuite[];
}

/** `playwright test --list --reporter=json` output: suites of specs, each with its tests. */
export function countPlaywrightList(json: string, testDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (suite: PlaywrightSuite): void => {
    for (const spec of suite.specs ?? []) {
      const file = posix.join(testDir, spec.file.replaceAll('\\', '/'));
      counts.set(file, (counts.get(file) ?? 0) + (spec.tests?.length ?? 1));
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (JSON.parse(json) as { suites?: PlaywrightSuite[] }).suites ?? [])
    walk(suite);
  return counts;
}
