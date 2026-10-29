/**
 * Forge's card scripts are GPL-3.0 and this repository is not, so no script line may be committed
 * (ADR 0033 decision 7). A script line starts `A:`, `T:`, `S:`, `R:` or `SVar:<name>:`, then
 * `SP$`, `AB$`, `DB$`, `Mode$` or `Event$` and a `|`-separated parameter list. Retyping a script
 * by hand in other words is not caught here; the card modeling guide states that rule.
 */
const FORGE_LINE = /^(?:[ATSR]|SVar:[^:\n]+):\s*(?:SP|AB|DB|Mode|Event)\$[^\n]*\|/m;

export function forgeScriptLines(text: string): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (FORGE_LINE.test(line.trimStart())) lines.push(index + 1);
  });
  return lines;
}

/** Tracked files other than docs and this check whose text holds a Forge script line. */
export function forgeTextErrors(
  files: readonly string[],
  read: (path: string) => string,
): string[] {
  const errors: string[] = [];
  for (const file of files) {
    if (file.startsWith('docs/') || file === 'scripts/contracts/forge-text.ts') continue;
    if (!/\.(?:ts|tsx|js|mjs|vue|json|md|txt|ya?ml)$/.test(file)) continue;
    for (const line of forgeScriptLines(read(file)))
      errors.push(
        `${file}:${line}: a Forge script line; Forge scripts are a reference, never committed`,
      );
  }
  return errors;
}
