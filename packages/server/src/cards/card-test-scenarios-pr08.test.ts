/** PR08 lab containment. Each implemented card adds normal-engine-path outcome tests here. */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';
import { describe, expect, it } from 'vitest';
import { createCardTestScenario, listCardTestScenarios } from './card-test-scenarios';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { sha256: string; card: OracleCard }[];
  }
).cards;

describe('PR08 lab containment', () => {
  it('does not publish viewer scenarios for unsupported PR08 cards', () => {
    const unsupported = new Set(
      pins.filter((pin) => !interpretCard(pin.card).modeled).map((pin) => pin.sha256),
    );
    const catalog = listCardTestScenarios();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.filter((scenario) => unsupported.has(scenario.oracleSha256))).toEqual([]);
  });
});

describe('Mob Rule Card Test Lab', () => {
  it.each(['large', 'small', 'cleanup'] as const)(
    'mob-rule-viewer-%s — normal modal cast resolves with the right affected set and duration',
    (mode) => {
      const scenario = createCardTestScenario(`mob-rule-viewer-${mode}`, 'pr08-mob-rule-lab');
      expect(scenario).not.toBeNull();
      let cast = false;
      let sawStack = false;
      let resolved = false;
      let decisions = 0;
      const selectedName = mode === 'small' ? 'Lab Servo' : 'Lab Ox';
      const otherName = mode === 'small' ? 'Lab Ox' : 'Lab Servo';
      for (;;) {
        const step = scenario!.engine.advance();
        const state = scenario!.engine.getState();
        if (state.stack.length > 0) sawStack = true;
        if (cast && sawStack && state.stack.length === 0 && !resolved) {
          const chosen = state.battlefield.filter((perm) => perm.name === selectedName);
          expect(chosen).toHaveLength(2);
          expect(chosen.every((perm) => perm.controllerId === 'P1' && !perm.tapped)).toBe(true);
          const other = state.battlefield.filter((perm) => perm.name === otherName);
          expect(other.map((perm) => perm.controllerId).sort()).toEqual(['P1', 'P2']);
          expect(other.every((perm) => perm.tapped)).toBe(true);
          resolved = true;
        }
        if (step.kind === 'gameOver') break;
        if (step.kind === 'continue') continue;
        if (++decisions > 70) throw new Error('Mob Rule lab failed to terminate');
        const action = step.request.legalActions.find(
          (candidate) =>
            candidate.description.includes('Cast Mob Rule') &&
            candidate.description.includes(
              mode === 'small' ? 'power 3 or less' : 'power 4 or greater',
            ),
        );
        const pass = step.request.legalActions.find((candidate) => candidate.type === 'pass');
        if (action) cast = true;
        scenario!.engine.submit({
          requestId: step.request.requestId,
          actionId: (action ?? pass ?? step.request.legalActions[0]!).id,
        });
      }
      expect(cast).toBe(true);
      expect(sawStack).toBe(true);
      expect(resolved).toBe(true);
      expect(scenario!.engine.getResult()?.haltReason).toBeNull();
      const state = scenario!.engine.getState();
      expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
      if (mode === 'cleanup') {
        expect(
          state.battlefield
            .filter((perm) => perm.name === 'Lab Ox')
            .map((perm) => perm.controllerId)
            .sort(),
        ).toEqual(['P1', 'P2']);
      }
    },
  );
});
