/**
 * XMage translation pilot: for every EDHREC card blocked by exactly one rules line, find the
 * XMage ability that implements that line, translate it with the strict adapters, and keep the
 * patch only if the merged card interprets as modeled and passes the authoring validator.
 *
 * Usage: bun run scripts/xmage-import/pilot.ts <xmage-checkout> <out-dir> [--limit 100]
 *
 * The XMage checkout is read as text only (see README.md). Patches are written in the shared
 * patch shape the batch card compiler imports (`run.ts import`), with
 * `source: "xmage@<commit>"`. Nothing is registered with the engine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '../../packages/shared/src';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import {
  getOverride,
  registerOverride,
  unregisterOverride,
  type CardOverride,
} from '../../packages/engine/src/cards/overrides/index';
import {
  validateCardDefinition,
  validateOverrideDefinition,
} from '../../packages/engine/src/cards/authoring-validation';
import { extractCard, type XCard } from './extract';
import { loadXmage, loadXmageCommit, matchAbility } from './lib';
import { translateAbility, Unmapped, type Fragment, type XmageContext } from './adapters';

const [xmage, outDir] = process.argv.slice(2);
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 100;
if (!xmage || !outDir) {
  console.error('usage: pilot.ts <xmage-checkout> <out-dir> [--limit N]');
  process.exit(2);
}

const FIX = 'packages/server/fixtures';
const SOURCE = `xmage@${loadXmageCommit(xmage)}`;

const ix = loadXmage(xmage);
const { lookup, subtypes, staticFilters, tokenSource } = ix;

// ── Our side ─────────────────────────────────────────────────────────────────────────────────

interface TriageRow {
  rank: number;
  name: string;
  decks: number;
  line: string;
  slot: string;
}
const triage: TriageRow[] = JSON.parse(readFileSync(`${FIX}/edhrec-triage.json`, 'utf8'));
const pinned = new Map<string, OracleCard>(
  (
    JSON.parse(readFileSync(`${FIX}/edhrec-pinned-oracle.json`, 'utf8')) as { card: OracleCard }[]
  ).map((r) => [r.card.name, r.card]),
);
const overlapPath =
  process.env['OVERLAP_TARGETS'] ?? 'docs/reviews/card-compiler-trial-01/targets.json';
/** The compiler trial's cards whose XMage classes we already model (its `xmageBucket`). */
const overlap = new Set<string>(
  existsSync(overlapPath)
    ? (JSON.parse(readFileSync(overlapPath, 'utf8')) as { name: string; xmageBucket?: string }[])
        .filter((t) => t.xmageBucket === 'xmage-known-classes')
        .map((t) => t.name)
    : [],
);

