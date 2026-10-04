import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

function inside(base: string, target: string): boolean {
  const part = relative(base, target);
  return (
    part === '' ||
    (part !== '..' && !part.startsWith(`..\\`) && !part.startsWith('../') && !isAbsolute(part))
  );
}

/** Lexical containment plus realpath containment of the nearest existing ancestor. */
export function confinedBenchmarkPath(
  repositoryRoot: string,
  value: string,
  area: 'benchmarks' | 'suites' | 'variants',
  options: { origin?: string; relativeOnly?: boolean } = {},
): string {
  const base = resolve(repositoryRoot, 'benchmarks', ...(area === 'benchmarks' ? [] : [area]));
  if (options.relativeOnly && isAbsolute(value))
    throw new Error(`absolute benchmark path rejected: ${value}`);
  const target = resolve(options.origin ?? repositoryRoot, value);
  if (!inside(base, target)) throw new Error(`benchmark path escapes ${base}: ${value}`);
  let ancestor = target;
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`benchmark path has no existing ancestor: ${value}`);
    ancestor = parent;
  }
  const realBase = realpathSync(base);
  const realRoot = realpathSync(repositoryRoot);
  const realBenchmarks = realpathSync(resolve(repositoryRoot, 'benchmarks'));
  if (!inside(realRoot, realBenchmarks) || !inside(realBenchmarks, realBase)) {
    throw new Error(`benchmark symlink path escapes repository: ${value}`);
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(ancestor);
  } catch {
    throw new Error(`benchmark symlink path cannot be resolved: ${value}`);
  }
  if (!inside(realBase, realAncestor))
    throw new Error(`benchmark symlink path escapes ${realBase}: ${value}`);
  return target;
}
