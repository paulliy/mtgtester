/**
 * Card Test Lab sampling (ADR 0037). A pull request's lab run plays a sample of the scenarios
 * instead of every one: the scenarios the change adds or edits, one scenario for each engine
 * primitive the change's engine edits name, and a hash-picked scenario per primitive family. The
 * weekly run and the `ci:lab-verbose` label still play every scenario.
 *
 * Everything here is pure: the CLI (`scripts/card-test-lab-sample.ts`) gathers the scenario
 * catalog, the committed fingerprint index at the base, and the diff, and passes them in.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** One lab scenario as the sampler sees it. */
export interface LabScenario {
  id: string;
  title: string;
  /** Engine capability IDs (`Family.name`) of the cards in the scenario's seats. */
  capabilities: readonly string[];
}

export type LabSelectionReason =
  'changed' | 'mentioned' | 'latest' | `engine:${string}` | `family:${string}`;

export interface LabSelectionInput {
  scenarios: readonly LabScenario[];
  /** The commit the sample derives from; the same seed always picks the same scenarios. */
  seed: string;
  /** Scenario IDs that are new or whose fingerprint differs from the base index. */
  changed: ReadonlySet<string>;
  /** Scenario IDs or titles the diff names (a changed line, or the test/scenario around one). */
  mentioned: ReadonlySet<string>;
  /** Engine capability IDs the diff's engine edits name. */
  touchedCapabilities: ReadonlySet<string>;
  /** Scenario IDs added on main recently (`ci:lab-latest`); empty when the label is absent. */
  latest: ReadonlySet<string>;
  /** Draw the per-family sample (`ci:lab`). Without it only the targeted scenarios run. */
  sample: boolean;
  /** Primitives drawn per family, and scenarios drawn per touched primitive. */
  perFamily: number;
  /**
   * Browser tests whose titles name no scenario, with the string literals their bodies use. A
   * test whose body names scenarios runs when any of them is selected; one naming none always
   * runs.
   */
  tests?: readonly SpecTest[];
}

/** A `test('<title>', ...)` call in a spec, with every string literal inside it. */
export interface SpecTest {
  title: string;
  literals: readonly string[];
}

export interface LabSelection {
  /** Selected scenario IDs, in catalog order, each with every reason it was picked. */
  selected: { id: string; title: string; reasons: LabSelectionReason[] }[];
  /** IDs and titles of the scenarios left out: the Playwright `grepInvert` input. */
  excludedTitles: string[];
}

/** A deterministic index in `[0, size)` for `key` under `seed`. */
export function pick(seed: string, key: string, size: number): number {
  if (size <= 0) throw new Error(`lab sample: nothing to pick for ${key}`);
  const digest = createHash('sha256').update(`${seed}\0${key}`).digest();
  return digest.readUInt32BE(0) % size;
}

/** The family of a capability ID: the part before the first dot. */
export function capabilityFamily(capability: string): string {
  const dot = capability.indexOf('.');
  return dot === -1 ? capability : capability.slice(0, dot);
}

/** The name of a capability ID: the part after the first dot. */
export function capabilityName(capability: string): string {
  const dot = capability.indexOf('.');
  return dot === -1 ? capability : capability.slice(dot + 1);
}

