import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Clause {
  oracleText: string;
  implementation: string[];
  engineTestIds: string[];
  viewerScenarioIds: string[];
}

interface ManifestCard {
  name: string;
  oracleSha256: string;
  implementationStatus: string;
  clauses?: Clause[];
  engineTestIds?: string[];
  viewerScenarioIds?: string[];
  gameplayAiScenarioIds: string[];
}

interface Manifest {
  schemaVersion: number;
  resultPolicy: string;
  cards: Record<string, ManifestCard>;
}

const manifest = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/card-verification-manifest.json'), 'utf8'),
) as Manifest;

describe('card verification manifest', () => {
  it('maps the sample card Oracle clause to implementation and declared tests', () => {
    const path = manifest.cards['d683d985-9888-4d21-8b5f-69e69ce4a03b'];
    expect(path?.name).toBe('Path to Exile');
    expect(path?.oracleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(path?.clauses).toHaveLength(1);
    const clause = path!.clauses![0]!;
    expect(clause.oracleText).toContain('Exile target creature');
    expect(clause.implementation).toEqual(
      expect.arrayContaining([
        'targeted exile',
        'controller-scoped optional basic-land search',
        'enters tapped',
        'shuffle',
      ]),
    );

    // Its engine tests are the runner scenarios in its committed scenario file.
    const scenarios = JSON.parse(
      readFileSync(resolve('packages/engine/tests/scenarios/path-to-exile.json'), 'utf8'),
    ) as { scenarios: Array<{ id: string }> };
    expect(clause.engineTestIds).toEqual(scenarios.scenarios.map(({ id }) => id));
    expect(clause.viewerScenarioIds).not.toHaveLength(0);
  });

  it('contains requirements but no handwritten evidence result flags', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.resultPolicy).toContain('no handwritten pass flags');
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(
      /"(?:passed|failed|viewerVerified|engineVerified|aiVerified)"\s*:/,
    );
    for (const [oracleId, card] of Object.entries(manifest.cards)) {
      expect(oracleId, card.name).toMatch(/^[a-f0-9-]{36}$/);
      expect(card.oracleSha256, card.name).toMatch(/^[a-f0-9]{64}$/);
      expect(card.gameplayAiScenarioIds, card.name).toBeInstanceOf(Array);
    }
  });
});
