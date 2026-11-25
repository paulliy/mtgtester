import { describe, expect, it } from 'vitest';
import type { CardTestScenarioMetadata } from '@mtg/shared';
import { listCardTestScenarios } from './card-test-scenarios';
import { catalogAudit, type AuditEntry, type CatalogAudit } from './card-report';
import { buildCardTestLabCards, loadLabManifest, type LabManifest } from './card-test-lab-cards';

const scenario = (id: string, sha: string, clauseIds: string[]): CardTestScenarioMetadata => ({
  id,
  version: 1,
  title: `Bear: ${id}`,
  instructions: [],
  expectedOutcome: '',
  oracleSha256: sha,
  clauseIds,
});
const ledger = (...entries: AuditEntry[]): CatalogAudit =>
  new Map(entries.map((entry) => [entry.oracleId, entry]));

const manifest: LabManifest = {
  'oid-1': {
    name: 'Bear',
    oracleSha256: 'aaa',
    implementationStatus: 'implemented-unreviewed',
    clauses: [
      { id: 'bear-attack', oracleText: 'Attack.', implementation: ['p'], engineTestIds: ['t1'] },
      { oracleText: 'Flying', viewerScenarioIds: ['s-fly'] },
      { id: 'bear-gap', oracleText: 'Gap clause.' },
    ],
    gameplayAiScenarioIds: ['s-fly'],
  },
  'oid-2': {
    name: 'Banned Thing',
    oracleSha256: 'bbb',
    implementationStatus: 'unsupported',
    unsupportedReason: 'Not modeled.',
    clauses: [{ id: 'banned-1', oracleText: 'Do a thing.' }],
  },
};

describe('card test lab cards', () => {
  it('lists every manifest clause, ties scenarios by clause id or viewer id, and shows gaps', () => {
    const [card] = buildCardTestLabCards(
      [
        scenario('s-attack', 'aaa', ['bear-attack']),
        scenario('s-fly', 'aaa', ['other']),
        scenario('s-stray', 'aaa', ['nowhere']),
      ],
      manifest,
      ledger({
        oracleId: 'oid-1',
        name: 'Bear',
        oracleSha256: 'aaa',
        implementationStatus: 'implemented-reviewed',
        engineEvidence: 'engine-tests',
        viewerEvidence: 'playwright',
        gameplayAiEvidence: 'not-evaluated',
        evidenceNote: 'note',
        viewerScenarioId: 's-fly',
      }),
    );
    expect(card!.name).toBe('Bear');
    expect(card!.manifestPinned).toBe(true);
    expect(card!.clauses.map((c) => c.scenarioIds)).toEqual([['s-attack'], ['s-fly'], []]);
    expect(card!.clauses[0]).toMatchObject({ id: 'bear-attack', engineTestIds: ['t1'] });
    expect(card!.unmappedScenarioIds).toEqual(['s-stray']);
    expect(card!.gameplayAiScenarioIds).toEqual(['s-fly']);
    expect(card!.audit).toBe('current');
    expect(card!.ledger).toEqual({
      engine: 'engine-tests',
      viewer: 'playwright',
      gameplayAi: 'not-evaluated',
      note: 'note',
      viewerScenarioId: 's-fly',
    });
  });

  it('carries the unsupported reason and leaves absent fields out', () => {
    const [card] = buildCardTestLabCards([scenario('s-b', 'bbb', ['banned-1'])], manifest, null);
    expect(card).toMatchObject({
      implementationStatus: 'unsupported',
      unsupportedReason: 'Not modeled.',
      audit: 'absent',
    });
    expect(card).not.toHaveProperty('ledger');
  });

  it('marks a ledger entry pinned to another hash stale and does not use its evidence', () => {
    const [card] = buildCardTestLabCards(
      [scenario('s', 'aaa', [])],
      manifest,
      ledger({
        oracleId: 'oid-1',
        name: 'Bear',
        oracleSha256: 'old',
        implementationStatus: 'implemented-reviewed',
        engineEvidence: 'engine-tests',
      }),
    );
    expect(card!.audit).toBe('stale');
    expect(card).not.toHaveProperty('ledger');
  });

  it('does not use a ledger entry with no hash, and keys an unpinned manifest by ledger hash', () => {
    const [noHash] = buildCardTestLabCards(
      [scenario('s', 'aaa', [])],
      manifest,
      ledger({ oracleId: 'oid-1', name: 'Bear', implementationStatus: 'x', engineEvidence: 'e' }),
    );
    expect(noHash!.audit).toBe('unpinned');
    expect(noHash).not.toHaveProperty('ledger');

    const [offManifest] = buildCardTestLabCards(
      [scenario('s', 'zzz', [])],
      {},
      ledger({
        oracleId: 'oid-9',
        name: 'Ledger Only',
        oracleSha256: 'zzz',
        implementationStatus: 'implemented-reviewed',
        engineEvidence: 'engine-tests',
      }),
    );
    expect(offManifest).toMatchObject({
      name: 'Ledger Only',
      manifestPinned: false,
      clauses: [],
      unmappedScenarioIds: ['s'],
      audit: 'current',
    });
  });

  it('reads the real files and covers every scenario hash (shape only)', () => {
    const scenarios = listCardTestScenarios();
    const cards = buildCardTestLabCards(scenarios, loadLabManifest(), catalogAudit());
    expect(new Set(cards.map((c) => c.oracleSha256)).size).toBe(cards.length);
    expect(cards.length).toBe(new Set(scenarios.map((s) => s.oracleSha256)).size);
    expect(cards.some((c) => c.manifestPinned && c.clauses.length > 0)).toBe(true);
    expect(cards.some((c) => c.audit === 'current' && c.ledger !== undefined)).toBe(true);
    for (const card of cards) {
      expect(['current', 'stale', 'unpinned', 'absent']).toContain(card.audit);
      if (card.audit !== 'current') expect(card.ledger).toBeUndefined();
    }
  });
});
