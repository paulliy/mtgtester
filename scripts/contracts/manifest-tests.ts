/**
 * Manifest test references (ADR 0034 decision 5): every `engineTestId` in the card verification
 * manifest must name exactly one collected Vitest test.
 *
 * - An ID matches a test whose title (its own name, or the full `describe > it` path) equals the
 *   ID, or starts with the ID followed by ` — `.
 * - An ID written `file::title` matches only tests in a file whose path ends with `file`; a clause's
 *   `engineTestSource` list narrows its IDs to those files the same way.
 * - When several tests match, the ones whose full title names the card (any face) are kept: a
 *   parametrized test is one ID per card.
 * - The matched test's file, or its generated title, must name the card (or carry its Oracle ID),
 *   so an ID cannot be satisfied by an unrelated test that happens to share a title.
 * - An ID marked `notExecutableInCi` runs only with the gitignored bulk file: it is not matched
 *   against the CI collection, but its text must still appear in a tracked test file.
 */

export interface CollectedTest {
  /** Repository-relative path. */
  file: string;
  /** `describe > … > it`, as `vitest list` prints it. */
  fullName: string;
}

export interface ManifestReference {
  card: string;
  oracleId: string;
  id: string;
  /** Files the clause's `engineTestSource` names, if any. */
  sources: string[];
  notExecutableInCi: boolean;
  /**
   * From a clause's `contractTestIds`: a shared or primitive test relevant to the clause (built
   * on stand-in cards), which must resolve but is not evidence for this card, so it need not
   * name it.
   */
  contract: boolean;
}

interface ManifestFile {
  cards: Record<
    string,
    {
      name: string;
      engineTestIds?: Array<string | { id: string; notExecutableInCi?: boolean }>;
      clauses: Array<{
        engineTestIds?: Array<string | { id: string; notExecutableInCi?: boolean }>;
        contractTestIds?: string[];
        engineTestSource?: string | string[];
        notExecutableInCi?: string[];
      }>;
    }
  >;
}

/** Every engine test reference in the manifest, card-level and clause-level. */
export function manifestReferences(manifestJson: string): ManifestReference[] {
  const manifest = JSON.parse(manifestJson) as ManifestFile;
  const references: ManifestReference[] = [];
  for (const [oracleId, card] of Object.entries(manifest.cards)) {
    const add = (
      entries: NonNullable<ManifestFile['cards'][string]['engineTestIds']>,
      sources: string[],
      bulkOnly: readonly string[],
      contract = false,
    ) => {
      for (const entry of entries) {
        const id = typeof entry === 'string' ? entry : entry.id;
        const flagged = typeof entry !== 'string' && entry.notExecutableInCi === true;
        references.push({
          card: card.name,
          oracleId,
          id,
          sources,
          notExecutableInCi: flagged || bulkOnly.includes(id),
          contract,
        });
      }
    };
    add(card.engineTestIds ?? [], [], []);
    for (const clause of card.clauses) {
      const sources =
        clause.engineTestSource === undefined
          ? []
          : Array.isArray(clause.engineTestSource)
            ? clause.engineTestSource
            : [clause.engineTestSource];
      add(clause.engineTestIds ?? [], sources, clause.notExecutableInCi ?? []);
      add(clause.contractTestIds ?? [], sources, [], true);
    }
  }
  return references;
}

/**
 * Whether a test file names the card: its name or a face's (as written, with escaped quotes, or
 * as its `oracle-<slug>` fixture alias), or its Oracle ID.
 */
export function fileNamesCard(source: string, name: string, oracleId: string): boolean {
  return source.includes(oracleId) || mentionsCard(source, name);
}

/** Whether text names the card or a face: as written, with escaped or curly quotes, or by slug. */
export function mentionsCard(text: string, name: string): boolean {
  return cardNames(name).some((face) =>
    [face, face.replaceAll("'", "\\'"), face.replaceAll("'", '’'), cardSlug(face)].some((variant) =>
      text.includes(variant),
    ),
  );
}

