/**
 * The cards whose definition snapshot entry changed against a base commit: `mutate-cards
 * --changed` mutates them and the card gate prints their facet warnings.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cardNames } from '../contracts/manifest-tests';
import { snapshotChanges } from './card-finish';

const SNAPSHOTS = [
  'packages/engine/tests/fixtures/interpret-defs.json',
  'packages/engine/tests/fixtures/override-defs.json',
];

const gitIn = (cwd: string | undefined, ...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...(cwd ? { cwd } : {}) });
const git = (...args: string[]) => gitIn(undefined, ...args);

/** The commit `ref` names, or undefined when it names none (or only the all-zero null SHA). */
function resolveCommit(ref: string, cwd?: string): string | undefined {
  try {
    const sha = gitIn(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim();
    return /^0+$/.test(sha) ? undefined : sha;
  } catch {
    return undefined;
  }
}

/**
 * The commit `candidate` (a pull request's base: a SHA or any ref) names. With no candidate, or an
 * all-zero one (a push to a new branch), HEAD's first parent; a candidate that names no commit is
 * an error rather than a silent switch to another base.
 */
export function baseCommit(
  candidate: string | undefined,
  /** The repository to resolve in; the current directory's by default. */
  cwd?: string,
): string {
  const value = candidate?.trim() ?? '';
  if (value === '' || /^0+$/.test(value)) return gitIn(cwd, 'rev-parse', 'HEAD^').trim();
  const sha = resolveCommit(value, cwd);
  if (sha === undefined) throw new Error(`--base ${value} does not name a commit in this clone`);
  return sha;
}

/** Of `cards`, those with a snapshot entry added or changed since `base`. */
export function changedCards(base: string, cards: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const path of SNAPSHOTS) {
    let before = '[]';
    try {
      before = git('show', `${base}:${path}`);
    } catch {
      // A snapshot the base does not have: every entry is new.
    }
    for (const change of snapshotChanges(before, readFileSync(path, 'utf8')))
      if (change.kind !== 'removed') names.add(change.name);
  }
  // A face's entry ("Web Shot") is its card's ("Ettercap // Web Shot").
  const cardOf = new Map<string, string>();
  for (const name of cards)
    for (const face of cardNames(name)) if (!cardOf.has(face)) cardOf.set(face, name);
  return [...new Set([...names].flatMap((name) => cardOf.get(name) ?? []))].sort();
}
