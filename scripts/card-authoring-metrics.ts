import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  ABILITY_SOURCE,
  COVERAGE_ORACLE,
  ENGINE_FIXTURES,
  MANIFEST,
  SLUG_FILE,
  collectCardNames,
} from './contracts/card-names';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  ID_SHAPES,
  ID_SHAPE_LABELS,
  RESOLVE_FILE,
  addLines,
  addedFixtureNames,
  changedManifestCards,
  countPumpCalls,
  emptyLines,
  isCompoundOp,
  isPumpScanFile,
  keywordCardsIn,
  linesByCategory,
  manifestIdShape,
  manifestTestIds,
  mentionsCard,
  median,
  parseNumstat,
  parsePatch,
  pathNamesCard,
  rankKeywords,
  indexStringLiterals,
  emptyLiteralIndex,
  textNamesCard,
  totalLines,
  touchKind,
  unionDiscriminants,
  type CategoryLines,
  type IdShape,
  type KeywordCard,
  type KeywordRank,
  type NumstatRow,
  type PatchFile,
  type PumpCounts,
  type TouchKind,
} from './contracts/card-authoring-metrics';
import { checkCardNamedOps, effectOps, slugTable, type SlugFile } from './contracts/ratchets';

/**
 * Phase 0 of docs/plans/card-authoring-and-fail-loud.md (ADR 0033): the baseline every later phase
 * is measured against. Offline; reads git history, tracked sources and the pinned fixtures.
 *
 *   bun run scripts/card-authoring-metrics.ts [--json] [--range <a>..<b>] [--out <file>]
 *
 * Every number in the output carries the rule that produced it and the commits behind it.
 */

const ADR_COMMIT = '8b93725';
const BULK_FILE = 'data/scryfall-oracle-cards.json';
const RULE_STATIC_SOURCE = 'packages/engine/src/cards/rule-statics.ts';
const FIX_WINDOW_DAYS = 30;
const KEYWORD_TOP = 40;

/** The card-named ops ADR 0033 (Context, "Primitives are minted per card") names. */
const ADR_CITED_OPS = [
  'angelGrace',
  'gisela',
  'humbleDefector',
  'kambal',
  'etaliPrimalConqueror',
  'druidPurification',
  'livingDeath',
  'huntingWilds',
  'chaosWarp',
  'inkshield',
  'capstoneParadigm',
  'masterOfCeremonies',
  'vindictiveLichModes',
  'shadrixModes',
  'schemingSymmetry',
];

/** The PR11, PR12 and PR11b commits ADR 0033 cites, as three ranges that skip the duplicates a rebase left. */
const DEFAULT_GROUPS: { label: string; range: string; note: string }[] = [
  {
    label: 'PR11',
    range: '406a1f5..9ab077d',
    note: 'rebased PR11 branch (merged by 4ffe5c6); 10 feat commits a1e406d..ecb4374, then tests/docs 98a1b20, 39a62fa, 7d6432a and rehashes 03e6854, 9ab077d',
  },
  {
    label: 'PR12',
    range: '4ffe5c6..fedd925',
    note: 'rebased PR12 branch: 6e2dfd7 (feat), e8f3dac (scenarios, manifest, docs), a29aa24 (rehash), fedd925 (evidence binding)',
  },
  {
    label: 'PR11b',
    range: 'f528447..da2e2c6',
    note: '8 feat commits 7dc31ad..22e46ba, then 63dd312, e039bc8, e61a3d9 (scenarios), 5861a5f, da2e2c6 (rehash)',
  },
];

// ---------------------------------------------------------------------------
// git and files
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitOptional(args: string[]): string | undefined {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const short = (hash: string) => hash.slice(0, 7);

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

interface CommitInfo {
  hash: string;
  short: string;
  group: string;
  authorDate: string;
  subject: string;
  body: string;
  feat: boolean;
  rows: NumstatRow[];
  lines: CategoryLines;
  patch: PatchFile[];
  manifestCards: string[];
}

function commitsOfRange(group: string, range: string): CommitInfo[] {
  const hashes = git(['rev-list', '--no-merges', '--reverse', range]).split('\n').filter(Boolean);
  if (hashes.length === 0) throw new Error(`range ${range} holds no non-merge commits`);
  const commits = hashes.map((hash): CommitInfo => {
    const [authorDate, subject, ...rest] = git([
      'show',
      '-s',
      '--format=%aI%x1f%s%x1f%b',
      hash,
    ]).split('\x1f');
    const rows = parseNumstat(git(['show', '--numstat', '--no-renames', '--format=', hash]));
    const patch = parsePatch(git(['show', '-U0', '--no-renames', '--format=', hash]));
    const touchesManifest = rows.some((row) => row.path === MANIFEST);
    const before = touchesManifest ? gitOptional(['show', `${hash}^:${MANIFEST}`]) : undefined;
    const after = touchesManifest ? gitOptional(['show', `${hash}:${MANIFEST}`]) : undefined;
    return {
      hash,
      short: short(hash),
      group,
      authorDate: authorDate!,
      subject: subject!,
      body: rest.join('\x1f'),
      feat: /^feat\(/.test(subject!),
      rows,
      lines: linesByCategory(rows),
      patch,
      manifestCards: touchesManifest
        ? changedManifestCards(before, after).map((card) => card.name)
        : [],
    };
  });
  return commits.sort((a, b) => Date.parse(a.authorDate) - Date.parse(b.authorDate));
}

const minutes = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;

function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 1) return `${Math.round(totalMinutes * 60)}s`;
  if (totalMinutes < 120) return `${totalMinutes.toFixed(1)} min`;
  if (totalMinutes < 48 * 60) return `${(totalMinutes / 60).toFixed(1)} h`;
  return `${(totalMinutes / 1440).toFixed(1)} d`;
}

