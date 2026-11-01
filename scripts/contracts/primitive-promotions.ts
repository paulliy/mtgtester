import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { parseEvidenceJson } from '../card-evidence-input';
import { canonicalJson, sha256 } from '../../packages/server/src/benchmark/hash';
import {
  requireReviewedPrimitiveEligibility,
  validateCurrentPrimitiveEvidence,
  type PrimitiveEvidence,
} from './primitive-evidence';

/** Existing pins use canonical key order; projection captures also retain their original order. */
export function oraclePinMatches(card: OracleCard, expected: string): boolean {
  return (
    sha256(card) === expected ||
    createHash('sha256').update(JSON.stringify(card)).digest('hex') === expected
  );
}

export interface ReviewDeclaration {
  name: string;
  oracleSha256: string;
  implementationStatus: 'unsupported' | 'implemented-unreviewed' | 'implemented-reviewed';
}
export interface ReviewManifest {
  schemaVersion: 1;
  cards: Record<string, ReviewDeclaration>;
}

/** Input declarations describe review requirements, never primitive execution results. */
export function parseReviewManifest(bytes: string): ReviewManifest {
  const value = parseEvidenceJson(bytes);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Primitive promotion: manifest must be an object');
  const manifest = value as Record<string, unknown>;
  if (
    manifest['schemaVersion'] !== 1 ||
    manifest['cards'] === null ||
    typeof manifest['cards'] !== 'object' ||
    Array.isArray(manifest['cards'])
  )
    throw new Error('Primitive promotion: manifest schema');
  for (const [id, value] of Object.entries(manifest['cards'])) {
    if (
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ||
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      throw new Error('Primitive promotion: card identity');
    const card = value as Record<string, unknown>;
    if (
      typeof card['name'] !== 'string' ||
      !card['name'].trim() ||
      typeof card['oracleSha256'] !== 'string' ||
      !/^[\da-f]{64}$/.test(card['oracleSha256']) ||
      !['unsupported', 'implemented-unreviewed', 'implemented-reviewed'].includes(
        card['implementationStatus'] as string,
      )
    )
      throw new Error(`Primitive promotion: declaration schema for ${id}`);
  }
  return value as ReviewManifest;
}

/**
 * Fields that point at evidence rather than state what is claimed: test and scenario IDs and the
 * equivalent-mutant records. Other checks hold them to the evidence (`check:manifest-tests`
 * resolves every ID, `mutate-cards` replays each mutant), and card and viewer evidence is not
 * this gate's scope, so re-pointing them is not a new review claim.
 */
const EVIDENCE_REFERENCE_FIELDS = new Set([
  'engineTestIds',
  'viewerScenarioIds',
  'gameplayAiScenarioIds',
  'equivalentMutants',
]);
const CLAUSE_EVIDENCE_REFERENCE_FIELDS = new Set([
  'engineTestIds',
  'engineTestSource',
  'viewerScenarioIds',
  'contractTestIds',
]);

/** The review claim a declaration makes: everything but its evidence references. */
function reviewClaim(card: ReviewDeclaration | undefined): unknown {
  if (card === undefined) return undefined;
  const entries = Object.entries(card as unknown as Record<string, unknown>).filter(
    ([key]) => !EVIDENCE_REFERENCE_FIELDS.has(key),
  );
  return Object.fromEntries(
    entries.map(([key, value]) =>
      key === 'clauses' && Array.isArray(value)
        ? [
            key,
            value.map((clause: unknown) =>
              clause !== null && typeof clause === 'object' && !Array.isArray(clause)
                ? Object.fromEntries(
                    Object.entries(clause).filter(
                      ([field]) => !CLAUSE_EVIDENCE_REFERENCE_FIELDS.has(field),
                    ),
                  )
                : clause,
            ),
          ]
        : [key, value],
    ),
  );
}

/** Unchanged historical declarations confer no current primitive certification. */
export function primitiveReviewPromotions(
  previous: ReviewManifest,
  current: ReviewManifest,
): string[] {
  return Object.entries(current.cards)
    .filter(
      ([id, card]) =>
        card.implementationStatus === 'implemented-reviewed' &&
        canonicalJson(reviewClaim(previous.cards[id])) !== canonicalJson(reviewClaim(card)),
    )
    .map(([id]) => id)
    .sort();
}

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Primitive promotion: fixture symlink');
      return entry.isDirectory()
        ? jsonFiles(path)
        : entry.isFile() && entry.name.endsWith('.json')
          ? [path]
          : [];
    })
    .sort();
}

/** Resolve every promoted claim to exact committed Oracle bytes before interpreting final IR. */
export function verifyPrimitiveReviewPromotions(
  repoRoot: string,
  current: ReviewManifest,
  promotedIds: readonly string[],
  evidence: PrimitiveEvidence,
): void {
  validateCurrentPrimitiveEvidence(evidence, repoRoot);
  const inputs = new Map<string, string>();
  const pins = new Map<string, OracleCard>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record['oracleId'] === 'string' && typeof record['oracleText'] === 'string') {
      const id = record['oracleId'];
      const declaration = current.cards[id];
      if (!promotedIds.includes(id) || !declaration) return;
      if (
        oraclePinMatches(value as OracleCard, declaration.oracleSha256) &&
        record['name'] === declaration.name
      )
        pins.set(id, value as OracleCard);
      return;
    }
    Object.values(record).forEach(collect);
  }
  if (promotedIds.length > 0) {
    for (const directory of ['packages/engine/tests/fixtures', 'packages/server/fixtures'])
      for (const path of jsonFiles(join(repoRoot, directory))) {
        const bytes = readFileSync(path, 'utf8');
        inputs.set(path, bytes);
        collect(parseEvidenceJson(bytes));
      }
  }
  const consumers = promotedIds.map((id) => {
    const card = pins.get(id);
    if (!card) throw new Error(`Primitive promotion: no exact committed Oracle pin for ${id}`);
    return { canonicalOracleId: id, definition: interpretCard(card) };
  });
  requireReviewedPrimitiveEligibility(consumers, promotedIds, evidence);
  for (const [path, bytes] of inputs)
    if (readFileSync(path, 'utf8') !== bytes)
      throw new Error('Primitive promotion: fixture bytes changed');
  validateCurrentPrimitiveEvidence(evidence, repoRoot);
}
