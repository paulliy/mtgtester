import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { AiConfig } from '../ai/config';
import { AI_VERSIONS } from '../ai/versions';
import type { BenchmarkCase, BenchmarkMode, BenchmarkRole } from './contracts';
import { compareCodeUnits, sha256 } from './hash';

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  baselineId: string;
  variantId: string;
  code: { commit: string; dirty: boolean; dirtyPatchHash: string | null };
  hashes: { engine: string; cardDefinitions: string; suite: string; cases: string };
  versions: typeof AI_VERSIONS;
  role: BenchmarkRole;
  mode: BenchmarkMode;
  tacticianPromptVersion: 'legacy-v1' | 'decision-shaped-v2';
  trials: number;
  suiteId: string;
  caseIds: string[];
  effectiveModelConfig: Omit<AiConfig, 'apiKey'>;
  limits: {
    spendCapUsd: number | null;
    maxAttempts: number;
    concurrency: number;
    timeoutMs: number;
  };
}

/**
 * Engine semantics live in TypeScript sources. Compiled output, generated JSON, and scratch notes
 * that happen to sit under the tree are not engine behavior and must not reseal a run. The walk is
 * filesystem-only: real but untracked source such as `testing/candidate-definition.ts` is covered,
 * and the hash stays computable where git is absent.
 */
function sourceFilesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(child);
    return entry.name.endsWith('.ts') ? [child] : [];
  });
}

function treeHash(root: string, path: string): string {
  const entries = sourceFilesUnder(path).map((file) => ({
    // Normalize before sorting, not after: the native separator (0x5C) and '/' (0x2F) order
    // sibling names differently, so a post-sort rewrite would leave a platform-dependent order.
    path: relative(root, file).replaceAll('\\', '/'),
    // A Windows checkout with core.autocrlf=true holds CRLF where CI holds LF. Identical source
    // must produce an identical hash on both.
    content: readFileSync(file, 'utf8').replaceAll('\r\n', '\n'),
  }));
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return sha256(entries);
}

export function benchmarkSourceHashes(repositoryRoot: string): {
  engine: string;
  cardDefinitions: string;
} {
  const root = resolve(repositoryRoot);
  return {
    engine: treeHash(root, join(root, 'packages', 'engine', 'src')),
    cardDefinitions: treeHash(root, join(root, 'packages', 'engine', 'src', 'cards')),
  };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function worktreeIdentity(root: string): { dirty: boolean; patchHash: string | null } {
  const trackedPatch = git(root, ['diff', '--binary', 'HEAD']);
  const untrackedPaths = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((path) => path.length > 0)
    .sort();
  if (trackedPatch.length === 0 && untrackedPaths.length === 0) {
    return { dirty: false, patchHash: null };
  }
  return {
    dirty: true,
    patchHash: sha256({
      trackedPatch,
      untracked: untrackedPaths.map((path) => ({
        path: path.replaceAll('\\', '/'),
        contentBase64: readFileSync(join(root, path)).toString('base64'),
      })),
    }),
  };
}

export function createRunManifest(input: {
  repositoryRoot: string;
  baselineId: string;
  variantId: string;
  role: BenchmarkRole;
  mode: BenchmarkMode;
  trials: number;
  suiteId: string;
  suiteValue: unknown;
  cases: BenchmarkCase[];
  config: AiConfig;
  spendCapUsd: number | null;
  maxAttempts: number;
  concurrency: number;
  timeoutMs: number;
  tacticianPromptVersion?: 'legacy-v1' | 'decision-shaped-v2';
}): RunManifest {
  const root = resolve(input.repositoryRoot);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const worktree = worktreeIdentity(root);
  const { apiKey: _secret, ...effectiveModelConfig } = input.config;
  const createdAt = new Date().toISOString();
  const sourceHashes = benchmarkSourceHashes(root);
  return {
    schemaVersion: 1,
    runId: `${createdAt.replace(/[:.]/g, '-')}-${input.role}-${input.mode}-${input.variantId.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
    createdAt,
    baselineId: input.baselineId,
    variantId: input.variantId,
    code: {
      commit,
      dirty: worktree.dirty,
      dirtyPatchHash: worktree.patchHash,
    },
    hashes: {
      ...sourceHashes,
      suite: sha256(input.suiteValue),
      cases: sha256(input.cases.map((item) => item.contentHash)),
    },
    versions: AI_VERSIONS,
    role: input.role,
    mode: input.mode,
    tacticianPromptVersion: input.tacticianPromptVersion ?? 'decision-shaped-v2',
    trials: input.trials,
    suiteId: input.suiteId,
    caseIds: input.cases.map((item) => item.caseId),
    effectiveModelConfig,
    limits: {
      spendCapUsd: input.spendCapUsd,
      maxAttempts: input.maxAttempts,
      concurrency: input.concurrency,
      timeoutMs: input.timeoutMs,
    },
  };
}

/** Manifests are immutable: an existing run path is never overwritten. */
export function writeManifest(path: string, manifest: RunManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function defaultRunDirectory(root: string, manifest: RunManifest): string {
  return join(root, 'benchmark-output', basename(manifest.runId));
}
