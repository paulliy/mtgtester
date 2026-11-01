import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ABILITY_SOURCE, MANIFEST, SLUG_FILE, collectCardNames } from './contracts/card-names';
import {
  checkCardNamedOps,
  checkNotExecutableInCi,
  effectOps,
  resolveBase,
  slugTable,
  type SlugFile,
} from './contracts/ratchets';
import { strictPumpErrors, type ChangedTestFile } from './contracts/strict-pump';

// ADR 0034 decision 9: lists that may shrink but must not grow, and no new guessing pump() call,
// compared with the pull request's base commit. The base comes from RATCHET_BASE (ci.yml passes the pull request's base SHA, or a
// push event's `before` SHA) or `--base <sha>`; an unusable base falls back to HEAD's first parent.
// A git failure throws: only a path missing at the base counts as "absent there" (see `baseFile`).
function git(args: string[], quiet = false): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
    maxBuffer: 1 << 28,
  });
}

/** `git` for the base probes, where failing is an answer (an unknown commit, no parent). */
function tryGit(args: string[]): string | undefined {
  try {
    return git(args, true);
  } catch {
    return undefined;
  }
}

const flag = process.argv.indexOf('--base');
const candidate = flag === -1 ? process.env['RATCHET_BASE'] : process.argv[flag + 1];
const base = resolveBase(candidate, {
  hasCommit: (sha) => tryGit(['cat-file', '-e', `${sha}^{commit}`]) !== undefined,
  firstParent: () => tryGit(['rev-parse', '--verify', 'HEAD^'])?.trim() || undefined,
});
if (base.notice !== undefined)
  console.log(`${base.kind === 'none' ? '::notice::' : '::warning::'}${base.notice}`);
if (base.kind === 'none') process.exit(0);

// The file at the base, or undefined when the base has no such path; any other git error throws.
const baseFile = (path: string): string | undefined =>
  git(['ls-tree', '--name-only', base.sha, '--', path]).trim() === ''
    ? undefined
    : git(['show', `${base.sha}:${path}`]);

// The committed slug list, plus slugs of any card names added since it was generated, so a new
// fixture cannot open a gap before the list is regenerated.
const committed = JSON.parse(readFileSync(SLUG_FILE, 'utf8')) as SlugFile;
const current = slugTable(collectCardNames(process.cwd()));
const missing = Object.keys(current).filter((slug) => !Object.hasOwn(committed.slugs, slug));
const warnings: string[] = [];
if (missing.length > 0)
  warnings.push(
    `${SLUG_FILE} is stale (${missing.length} slugs missing, e.g. ${missing.slice(0, 3).join(', ')}); run \`bun run card-slugs:generate\`.`,
  );

const headSource = readFileSync(ABILITY_SOURCE, 'utf8');
const baseSource = baseFile(ABILITY_SOURCE);
const ops = checkCardNamedOps({
  baseOps: baseSource === undefined ? undefined : effectOps(ABILITY_SOURCE, baseSource),
  headOps: effectOps(ABILITY_SOURCE, headSource),
  slugs: { ...committed.slugs, ...current },
});
const manifest = checkNotExecutableInCi({
  baseManifest: baseFile(MANIFEST),
  headManifest: readFileSync(MANIFEST, 'utf8'),
});

// Test files changed against the base, renames compared with their old version.
const changedTests: ChangedTestFile[] = git([
  'diff',
  '--name-status',
  '-M',
  '--diff-filter=AMR',
  base.sha,
  'HEAD',
])
  .split('\n')
  .map((line) => line.split('\t'))
  .filter((parts) => parts.length >= 2)
  .map((parts) => {
    const status = parts[0]!;
    const path = parts[parts.length - 1]!;
    const oldPath = status.startsWith('R') ? parts[1]! : path;
    return { status, path, oldPath };
  })
  .filter(({ path }) => /\.(test|spec)\.ts$/.test(path) || /^packages\/[^/]+\/tests\//.test(path))
  .map(({ status, path, oldPath }) => ({
    path,
    base: status === 'A' ? undefined : baseFile(oldPath),
    head: readFileSync(path, 'utf8'),
  }));
const pumps = strictPumpErrors(changedTests);

warnings.push(...ops.warnings);
for (const warning of warnings) console.log(`::warning::${warning}`);
const errors = [...ops.errors, ...manifest.errors, ...pumps];
if (errors.length > 0) {
  for (const error of errors) console.error(`::error::${error}`);
  console.error(`Ratchets failed (${errors.length}) against base ${base.sha}.`);
  process.exit(1);
}
console.log(`card-named Effect ops: ${ops.cardNamed.join(', ')}`);
console.log(
  `ratchets ok against ${base.sha.slice(0, 12)}: ${ops.cardNamed.length} card-named Effect ops (may not grow), ${manifest.count} notExecutableInCi IDs (may not grow), ${changedTests.length} changed test files with no guessing pump() call`,
);
