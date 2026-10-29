import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

interface PinnedFixture {
  cards: PinnedCard[];
}

interface ManifestClause {
  id?: string;
  oracleText: string;
  implementation: string[];
  engineTestIds: string[];
  viewerScenarioIds: string[];
}

interface ManifestCard {
  name: string;
  oracleSha256: string;
  implementationStatus: string;
  clauses: ManifestClause[];
  gameplayAiScenarioIds: string[];
}

interface Manifest {
  cards: Record<string, ManifestCard>;
}

const restored = [
  {
    oracleId: 'ab1cc360-b9de-48d9-9983-4dfe4a7d2a37',
    name: 'Arcane Denial',
    sha256: '7d764e957064fa08627fd48a85e1ea9aa50de341ffa09a88c2d36d0598156746',
    clauseCount: 2,
  },
  {
    oracleId: '153376c9-dffd-458c-8ce3-a4c8269bc4e9',
    name: 'Smothering Tithe',
    sha256: '38346bcc71227873ac4c358bd89d277f9d1f94a65e7778392c5e0aefeb7ab2c4',
    clauseCount: 1,
  },
  {
    oracleId: '0c85b8f7-0bd0-4680-9ec5-d4b110460a54',
    name: 'Fabled Passage',
    sha256: 'fd064f3f1c8289f7cd3a05433a31b03a8676ba4ce9035cd6706bd37087c9a7ef',
    clauseCount: 1,
  },
  {
    oracleId: '2549bc57-9ffb-4053-9f10-f2a5f792b845',
    name: 'Myriad Landscape',
    sha256: '696f038611a9d1540a151ab63ccc13e36fd4aa355a54806e741eb6a44f77442b',
    clauseCount: 3,
  },
  {
    oracleId: '71c52bf5-2a5d-488e-8b15-7ef290e4b77d',
    name: 'War Room',
    sha256: '7014d3a7b8e20db7e2a12576165361775173e73cb28f1106afa40a659d6d0c74',
    clauseCount: 2,
  },
] as const;

// Toxic Deluge was restored in coverage PR02; its gate is packages/engine/tests/pr02-card-coverage.test.ts.
// Deflecting Swat was the last contained card here; PR10 restored it (see the PR10 test below).
const expected: readonly {
  oracleId: string;
  name: string;
  sha256: string;
  reason: string;
  clauseCount: number;
}[] = [];

const fixture = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;
const pr09Fixture = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/coverage-pr09-oracle.json'), 'utf8'),
) as PinnedFixture;
const pr10Fixture = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/coverage-pr10-oracle.json'), 'utf8'),
) as PinnedFixture;
const manifest = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/card-verification-manifest.json'), 'utf8'),
) as Manifest;
/**
 * Every restored card's manifest clause requirements are cross-checked against real sources. A
 * per-card block used to do this, and Myriad Landscape was simply missing from it, so its
 * declared engine test and viewer scenario ids drifted to names that existed nowhere. The table
 * keeps the check total: adding a card to `restored` without its engine test file fails here.
 */
const RESTORED_ENGINE_TEST_FILES: Record<string, string> = {
  'Arcane Denial': 'packages/engine/tests/arcane-denial.test.ts',
  'Smothering Tithe': 'packages/engine/tests/smothering-tithe.test.ts',
  'Fabled Passage': 'packages/engine/tests/fabled-passage.test.ts',
  'Myriad Landscape': 'packages/engine/tests/myriad-landscape.test.ts',
  'War Room': 'packages/engine/tests/war-room.test.ts',
};
const sharedEngineSource = readFileSync(
  resolve('packages/server/src/cards/card-test-scenarios.test.ts'),
  'utf8',
);
const viewerSources = [
  readFileSync(resolve('packages/server/src/cards/card-test-scenarios.ts'), 'utf8'),
  readFileSync(resolve('apps/web/e2e/card-test-lab.spec.ts'), 'utf8'),
].join('\n');
const gameplayAiSource = readFileSync(
  resolve('packages/server/src/cards/gameplay-ai-evaluation.ts'),
  'utf8',
);
const engineSourcesFor = (name: string): string =>
  [readFileSync(resolve(RESTORED_ENGINE_TEST_FILES[name]!), 'utf8'), sharedEngineSource].join('\n');

