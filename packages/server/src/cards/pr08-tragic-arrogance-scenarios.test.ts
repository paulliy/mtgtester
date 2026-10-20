import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import {
  PR08_REMAINING_SCENARIO_IDS,
  pr08TragicArroganceScenario,
  pr08TragicArroganceScenarioSubject,
} from './pr08-remaining-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };

function run(id: (typeof PR08_REMAINING_SCENARIO_IDS)[number]) {
  const scenario = pr08TragicArroganceScenario(id, `tragic-arrogance-${id}`);
  let castAction: string | undefined;
  const choiceDescriptions: string[] = [];
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    const actions = request.legalActions;
    let action = actions.find(
      (candidate) =>
        candidate.type === 'castSpell' && candidate.description.startsWith('Cast Tragic Arrogance'),
    );
    if (action) castAction = action.description;
    if (!action && request.decidingPlayer === 'P1') {
      action = actions.find((candidate) => /Lab Keeper/.test(candidate.description));
      if (action) choiceDescriptions.push(action.description);
    }
    action ??= actions.find((candidate) => candidate.type === 'pass') ?? actions[0]!;
    scenario.engine.submit({ requestId: request.requestId, actionId: action.id });
    if (++decisions > 200) throw new Error(`${id} exceeded 200 decisions`);
  }
  return { scenario, castAction, choiceDescriptions, decisions };
}

describe('pinned Tragic Arrogance viewer scenarios', () => {
  it('validates the exact Oracle pin', () => {
    for (const entry of pins.cards) expect(sha256(entry.card)).toBe(entry.sha256);
  });

  it.each(PR08_REMAINING_SCENARIO_IDS)('%s casts and resolves from a prepared real game', (id) => {
    const { scenario, castAction, choiceDescriptions, decisions } = run(id);
    const state = scenario.engine.getState();
    const pin = pins.cards.find(
      (entry) => entry.card.name === pr08TragicArroganceScenarioSubject(id),
    )!;
    expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
    expect(decisions).toBeLessThanOrEqual(200);
    expect(castAction).toContain(pin.card.manaCost);
    expect(castAction).not.toContain('without paying');
    expect(
      state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Tragic Arrogance',
      ),
    ).toBe(true);
    const battlefieldNames = state.battlefield.map((permanent) => permanent.name);
    expect(battlefieldNames.filter((name) => name === 'Plains')).toHaveLength(2);
    expect(battlefieldNames.filter((name) => name === 'Forest')).toHaveLength(4);
    if (id === PR08_REMAINING_SCENARIO_IDS[0]) {
      expect(
        choiceDescriptions.filter((description) => /Lab Keeper/.test(description)),
      ).toHaveLength(2);
      expect(battlefieldNames).toContain('Lab Keeper');
      expect(battlefieldNames).not.toContain('Lab Victim');
      expect(battlefieldNames).not.toContain('Lab Spare');
      const departedEvents = state.eventLog.filter(
        (event) => event.type === 'zoneChange' && event.payload['from'] === 'battlefield',
      );
      expect(departedEvents.map((event) => event.payload['name'])).toEqual([
        'Lab Victim',
        'Lab Spare',
      ]);
      expect(departedEvents[1]!.sequence).toBe(departedEvents[0]!.sequence + 1);
    } else {
      expect(battlefieldNames).toContain('Lab Lone Creature');
      expect(
        state.eventLog.some(
          (event) => event.type === 'zoneChange' && event.payload['from'] === 'battlefield',
        ),
      ).toBe(false);
    }
  });
});
