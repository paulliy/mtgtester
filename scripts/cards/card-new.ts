/**
 * `bun run card:new "<name>" [--batch <id>]` (ADR 0033 decision 1, plan phase 2 step 5): starts
 * a card. It pins the card, prints what the engine already makes of it (the exact `handledLines`
 * an override must claim, and which lines are already modeled), lists the nearest modeled cards
 * for each unparsed line, shows the card's Forge script as a reference when the network allows
 * (decision 7), and prints the interaction questions the card's clause shapes raise.
 *
 * `--primitive <op>` instead scaffolds a new Effect op in its five places (decision 5).
 *
 * With `--batch <id>` it also writes the scaffold, every part of which stays rejected until
 * filled: an `unimplemented()` stub (the card stays unmodeled), a manifest entry whose clauses
 * have no test IDs, a runner test file of `it.todo` placeholders that the skip lint refuses, and
 * the test file's card-gate entry. It never copies another card's definition, and it reads the
 * engine's own interpreter rather than any copy of its vocabulary.
 *
 * For a card the engine already models, it also runs `card:scaffold`: it prints the generated
 * promotion drafts and the mutants they leave. `card:scaffold --write` saves them, unreviewed
 * until `card:scaffold --approve`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { handledLineOf } from '../../packages/engine/src/cards/overrides/index';
import {
  PIN_STORE_PATH,
  oracleSha256,
  pinStore,
  type PinStoreFile,
} from '../../packages/engine/tests/scenario/pin-store';
import { CARD_GATE_LIST } from '../contracts/suite-integrity';
import { withLf } from './line-endings';
import { runPrettier } from './prettier';
import { COVERAGE_ORACLE, findCard } from './resolve-card';

const OVERRIDES_DIR = 'packages/engine/src/cards/overrides';
const OVERRIDES_INDEX = `${OVERRIDES_DIR}/index.ts`;
const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
const CARD_TESTS_DIR = 'packages/engine/tests/cards';
export const FORGE_COMMIT = '6a2dcdc';
const FORGE_CACHE = '.cache/forge';

export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const pascalOf = (id: string): string =>
  id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');

// ── Interaction prompts ────────────────────────────────────────────────────────────────────────

/**
 * Clause shapes behind recent escaped bugs, and the question each one raises. The shapes are
 * deliberately loose: a false prompt costs a moment's thought, a missed one costs a bug.
 */
const INTERACTION_SHAPES: ReadonlyArray<{ shape: string; pattern: RegExp; question: string }> = [
  {
    shape: 'copies',
    pattern: /\bcop(?:y|ies)\b/i,
    question:
      'A copy: which values are copied (CR 707.2), which are not (counters, damage, choices), and is the copy cast?',
  },
  {
    shape: 'phasing',
    pattern: /\bphases? (?:out|in)\b|\bphasing\b/i,
    question:
      'Phasing: do attachments phase with it, and do its effects keep tracking it (CR 702.26)?',
  },
  {
    shape: 'last known information',
    pattern:
      /\b(?:dies|leaves the battlefield|is put into a graveyard)\b[^.]*\b(?:its|that creature's|that permanent's)\b/i,
    question:
      'Last known information: which values come from the object as it last existed on the battlefield (CR 608.2h)?',
  },
  {
    shape: 'per-player grouping',
    pattern: /\beach (?:player|opponent)\b|\bfor each (?:player|opponent)\b/i,
    question:
      'Per player: in what order do players choose and act, and what happens for a player who cannot (APNAP, CR 101.4)?',
  },
  {
    shape: 'graveyard cast permission',
    pattern: /\b(?:cast|play)\b[^.]*\bfrom (?:your|a|their) graveyard\b/i,
    question:
      'Casting from a graveyard: which costs apply, where does the card go after, and does the permission survive a zone change?',
  },
  {
    shape: 'type read off the battlefield',
    pattern: /\bif (?:it|that card|that creature) (?:was|is) an?\b|\bif it was a\b/i,
    question:
      'A type read after a zone change: is the type checked as it last existed, or in its new zone?',
  },
  {
    shape: '"another"',
    pattern: /\banother\b/i,
    question:
      '"Another": is the source itself excluded everywhere it should be, including from counts?',
  },
  {
    shape: '"you may"',
    pattern: /\byou may\b/i,
    question: '"You may": who decides, when, and is declining a separate tested path?',
  },
  {
    shape: 'intervening "if"',
    pattern: /^(?:When|Whenever|At)\b[^,]*, if\b/m,
    question:
      'Intervening "if" (CR 603.4): is the condition checked both when the trigger fires and when it resolves?',
  },
];