export function selectLabScenarios(input: LabSelectionInput): LabSelection {
  const { scenarios, seed, perFamily } = input;
  if (!Number.isInteger(perFamily) || perFamily < 1)
    throw new Error('lab sample: perFamily must be a positive integer');
  const reasons = new Map<string, Set<LabSelectionReason>>();
  const add = (id: string, reason: LabSelectionReason): void => {
    const set = reasons.get(id) ?? new Set<LabSelectionReason>();
    set.add(reason);
    reasons.set(id, set);
  };
  const readers = new Map<string, string[]>();
  for (const scenario of scenarios) {
    if (input.changed.has(scenario.id)) add(scenario.id, 'changed');
    if (input.mentioned.has(scenario.id) || input.mentioned.has(scenario.title))
      add(scenario.id, 'mentioned');
    if (input.latest.has(scenario.id)) add(scenario.id, 'latest');
    for (const capability of scenario.capabilities) {
      const list = readers.get(capability) ?? [];
      list.push(scenario.id);
      readers.set(capability, list);
    }
  }
  // Up to `count` distinct scenarios reading `capability`, drawn without replacement.
  const draw = (capability: string, count: number, salt: string): string[] => {
    const pool = [...(readers.get(capability) ?? [])].sort();
    const drawn: string[] = [];
    while (drawn.length < count && pool.length > 0)
      drawn.push(
        pool.splice(pick(seed, `${salt}:${capability}:${drawn.length}`, pool.length), 1)[0]!,
      );
    return drawn;
  };
  for (const capability of [...input.touchedCapabilities].sort())
    for (const id of draw(capability, perFamily, 'engine')) add(id, `engine:${capability}`);
  if (input.sample) {
    const families = new Map<string, string[]>();
    for (const capability of [...readers.keys()].sort()) {
      const family = capabilityFamily(capability);
      families.set(family, [...(families.get(family) ?? []), capability]);
    }
    for (const [family, capabilities] of families) {
      const pool = [...capabilities];
      for (let index = 0; index < perFamily && pool.length > 0; index++) {
        const [capability] = pool.splice(pick(seed, `family:${family}:${index}`, pool.length), 1);
        for (const id of draw(capability!, 1, 'family')) add(id, `family:${capability!}`);
      }
    }
  }
  const selected: LabSelection['selected'] = [];
  const excluded: string[] = [];
  for (const scenario of scenarios) {
    const why = reasons.get(scenario.id);
    if (why === undefined) excluded.push(scenario.id, scenario.title);
    else selected.push({ id: scenario.id, title: scenario.title, reasons: [...why].sort() });
  }
  // A test titled with no scenario runs when any scenario its body names is selected, and is left
  // out only when it names some and none of them is.
  const names = new Map<string, string>();
  for (const scenario of scenarios) {
    names.set(scenario.id, scenario.id);
    names.set(scenario.title, scenario.id);
  }
  const chosen = new Set(selected.map(({ id }) => id));
  for (const test of input.tests ?? []) {
    if (names.has(test.title)) continue;
    const linked = new Set(test.literals.flatMap((literal) => names.get(literal) ?? []));
    if (linked.size > 0 && ![...linked].some((id) => chosen.has(id))) excluded.push(test.title);
  }
  // A string that names a selected scenario must never filter a test out.
  const kept = new Set(selected.flatMap(({ id, title }) => [id, title]));
  const excludedTitles = [...new Set(excluded)].filter((title) => !kept.has(title)).sort();
  return { selected, excludedTitles };
}

/** Lines a unified diff (`git diff -U0`) changes, per file, on the new side. */
export interface ChangedFile {
  path: string;
  /** New-side line numbers (1-based) changed; a pure deletion marks the line after it. */
  lines: number[];
  /** The text of every added and removed line. */
  text: string[];
}

export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let next = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4);
      current = { path: path === '/dev/null' ? '' : path.replace(/^b\//, ''), lines: [], text: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith('--- ') && current === undefined) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null && current !== undefined) {
      next = Number(hunk[1]);
      if (hunk[2] === '0') current.lines.push(Math.max(1, next));
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('+')) {
      current.lines.push(next++);
      current.text.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.text.push(line.slice(1));
    } else if (line.startsWith(' ')) next++;
  }
  return files.filter((file) => file.path !== '' || file.text.length > 0);
}

