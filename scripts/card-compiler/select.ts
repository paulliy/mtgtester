/**
 * Pick a trial set: unmodeled EDHREC cards whose only blockers are unparsed rules lines.
 *
 *   bun run scripts/card-compiler/select.ts --out <dir> [--count 50] [--max-lines 1]
 *        [--xmage <rows.json>] [--xmage-share 0.6]
 *
 * Cards are spread evenly across the EDHREC rank order so the trial is not all staples or all
 * long tail. With `--xmage` (the XMage scan's rows.json), `--xmage-share` of the set is drawn from
 * cards XMage builds only from library classes already used by cards we model, so the compiler's
 * results can be compared card for card with a translator working from XMage.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileTarget, pinnedPool, type CompileTarget } from './lib';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

const out = arg('out');
if (out === undefined) throw new Error('--out <dir> is required');
const count = Number(arg('count') ?? 50);
const maxLines = Number(arg('max-lines') ?? 1);
const xmagePath = arg('xmage');
const xmageShare = Number(arg('xmage-share') ?? 0.6);

const candidates: CompileTarget[] = [];
for (const row of pinnedPool()) {
  if (row.card.layout !== 'normal') continue;
  const target = compileTarget(row);
  if (target === null || target.lines.length === 0 || target.lines.length > maxLines) continue;
  candidates.push(target);
}
candidates.sort((a, b) => a.rank - b.rank);

/** `n` cards spread evenly over `pool` (already in rank order). */
function spread(pool: CompileTarget[], n: number): CompileTarget[] {
  if (pool.length <= n) return pool;
  return Array.from(
    { length: n },
    (_, index) => pool[Math.floor(((index + 0.5) * pool.length) / n)]!,
  );
}

interface XmageRow {
  name: string;
  status: string;
  found: boolean;
  shared_only: boolean;
  imports: string[];
}
let picked: (CompileTarget & { xmageBucket?: string })[];
if (xmagePath === undefined) {
  picked = spread(candidates, count);
} else {
  const rows = JSON.parse(readFileSync(xmagePath, 'utf8')) as XmageRow[];
  const known = new Set(
    rows.filter((row) => row.found && row.status === 'modeled').flatMap((row) => row.imports),
  );
  const bucketOf = new Map<string, string>();
  for (const row of rows) {
    if (!row.found) bucketOf.set(row.name, 'xmage-missing');
    else if (!row.shared_only) bucketOf.set(row.name, 'xmage-custom-classes');
    else if (row.imports.every((name) => known.has(name)))
      bucketOf.set(row.name, 'xmage-known-classes');
    else bucketOf.set(row.name, 'xmage-new-shared-classes');
  }
  const tagged = candidates.map((target) => ({
    ...target,
    xmageBucket: bucketOf.get(target.name) ?? 'not-in-scan',
  }));
  const inKnown = tagged.filter((target) => target.xmageBucket === 'xmage-known-classes');
  const rest = tagged.filter((target) => target.xmageBucket !== 'xmage-known-classes');
  const fromKnown = Math.round(count * xmageShare);
  picked = [...spread(inKnown, fromKnown), ...spread(rest, count - fromKnown)].sort(
    (a, b) => a.rank - b.rank,
  );
}

mkdirSync(out, { recursive: true });
writeFileSync(
  `${out}/targets.json`,
  `${JSON.stringify(
    picked.map((target) => ({
      name: target.name,
      rank: target.rank,
      lines: target.lines,
      ...('xmageBucket' in target ? { xmageBucket: target.xmageBucket } : {}),
    })),
    null,
    2,
  )}\n`,
);
console.log(
  `${candidates.length} candidates; wrote ${picked.length} targets to ${out}/targets.json`,
);