export function interactionPrompts(oracleText: string): Array<{ shape: string; question: string }> {
  return INTERACTION_SHAPES.filter(({ pattern }) => pattern.test(oracleText)).map(
    ({ shape, question }) => ({ shape, question }),
  );
}

/**
 * Reasons a spell face reports as `<Face>: <reason>` (Adventure, Omen and modal faces). The face is
 * authored on its own with `defineSpellFace`, claiming the face's own line.
 */
export function faceReasons(
  card: OracleCard,
  reasons: readonly string[],
): Array<{ face: string; line: string }> {
  const faces = [
    ...card.name.split(' // '),
    ...(card.backFace === undefined ? [] : [card.backFace.name]),
  ];
  return reasons.flatMap((reason) => {
    const face = faces.find((name) => reason.startsWith(`${name}: `));
    return face === undefined || face === card.name
      ? []
      : [{ face, line: handledLineOf(reason.slice(face.length + 2)) }];
  });
}

// ── Nearest modeled cards ──────────────────────────────────────────────────────────────────────

/**
 * A line in the form `unmodeledReasons` quotes it: reminder text and an ability word dropped, and
 * the card's name, its short name ("Etali" for "Etali, Primal Storm") and "this artifact" written as
 * "~". Both sides go through it, so a reason matches the Oracle line it came from.
 */