/** Every string literal in `text` (single, double or template quotes, no interpolation). */
export function stringLiterals(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`/g)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    found.push(raw.replace(/\\(.)/g, '$1'));
  }
  return found;
}

/**
 * The string literals a change names in a TypeScript source: those on the changed lines, the
 * labels of every `case` around one, the literals an enclosing `if` compares with `===`/`!==`,
 * the title of an enclosing `test(...)`/`describe(...)` call, and the `id` of an enclosing object.
 * With `callArguments`, the string arguments of every enclosing call count too, so an edit inside
 * `entry(CARD, 'mode', 'Scenario title', ...)` names that scenario. Engine sources leave it off:
 * there it would name every event and helper key around the edit.
 */
export function enclosingLiterals(
  path: string,
  source: string,
  lines: readonly number[],
  callArguments = false,
): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const starts = file.getLineStarts();
  const found = new Set<string>();
  const offsets = lines
    .filter((line) => line >= 1 && line <= starts.length)
    .map((line) => [starts[line - 1]!, starts[line] ?? source.length] as const);
  const comparisons = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    )
      for (const side of [node.left, node.right])
        if (ts.isStringLiteralLike(side)) found.add(side.text);
    ts.forEachChild(node, comparisons);
  };
  const isTestCall = (node: ts.CallExpression): boolean => {
    let callee: ts.Expression = node.expression;
    while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
    return ts.isIdentifier(callee) && ['test', 'it', 'describe'].includes(callee.text);
  };
  const visit = (node: ts.Node): void => {
    const start = node.getStart(file);
    const end = node.getEnd();
    if (!offsets.some(([from, to]) => from < end && to > start)) return;
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression))
      found.add(node.expression.text);
    if (ts.isIfStatement(node)) comparisons(node.expression);
    if (ts.isCallExpression(node) && callArguments)
      for (const argument of node.arguments)
        if (ts.isStringLiteralLike(argument)) found.add(argument.text);
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const [title] = node.arguments;
      if (title !== undefined && ts.isStringLiteralLike(title)) found.add(title.text);
    }
    if (ts.isObjectLiteralExpression(node))
      for (const property of node.properties)
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'id' &&
          ts.isStringLiteralLike(property.initializer)
        )
          found.add(property.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found].sort();
}

/** Every `test('<title>', ...)` call with a literal title in a spec, and the literals inside it. */
export function specTests(path: string, source: string): SpecTest[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const tests: SpecTest[] = [];
  const literalsIn = (node: ts.Node, into: Set<string>): void => {
    if (ts.isStringLiteralLike(node)) into.add(node.text);
    ts.forEachChild(node, (child) => literalsIn(child, into));
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'test'
    ) {
      const [title, ...rest] = node.arguments;
      if (title !== undefined && ts.isStringLiteralLike(title)) {
        const literals = new Set<string>();
        for (const argument of rest) literalsIn(argument, literals);
        tests.push({ title: title.text, literals: [...literals].sort() });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return tests;
}

/** Engine sources whose edits count as primitive edits: not tests and not per-card overrides. */
export function isEnginePrimitiveSource(path: string): boolean {
  return (
    path.startsWith('packages/engine/src/') &&
    path.endsWith('.ts') &&
    !/\.(test|spec)\.ts$/.test(path) &&
    !path.startsWith('packages/engine/src/cards/overrides/')
  );
}

/** Capabilities whose name (the part after the family) is one of `literals`. */
export function capabilitiesNamed(
  capabilities: Iterable<string>,
  literals: ReadonlySet<string>,
): Set<string> {
  const touched = new Set<string>();
  for (const capability of capabilities)
    if (literals.has(capabilityName(capability))) touched.add(capability);
  return touched;
}

function canonical(value: unknown): unknown {
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value instanceof Set) return canonical([...value]);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** A short stable hash of `value`'s canonical JSON (object keys sorted, Maps and Sets expanded). */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Where the cards of a prepared board sit, without the engine's internal fields: each object
 * with an `oracleId`, keyed by its path with array positions removed (`players.hand`,
 * `battlefield`), plus each player's life and the turn position. A scenario edit that moves a
 * card or changes a life total changes this; an engine change that adds a state field does not.
 */
export function boardSummary(state: unknown): unknown {
  const cards: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, path);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record['oracleId'] === 'string') {
      const flags = ['tapped', 'controller', 'owner', 'faceDown', 'counters']
        .filter((key) => record[key] !== undefined)
        .map((key) => `${key}=${JSON.stringify(canonical(record[key]))}`);
      cards.push(`${path}:${record['oracleId']}${flags.length > 0 ? `[${flags.join(',')}]` : ''}`);
    }
    for (const [key, child] of Object.entries(record))
      if (key !== 'eventLog') walk(child, path === '' ? key : `${path}.${key}`);
  };
  walk(state, '');
  const record = (state ?? {}) as Record<string, unknown>;
  const players = Array.isArray(record['players']) ? record['players'] : [];
  return {
    cards: cards.sort(),
    life: players.map((player) => (player as Record<string, unknown>)['life'] ?? null),
    turn: [record['turnNumber'], record['activePlayerIndex'], record['phase'], record['step']],
  };
}

/** The committed index: scenario ID to fingerprint. */
export interface LabIndex {
  schemaVersion: 1;
  scenarios: Record<string, string>;
}

export function parseLabIndex(text: string): LabIndex {
  const value = JSON.parse(text) as Partial<LabIndex>;
  if (value.schemaVersion !== 1 || value.scenarios === null || typeof value.scenarios !== 'object')
    throw new Error('lab sample: the index is not a schemaVersion 1 scenario index');
  return value as LabIndex;
}

export function formatLabIndex(scenarios: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(scenarios).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify({ schemaVersion: 1, scenarios: sorted }, null, 2)}\n`;
}

/** Scenario IDs in `current` that are absent from `base` or carry a different fingerprint. */
export function changedScenarios(current: LabIndex, base: LabIndex): Set<string> {
  const changed = new Set<string>();
  for (const [id, hash] of Object.entries(current.scenarios))
    if (base.scenarios[id] !== hash) changed.add(id);
  return changed;
}

/** Scenario IDs in `current` that `older` does not have. */
export function addedScenarios(current: LabIndex, older: LabIndex): Set<string> {
  return new Set(Object.keys(current.scenarios).filter((id) => !(id in older.scenarios)));
}
