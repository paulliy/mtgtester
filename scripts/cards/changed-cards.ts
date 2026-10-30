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

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/** A commit SHA from `candidate` (a pull request's base), or HEAD's first parent. */
export function baseCommit(candidate: string | undefined): string {
  const value = candidate?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/.test(value) ? value : git('rev-parse', 'HEAD^').trim();
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
