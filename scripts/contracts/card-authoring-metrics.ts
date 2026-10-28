import ts from 'typescript';

/**
 * Pure parts of `scripts/card-authoring-metrics.ts` (ADR 0033, plan phase 0). Everything here is a
 * function over text, so each counting rule can be tested without a git history or a bulk file.
 * The CLI owns every git command and file read.
 */

// ---------------------------------------------------------------------------
// Path categories
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  'generated',
  'tests',
  'scenarios',
  'manifestAndDocs',
  'opTables',
  'resolve',
  'engineCards',
  'engineSrcOther',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  generated: 'generated (snapshots, benchmark and pinned fixtures)',
  tests: 'tests (engine, server and e2e)',
  scenarios: 'Card Test Lab scenarios (non-test sources)',
  manifestAndDocs: 'manifest, ledger and docs',
  opTables: 'per-op tables',
  resolve: 'resolve.ts',
  engineCards: 'engine src/cards (overrides, interpreter, other)',
  engineSrcOther: 'engine src outside cards/ and resolve.ts',
  other: 'other (scripts, package.json, web, server src)',
};

/** The files that hold one entry per `Effect` op, outside `resolve.ts` (ADR 0033 Context). */
export const OP_TABLE_FILES = [
  'packages/engine/src/cards/ability.ts',
  'packages/engine/src/cards/expression-validation.ts',
  'packages/engine/src/cards/effect-reference-contracts.ts',
  'packages/engine/src/cards/capabilities.ts',
] as const;

export const RESOLVE_FILE = 'packages/engine/src/effects/resolve.ts';
export const MANIFEST_FILE = 'packages/server/fixtures/card-verification-manifest.json';

/**
 * Which category a repo-relative path belongs to. The first matching rule wins:
 *
 * 1. generated: `packages/engine/tests/fixtures/**` (prettierignore calls it "generated snapshot
 *    fixtures"), `benchmarks/**`, `data/benchmarks/**`, `*.snap`, `packages/server/fixtures/**` except
 *    the hand-written manifest, and `docs/reviews/*-verification.json` / `*-gameplay-ai.json`.
 * 2. tests: `*.test.ts`, `*.spec.ts`, anything under `packages/<p>/tests/` or an `e2e/` directory.
 * 3. scenarios: a non-test `.ts` under `packages/server/src/cards/` whose name has `scenario`.
 * 4. manifestAndDocs: the manifest, `docs/**` and Markdown files.
 * 5. opTables / resolve / engineCards / engineSrcOther: files of `packages/engine/src/`.
 * 6. other.
 */
export function classifyPath(path: string): Category {
  if (
    path.startsWith('packages/engine/tests/fixtures/') ||
    path.startsWith('benchmarks/') ||
    path.startsWith('data/benchmarks/') ||
    path.endsWith('.snap') ||
    (path.startsWith('packages/server/fixtures/') && path !== MANIFEST_FILE) ||
    /^docs\/reviews\/[^/]+-(?:verification|gameplay-ai)\.json$/.test(path)
  )
    return 'generated';
  if (
    /\.(?:test|spec)\.ts$/.test(path) ||
    /^packages\/[^/]+\/tests\//.test(path) ||
    /(?:^|\/)e2e\//.test(path)
  )
    return 'tests';
  if (/^packages\/server\/src\/cards\/[^/]*scenario[^/]*\.ts$/.test(path)) return 'scenarios';
  if (path === MANIFEST_FILE || path.startsWith('docs/') || path.endsWith('.md'))
    return 'manifestAndDocs';
  if (path.startsWith('packages/engine/src/')) {
    if (path === RESOLVE_FILE) return 'resolve';
    if ((OP_TABLE_FILES as readonly string[]).includes(path)) return 'opTables';
    if (path.startsWith('packages/engine/src/cards/')) return 'engineCards';
    return 'engineSrcOther';
  }
  return 'other';
}

export type TouchKind = 'override' | 'test' | 'manifest' | 'scenario';

/** The kind of per-card evidence a changed file can be, or `undefined` for any other file. */
export function touchKind(path: string): TouchKind | undefined {
  if (path === MANIFEST_FILE) return 'manifest';
  if (path.startsWith('packages/engine/src/cards/overrides/')) return 'override';
  const category = classifyPath(path);
  if (category === 'tests') return 'test';
  if (category === 'scenarios') return 'scenario';
  return undefined;
}

// ---------------------------------------------------------------------------
// numstat
// ---------------------------------------------------------------------------

export interface NumstatRow {
  path: string;
  added: number;
  deleted: number;
}

