import { describe, expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';

const expected = [
  { id: 'marchesa-viewer-first-zone-own', owner: 'P1', returns: true },
  { id: 'marchesa-viewer-first-zone-opponent-owned', owner: 'P2', returns: true },
  { id: 'marchesa-viewer-first-zone-no-counter', owner: 'P1', returns: false },
  { id: 'marchesa-viewer-first-zone-opponent-controlled', owner: 'P2', returns: false },
  { id: 'marchesa-viewer-first-zone-exiled', owner: 'P2', returns: false },
] as const;

describe('pinned Marchesa first-zone real Lab scenarios', () => {
  it.each(expected)('$id applies the independently expected owner and zone outcome', (entry) => {
    const scenario = createCardTestScenario(entry.id, `lab-unit-${entry.id}`)!;
    expect(scenario).not.toBeNull();
    const engine = scenario.engine;
    let murder = false;
    let bog = false;
    let ended = false;
    for (let count = 0; count < 100; count++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        ended = true;
        break;
      }
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const main =
        request.decidingPlayer === 'P1' &&
        request.legalActions.find(
          (action) =>
            (!murder && action.type === 'castSpell' && action.description.includes('Murder')) ||
            (murder &&
              !bog &&
              action.type === 'playLand' &&
              action.description.includes('Bojuka Bog')),
        );
      const action =
        main ||
        request.legalActions.find((action) => action.type === 'pass') ||
        request.legalActions[0]!;
      if (main) {
        if (action.type === 'castSpell') murder = true;
        else bog = true;
      }
      const targets =
        action.targets?.map((slot) => ({
          slot: slot.slot,
          choice:
            slot.options.find(
              (id) =>
                id === 'P2' ||
                engine
                  .getState()
                  .battlefield.some(
                    (object) => object.id === id && object.name === 'First-Zone Witness',
                  ),
            ) ?? slot.options[0]!,
        })) ?? [];
      engine.submit({ requestId: request.requestId, actionId: action.id, targets });
    }
    expect(ended).toBe(true);
    expect(murder).toBe(true);
    expect(bog).toBe(entry.id.endsWith('exiled'));
    const state = engine.getState();
    const returned = state.battlefield.find((object) => object.name === 'First-Zone Witness');
    if (entry.returns) {
      expect(returned).toBeDefined();
      expect(returned!.ownerId).toBe(entry.owner);
      expect(returned!.controllerId).toBe('P1');
      expect(returned!.counters).toEqual({});
      expect(returned).not.toHaveProperty('firstDestinationObjectId');
      expect(returned).not.toHaveProperty('lastKnownFacts');
    } else expect(returned).toBeUndefined();
    const graveyard = state.players.find((player) => player.id === entry.owner)!.graveyard;
    expect(graveyard.some((card) => card.name === 'First-Zone Witness')).toBe(
      !entry.returns && !bog,
    );
    expect(state.exile.some((card) => card.name === 'First-Zone Witness')).toBe(bog);
    expect(state.players[0]!.graveyard.filter((card) => card.name === 'Murder')).toHaveLength(1);
    expect(JSON.stringify(engine.view('P1'))).not.toMatch(
      /firstDestinationObjectId|lastKnownFacts|resolutionObjectFacts|sourceCastState/,
    );
  });
});