export function reasonForm(line: string, cardName: string): string {
  const names = [cardName, cardName.split(', ')[0]!].filter((name) => name !== '');
  let form = line
    .replace(/\s*\([^()]*\)/g, '')
    .replace(/^[A-Z][A-Za-z' -]* — (?=\S)/, '')
    .trim();
  for (const name of names) form = form.split(name).join('~');
  return form.replace(
    /\b[Tt]his (?:creature|artifact|enchantment|land|permanent|spell|token|Vehicle|Equipment|Saga|planeswalker|Aura)\b/g,
    '~',
  );
}

/** Whether `line` is one an unmodeled reason quotes. */
export function lineIsUnparsed(
  line: string,
  reasons: readonly string[],
  cardName: string,
): boolean {
  const form = reasonForm(line, cardName);
  return reasons.some((reason) => reasonForm(handledLineOf(reason), cardName) === form);
}

/** A line's words with its card's name, numbers and mana symbols made generic. */
export function normalizeLine(line: string, cardName: string): string[] {
  const named = cardName === '' ? line : line.split(cardName).join(' cardname ');
  return named
    .toLowerCase()
    .replace(/\{[^}]+\}/g, ' sym ')
    .replace(/\b\d+\b/g, ' num ')
    .split(/[^a-z']+/)
    .filter(Boolean);
}

/** Jaccard similarity of two lines' word sets. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export interface ModeledLine {
  card: string;
  line: string;
  words: string[];
}

/** Every Oracle line the engine models, across the cards available locally. */
export function modeledLines(cards: readonly OracleCard[]): ModeledLine[] {
  const lines: ModeledLine[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.name)) continue;
    seen.add(card.name);
    let reasons: readonly string[];
    try {
      const def = interpretCard(card);
      if (!def.modeled) continue;
      reasons = def.unmodeledReasons;
    } catch {
      continue;
    }
    for (const line of card.oracleText.split('\n'))
      if (line.trim() !== '' && !lineIsUnparsed(line, reasons, card.name))
        lines.push({ card: card.name, line, words: normalizeLine(line, card.name) });
  }
  return lines;
}

export function nearestCards(
  line: string,
  cardName: string,
  corpus: readonly ModeledLine[],
  count = 5,
): Array<ModeledLine & { score: number }> {
  const words = normalizeLine(line, cardName);
  return corpus
    .filter((entry) => entry.card !== cardName)
    .map((entry) => ({ ...entry, score: similarity(words, entry.words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.card.localeCompare(b.card))
    .slice(0, count);
}

/** Where a card's behavior is defined: its override registration, or the parser. */
function definitionSite(name: string): string {
  const quoted = [`'${name}'`, `"${name}"`, `'${name.replaceAll("'", "\\'")}'`];
  for (const file of readdirSync(OVERRIDES_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()) {
    const lines = readFileSync(join(OVERRIDES_DIR, file), 'utf8').split(/\r?\n/);
    const index = lines.findIndex((text) => quoted.some((needle) => text.includes(needle)));
    if (index !== -1) return `${OVERRIDES_DIR}/${file}:${index + 1}`;
  }
  return 'packages/engine/src/cards/interpret.ts (the parser)';
}

// ── Forge reference ────────────────────────────────────────────────────────────────────────────

/** The card's script path in the Forge repository: `cardsfolder/<initial>/<name>.txt`. */
export function forgeScriptPath(name: string): string {
  const file = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/ +/g, '_');
  return `forge-gui/res/cardsfolder/${file[0]}/${file}.txt`;
}

/** The Forge script, from the gitignored cache or the network; null in CI, offline, or absent. */
async function forgeScript(name: string): Promise<string | null> {
  if (process.env['CI'] !== undefined) return null;
  const path = forgeScriptPath(name);
  const cached = join(FORGE_CACHE, FORGE_COMMIT, path);
  if (existsSync(cached)) return readFileSync(cached, 'utf8');
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/Card-Forge/forge/${FORGE_COMMIT}/${path}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) return null;
    const text = await response.text();
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, text);
    return text;
  } catch {
    return null;
  }
}

// ── The scaffold ───────────────────────────────────────────────────────────────────────────────

export function overrideStub(card: OracleCard, handledLines: readonly string[]): string {
  const lines = handledLines.map((line) => `    ${JSON.stringify(line)},`).join('\n');
  return [
    `  // card:new scaffold: the card stays unmodeled until this becomes a real definition, built`,
    `  // with spell()/triggered()/activated() and targetSlots() named slots.`,
    `  unimplemented(${JSON.stringify(card.oracleId)}, ${JSON.stringify(card.name)}, [`,
    lines,
    `  ]);`,
  ].join('\n');
}

export function batchFileSource(batch: string): string {
  return [
    `import { unimplemented } from './index';`,
    ``,
    `/** Card batch \`${batch}\`, started with card:new. */`,
    `export function register${pascalOf(batch)}Overrides(): void {`,
    `}`,
    ``,
  ].join('\n');
}

/** The batch file with `stub` added at the end of its register function. */
export function insertStub(source: string, stub: string): string {
  return withLf(source, (lf) => insertStubLf(lf, stub));
}

function insertStubLf(source: string, stub: string): string {
  const end = source.lastIndexOf('\n}');
  if (end === -1) throw new Error('the batch file has no closing brace to insert before');
  const before = source.slice(0, end).replace(/\n*$/, '');
  const opening = before.endsWith('{') ? '' : '\n';
  // Imported already, alone or among other names from './index'.
  const withImport = /import\s*\{[^}]*\bunimplemented\b[^}]*\}\s*from\s*'\.\/index'/.test(source);
  const result = `${before}\n${opening}${stub}${source.slice(end)}`;
  return withImport ? result : `import { unimplemented } from './index';\n${result}`;
}