/** Rows of `git show --numstat --no-renames --format=`. Binary files (`-`) count as zero lines. */
export function parseNumstat(text: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (match === null) continue;
    rows.push({
      path: match[3]!,
      added: match[1] === '-' ? 0 : Number(match[1]),
      deleted: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return rows;
}

export type CategoryLines = Record<Category, number>;

export function emptyLines(): CategoryLines {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as CategoryLines;
}

/** Lines changed (added plus deleted) per category. */
export function linesByCategory(rows: readonly NumstatRow[]): CategoryLines {
  const lines = emptyLines();
  for (const row of rows) lines[classifyPath(row.path)] += row.added + row.deleted;
  return lines;
}

export function addLines(into: CategoryLines, from: CategoryLines, weight = 1): void {
  for (const category of CATEGORIES) into[category] += from[category] * weight;
}

export function totalLines(lines: CategoryLines): number {
  return CATEGORIES.reduce((sum, category) => sum + lines[category], 0);
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Zero-context patches
// ---------------------------------------------------------------------------

export interface PatchFile {
  path: string;
  /** Added and removed lines, without their `+`/`-` marker. */
  changed: string[];
}

/** Files of `git show -U0 --no-renames --format=` with their changed lines. */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { path: match?.[2] ?? line, changed: [] };
      files.push(current);
    } else if (current !== undefined) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+') || line.startsWith('-')) current.changed.push(line.slice(1));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Card name matching
// ---------------------------------------------------------------------------

/** Normalizes apostrophes and the escape a TS source adds to them, so `Urza\'s` matches `Urza's`. */
export function normalizeText(text: string): string {
  return text.replace(/\\(['"])/g, '$1').replace(/[’‘]/g, "'");
}

/** Whole name, each face of a `//` card, and a legend's short name, normalized. */
export function cardNameForms(name: string): string[] {
  const forms = new Set<string>();
  for (const form of [name, ...name.split('//')]) {
    const trimmed = normalizeText(form.trim());
    if (trimmed.length >= 4) forms.add(trimmed);
    // "Gut, True Soul Zealot" is written "Gut" in tests; the part before a legend's comma counts.
    const legend = trimmed.split(',')[0]!.trim();
    if (trimmed.includes(',') && legend.length >= 3) forms.add(legend);
  }
  return [...forms];
}

/** `Angel's Grace` becomes `angels-grace`, the shape test files use (`caged-sun.test.ts`). */
export function kebabForms(name: string): string[] {
  const kebab = (text: string) =>
    normalizeText(text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const forms = new Set<string>();
  for (const face of name.split('//')) {
    const whole = kebab(face);
    if (whole.length >= 4) forms.add(whole);
    const legend = kebab(face.split(',')[0]!);
    if (legend.length >= 4) forms.add(legend);
  }
  return [...forms];
}

/** Whether a changed line or a path names the card (case-sensitive for lines, so "Gut" is not "gutter"). */
export function mentionsCard(name: string, line: string): boolean {
  const text = normalizeText(line);
  return cardNameForms(name).some((form) => {
    let from = text.indexOf(form);
    while (from !== -1) {
      const before = from === 0 ? ' ' : text[from - 1]!;
      const after = text[from + form.length] ?? ' ';
      if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return true;
      from = text.indexOf(form, from + 1);
    }
    return false;
  });
}

export function pathNamesCard(name: string, path: string): boolean {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  return kebabForms(name).some((form) => base.includes(form));
}

/** Whether a fix commit's subject or body names the card (case-insensitive, whole name or face). */
export function textNamesCard(name: string, text: string): boolean {
  const haystack = normalizeText(text).toLowerCase();
  return cardNameForms(name).some((form) => {
    const needle = form.toLowerCase();
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      const before = from === 0 ? ' ' : haystack[from - 1]!;
      const after = haystack[from + needle.length] ?? ' ';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      from = haystack.indexOf(needle, from + 1);
    }
    return false;
  });
}

/** Names in the `"name": "..."` lines a diff adds to a pinned Oracle fixture. */
export function addedFixtureNames(changed: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of changed) {
    const match = /^\s*"name":\s*("(?:[^"\\]|\\.)*"),?\s*$/.exec(line);
    if (match === null) continue;
    try {
      names.push(JSON.parse(match[1]!) as string);
    } catch {
      // not a JSON string; ignore
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Ops, rule statics, compound and card-named
// ---------------------------------------------------------------------------

/**
 * A compound op joins two instructions: `And` or `Then` inside the name, as in
 * `reanimateAndLoseLife`. Same pattern as `COMPOSITE` in `contracts/ratchets.ts`, which is not
 * exported; the test file proves the two agree on every op of `ability.ts`.
 */
export const COMPOUND_OP = /[a-z0-9](And|Then)(?=[A-Z0-9]|$)/;

export function isCompoundOp(op: string): boolean {
  return COMPOUND_OP.test(op);
}

/**
 * The string-literal discriminant (`op`, `kind`) of every member of a union type alias. Throws on a
 * member that is not an object type literal with that discriminant, like `effectOps`.
 */
export function unionDiscriminants(
  path: string,
  source: string,
  alias: string,
  discriminant: string,
): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  let found = false;
  for (const statement of file.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== alias) continue;
    found = true;
    const members = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type];
    for (const member of members) {
      if (!ts.isTypeLiteralNode(member))
        throw new Error(
          `${path}: \`${alias}\` member \`${member.getText(file).slice(0, 60)}\` is not an object type literal`,
        );
      const property = member.members.find(
        (entry): entry is ts.PropertySignature =>
          ts.isPropertySignature(entry) && entry.name.getText(file) === discriminant,
      );
      const literal =
        property?.type !== undefined && ts.isLiteralTypeNode(property.type)
          ? property.type.literal
          : undefined;
      if (literal === undefined || !ts.isStringLiteral(literal))
        throw new Error(`${path}: a \`${alias}\` member has no string-literal \`${discriminant}\``);
      values.push(literal.text);
    }
  }
  if (!found) throw new Error(`${path}: no \`${alias}\` type alias`);
  return values;
}

// ---------------------------------------------------------------------------
// pump() arity
// ---------------------------------------------------------------------------

export interface PumpCounts {
  /** `pump(gen)`: the generator alone, every decision answered by the default. */
  oneArg: number;
  /** `pump(gen, answer)`. */
  twoArg: number;
  /** Zero arguments or a spread argument, whose arity cannot be read from the call. */
  other: number;
}

/**
 * Calls of a bare identifier `pump`, by argument count, from the TypeScript AST. Method calls such
 * as `x.pump(...)` and non-call mentions (`const pump = ...`) are not counted.
 */
export function countPumpCalls(path: string, source: string): PumpCounts {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const counts: PumpCounts = { oneArg: 0, twoArg: 0, other: 0 };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pump'
    ) {
      const spread = node.arguments.some((argument) => ts.isSpreadElement(argument));
      if (spread || node.arguments.length === 0 || node.arguments.length > 2) counts.other++;
      else if (node.arguments.length === 1) counts.oneArg++;
      else counts.twoArg++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return counts;
}

/** Whether a path is in the pump() scan: `packages/**\/tests/**` or `packages/**\/*.test.ts`. */
export function isPumpScanFile(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !path.endsWith('.d.ts') &&
    /^packages\//.test(path) &&
    (/\/tests\//.test(path) || /\.test\.ts$/.test(path))
  );
}

// ---------------------------------------------------------------------------
// Manifest test-ID shapes
// ---------------------------------------------------------------------------

export const ID_SHAPES = ['fileQualified', 'exactTitle', 'titlePrefixDash', 'noLiteral'] as const;
export type IdShape = (typeof ID_SHAPES)[number];

export const ID_SHAPE_LABELS: Record<IdShape, string> = {
  fileQualified: 'file-qualified (`file.test.ts::title`)',
  exactTitle: 'exact title (equals a string literal, such as an `it()` title)',
  titlePrefixDash:
    'title prefix with `—` (a literal title is `id — description`, so the ID is its prefix)',
  noLiteral: 'computed or no literal (no string literal equals it or starts with `id — `)',
};

/** Plain string literals of tracked sources, and the part before ` — ` of each that has one. */
export interface LiteralIndex {
  exact: Set<string>;
  dashPrefix: Set<string>;
}

export function emptyLiteralIndex(): LiteralIndex {
  return { exact: new Set(), dashPrefix: new Set() };
}

/**
 * The shape of one manifest test ID, first match wins: it contains `.test.ts::` or `.spec.ts::`;
 * it equals a string literal; it is the prefix of a literal `id — description`; otherwise nothing
 * in the sources spells it, so it is built at run time (a template or a loop over a table).
 */
export function manifestIdShape(id: string, index: LiteralIndex): IdShape {
  if (/\.(?:test|spec)\.ts::/.test(id)) return 'fileQualified';
  if (index.exact.has(id)) return 'exactTitle';
  if (index.dashPrefix.has(id)) return 'titlePrefixDash';
  return 'noLiteral';
}

/**
 * Adds the plain string literals of a `.ts` source to an index (template literals containing `${`
 * are skipped). Regex over source text, not the AST: it is run over ~1,000 files.
 */
export function indexStringLiterals(
  source: string,
  into: LiteralIndex = emptyLiteralIndex(),
): LiteralIndex {
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    if (match[3] !== undefined && text.includes('${')) continue;
    const value = text.replace(/\\(.)/g, '$1');
    into.exact.add(value);
    const dash = value.indexOf(' — ');
    if (dash > 0) into.dashPrefix.add(value.slice(0, dash));
  }
  return into;
}

/** Every test ID string in the manifest: clause `engineTestIds` and card-level `engineTestIds`. */
export function manifestTestIds(manifestText: string): string[] {
  const manifest = JSON.parse(manifestText) as {
    cards?: Record<string, { clauses?: Record<string, unknown>[]; engineTestIds?: unknown }>;
  };
  const ids: string[] = [];
  const take = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry === 'string') ids.push(entry);
      else if (entry !== null && typeof entry === 'object') {
        const id = (entry as Record<string, unknown>)['id'];
        if (typeof id === 'string') ids.push(id);
      }
    }
  };
  for (const card of Object.values(manifest.cards ?? {})) {
    take(card.engineTestIds);
    for (const clause of card.clauses ?? []) take(clause['engineTestIds']);
  }
  return ids;
}

