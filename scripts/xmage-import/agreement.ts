/**
 * Adapter accuracy check: on rules lines that both the Oracle interpreter and the XMage adapters
 * can read, do they produce the same IR?
 *
 * For every pinned EDHREC card and every line of its Oracle text, the line is interpreted alone
 * (a copy of the card carrying only that line, under a fresh oracle id so no authored override
 * applies) and, separately, translated from the matching XMage ability. When both succeed the
 * two fragments are compared after canonicalization (descriptions and token type lines
 * dropped, `allOf`/`anyOf` members sorted). Disagreements are listed for review: each one is an
 * adapter bug, a parser bug, or a real difference between XMage and Oracle text.
 *
 * Usage: bun run scripts/xmage-import/agreement.ts <xmage-checkout> <out-file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { extractCard, type XCard } from './extract';
import { loadXmage, loadXmageCommit, matchAbility } from './lib';
import { translateAbility, Unmapped, type Fragment } from './adapters';

const [xmage, outFile] = process.argv.slice(2);
if (!xmage || !outFile) {
  console.error('usage: agreement.ts <xmage-checkout> <out-file>');
  process.exit(2);
}
const ix = loadXmage(xmage);
const pinned = (
  JSON.parse(readFileSync('packages/server/fixtures/edhrec-pinned-oracle.json', 'utf8')) as {
    card: OracleCard;
  }[]
).map((r) => r.card);

const KEYS = [
  'staticEffects',
  'ruleStatics',
  'spellAbility',
  'activatedAbilities',
  'triggers',
] as const;
const DROP = new Set(['description', 'typeLine']);

const isConst = (v: unknown) =>
  v !== null &&
  typeof v === 'object' &&
  (v as { kind?: string }).kind === 'const' &&
  Object.keys(v).length === 2;

/**
 * "Elves you control": XMage filters Elf *creatures*, the interpreter writes the subtype alone.
 * The two differ only for a noncreature Kindred permanent with that subtype, so they are reported
 * as a separate class rather than as a disagreement.
 */
function dropCreatureNextToSubtype(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropCreatureNextToSubtype);
  if (v === null || typeof v !== 'object') return v;
  const o = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, dropCreatureNextToSubtype(x)]),
  );
  if (o['kind'] === 'allOf' && Array.isArray(o['of'])) {
    const of = o['of'] as { kind: string; value?: string }[];
    if (
      of.some((x) => x.kind === 'subtype') &&
      of.some((x) => x.kind === 'type' && x.value === 'Creature')
    ) {
      const rest = of.filter((x) => !(x.kind === 'type' && x.value === 'Creature'));
      return rest.length === 1 ? rest[0] : { ...o, of: rest };
    }
  }
  return o;
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    if (DROP.has(k)) continue;
    out[k] = canon(o[k]);
  }
  // `count: 1` and `count: {kind:'const', n:1}` are the same value (`Value | number`).
  for (const k of ['count', 'amount']) if (isConst(out[k])) out[k] = (out[k] as { n: number }).n;
  if ((out['kind'] === 'allOf' || out['kind'] === 'anyOf') && Array.isArray(out['of']))
    out['of'] = (out['of'] as unknown[])
      .map((x) => JSON.stringify(x))
      .sort()
      .map((x) => JSON.parse(x) as unknown);
  return out;
}

function pick(def: Partial<Record<(typeof KEYS)[number], unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const v = def[k];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

let compared = 0;
let agree = 0;
let subtypeOnly = 0;
const disagreements: unknown[] = [];
const cache = new Map<string, XCard | null>();
let n = 0;
for (const card of pinned) {
  const cls = ix.lookup(card.name);
  if (!cls) continue;
  if (!cache.has(cls)) {
    const src = ix.cardSource(cls);
    cache.set(cls, src ? extractCard(src) : null);
  }
  const x = cache.get(cls);
  if (!x) continue;
  for (const line of (card.oracleText ?? '').split('\n')) {
    if (!line.trim()) continue;
    const match = matchAbility(x.abilities, line, card.name);
    if (!match) continue;
    let frag: Fragment;
    try {
      frag = translateAbility(
        match,
        {
          card: x,
          subtypes: ix.subtypes,
          staticFilters: ix.staticFilters,
          tokenSource: ix.tokenSource,
        },
        line,
      );
    } catch (e) {
      if (e instanceof Unmapped) continue;
      throw e;
    }
    const probe = interpretCard({
      ...card,
      oracleText: line,
      oracleId: `xmage-agreement-${n++}`,
      keywords: [],
    });
    if (!probe.modeled) continue;
    compared++;
    const a = JSON.stringify(canon(pick(frag)));
    const b = JSON.stringify(canon(pick(probe)));
    if (a === b) agree++;
    else if (
      JSON.stringify(canon(dropCreatureNextToSubtype(JSON.parse(a)))) ===
      JSON.stringify(canon(dropCreatureNextToSubtype(JSON.parse(b))))
    )
      subtypeOnly++;
    else
      disagreements.push({
        name: card.name,
        line,
        xmage: JSON.parse(a) as unknown,
        interpreter: JSON.parse(b) as unknown,
      });
  }
}
const summary = {
  source: `xmage@${loadXmageCommit(xmage)}`,
  compared,
  agree,
  subtypeImpliesCreature: subtypeOnly,
  disagree: compared - agree - subtypeOnly,
};
writeFileSync(outFile, `${JSON.stringify({ summary, disagreements }, null, 2)}\n`);
console.log(JSON.stringify(summary));