/** The overrides index with the batch's register function imported and called, once. */
export function wireBatch(index: string, batch: string): string {
  return withLf(index, (lf) => wireLf(lf, batch));
}

function wireLf(index: string, batch: string): string {
  const fn = `register${pascalOf(batch)}Overrides`;
  if (index.includes(`${fn}(`) || index.includes(`, ${fn});`)) return index;
  const imports = [...index.matchAll(/^import .*;$/gm)];
  const lastImport = imports[imports.length - 1]!;
  const importEnd = lastImport.index! + lastImport[0].length;
  const withImport = `${index.slice(0, importEnd)}\nimport { ${fn} } from './${batch}';${index.slice(importEnd)}`;
  const calls = [...withImport.matchAll(/^registerDeck\([^;]*\);$/gms)];
  const lastCall = calls[calls.length - 1]!;
  const callEnd = lastCall.index! + lastCall[0].length;
  return `${withImport.slice(0, callEnd)}\nregisterDeck('${batch}', ${fn});${withImport.slice(callEnd)}`;
}

export interface ManifestEntry {
  name: string;
  oracleSha256: string;
  implementationStatus: 'implemented-unreviewed';
  clauses: Array<{ oracleText: string; implementation: string[]; engineTestIds: string[] }>;
  gameplayAiScenarioIds: string[];
}

/** A manifest entry whose clauses name no implementation and no test: rejected until filled. */
export function manifestEntry(card: OracleCard, sha: string): ManifestEntry {
  return {
    name: card.name,
    oracleSha256: sha,
    implementationStatus: 'implemented-unreviewed',
    clauses: card.oracleText
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((oracleText) => ({ oracleText, implementation: [], engineTestIds: [] })),
    gameplayAiScenarioIds: [],
  };
}

/** A runner test file with a positive and a negative placeholder per Oracle line. */
export function runnerTestSource(card: OracleCard, batch: string): string {
  const slug = slugOf(card.name);
  const todos = card.oracleText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line, index) => [
      `  it.todo(${JSON.stringify(`clause ${index + 1}: ${line}`)});`,
      `  it.todo(${JSON.stringify(`clause ${index + 1}, negative: when this line must not act`)});`,
    ]);
  return [
    `/**`,
    ` * ${card.name} (batch ${batch}), started with card:new. Each placeholder becomes a scenario in`,
    ` * packages/engine/tests/scenarios/${slug}.json run through the scenario runner, for example:`,
    ` *`,
    ` *   const file = loadScenarioFile(new URL('../../scenarios/${slug}.json', import.meta.url));`,
    ` *   for (const scenario of file.scenarios)`,
    ` *     it(scenario.id, () => expect(scenarioFailures(runScenario(file, scenario), scenario)).toEqual([]));`,
    ` *`,
    ` * The skip lint rejects \`it.todo\`, so this file fails until every placeholder is replaced.`,
    ` */`,
    `import { describe, it } from 'vitest';`,
    ``,
    `describe(${JSON.stringify(card.name)}, () => {`,
    ...todos,
    `});`,
    ``,
  ].join('\n');
}

// ── A new primitive (ADR 0033 decision 5) ──────────────────────────────────────────────────────

export const PRIMITIVE_FILES = {
  ability: 'packages/engine/src/cards/ability.ts',
  expressions: 'packages/engine/src/cards/expression-validation.ts',
  references: 'packages/engine/src/cards/effect-reference-contracts.ts',
  capabilities: 'packages/engine/src/cards/capabilities.ts',
  resolve: 'packages/engine/src/effects/resolve.ts',
} as const;
export type PrimitiveSources = Record<keyof typeof PRIMITIVE_FILES, string>;

function insertAfter(source: string, anchor: string, text: string, file: string): string {
  return withLf(source, (lf) => {
    const at = lf.indexOf(anchor);
    if (at === -1) throw new Error(`${file} no longer has the anchor the scaffold writes after`);
    if (lf.indexOf(anchor, at + 1) !== -1) throw new Error(`${file} has the anchor twice`);
    return `${lf.slice(0, at + anchor.length)}${text}${lf.slice(at + anchor.length)}`;
  });
}