/** Vitest prints a string parameter quoted (`'x' rest`); the ID names it unquoted. */
const unquoted = (title: string): string => title.replace(/^'((?:[^'\\]|\\.)*)'/, '$1');

/**
 * Collected tests by every ID that matches them: each title form (own and full, as printed and
 * with a leading parameter unquoted) and each prefix of it that ends before a ` — `.
 */
export type TestIndex = ReadonlyMap<string, readonly CollectedTest[]>;

export function indexTests(tests: readonly CollectedTest[]): TestIndex {
  const index = new Map<string, CollectedTest[]>();
  for (const test of tests) {
    const own = test.fullName.split(' > ').at(-1)!;
    const keys = new Set<string>();
    for (const form of [own, test.fullName, unquoted(own), unquoted(test.fullName)]) {
      keys.add(form);
      for (let at = form.indexOf(' — '); at !== -1; at = form.indexOf(' — ', at + 1))
        keys.add(form.slice(0, at));
    }
    for (const key of keys) {
      const list = index.get(key);
      if (list === undefined) index.set(key, [test]);
      else list.push(test);
    }
  }
  return index;
}

const cardSlug = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The names a card's tests may use for it: the full name, each face's, and a legend's short name
 * (the part before the comma: "Scriv, the Obligator" is "Scriv").
 */
export function cardNames(name: string): string[] {
  const faces = name.split(' // ');
  return [...new Set([name, ...faces, ...faces.map((face) => face.split(', ')[0]!)])];
}

export interface ReferenceResult {
  reference: ManifestReference;
  matches: CollectedTest[];
  problem: string | null;
}

export function checkReference(
  reference: ManifestReference,
  tests: TestIndex,
  readFile: (path: string) => string,
): ReferenceResult {
  const [filePart, titlePart] = reference.id.includes('::')
    ? (reference.id.split(/::(.*)/s, 2) as [string, string])
    : [null, reference.id];
  const inFile = (test: CollectedTest) =>
    (filePart === null || test.file.endsWith(filePart)) &&
    (reference.sources.length === 0 ||
      reference.sources.some((source) => test.file.endsWith(source)));
  let matches = (tests.get(titlePart) ?? []).filter(inFile);
  if (matches.length > 1) {
    const naming = matches.filter((test) => mentionsCard(test.fullName, reference.card));
    if (naming.length > 0) matches = naming;
  }
  const result = (problem: string | null): ReferenceResult => ({ reference, matches, problem });
  if (reference.notExecutableInCi) {
    if (matches.length > 0) return result('is marked notExecutableInCi but runs in CI');
    return result(null);
  }
  if (matches.length === 0) return result('matches no collected test');
  if (matches.length > 1)
    return result(
      `matches ${matches.length} tests: ${matches
        .slice(0, 3)
        .map((test) => `${test.file} › ${test.fullName}`)
        .join('; ')}${matches.length > 3 ? '; …' : ''}`,
    );
  if (reference.contract) return result(null);
  // A test parametrized over pinned cards names its card in its title, not in its source.
  const named =
    mentionsCard(matches[0]!.fullName, reference.card) ||
    fileNamesCard(readFile(matches[0]!.file), reference.card, reference.oracleId);
  if (!named) return result(`matches ${matches[0]!.file}, which never names ${reference.card}`);
  return result(null);
}

/** A `notExecutableInCi` ID's text must still be in a tracked test file. */
export function bulkReferenceProblem(
  reference: ManifestReference,
  testSources: ReadonlyMap<string, string>,
): string | null {
  const title = reference.id.includes('::') ? reference.id.split(/::(.*)/s)[1]! : reference.id;
  for (const source of testSources.values()) if (source.includes(title)) return null;
  return 'is marked notExecutableInCi, but no tracked test file holds its text';
}