// ---------------------------------------------------------------------------
// Per-card cost
// ---------------------------------------------------------------------------

type Touch = TouchKind | 'subject';

interface CardCost {
  name: string;
  group: string;
  commits: { hash: string; subject: string; touches: Touch[] }[];
  firstCommit: string;
  lastCommit: string;
  spanMinutes: number;
  /** Lines of the commits that touch the card, each commit split equally among the cards it touches. */
  proratedLines: CategoryLines;
  proratedTotal: number;
  fixes: { hash: string; date: string; subject: string }[];
}

interface FixCommit {
  hash: string;
  authorDate: string;
  subject: string;
  text: string;
}

function allFixCommits(since: string, exclude: ReadonlySet<string>): FixCommit[] {
  const raw = git([
    'log',
    '--no-merges',
    `--since=${since}`,
    '--format=%H%x1f%aI%x1f%s%x1f%b%x1e',
    'HEAD',
  ]);
  return raw
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [hash, authorDate, subject, body] = record.split('\x1f');
      return {
        hash: hash!,
        authorDate: authorDate!,
        subject: subject!,
        text: `${subject}\n${body}`,
      };
    })
    .filter((commit) => /^fix(?:\(|:|!)/.test(commit.subject) && !exclude.has(commit.hash));
}

function cardCosts(
  commits: readonly CommitInfo[],
  knownNames: ReadonlySet<string>,
): {
  cards: CardCost[];
  pinnedOnly: string[];
  unattributed: { commit: CommitInfo; total: number }[];
} {
  // Candidates: cards a commit of the range adds to a pinned Oracle fixture.
  const pinned = new Set<string>();
  for (const commit of commits)
    for (const file of commit.patch)
      if (/^packages\/engine\/tests\/fixtures\/[^/]+-oracle\.json$/.test(file.path))
        for (const name of addedFixtureNames(file.changed))
          if (knownNames.has(name)) pinned.add(name);
  // "Malakir Rebirth // Malakir Mire" and its face "Malakir Mire" are one card; keep the whole.
  for (const name of [...pinned])
    for (const whole of pinned)
      if (
        whole !== name &&
        whole.includes('//') &&
        whole
          .split('//')
          .map((f) => f.trim())
          .includes(name)
      )
        pinned.delete(name);

  const touches = new Map<string, Map<string, Set<Touch>>>(); // name -> hash -> touches
  const note = (name: string, hash: string, touch: Touch) => {
    const byCommit = touches.get(name) ?? new Map<string, Set<Touch>>();
    const set = byCommit.get(hash) ?? new Set<Touch>();
    set.add(touch);
    byCommit.set(hash, set);
    touches.set(name, byCommit);
  };
  for (const name of pinned) {
    for (const commit of commits) {
      if (commit.feat && textNamesCard(name, `${commit.subject}\n${commit.body}`))
        note(name, commit.hash, 'subject');
      if (commit.manifestCards.includes(name)) note(name, commit.hash, 'manifest');
      for (const file of commit.patch) {
        const kind = touchKind(file.path);
        if (kind === undefined || kind === 'manifest') continue;
        if (pathNamesCard(name, file.path) || file.changed.some((line) => mentionsCard(name, line)))
          note(name, commit.hash, kind);
      }
    }
  }

  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const touchedBy = new Map<string, string[]>(); // hash -> card names
  for (const [name, byCommit] of touches)
    for (const hash of byCommit.keys()) touchedBy.set(hash, [...(touchedBy.get(hash) ?? []), name]);

  const earliest = commits.reduce(
    (min, commit) => (Date.parse(commit.authorDate) < Date.parse(min) ? commit.authorDate : min),
    commits[0]!.authorDate,
  );
  const fixes = allFixCommits(earliest, new Set(commits.map((commit) => commit.hash)));

  const cards: CardCost[] = [];
  for (const [name, byCommit] of touches) {
    const touching = [...byCommit.keys()]
      .map((hash) => byHash.get(hash)!)
      .sort((a, b) => Date.parse(a.authorDate) - Date.parse(b.authorDate));
    const first = touching[0]!;
    const last = touching[touching.length - 1]!;
    const proratedLines = emptyLines();
    for (const commit of touching)
      addLines(proratedLines, commit.lines, 1 / touchedBy.get(commit.hash)!.length);
    const windowEnd = Date.parse(last.authorDate) + FIX_WINDOW_DAYS * 86_400_000;
    cards.push({
      name,
      group: first.group,
      commits: touching.map((commit) => ({
        hash: commit.short,
        subject: commit.subject,
        touches: [...byCommit.get(commit.hash)!].sort(),
      })),
      firstCommit: first.authorDate,
      lastCommit: last.authorDate,
      spanMinutes: minutes(first.authorDate, last.authorDate),
      proratedLines,
      proratedTotal: totalLines(proratedLines),
      fixes: fixes
        .filter(
          (fix) =>
            Date.parse(fix.authorDate) > Date.parse(last.authorDate) &&
            Date.parse(fix.authorDate) <= windowEnd &&
            textNamesCard(name, fix.text),
        )
        .map((fix) => ({ hash: short(fix.hash), date: fix.authorDate, subject: fix.subject })),
    });
  }
  cards.sort(
    (a, b) => Date.parse(a.firstCommit) - Date.parse(b.firstCommit) || (a.name < b.name ? -1 : 1),
  );
  return {
    cards,
    pinnedOnly: [...pinned].filter((name) => !touches.has(name)).sort(),
    unattributed: commits
      .filter((commit) => !touchedBy.has(commit.hash))
      .map((commit) => ({ commit, total: totalLines(commit.lines) })),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface GroupReport {
  label: string;
  range: string;
  note: string;
  commits: { hash: string; authorDate: string; subject: string; feat: boolean; lines: number }[];
  featCount: number;
  featSpanMinutes: number | undefined;
  /** Gaps between consecutive feat commits, in minutes (author dates). */
  featGapMedianMinutes: number | undefined;
  linesAll: CategoryLines;
  linesFeat: CategoryLines;
  cardCount: number;
  cardSpanMedianMinutes: number | undefined;
  cardProratedMedianLines: number | undefined;
}

function sourceAt(path: string, rev: string | undefined): string {
  return rev === undefined ? readFileSync(path, 'utf8') : git(['show', `${rev}:${path}`]);
}

interface CountsAt {
  rev: string;
  effectOps: number;
  effectOpNames: string[];
  ruleStaticKinds: number;
  compoundOps: string[];
  compoundAnd: number;
  compoundThen: number;
  cardNamedOps: string[];
}

function countsAt(rev: string | undefined, slugs: Record<string, string>): CountsAt {
  const abilityText = sourceAt(ABILITY_SOURCE, rev);
  const ruleText = sourceAt(RULE_STATIC_SOURCE, rev);
  const ops = effectOps(ABILITY_SOURCE, abilityText);
  const kinds = unionDiscriminants(RULE_STATIC_SOURCE, ruleText, 'RuleStatic', 'kind');
  const compound = ops.filter(isCompoundOp);
  return {
    rev: rev ?? 'HEAD',
    effectOps: ops.length,
    effectOpNames: ops,
    ruleStaticKinds: kinds.length,
    compoundOps: compound,
    compoundAnd: compound.filter((op) => /[a-z0-9]And(?=[A-Z0-9]|$)/.test(op)).length,
    compoundThen: compound.filter((op) => /[a-z0-9]Then(?=[A-Z0-9]|$)/.test(op)).length,
    cardNamedOps: checkCardNamedOps({ baseOps: undefined, headOps: ops, slugs }).cardNamed,
  };
}

function lastCommitOf(path: string): string {
  return short(git(['log', '-1', '--format=%H', 'HEAD', '--', path]).trim());
}

interface Report {
  generatedAt: string;
  head: string;
  adrCommit: string;
  runtimeSeconds: number;
  groups: GroupReport[];
  cards: CardCost[];
  pinnedOnly: string[];
  unattributed: { hash: string; subject: string; lines: number }[];
  totals: {
    featAll: CategoryLines;
    commitsAll: CategoryLines;
    featCommits: number;
    commits: number;
  };
  counts: {
    head: CountsAt;
    adr: CountsAt;
    sources: { path: string; lastCommit: string }[];
    adrCited: { exactSlug: string[]; notSlug: string[]; absent: string[] };
  };
  pump: {
    files: number;
    filesWithOneArg: number;
    total: PumpCounts;
    topFiles: { path: string; oneArg: number }[];
  };
  manifestShapes: {
    ids: number;
    byShape: Record<IdShape, number>;
    manifestLastCommit: string;
    literalFiles: number;
  };
  keywords: {
    source: 'bulk' | 'fixtures';
    bulkPresent: boolean;
    bulkFile: string;
    bulkSha256: string | null;
    fixtureHashes: { path: string; sha256: string }[];
    fixtureSetSha256: string | null;
    cards: number;
    ranking: KeywordRank[];
  };
}

function groupReport(
  label: string,
  range: string,
  note: string,
  commits: readonly CommitInfo[],
  cards: readonly CardCost[],
): GroupReport {
  const feat = commits.filter((commit) => commit.feat);
  const gaps = feat
    .slice(1)
    .map((commit, index) => minutes(feat[index]!.authorDate, commit.authorDate));
  const linesAll = emptyLines();
  const linesFeat = emptyLines();
  for (const commit of commits) {
    addLines(linesAll, commit.lines);
    if (commit.feat) addLines(linesFeat, commit.lines);
  }
  const mine = cards.filter((card) => card.group === label);
  return {
    label,
    range,
    note,
    commits: commits.map((commit) => ({
      hash: commit.short,
      authorDate: commit.authorDate,
      subject: commit.subject,
      feat: commit.feat,
      lines: totalLines(commit.lines),
    })),
    featCount: feat.length,
    featSpanMinutes:
      feat.length > 1 ? minutes(feat[0]!.authorDate, feat[feat.length - 1]!.authorDate) : undefined,
    featGapMedianMinutes: median(gaps),
    linesAll,
    linesFeat,
    cardCount: mine.length,
    cardSpanMedianMinutes: median(mine.map((card) => card.spanMinutes)),
    cardProratedMedianLines: median(mine.map((card) => card.proratedTotal)),
  };
}

function collectPump(files: readonly string[]): Report['pump'] {
  const total: PumpCounts = { oneArg: 0, twoArg: 0, other: 0 };
  const perFile: { path: string; oneArg: number }[] = [];
  for (const path of files) {
    const counts = countPumpCalls(path, readFileSync(path, 'utf8'));
    total.oneArg += counts.oneArg;
    total.twoArg += counts.twoArg;
    total.other += counts.other;
    if (counts.oneArg > 0) perFile.push({ path, oneArg: counts.oneArg });
  }
  perFile.sort((a, b) => b.oneArg - a.oneArg || (a.path < b.path ? -1 : 1));
  return {
    files: files.length,
    filesWithOneArg: perFile.length,
    total,
    topFiles: perFile.slice(0, 10),
  };
}

function collectKeywords(): Report['keywords'] {
  if (existsSync(BULK_FILE)) {
    const raw = readFileSync(BULK_FILE);
    const cards = keywordCardsIn(JSON.parse(raw.toString('utf8')));
    return {
      source: 'bulk',
      bulkPresent: true,
      bulkFile: BULK_FILE,
      bulkSha256: sha256(raw),
      fixtureHashes: [],
      fixtureSetSha256: null,
      cards: cards.size,
      ranking: rankKeywords(cards.values()),
    };
  }
  const paths = [
    COVERAGE_ORACLE,
    ...readdirSync(ENGINE_FIXTURES)
      .filter((file) => file.endsWith('-oracle.json'))
      .sort()
      .map((file) => `${ENGINE_FIXTURES}/${file}`),
  ];
  const cards = new Map<string, KeywordCard>();
  const fixtureHashes: { path: string; sha256: string }[] = [];
  for (const path of paths) {
    const raw = readFileSync(path);
    fixtureHashes.push({ path, sha256: sha256(raw) });
    keywordCardsIn(JSON.parse(raw.toString('utf8')), cards);
  }
  return {
    source: 'fixtures',
    bulkPresent: false,
    bulkFile: BULK_FILE,
    bulkSha256: null,
    fixtureHashes,
    fixtureSetSha256: sha256(
      fixtureHashes.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(''),
    ),
    cards: cards.size,
    ranking: rankKeywords(cards.values()),
  };
}

function build(rangeArg: string | undefined): Report {
  const groupsSpec =
    rangeArg === undefined
      ? DEFAULT_GROUPS
      : [{ label: 'range', range: rangeArg, note: `--range ${rangeArg}` }];
  const commitsByGroup = groupsSpec.map((group) => commitsOfRange(group.label, group.range));
  const commits = commitsByGroup.flat();
  const names = collectCardNames(process.cwd());
  const { cards, pinnedOnly, unattributed } = cardCosts(commits, names);
  const groups = groupsSpec.map((group, index) =>
    groupReport(group.label, group.range, group.note, commitsByGroup[index]!, cards),
  );

  const featAll = emptyLines();
  const commitsAll = emptyLines();
  for (const commit of commits) {
    addLines(commitsAll, commit.lines);
    if (commit.feat) addLines(featAll, commit.lines);
  }

  // Counts: committed slug list plus slugs of names added since (same union as check-ratchets).
  const committed = JSON.parse(readFileSync(SLUG_FILE, 'utf8')) as SlugFile;
  const slugs = { ...committed.slugs, ...slugTable(names) };
  const head = countsAt(undefined, slugs);
  const adr = countsAt(ADR_COMMIT, slugs);

  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const pump = collectPump(tracked.filter(isPumpScanFile));

  const literals = emptyLiteralIndex();
  const sourceFiles = tracked.filter(
    (path) => /^(?:packages|apps)\/.+\.ts$/.test(path) && !path.endsWith('.d.ts'),
  );
  for (const path of sourceFiles) indexStringLiterals(readFileSync(path, 'utf8'), literals);
  const byShape = Object.fromEntries(ID_SHAPES.map((shape) => [shape, 0])) as Record<
    IdShape,
    number
  >;
  const ids = manifestTestIds(readFileSync(MANIFEST, 'utf8'));
  for (const id of ids) {
    byShape[manifestIdShape(id, literals)]++;
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    head: short(git(['rev-parse', 'HEAD']).trim()),
    adrCommit: ADR_COMMIT,
    runtimeSeconds: 0,
    groups,
    cards,
    pinnedOnly,
    unattributed: unattributed.map(({ commit, total }) => ({
      hash: commit.short,
      subject: commit.subject,
      lines: total,
    })),
    totals: {
      featAll,
      commitsAll,
      featCommits: commits.filter((commit) => commit.feat).length,
      commits: commits.length,
    },
    counts: {
      head,
      adr,
      adrCited: {
        exactSlug: ADR_CITED_OPS.filter((op) => head.cardNamedOps.includes(op)),
        notSlug: ADR_CITED_OPS.filter(
          (op) => head.effectOpNames.includes(op) && !head.cardNamedOps.includes(op),
        ),
        absent: ADR_CITED_OPS.filter((op) => !head.effectOpNames.includes(op)),
      },
      sources: [ABILITY_SOURCE, RULE_STATIC_SOURCE, SLUG_FILE, MANIFEST].map((path) => ({
        path,
        lastCommit: lastCommitOf(path),
      })),
    },
    pump,
    manifestShapes: {
      ids: ids.length,
      byShape,
      manifestLastCommit: lastCommitOf(MANIFEST),
      literalFiles: sourceFiles.length,
    },
    keywords: collectKeywords(),
  };
  return report;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const pct = (part: number, whole: number) =>
  whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
const fixed = (value: number | undefined, digits = 1) =>
  value === undefined ? 'n/a' : value.toFixed(digits);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function categoryTable(lines: CategoryLines): string {
  const total = totalLines(lines);
  return table(
    ['Category', 'Lines', 'Share'],
    [
      ...CATEGORIES.map((category) => [
        CATEGORY_LABELS[category],
        String(Math.round(lines[category])),
        pct(lines[category], total),
      ]),
      ['total', String(Math.round(total)), '100.0%'],
    ],
  );
}

function renderMarkdown(report: Report): string {
  const out: string[] = [];
  const k = report.keywords;
  const bulkNote = k.bulkPresent
    ? `The bulk Oracle file \`${k.bulkFile}\` was present (SHA-256 \`${k.bulkSha256}\`), so the keyword ranking below is the bulk ranking.`
    : `The bulk Oracle file \`${k.bulkFile}\` (gitignored) was not available in the environment that produced this report, so the keyword ranking below is a **fixture-only fallback** over the committed pinned fixtures, not the bulk ranking; rerun the script where the bulk file exists to produce it.`;
  out.push('# Card authoring baseline (2026-10-28)');
  out.push('');
  out.push(
    `Generated by \`bun run scripts/card-authoring-metrics.ts\` (phase 0 of the card authoring plan, ADR 0033) at HEAD \`${report.head}\` on ${report.generatedAt}, offline from git history, tracked sources and the pinned fixtures, in ${report.runtimeSeconds.toFixed(1)} s. Every number names its rule and the commits behind it; rerun the command to reproduce it (only the timestamp and runtime change). ${bulkNote} Commit times are author dates. The default range is the three PR11, PR12 and PR11b ranges below, which skip the pre-rebase duplicates of the same commits; \`--range <a>..<b>\` replaces them with one range.`,
  );
  out.push('');

  // --- per card -----------------------------------------------------------
  out.push('## 1. Per-card cost over the PR11, PR12 and PR11b commits');
  out.push('');
  out.push('Rules:');
  out.push('');
  out.push(
    '- **Commits**: `git rev-list --no-merges --reverse <range>` for each range below. A `feat` commit is one whose subject starts `feat(`.',
  );
  out.push(
    '- **Cards**: names a commit of the range adds to a pinned Oracle fixture (an added `"name": "..."` line in `packages/engine/tests/fixtures/*-oracle.json`, found with `git show -U0`) that are also in the pinned fixtures or the manifest. A card is listed when at least one commit touches it.',
  );
  out.push(
    "- **A commit touches a card** as `subject` (a `feat` commit whose subject or body names it), `manifest` (its entry in `card-verification-manifest.json` differs between `<commit>^` and `<commit>`), `override` (a changed line under `packages/engine/src/cards/overrides/` names it), `test` (a changed line of a `*.test.ts`, `*.spec.ts` or `packages/*/tests/` file names it, or such a file name contains its kebab-case name) or `scenario` (the same for `packages/server/src/cards/*scenario*.ts`). Names match whole words, by whole name, by `//` face, and by a legend's name before the comma. Because only changed lines are read, an edit inside an existing override that does not repeat the name is missed.",
  );
  out.push(
    '- **Lines** are added plus deleted lines (`git show --numstat --no-renames`) by the path categories of section 2. A commit that touches several cards is split equally among them, so per-card lines add up; commits touching no listed card are shown as unattributed.',
  );
  out.push(
    `- **Span** is the author-time distance between a card's first and last touching commit. **Fixes** are \`fix(...)\` commits reachable from HEAD, outside the range, authored after the card's last touching commit and within ${FIX_WINDOW_DAYS} days of it, whose subject or body names the card (case-insensitive whole words; \`git log --no-merges --since=<earliest range commit>\`).`,
  );
  out.push('');
  for (const group of report.groups) {
    out.push(`### ${group.label}: \`${group.range}\``);
    out.push('');
    out.push(group.note + '.');
    out.push('');
    out.push(
      table(
        ['Measure', 'Value', 'Rule'],
        [
          [
            'commits (non-merge)',
            String(group.commits.length),
            `\`git rev-list --no-merges ${group.range}\``,
          ],
          ['feat commits', String(group.featCount), 'subject starts `feat(`'],
          [
            'feat commit-time span',
            group.featSpanMinutes === undefined ? 'n/a' : formatDuration(group.featSpanMinutes),
            'last minus first feat author date',
          ],
          [
            'median time per feat commit',
            group.featGapMedianMinutes === undefined
              ? 'n/a'
              : formatDuration(group.featGapMedianMinutes),
            'median gap between consecutive feat author dates (the first feat commit has no predecessor)',
          ],
          ['cards listed', String(group.cardCount), 'section rule "Cards"'],
          [
            'median card span (first to last touching commit)',
            group.cardSpanMedianMinutes === undefined
              ? 'n/a'
              : formatDuration(group.cardSpanMedianMinutes),
            'includes the evidence tail',
          ],
          [
            'median prorated lines per card',
            fixed(group.cardProratedMedianLines, 0),
            'prorated across touching commits',
          ],
        ],
      ),
    );
    out.push('');
    out.push(
      table(
        ['Commit', 'Author time', 'Lines', 'Subject'],
        group.commits.map((commit) => [
          `\`${commit.hash}\``,
          commit.authorDate.replace('T', ' ').slice(0, 19),
          String(commit.lines),
          commit.subject,
        ]),
      ),
    );
    out.push('');
    out.push(
      table(
        [
          'Card',
          'Commits (touches)',
          'Span',
          'Prorated lines (gen / tests+scen / engine / other)',
          'Fixes within 30 d',
        ],
        report.cards
          .filter((card) => card.group === group.label)
          .map((card) => {
            const l = card.proratedLines;
            return [
              card.name,
              card.commits.map((c) => `\`${c.hash}\` (${c.touches.join(', ')})`).join('; '),
              formatDuration(card.spanMinutes),
              `${Math.round(card.proratedTotal)}: ${Math.round(l.generated)} / ${Math.round(l.tests + l.scenarios)} / ${Math.round(l.opTables + l.resolve + l.engineCards + l.engineSrcOther)} / ${Math.round(l.manifestAndDocs + l.other)}`,
              card.fixes.length === 0
                ? 'none'
                : card.fixes.map((fix) => `\`${fix.hash}\` ${fix.subject}`).join('; '),
            ];
          }),
      ),
    );
    out.push('');
  }
  if (report.pinnedOnly.length > 0) {
    out.push(
      `Pinned in the range but touched by no listed commit: ${report.pinnedOnly.join(', ')}.`,
    );
    out.push('');
  }
  if (report.unattributed.length > 0) {
    out.push(
      `Commits touching no listed card (shared evidence, rehashes, infrastructure): ${report.unattributed
        .map((c) => `\`${c.hash}\` ${c.subject} (${c.lines} lines)`)
        .join('; ')}.`,
    );
    out.push('');
  }

  // --- categories ----------------------------------------------------------
  out.push('## 2. Lines changed by category');
  out.push('');
  out.push(
    'Rule: `git show --numstat --no-renames --format= <commit>` per commit, each path classified by `classifyPath` in `scripts/contracts/card-authoring-metrics.ts` (first match wins): generated = `packages/engine/tests/fixtures/**`, `benchmarks/**`, `*.snap`, `packages/server/fixtures/**` except the manifest, `docs/reviews/*-verification.json` and `*-gameplay-ai.json`; tests = `*.test.ts`, `*.spec.ts`, `packages/*/tests/**`, `e2e/**`; scenarios = `packages/server/src/cards/*scenario*.ts`; manifest and docs = the manifest, `docs/**`, `*.md`; per-op tables = `ability.ts`, `expression-validation.ts`, `effect-reference-contracts.ts`, `capabilities.ts` under `packages/engine/src/cards/`; resolve.ts = `' +
      RESOLVE_FILE +
      '`; engine src/cards = the rest of `packages/engine/src/cards/`; engine src outside cards/ = the rest of `packages/engine/src/`. Binary files count as zero lines.',
  );
  out.push('');
  out.push(
    `### Feat commits only (${report.totals.featCommits} commits: ${report.groups.map((g) => `${g.label} ${g.featCount}`).join(', ')})`,
  );
  out.push('');
  out.push(categoryTable(report.totals.featAll));
  out.push('');
  out.push(
    `### All ${report.totals.commits} non-merge commits of the ranges, evidence tail included`,
  );
  out.push('');
  out.push(categoryTable(report.totals.commitsAll));
  out.push('');
  for (const group of report.groups) {
    out.push(`### ${group.label}, all ${group.commits.length} commits`);
    out.push('');
    out.push(categoryTable(group.linesAll));
    out.push('');
  }
  const all = report.totals.commitsAll;
  const allTotal = totalLines(all);
  const featT = report.totals.featAll;
  const featTotal = totalLines(featT);
  out.push(
    `ADR 0033 reports generated 46%, tests 33%, engine source outside \`resolve.ts\` 10%, \`resolve.ts\` 3.5% and per-op tables 2% for the 19 feat commits. Over the feat commits alone this script gets generated ${pct(featT.generated, featTotal)}, tests ${pct(featT.tests, featTotal)} (tests plus scenarios ${pct(featT.tests + featT.scenarios, featTotal)}), engine source outside \`resolve.ts\` ${pct(featT.opTables + featT.engineCards + featT.engineSrcOther, featTotal)}, \`resolve.ts\` ${pct(featT.resolve, featTotal)}, per-op tables ${pct(featT.opTables, featTotal)}; engine source outside \`cards/\` and \`resolve.ts\` alone is ${pct(featT.engineSrcOther, featTotal)}. Over all commits of the ranges: generated ${pct(all.generated, allTotal)}, tests ${pct(all.tests, allTotal)} (with scenarios ${pct(all.tests + all.scenarios, allTotal)}), engine source outside \`resolve.ts\` ${pct(all.opTables + all.engineCards + all.engineSrcOther, allTotal)}, \`resolve.ts\` ${pct(all.resolve, allTotal)}, per-op tables ${pct(all.opTables, allTotal)}. The ADR does not state its category rules, so differences come from where the lines are drawn (for example whether pinned Oracle fixtures, scenarios and the manifest count as generated).`,
  );
  out.push('');

  // --- counts -------------------------------------------------------------
  const h = report.counts.head;
  const a = report.counts.adr;
  out.push('## 3. Vocabulary counts');
  out.push('');
  out.push(
    `Measured at HEAD \`${report.head}\` and, for comparison with the ADR, at \`${a.rev}\`. Source files and the last commit that changed each: ${report.counts.sources.map((s) => `\`${s.path}\` (\`${s.lastCommit}\`)`).join(', ')}.`,
  );
  out.push('');
  out.push(
    table(
      ['Count', `HEAD ${report.head}`, `${a.rev}`, 'Rule'],
      [
        [
          '`Effect` ops',
          String(h.effectOps),
          String(a.effectOps),
          '`effectOps()` in `scripts/contracts/ratchets.ts`: the string `op` of each member of `type Effect` in `ability.ts` (TypeScript AST)',
        ],
        [
          '`RuleStatic` kinds',
          String(h.ruleStaticKinds),
          String(a.ruleStaticKinds),
          '`unionDiscriminants()`: the string `kind` of each member of `type RuleStatic` in `rule-statics.ts` (AST)',
        ],
        [
          'compound ops (`And` or `Then`)',
          String(h.compoundOps.length),
          String(a.compoundOps.length),
          '`isCompoundOp()`: regex `[a-z0-9](And|Then)(?=[A-Z0-9]|$)`, the `COMPOSITE` pattern of `check-ratchets`',
        ],
        [
          '  of which `And`',
          String(h.compoundAnd),
          String(a.compoundAnd),
          'same regex with `And` only',
        ],
        [
          '  of which `Then`',
          String(h.compoundThen),
          String(a.compoundThen),
          'same regex with `Then` only',
        ],
        [
          'card-named ops',
          String(h.cardNamedOps.length),
          String(a.cardNamedOps.length),
          '`checkCardNamedOps().cardNamed` in `ratchets.ts`: op equals a slug of `scripts/card-name-slugs.json` or of a name in the pinned fixtures and manifest at HEAD',
        ],
      ],
    ),
  );
  out.push('');
  out.push(
    `Compound ops at HEAD (${h.compoundOps.length}): ${h.compoundOps.map((op) => `\`${op}\``).join(', ')}.`,
  );
  out.push('');
  out.push(
    `Card-named ops at HEAD (${h.cardNamedOps.length}): ${h.cardNamedOps.map((op) => `\`${op}\``).join(', ')}.`,
  );
  out.push('');
  out.push(
    `ADR 0033 lists 15 card-named ops by hand. Of those, ${report.counts.adrCited.exactSlug.length} equal a card-name slug and are counted above; ${report.counts.adrCited.notSlug.length} are \`Effect\` ops at HEAD that no card-name slug equals, so the exact-slug rule does not count them (${report.counts.adrCited.notSlug.map((op) => `\`${op}\``).join(', ')}); ${report.counts.adrCited.absent.length} are not \`Effect\` ops at HEAD (${report.counts.adrCited.absent.map((op) => `\`${op}\``).join(', ') || 'none'}). A looser "starts with a card slug" rule was tried and rejected: common verbs such as \`reanimate\` are card names, so it matches generic ops.`,
  );
  out.push('');
  const p = report.pump;
  out.push('### One-argument `pump()` calls');
  out.push('');
  out.push(
    `Rule: TypeScript AST over the ${p.files} tracked \`.ts\` files matching \`packages/**/tests/**\` or \`packages/**/*.test.ts\` (from \`git ls-files\` at HEAD \`${report.head}\`, \`.d.ts\` excluded); a call counts when its callee is the bare identifier \`pump\`. \`pump(gen)\` is one-argument: it answers every decision with option 0, so a decision that appears or changes goes unnoticed (ADR 0034).`,
  );
  out.push('');
  out.push(
    table(
      ['Calls', 'Count'],
      [
        ['one argument', String(p.total.oneArg)],
        ['two arguments (with an answer callback)', String(p.total.twoArg)],
        ['zero, spread or more than two arguments', String(p.total.other)],
        ['files with a one-argument call', String(p.filesWithOneArg)],
      ],
    ),
  );
  out.push('');
  out.push(
    `Most one-argument calls: ${p.topFiles.map((f) => `\`${f.path}\` (${f.oneArg})`).join(', ')}.`,
  );
  out.push('');
  const m = report.manifestShapes;
  out.push('### Manifest test-ID shapes');
  out.push('');
  out.push(
    `Rule: every string in an \`engineTestIds\` array (clause level and card level) of \`${MANIFEST}\` (last changed in \`${m.manifestLastCommit}\`), classified by \`manifestIdShape()\`, first match wins: it contains \`.test.ts::\` or \`.spec.ts::\` (file-qualified); it equals a plain string literal in one of the ${m.literalFiles} tracked \`packages/**\` and \`apps/**\` \`.ts\` files (exact title); it is the part before \` — \` of such a literal (title prefix with \`—\`); otherwise no source spells it (computed or no literal). Literals come from a regex over source text, with templates containing \`\${\` skipped and backslash escapes removed.`,
  );
  out.push('');
  out.push(
    table(
      ['Shape', 'IDs', 'Share'],
      [
        ...ID_SHAPES.map((shape) => [
          ID_SHAPE_LABELS[shape],
          String(m.byShape[shape]),
          pct(m.byShape[shape], m.ids),
        ]),
        ['total', String(m.ids), '100.0%'],
      ],
    ),
  );
  out.push('');

  // --- keywords ------------------------------------------------------------
  out.push('## 4. Keyword frequency ranking');
  out.push('');
  if (k.bulkPresent) {
    out.push(
      `Source: \`${k.bulkFile}\`, SHA-256 \`${k.bulkSha256}\`. Rule: the \`keywords\` array of each card (distinct \`oracle_id\`); a keyword's count is the number of cards carrying it.`,
    );
  } else {
    out.push(
      `**Fixture-only fallback, not the bulk ranking.** The ranking this plan asks for needs the bulk Oracle file \`${k.bulkFile}\`, which is gitignored and was not present when this report was generated. Until it is rerun with that file, the table below counts the \`keywords\` array of ${k.cards} distinct cards (by Oracle id) in the committed pinned fixtures (\`${COVERAGE_ORACLE}\` and \`${ENGINE_FIXTURES}/*-oracle.json\`, ${k.fixtureHashes.length} files, combined SHA-256 \`${k.fixtureSetSha256}\` over the sorted per-file \`sha256  path\` lines; per-file hashes below). The fixtures are the cards this project has already pinned for tests, so the ranking is biased toward cards that were modeled or audited and says little about the keyword frequency of the whole card pool. Running \`bun run scripts/card-authoring-metrics.ts\` with the bulk file present replaces this section with the bulk ranking and its SHA-256.`,
    );
  }
  out.push('');
  out.push(
    table(
      [
        'Rank',
        'Keyword',
        'Cards',
        ...(k.ranking[0]?.commanderLegalCards === undefined ? [] : ['Commander-legal cards']),
      ],
      k.ranking
        .slice(0, KEYWORD_TOP)
        .map((rank, index) => [
          String(index + 1),
          rank.keyword,
          String(rank.cards),
          ...(rank.commanderLegalCards === undefined ? [] : [String(rank.commanderLegalCards)]),
        ]),
    ),
  );
  out.push('');
  out.push(
    `${k.ranking.length} distinct keywords in all; the first ${Math.min(KEYWORD_TOP, k.ranking.length)} are shown (\`--json\` has all).`,
  );
  out.push('');
  if (!k.bulkPresent) {
    out.push('<details><summary>Fixture hashes (SHA-256)</summary>');
    out.push('');
    out.push(
      table(
        ['File', 'SHA-256'],
        k.fixtureHashes.map((entry) => [`\`${entry.path}\``, `\`${entry.sha256}\``]),
      ),
    );
    out.push('');
    out.push('</details>');
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const started = Date.now();
  const report = build(valueOf('--range'));
  report.runtimeSeconds = (Date.now() - started) / 1000;
  const text = args.includes('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderMarkdown(report)}\n`;
  const out = valueOf('--out');
  if (out === undefined) process.stdout.write(text);
  else {
    writeFileSync(out, text);
    console.error(`wrote ${out} in ${report.runtimeSeconds.toFixed(1)} s`);
  }
}

main();