describe('fail-closed restoration baseline', () => {
  it('keeps the remaining restoration cards explicitly contained for the documented reason', () => {
    // A card is either still contained or restored, never both.
    expect(
      expected.filter((card) => restored.some((entry) => entry.oracleId === card.oracleId)),
    ).toEqual([]);
    for (const card of expected) {
      const pinned = fixture.cards.find((entry) => entry.card.oracleId === card.oracleId);
      expect(pinned?.sha256, card.name).toBe(card.sha256);
      const real = interpretCard(pinned!.card);
      expect(real.modeled, `${card.name} real Oracle id`).toBe(false);
      expect(real.unmodeledReasons, `${card.name} real Oracle id`).toContain(card.reason);

      const alias = interpretCard({
        ...pinned!.card,
        oracleId: `oracle-${card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      });
      expect(alias.modeled, `${card.name} fixture alias`).toBe(false);
      expect(alias.unmodeledReasons, `${card.name} fixture alias`).toContain(card.reason);
    }
  });

  it('recognizes each independently restored slice', () => {
    for (const card of restored) {
      const pinned = fixture.cards.find((entry) => entry.card.oracleId === card.oracleId);
      expect(pinned?.sha256, card.name).toBe(card.sha256);
      expect(interpretCard(pinned!.card).modeled, card.name).toBe(true);
      expect(
        interpretCard({
          ...pinned!.card,
          oracleId: `oracle-${card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        }).modeled,
        `${card.name} fixture alias`,
      ).toBe(true);
    }
  });

  it('recognizes the PR09 Chaos Warp restoration from its current pin and viewer clauses', () => {
    const pin = pr09Fixture.cards.find(
      (entry) => entry.card.oracleId === '07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8',
    );
    expect(pin?.sha256).toBe('0a92bef047916a597355070ad23e806e609a1f66affb5af24a5e236d1f961014');
    expect(pin?.card.name).toBe('Chaos Warp');
    expect(interpretCard(pin!.card).modeled).toBe(true);

    const alias = interpretCard({
      ...pin!.card,
      oracleId: 'oracle-chaos-warp',
    });
    expect(alias.modeled).toBe(true);

    const entry = manifest.cards[pin!.card.oracleId] as
      (ManifestCard & { oracleSha256: string; implementationStatus: string }) | undefined;
    expect(entry?.name).toBe('Chaos Warp');
    expect(entry?.oracleSha256).toBe(pin!.sha256);
    expect(entry?.implementationStatus).toBe('implemented-reviewed');
    expect(entry?.clauses).toHaveLength(1);
    expect(entry?.clauses[0]?.oracleText).toBe(pin!.card.oracleText);
    expect(entry?.clauses[0]?.viewerScenarioIds).toEqual([
      'pr09-chaos-warp-viewer-positive',
      'pr09-chaos-warp-viewer-negative',
    ]);
  });

  it('recognizes the PR10 Deflecting Swat restoration from its current pin and viewer clauses', () => {
    const pin = pr10Fixture.cards.find(
      (entry) => entry.card.oracleId === 'ae120613-97d6-4393-b39d-c3e6c076f5d6',
    );
    expect(pin?.card.name).toBe('Deflecting Swat');
    expect(interpretCard(pin!.card).modeled).toBe(true);
    expect(interpretCard({ ...pin!.card, oracleId: 'oracle-deflecting-swat' }).modeled).toBe(true);

    const entry = manifest.cards[pin!.card.oracleId];
    expect(entry?.name).toBe('Deflecting Swat');
    expect(entry?.oracleSha256).toBe(pin!.sha256);
    expect(entry?.implementationStatus).toBe('implemented-reviewed');
    expect(entry?.clauses).toHaveLength(2);
    expect(entry?.clauses.map((clause) => clause.viewerScenarioIds)).toEqual([
      ['pr10-deflecting-swat-viewer-commander', 'pr10-deflecting-swat-viewer-no-commander'],
      ['pr10-deflecting-swat-viewer-positive', 'pr10-deflecting-swat-viewer-negative'],
    ]);
  });

  it('declares pinned clause-level engine and viewer requirements without handwritten results', () => {
    for (const card of [...restored, ...expected]) {
      const entry = manifest.cards[card.oracleId];
      expect(entry?.name, card.name).toBe(card.name);
      expect(entry?.oracleSha256, card.name).toBe(card.sha256);
      expect(entry?.implementationStatus, card.name).toBe(
        restored.some((candidate) => candidate.oracleId === card.oracleId)
          ? 'implemented-reviewed'
          : 'unsupported',
      );
      expect(entry?.clauses, card.name).toHaveLength(card.clauseCount);
      const isRestored = restored.some((candidate) => candidate.oracleId === card.oracleId);
      for (const clause of entry!.clauses) {
        expect(clause.oracleText, `${card.name} Oracle clause`).toBeTruthy();
        expect(clause.implementation, `${card.name} implementation mapping`).not.toHaveLength(0);
        if (isRestored) {
          expect(clause.id, `${card.name} clause id`).toBeTruthy();
          expect(clause.engineTestIds, `${card.name} engine requirements`).not.toHaveLength(0);
          expect(clause.viewerScenarioIds, `${card.name} viewer requirements`).not.toHaveLength(0);
        }
      }
      expect(entry?.gameplayAiScenarioIds, card.name).toBeInstanceOf(Array);
      if (!isRestored) continue;
      expect(RESTORED_ENGINE_TEST_FILES[card.name], `${card.name} engine test file`).toBeTruthy();
      const engineSources = engineSourcesFor(card.name);
      for (const clause of entry!.clauses) {
        // A parametrized title's ID is literal up to its em dash; check:manifest-tests matches it whole.
        for (const id of clause.engineTestIds)
          expect(engineSources, id).toContain(id.split(' — ')[0]);
        for (const id of clause.viewerScenarioIds) expect(viewerSources, id).toContain(id);
      }
      for (const id of entry!.gameplayAiScenarioIds) expect(gameplayAiSource, id).toContain(id);
    }
  });
});