/** Oracle ids whose manifest entry differs between two manifest texts (added, removed or edited). */
export function changedManifestCards(
  before: string | undefined,
  after: string | undefined,
): { oracleId: string; name: string }[] {
  const read = (text: string | undefined) =>
    (text === undefined
      ? {}
      : (JSON.parse(text) as { cards?: Record<string, { name?: unknown }> }).cards) ?? {};
  const a = read(before);
  const b = read(after);
  const changed: { oracleId: string; name: string }[] = [];
  for (const oracleId of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[oracleId]) === JSON.stringify(b[oracleId])) continue;
    const name = (b[oracleId] ?? a[oracleId])?.name;
    if (typeof name === 'string') changed.push({ oracleId, name });
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Keyword ranking
// ---------------------------------------------------------------------------

export interface KeywordCard {
  /** Oracle id, or the name when a source has no id. */
  id: string;
  name: string;
  keywords: string[];
  /** Absent when the source carries no legality information. */
  commanderLegal?: boolean;
}

/**
 * Cards with a `keywords` array from a Scryfall bulk file (`oracle_id`, `legalities.commander`),
 * the committed projections (`oracleId`, `commanderLegality`) or any envelope around either. Cards
 * repeated across files are kept once, keyed by Oracle id.
 */
export function keywordCardsIn(
  value: unknown,
  into: Map<string, KeywordCard> = new Map(),
): Map<string, KeywordCard> {
  if (Array.isArray(value)) for (const entry of value) keywordCardsIn(entry, into);
  else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keywords = object['keywords'];
    if (
      typeof object['name'] === 'string' &&
      Array.isArray(keywords) &&
      keywords.every((keyword) => typeof keyword === 'string')
    ) {
      const rawId = object['oracle_id'] ?? object['oracleId'];
      const id = typeof rawId === 'string' ? rawId : object['name'];
      const legalities = object['legalities'] as Record<string, unknown> | undefined;
      const legality = legalities?.['commander'] ?? object['commanderLegality'];
      const card: KeywordCard = { id, name: object['name'], keywords: keywords as string[] };
      if (typeof legality === 'string') card.commanderLegal = legality !== 'not_legal';
      if (!into.has(id)) into.set(id, card);
    } else for (const entry of Object.values(object)) keywordCardsIn(entry, into);
  }
  return into;
}

export interface KeywordRank {
  keyword: string;
  cards: number;
  commanderLegalCards: number | undefined;
}

/** Keywords by number of distinct cards that carry them, ties broken alphabetically. */
export function rankKeywords(cards: Iterable<KeywordCard>): KeywordRank[] {
  const all = new Map<string, number>();
  const legal = new Map<string, number>();
  let anyLegality = false;
  for (const card of cards) {
    if (card.commanderLegal !== undefined) anyLegality = true;
    for (const keyword of new Set(card.keywords)) {
      all.set(keyword, (all.get(keyword) ?? 0) + 1);
      if (card.commanderLegal === true) legal.set(keyword, (legal.get(keyword) ?? 0) + 1);
    }
  }
  return [...all.entries()]
    .map(([keyword, count]) => ({
      keyword,
      cards: count,
      commanderLegalCards: anyLegality ? (legal.get(keyword) ?? 0) : undefined,
    }))
    .sort((a, b) => b.cards - a.cards || (a.keyword < b.keyword ? -1 : 1));
}