/**
 * The stub rows a new `Effect` op needs in its five places: the union member, an empty
 * expression-field row, an empty reference contract, its capability tag, and an executor case
 * that throws. The tables stay exhaustive, so the engine compiles, and the op does nothing until
 * its executor and contract tests are written.
 */
export function primitiveScaffold(op: string, sources: PrimitiveSources): PrimitiveSources {
  if (!/^[a-z][A-Za-z0-9]*$/.test(op)) throw new Error('an op is a camelCase identifier');
  if (new RegExp(`op: '${op}'`).test(sources.ability))
    throw new Error(`the Effect union already has op '${op}'`);
  return {
    ability: insertAfter(
      sources.ability,
      'export type Effect =\n',
      `  /** card:new --primitive scaffold: give \`${op}\` its fields and document its rules. */\n  | { op: '${op}' }\n`,
      PRIMITIVE_FILES.ability,
    ),
    expressions: insertAfter(
      sources.expressions,
      'const effectExpressions = {\n',
      `  ${op}: {},\n`,
      PRIMITIVE_FILES.expressions,
    ),
    references: insertAfter(
      sources.references,
      'export const EFFECT_REFERENCE_CONTRACTS = {\n',
      `  ${op}: {},\n`,
      PRIMITIVE_FILES.references,
    ),
    capabilities: insertAfter(
      sources.capabilities,
      "  Effect: {\n    prefix: 'Effect',\n    discriminator: 'op',\n    tags: {\n",
      `      ${op}: true,\n`,
      PRIMITIVE_FILES.capabilities,
    ),
    resolve: insertAfter(
      sources.resolve,
      "        throw new Error('engine bug: executable noOp effect is prohibited');\n",
      [
        `      case '${op}':`,
        `        // card:new --primitive scaffold: write the executor, then its contract tests.`,
        `        throw new EngineInvariantError('resolve.${op}', 'the ${op} primitive has no executor yet');`,
        '',
      ].join('\n'),
      PRIMITIVE_FILES.resolve,
    ),
  };
}

/** The contract-test skeleton for a new op: placeholders the skip lint refuses until filled. */
export function primitiveContractSource(op: string): string {
  const cases = [
    'executes through a real spell or ability, with the engine path',
    'does nothing it should not: the negative case',
    'validation rejects malformed IR for it',
    'every reference it reads or writes resolves (effect-reference-contracts)',
    'its capability tag matches what the executor supports',
  ];
  return [
    `/**`,
    ` * Contract tests for the \`${op}\` primitive, started with card:new --primitive. Each`,
    ` * placeholder becomes a test; the skip lint rejects \`it.todo\`, so this file fails until then.`,
    ` * Contract tests may not use the scenario runner (their evidence hashes this file's closure).`,
    ` */`,
    `import { describe, it } from 'vitest';`,
    ``,
    `describe('${op} primitive contract', () => {`,
    ...cases.map((text) => `  it.todo(${JSON.stringify(text)});`),
    `});`,
    ``,
  ].join('\n');
}

// ── The command ────────────────────────────────────────────────────────────────────────────────

function pinCard(card: OracleCard): string {
  const store = JSON.parse(readFileSync(PIN_STORE_PATH, 'utf8')) as PinStoreFile;
  const existing = store.names[card.name];
  if (existing !== undefined) return existing;
  const sha = oracleSha256(card);
  store.cards[sha] = card;
  store.names[card.name] = sha;
  const sorted = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    PIN_STORE_PATH,
    `${JSON.stringify({ schemaVersion: 1, names: sorted(store.names), cards: sorted(store.cards) }, null, 2)}\n`,
  );
  return sha;
}