function applyPatch(
  card: OracleCard,
  line: string,
  def: Partial<CardDefinition>,
): { ok: boolean; issues: string[] } {
  const override: CardOverride = {
    oracleId: card.oracleId as CardOverride['oracleId'],
    name: card.name,
    handledLines: [line],
    def,
    compose: 'append',
  };
  const early = validateOverrideDefinition(override);
  if (early.length) return { ok: false, issues: early.map((i) => `${i.path}: ${i.message}`) };
  const previous = getOverride(override.oracleId);
  if (previous) unregisterOverride(override.oracleId);
  registerOverride(override);
  try {
    const d = interpretCard(card);
    const issues = d.modeled
      ? validateCardDefinition(d).map((i) => `${i.path}: ${i.message}`)
      : d.unmodeledReasons;
    return { ok: d.modeled && issues.length === 0, issues };
  } catch (e) {
    return { ok: false, issues: [`interpretation threw: ${String(e)}`] };
  } finally {
    unregisterOverride(override.oracleId);
    if (previous) registerOverride(previous);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

type Outcome =
  | 'translated'
  | 'no-xmage-class'
  | 'no-matching-ability'
  | 'unmapped'
  | 'spell-merge'
  | 'invalid'
  | 'not-pinned'
  | 'already-modeled';
interface Result {
  rank: number;
  name: string;
  decks: number;
  line: string;
  xmageClass?: string;
  outcome: Outcome;
  detail?: string;
  overlap: boolean;
}

const results: Result[] = [];
const patches: { slug: string; body: unknown; decks: number; name: string }[] = [];
const cache = new Map<string, XCard>();

for (const row of triage) {
  const base = {
    rank: row.rank,
    name: row.name,
    decks: row.decks,
    line: row.line,
    overlap: overlap.has(row.name),
  };
  const card = pinned.get(row.name);
  if (!card) {
    results.push({ ...base, outcome: 'not-pinned' });
    continue;
  }
  // The triage fixture can lag the parser: skip cards the interpreter now models by itself.
  if (interpretCard(card).modeled) {
    results.push({ ...base, outcome: 'already-modeled' });
    continue;
  }
  const cls = lookup(row.name);
  if (!cls) {
    results.push({ ...base, outcome: 'no-xmage-class' });
    continue;
  }
  let x = cache.get(cls);
  if (!x) {
    const src = ix.cardSource(cls);
    if (!src) {
      results.push({ ...base, xmageClass: cls, outcome: 'no-xmage-class' });
      continue;
    }
    x = extractCard(src);
    cache.set(cls, x);
  }
  const match = matchAbility(x.abilities, row.line, row.name);
  if (!match) {
    results.push({ ...base, xmageClass: cls, outcome: 'no-matching-ability' });
    continue;
  }
  const ctx: XmageContext = { card: x, subtypes, staticFilters, tokenSource };
  let frag: Fragment;
  try {
    frag = translateAbility(match, ctx, row.line);
  } catch (e) {
    if (!(e instanceof Unmapped)) throw e;
    results.push({ ...base, xmageClass: cls, outcome: 'unmapped', detail: e.node });
    continue;
  }
  if (frag.spellAbility) {
    // spellAbility is replaced, not appended, by an override: only safe when the interpreter
    // produced no spell effects of its own from the card's other lines.
    const parsed = interpretCard(card).spellAbility;
    if (parsed && (parsed.effects.length > 0 || parsed.modes)) {
      results.push({
        ...base,
        xmageClass: cls,
        outcome: 'spell-merge',
        detail: 'card has other parsed spell effects',
      });
      continue;
    }
  }
  const check = applyPatch(card, row.line, frag);
  if (!check.ok) {
    results.push({
      ...base,
      xmageClass: cls,
      outcome: 'invalid',
      detail: check.issues.join('; ').slice(0, 300),
    });
    continue;
  }
  results.push({ ...base, xmageClass: cls, outcome: 'translated' });
  const slug = row.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  patches.push({
    slug,
    name: row.name,
    decks: row.decks,
    body: {
      name: row.name,
      oracleId: card.oracleId,
      handledLines: [row.line],
      compose: 'append',
      def: frag,
      source: SOURCE,
      xmageClass: `mage.cards.${cls.replace('/', '.')}`,
    },
  });
}

// Keep the LIMIT most-played translations, plus every overlap card that translated.
patches.sort((a, b) => b.decks - a.decks);
const kept = patches.filter((p, i) => i < LIMIT || overlap.has(p.name));
mkdirSync(join(outDir, 'patches'), { recursive: true });
for (const p of kept)
  writeFileSync(join(outDir, 'patches', `${p.slug}.json`), `${JSON.stringify(p.body, null, 2)}\n`);

const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
const unmapped = new Map<string, number>();
for (const r of results)
  if (r.outcome === 'unmapped') unmapped.set(r.detail!, (unmapped.get(r.detail!) ?? 0) + 1);
const summary = {
  source: SOURCE,
  population: results.length,
  outcomes: Object.fromEntries(
    (
      [
        'translated',
        'unmapped',
        'no-matching-ability',
        'no-xmage-class',
        'spell-merge',
        'invalid',
        'not-pinned',
        'already-modeled',
      ] as Outcome[]
    ).map((o) => [o, count(o)]),
  ),
  keptPatches: kept.length,
  overlap: {
    total: overlap.size,
    translated: results.filter((r) => r.overlap && r.outcome === 'translated').length,
  },
  topUnmapped: [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 40),
};
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
