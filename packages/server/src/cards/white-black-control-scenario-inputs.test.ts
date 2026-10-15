import { readFileSync } from 'node:fs';
import { interpretCard } from '@mtg/engine';
import { expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';

// Witness cards also reach interpretation during casting, discard, and zone moves.
// Validate their inputs before spending a browser run on a fail-closed fixture.
const requirements = JSON.parse(
  readFileSync('docs/plans/white-black-control-verification-requirements.json', 'utf8'),
) as { evidenceSemantics: { factoryReadyViewerScenarioIds: string[] } };

it.each(requirements.evidenceSemantics.factoryReadyViewerScenarioIds)(
  '%s has supported subjects and witness cards',
  (id) => {
    const scenario = createCardTestScenario(id, `input-check-${id}`);
    expect(scenario).not.toBeNull();
    for (const seat of scenario!.seats) {
      for (const card of seat.config.cards) {
        const definition = interpretCard(card);
        expect(definition.unmodeledReasons, `${id}: ${card.name}`).toEqual([]);
        expect(definition.modeled, `${id}: ${card.name}`).toBe(true);
      }
    }
  },
);
