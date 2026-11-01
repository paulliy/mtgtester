import { createHash } from 'node:crypto';
import { oracle } from '../../../engine/tests/fixtures';
import { sha256 } from '../benchmark/hash';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseReviewManifest,
  oraclePinMatches,
  primitiveReviewPromotions,
  type ReviewDeclaration,
} from '../../../../scripts/contracts/primitive-promotions';

const id = 'ceca9ae4-c9ba-4018-b5f2-1288fe8792af';
const declaration: ReviewDeclaration = {
  name: 'Boundary unit fixture',
  oracleSha256: 'a'.repeat(64),
  implementationStatus: 'implemented-reviewed',
};
const manifest = (cards: Record<string, ReviewDeclaration>) => ({
  schemaVersion: 1 as const,
  cards,
});

describe('primitive promotion requirements (declarations are not execution evidence)', () => {
  it('binds both established pin encodings to the complete Oracle projection', () => {
    const card = oracle({
      name: 'Pin boundary unit fixture',
      typeLine: 'Sorcery',
      oracleText: 'You gain 3 life.',
    });
    for (const digest of [
      sha256(card),
      createHash('sha256').update(JSON.stringify(card)).digest('hex'),
    ]) {
      expect(oraclePinMatches(card, digest)).toBe(true);
      expect(oraclePinMatches({ ...card, oracleText: 'You gain 4 life.' }, digest)).toBe(false);
      expect(oraclePinMatches({ ...card, manaCost: '{1}{G}' }, digest)).toBe(false);
    }
    expect(oraclePinMatches(card, '0'.repeat(64))).toBe(false);
  });

  it('parses the complete committed manifest without granting current primitive proof', () => {
    const current = parseReviewManifest(
      readFileSync('packages/server/fixtures/card-verification-manifest.json', 'utf8'),
    );
    expect(primitiveReviewPromotions(current, current)).toEqual([]);
    expect(
      Object.values(current.cards).some(
        (card) => card.implementationStatus === 'implemented-reviewed',
      ),
    ).toBe(true);
  });
  it.each([
    'new',
    'previouslyUnreviewed',
    'previouslyUnsupported',
    'oracleChanged',
    'nameChanged',
    'requirementsChanged',
  ] as const)('requires new proof for %s reviewed declarations', (variant) => {
    const previous = variant === 'new' ? manifest({}) : manifest({ [id]: { ...declaration } });
    if (variant === 'previouslyUnreviewed')
      previous.cards[id]!.implementationStatus = 'implemented-unreviewed';
    if (variant === 'previouslyUnsupported')
      previous.cards[id]!.implementationStatus = 'unsupported';
    if (variant === 'oracleChanged') previous.cards[id]!.oracleSha256 = 'b'.repeat(64);
    if (variant === 'nameChanged') previous.cards[id]!.name = 'Old name';
    const current = manifest({
      [id]: {
        ...declaration,
        ...(variant === 'requirementsChanged'
          ? { clauses: [{ oracleText: 'Changed requirement' }] }
          : {}),
      },
    });
    expect(primitiveReviewPromotions(previous, current)).toEqual([id]);
  });
  it('does not treat re-pointed evidence references as a promotion', () => {
    // Manifest entries carry more than the declaration's typed fields.
    const entry = (fields: Record<string, unknown>) =>
      ({ ...declaration, ...fields }) as ReviewDeclaration;
    const clause = { oracleText: 'You gain 3 life.', implementation: ['gainLife 3'] };
    const previous = manifest({
      [id]: entry({ clauses: [{ ...clause, engineTestIds: ['old-test'] }] }),
    });
    const current = manifest({
      [id]: entry({
        clauses: [
          {
            ...clause,
            engineTestIds: ['renamed-test', 'new-test'],
            viewerScenarioIds: ['scenario'],
            contractTestIds: ['contract'],
          },
        ],
        engineTestIds: ['card-test'],
        equivalentMutants: [{ mutant: 'm', reason: 'r' }],
      }),
    });
    expect(primitiveReviewPromotions(previous, current)).toEqual([]);
    // A changed clause requirement alongside them is still a promotion.
    current.cards[id] = entry({ clauses: [{ ...clause, implementation: ['gainLife 4'] }] });
    expect(primitiveReviewPromotions(previous, current)).toEqual([id]);
  });
  it('ignores property order while retaining additional clause requirements', () => {
    const previous = manifest({ [id]: { ...declaration } });
    const current = manifest({
      [id]: {
        implementationStatus: declaration.implementationStatus,
        oracleSha256: declaration.oracleSha256,
        name: declaration.name,
      },
    });
    expect(primitiveReviewPromotions(previous, current)).toEqual([]);
  });
  it.each(['implemented-unreviewed', 'unsupported'] as const)(
    'does not treat %s as a promotion',
    (implementationStatus) => {
      expect(
        primitiveReviewPromotions(
          manifest({}),
          manifest({ [id]: { ...declaration, implementationStatus } }),
        ),
      ).toEqual([]);
    },
  );
  it.each([
    'badVersion',
    'badIdentity',
    'badHash',
    'badStatus',
    'missingName',
    'duplicateKey',
    'arrayCards',
  ] as const)('rejects malformed review input: %s', (variant) => {
    const input = manifest({ [id]: { ...declaration } }) as unknown as Record<string, unknown>;
    const card = (input['cards'] as Record<string, Record<string, unknown>>)[id]!;
    if (variant === 'badVersion') input['schemaVersion'] = 2;
    if (variant === 'badIdentity') input['cards'] = { 'fixture-alias': card };
    if (variant === 'badHash') card['oracleSha256'] = 'unknown';
    if (variant === 'badStatus') card['implementationStatus'] = 'engine-proven';
    if (variant === 'missingName') delete card['name'];
    if (variant === 'arrayCards') input['cards'] = [];
    const bytes =
      variant === 'duplicateKey'
        ? JSON.stringify(input).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')
        : JSON.stringify(input);
    expect(() => parseReviewManifest(bytes)).toThrow();
  });
});