function writeScaffold(card: OracleCard, sha: string, handled: string[], batch: string): string[] {
  const written: string[] = [];
  const batchFile = `${OVERRIDES_DIR}/${batch}.ts`;
  const source = existsSync(batchFile) ? readFileSync(batchFile, 'utf8') : batchFileSource(batch);
  if (source.includes(JSON.stringify(card.oracleId)))
    throw new Error(`${batchFile} already registers ${card.name}`);
  writeFileSync(batchFile, insertStub(source, overrideStub(card, handled)));
  written.push(batchFile);
  const index = readFileSync(OVERRIDES_INDEX, 'utf8');
  const wired = wireBatch(index, batch);
  if (wired !== index) {
    writeFileSync(OVERRIDES_INDEX, wired);
    written.push(OVERRIDES_INDEX);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    cards: Record<string, unknown>;
  };
  if (manifest.cards[card.oracleId] === undefined) {
    manifest.cards[card.oracleId] = manifestEntry(card, sha);
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    written.push(MANIFEST);
  }

  const testFile = `${CARD_TESTS_DIR}/${batch}/${slugOf(card.name)}.test.ts`;
  if (!existsSync(testFile)) {
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, runnerTestSource(card, batch));
    written.push(testFile);
  }
  const gate = readFileSync(CARD_GATE_LIST, 'utf8');
  const entry = `${CARD_TESTS_DIR}/${batch}`;
  if (!gate.split(/\r?\n/).includes(entry)) {
    writeFileSync(
      CARD_GATE_LIST,
      withLf(gate, (lf) => `${lf.replace(/\n*$/, '\n')}${entry}\n`),
    );
    written.push(CARD_GATE_LIST);
  }
  return written;
}

/** The scaffold in the repository's own style, so it reads like the code around it. */
function formatWritten(paths: readonly string[]): void {
  runPrettier(paths.filter((path) => !path.endsWith('.txt')));
}

