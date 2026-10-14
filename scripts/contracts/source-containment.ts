import { isAbsolute, relative, sep, type posix } from 'node:path';

/** Inputs must already have been canonicalized with realpath by the caller. */
export function isPathWithinRoot(
  root: string,
  source: string,
  paths: Pick<typeof posix, 'relative' | 'isAbsolute' | 'sep'> = { relative, isAbsolute, sep },
): boolean {
  const local = paths.relative(root, source);
  return (
    local !== '' &&
    local !== '..' &&
    !local.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(local)
  );
}
