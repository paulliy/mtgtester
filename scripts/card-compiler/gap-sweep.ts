/**
 * Gap sweep (issue #95, section 1): lists every promoted compiled card whose patch uses an IR shape
 * a known engine gap or a known misreading makes wrong, and every compiled card whose Oracle text
 * and IR disagree on a facet (ADR 0034 decision 6).
 *
 * It reads the patches and changes nothing. A flagged card is a lead for review, not a verdict: a
 * detector matches the shape, and whether the card's own Oracle text needs the broken behavior is
 * the reviewer's call. Each detector is calibrated against the retired patches it was written from
 * (`docs/reviews/compiled-card-retired.json`); the report prints its recall there, so a detector that
 * misses its own examples shows up immediately.
 *
 *   bun run scripts/card-compiler/gap-sweep.ts [--json out.json] [--markdown out.md]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { facetMismatches, type FacetMismatch } from '../../packages/engine/src/cards/facets';
import { compiledCards } from '../../packages/engine/src/cards/overrides/compiled/register';
import { withPatch } from './lib';
import { DETECTORS as ALL_DETECTORS } from './known-gaps';

/** A patch's IR, read as plain JSON. */
type Json = unknown;

// A closed gap no longer makes its shape wrong, so the sweep reports open ones only.
const DETECTORS = ALL_DETECTORS.filter((detector) => detector.open);

interface Flag {
  name: string;
  oracleId: string;
  rank: number;
  batch: string;
  detectors: string[];
  facets: FacetMismatch[];
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const pinned = new Map<string, { rank: number; card: OracleCard }>(
  (
    JSON.parse(readFileSync('packages/server/fixtures/edhrec-pinned-oracle.json', 'utf8')) as {
      rank: number;
      card: OracleCard;
    }[]
  ).map((row) => [row.card.oracleId, row]),
);
const lineText = (lines: readonly string[]): string => lines.join('\n');

// Calibration: each detector against the retired patches it was written from.
const patches = new Map<string, { def: Json; handledLines: string[] }>();
for (const dir of readdirSync('docs/reviews').filter((d) => d.startsWith('card-compiler-trial'))) {
  let files: string[] = [];
  try {
    files = readdirSync(`docs/reviews/${dir}/patches`);
  } catch {
    continue;
  }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const patch = JSON.parse(readFileSync(`docs/reviews/${dir}/patches/${file}`, 'utf8')) as {
      oracleId?: string;
      def: Json;
      handledLines: string[];
    };
    if (patch.oracleId !== undefined) patches.set(patch.oracleId, patch);
  }
}
const retired = (
  JSON.parse(readFileSync('docs/reviews/compiled-card-retired.json', 'utf8')) as {
    retired: { name: string; oracleId: string; reason: string }[];
  }
).retired;
const retiredByName = new Map(retired.map((r) => [r.name, r]));
const calibration = DETECTORS.map((detector) => {
  const missed = detector.examples.filter((name) => {
    const entry = retiredByName.get(name);
    const patch = entry && patches.get(entry.oracleId);
    const typeLine = (entry && pinned.get(entry.oracleId)?.card.typeLine) ?? '';
    return !patch || !detector.matches(patch.def, lineText(patch.handledLines), typeLine);
  });
  return { id: detector.id, examples: detector.examples.length, missed };
});

// Facet recall on the retired wrong patches (grammar supersessions excluded).
let wrongRetired = 0;
let facetCaught = 0;
for (const entry of retired) {
  if (/now parses/.test(entry.reason)) continue;
  const patch = patches.get(entry.oracleId);
  const pin = pinned.get(entry.oracleId);
  if (!patch || !pin) continue;
  wrongRetired++;
  const mismatches = withPatch(
    {
      oracleId: entry.oracleId,
      name: entry.name,
      lines: patch.handledLines,
      card: pin.card,
    } as Parameters<typeof withPatch>[0],
    patch.def as never,
    () => facetMismatches(pin.card, interpretCard(pin.card)),
  );
  if (mismatches.length > 0) facetCaught++;
}

// The sweep.
const flags: Flag[] = [];
const compiled = compiledCards();
for (const [oracleId, card] of compiled) {
  const pin = pinned.get(oracleId);
  if (!pin) throw new Error(`compiled card ${card.name} has no pinned Oracle entry`);
  const text = lineText(card.handledLines);
  const detectors = DETECTORS.filter((d) => d.matches(card.def, text, pin.card.typeLine)).map(
    (d) => d.id,
  );
  const facets = facetMismatches(pin.card, interpretCard(pin.card));
  if (detectors.length > 0 || facets.length > 0)
    flags.push({ name: card.name, oracleId, rank: pin.rank, batch: card.batch, detectors, facets });
}
flags.sort((a, b) => b.detectors.length - a.detectors.length || a.rank - b.rank);

const byDetector = DETECTORS.map((d) => ({
  ...d,
  cards: flags.filter((f) => f.detectors.includes(d.id)),
}));
const shapeFlagged = flags.filter((f) => f.detectors.length > 0);
const facetOnly = flags.filter((f) => f.detectors.length === 0);

const summary = {
  compiled: compiled.size,
  shapeFlagged: shapeFlagged.length,
  facetOnly: facetOnly.length,
  facetRecallOnRetired: `${facetCaught}/${wrongRetired}`,
  calibration,
};
console.log(JSON.stringify(summary, null, 2));
for (const d of byDetector) console.log(`${d.id.padEnd(34)} ${d.cards.length}`);

const jsonPath = option('--json');
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ summary, flags }, null, 2)}\n`);

const mdPath = option('--markdown');
if (mdPath) {
  const facetText = (f: FacetMismatch): string => `${f.facet} (text ${f.text}, IR ${f.ir})`;
  const lines: string[] = [];
  lines.push('## Shape detectors', '');
  for (const d of byDetector) {
    const cal = calibration.find((c) => c.id === d.id)!;
    lines.push(
      `### \`${d.id}\` — ${d.cards.length} live card${d.cards.length === 1 ? '' : 's'}`,
      '',
      d.gap,
      '',
      `Calibration: ${cal.examples - cal.missed.length}/${cal.examples} retired examples matched${
        cal.missed.length > 0 ? ` (missed: ${cal.missed.join(', ')})` : ''
      }.`,
      '',
    );
    for (const card of d.cards)
      lines.push(
        `- ${card.name} (rank ${card.rank}, ${card.batch})${
          card.facets.length > 0 ? ` — also facets: ${card.facets.map(facetText).join(', ')}` : ''
        }`,
      );
    if (d.cards.length > 0) lines.push('');
  }
  lines.push(
    '## Facet mismatches only',
    '',
    `${facetOnly.length} cards. Weak signal: the facet counter matched ${facetCaught} of ${wrongRetired} known-wrong retired patches, so most of these are expected to be modeling choices.`,
    '',
  );
  for (const card of [...facetOnly].sort((a, b) => a.rank - b.rank))
    lines.push(`- ${card.name} (rank ${card.rank}): ${card.facets.map(facetText).join(', ')}`);
  writeFileSync(mdPath, `${lines.join('\n')}\n`);
}
