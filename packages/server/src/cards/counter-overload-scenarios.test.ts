import { describe, expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';

const counters = ['Counterspell', 'Negate', 'Mana Leak', 'Stubborn Denial'];
const overloads = ['Cyclonic Rift', 'Vandalblast', 'Damn'];
const slug = (name: string) => name.toLowerCase().replaceAll(' ', '-');

describe('pinned counter and overload lab scenarios', () => {
  it.each(
    counters.flatMap((name) => ['own-counter', 'opponent-counter'].map((mode) => [name, mode])),
  )('runs %s %s through ordinary engine decisions', (name, mode) => {
    const engine = finish(name!, mode!);
    expect(engine.getState().stack).toHaveLength(0);
    expect(engine.getState().players.map((player) => player.life)).toEqual([40, 40, 40, 40]);
    const owner = engine.getState().players[mode === 'own-counter' ? 0 : 1]!;
    expect(owner.graveyard.map((card) => card.name)).toContain('Independent Pending Spell');
    expect(engine.getState().players[0]!.graveyard.map((card) => card.name)).toContain(name);
  });

  it.each(overloads.flatMap((name) => ['normal', 'overload'].map((mode) => [name, mode])))(
    'runs %s %s with independent retained and affected witnesses',
    (name, mode) => {
      const engine = finish(name!, mode!);
      const state = engine.getState();
      const board = state.battlefield.map((card) => card.name);
      expect(board).not.toContain('Chosen Overload Witness');
      expect(board).toContain('Forest');
      expect(state.players[0]!.graveyard.map((card) => card.name)).toContain(name);
      const expectedZone =
        name === 'Cyclonic Rift' ? state.players[1]!.hand : state.players[1]!.graveyard;
      expect(expectedZone.map((card) => card.name)).toContain('Chosen Overload Witness');
      if (mode === 'normal') {
        expect(board).toEqual(
          expect.arrayContaining([
            'Own Overload Witness',
            'Other Overload Witness',
            'Protected Overload Witness',
            'Indestructible Overload Witness',
          ]),
        );
      } else {
        expect(board).not.toContain('Other Overload Witness');
        expect(board).not.toContain('Protected Overload Witness');
        expect(expectedZone.map((card) => card.name)).toEqual(
          expect.arrayContaining(['Other Overload Witness', 'Protected Overload Witness']),
        );
        if (name === 'Damn') {
          expect(board).not.toContain('Own Overload Witness');
          expect(state.players[0]!.graveyard.map((card) => card.name)).toContain(
            'Own Overload Witness',
          );
        } else expect(board).toContain('Own Overload Witness');
        if (name === 'Cyclonic Rift')
          expect(board).not.toContain('Indestructible Overload Witness');
        else expect(board).toContain('Indestructible Overload Witness');
      }
    },
  );
});

function finish(name: string, mode: string) {
  const id = `${slug(name)}-viewer-${mode}`;
  const scenario = createCardTestScenario(id, `lab-test-${id}`)!;
  expect(scenario).not.toBeNull();
  const engine = scenario.engine;
  let cast = false;
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
      !cast &&
      request.decidingPlayer === 'P1' &&
      request.legalActions.find(
        (action) =>
          action.type === 'castSpell' &&
          action.description.includes(name) &&
          action.description.toLowerCase().includes('overload') === (mode === 'overload'),
      );
    const action =
      main ||
      request.legalActions.find((action) => action.type === 'decline') ||
      request.legalActions.find((action) => action.type === 'pass') ||
      request.legalActions[0]!;
    if (main) {
      cast = true;
      if (mode === 'overload') expect(action.targets).toBeUndefined();
    }
    const targets =
      action.targets?.map((slot) => ({
        slot: slot.slot,
        choice: slot.options.find((id) =>
          mode.endsWith('counter')
            ? engine
                .getState()
                .stack.some(
                  (spell) =>
                    spell.id === id && spell.description.includes('Independent Pending Spell'),
                )
            : engine
                .view('P1')
                .battlefield.some(
                  (card) => card.id === id && card.name === 'Chosen Overload Witness',
                ),
        )!,
      })) ?? [];
    engine.submit({ requestId: request.requestId, actionId: action.id, targets });
  }
  expect(cast).toBe(true);
  expect(ended).toBe(true);
  return engine;
}