function writePrimitive(op: string): void {
  const read = Object.fromEntries(
    Object.entries(PRIMITIVE_FILES).map(([key, path]) => [key, readFileSync(path, 'utf8')]),
  ) as PrimitiveSources;
  const written = primitiveScaffold(op, read);
  for (const [key, path] of Object.entries(PRIMITIVE_FILES))
    writeFileSync(path, written[key as keyof PrimitiveSources]);
  const test = `packages/engine/tests/${slugOf(op.replace(/([A-Z])/g, '-$1'))}-contract.test.ts`;
  if (!existsSync(test)) writeFileSync(test, primitiveContractSource(op));
  formatWritten([...Object.values(PRIMITIVE_FILES), test]);
  console.log(
    `Scaffolded op '${op}' (rejected until filled):\n${[...Object.values(PRIMITIVE_FILES), test]
      .map((path) => `  ${path}`)
      .join('\n')}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const primitive = args.indexOf('--primitive');
  if (primitive !== -1) {
    const op = args[primitive + 1];
    if (op === undefined) {
      console.error('usage: bun run card:new --primitive <op>');
      process.exit(2);
    }
    writePrimitive(op);
    return;
  }
  const batchFlag = args.indexOf('--batch');
  const batch = batchFlag === -1 ? null : args[batchFlag + 1];
  if (batch !== null && (batch === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(batch))) {
    console.error('--batch needs an id of lowercase words joined by hyphens');
    process.exit(2);
  }
  const name = args
    .filter((_, index) => batchFlag === -1 || (index !== batchFlag && index !== batchFlag + 1))
    .join(' ')
    .trim();
  if (name === '') {
    console.error('usage: bun run card:new "<card name>" [--batch <id>]');
    process.exit(2);
  }
  const found = findCard(name);
  if (found === null) {
    console.error(
      `"${name}" is not in the pin store, ${COVERAGE_ORACLE} or the Scryfall bulk file`,
    );
    process.exit(1);
  }
  const { card, source } = found;
  const sha = pinStore.has(card.name) ? pinStore.shaOf(card.name) : pinCard(card);
  console.log(`${card.name}: ${card.typeLine}${card.manaCost === null ? '' : ` ${card.manaCost}`}`);
  console.log(`from the ${source}; pinned as ${sha}\n`);

  const def = interpretCard(card);
  const faces = faceReasons(card, def.unmodeledReasons);
  const handled = def.unmodeledReasons.map(handledLineOf);
  const isUnparsed = (line: string): boolean =>
    lineIsUnparsed(line, def.unmodeledReasons, card.name);
  console.log('Oracle lines:');
  for (const [index, line] of card.oracleText.split('\n').entries())
    console.log(`  ${index + 1}. ${isUnparsed(line) ? '[unparsed]' : '[modeled] '} ${line}`);
  if (def.unmodeledReasons.length === 0) console.log('\nThe engine already models every line.');
  else {
    console.log('\nunmodeledReasons, verbatim:');
    for (const reason of def.unmodeledReasons) console.log(`  ${reason}`);
    console.log('\nhandledLines an override must claim:');
    for (const line of handled) console.log(`  ${JSON.stringify(line)}`);
    for (const face of faces)
      console.log(
        `\n${face.face} is a spell face: author it with defineSpellFace(${JSON.stringify(card.oracleId)}, ${JSON.stringify(card.name)}, ${JSON.stringify(face.face)}, [...]) claiming:\n  ${JSON.stringify(face.line)}`,
      );
    console.log(
      '\nAuthor with the shared builders (spell(), triggered(), activated()) and targetSlots() named slots; the authoring lint rejects numeric slots.',
    );
  }

  const unparsed = card.oracleText.split('\n').filter(isUnparsed);
  if (unparsed.length > 0) {
    const pool = JSON.parse(readFileSync(COVERAGE_ORACLE, 'utf8')) as OracleCard[];
    const store = JSON.parse(readFileSync(PIN_STORE_PATH, 'utf8')) as PinStoreFile;
    const corpus = modeledLines([...Object.values(store.cards), ...pool]);
    console.log('\nNearest modeled cards (read them; never copy one):');
    for (const line of unparsed) {
      console.log(`  "${line}"`);
      for (const near of nearestCards(line, card.name, corpus))
        console.log(
          `    ${near.score.toFixed(2)} ${near.card} — ${definitionSite(near.card)}\n         "${near.line}"`,
        );
    }
  }

  const script = await forgeScript(card.name);
  if (script !== null) {
    console.log(
      `\nForge script at ${FORGE_COMMIT} (a reference only: never copy it into the repository):`,
    );
    for (const line of script.split('\n')) console.log(`  | ${line}`);
  }

  const prompts = interactionPrompts(card.oracleText);
  if (prompts.length > 0) {
    console.log('\nInteraction questions to answer in tests:');
    for (const { shape, question } of prompts) console.log(`  - ${shape}: ${question}`);
  }

  // Promotion drafts (hill-climb S4): a card the engine already models gets its positive
  // scenarios drafted now, so promoting it starts from review instead of a blank file.
  // It prints them only: --batch writes an unimplemented() stub, which would unmodel the card
  // the drafts were made from.
  if (def.modeled) {
    const scaffold = await import('./card-scaffold');
    console.log('\nPromotion drafts (card:scaffold):');
    scaffold.printScaffoldReport(card, scaffold.scaffoldReport(card));
    console.log(
      `\nbun run card:scaffold "${card.name}" --write saves them; review each, then --approve <id>.`,
    );
  } else
    console.log(
      `\nOnce the card models, bun run card:scaffold "${card.name}" --write drafts its positive scenarios.`,
    );

  if (batch === null) {
    console.log('\nPass --batch <id> to write the scaffold.');
    return;
  }
  const written = writeScaffold(card, sha, handled, batch);
  formatWritten(written);
  console.log(
    `\nScaffold written (rejected until filled):\n${written.map((path) => `  ${path}`).join('\n')}`,
  );
}

if (import.meta.main) await main();
