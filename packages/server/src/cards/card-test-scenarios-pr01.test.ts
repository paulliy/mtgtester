/**
 * Coverage PR01 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
 * through the same Engine the real viewer session uses. The Playwright spec drives the identical
 * scenarios through the real frontend; this suite pins their authoritative outcomes and replay.
 */
import type { DecisionRequest } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';
import type { CardTestScenario } from './card-test-scenarios';

interface Choice {
  actionId: number;
  targets?: Array<{ slot: number; choice: string }>;
}

/** One scripted step: take the first legal action whose description contains `action`. */
interface Step {
  action: string;
  /** Fill target slots, in order, with the objects or players of these names. */
  targets?: string[];
}

function objectNames(scenario: CardTestScenario): Map<string, string> {
  const names = new Map<string, string>();
  const state = scenario.engine.getState();
  for (const perm of state.battlefield) names.set(perm.id, perm.name);
  for (const player of state.players) {
    names.set(player.id, player.id);
    for (const card of player.graveyard) names.set(card.id, card.name);
    for (const card of player.hand) names.set(card.id, card.name);
  }
  for (const card of state.exile) names.set(card.id, card.name);
  for (const entry of state.stack) names.set(entry.id, entry.description);
  return names;
}

/**
 * Prefer the scripted steps in order; each step is consumed once. Anything else passes priority,
 * so the scenario ends once every player passes with an empty stack.
 */
function scripted(steps: Step[]) {
  const remaining = [...steps];
  return (request: DecisionRequest, scenario: CardTestScenario): Choice => {
    for (const [index, step] of remaining.entries()) {
      const action = request.legalActions.find((candidate) =>
        candidate.description.includes(step.action),
      );
      if (action === undefined) continue;
      remaining.splice(index, 1);
      if (step.targets === undefined) return { actionId: action.id };
      const slots =
        (
          action.interaction as
            { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
        )?.targetSlots ?? [];
      const names = objectNames(scenario);
      const targets = step.targets.map((name, position) => {
        const slot = slots[position];
        if (slot === undefined) throw new Error(`${step.action}: no target slot ${position}`);
        const choice = slot.options.find((id) => names.get(id) === name);
        if (choice === undefined) {
          throw new Error(
            `${step.action}: no target named ${name} among [${slot.options
              .map((id) => names.get(id) ?? id)
              .join(', ')}]`,
          );
        }
        return { slot: slot.slot, choice };
      });
      return { actionId: action.id, targets };
    }
    const pass = request.legalActions.find((action) => action.type === 'pass');
    return { actionId: (pass ?? request.legalActions[0]!).id };
  };
}

function run(scenarioId: string, steps: Step[]) {
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr01');
  expect(scenario, scenarioId).not.toBeNull();
  const choose = scripted(steps);
  const prompts: string[] = [];
  const offered: string[][] = [];
  let decisions = 0;
  for (;;) {
    const step = scenario!.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions++;
    prompts.push(step.request.prompt ?? '');
    offered.push(step.request.legalActions.map((action) => action.description));
    scenario!.engine.submit({
      requestId: step.request.requestId,
      ...choose(step.request, scenario!),
    });
    if (decisions > 60) throw new Error(`${scenarioId} did not terminate`);
  }
  const state = scenario!.engine.getState();
  const seat = (id: string) => state.players.find((candidate) => candidate.id === id)!;
  const onBattlefield = (name: string) =>
    state.battlefield.filter((permanent) => permanent.name === name);
  return { scenario: scenario!, state, seat, onBattlefield, prompts, offered };
}

function replays(scenarioId: string, steps: Step[]): void {
  const first = run(scenarioId, steps).state;
  const second = run(scenarioId, steps).state;
  expect(second.eventLog).toEqual(first.eventLog);
}

describe('Forum of Amity Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Forum of Amity: {2}{W}{B}, {T}: Surveil 1.' },
    { action: 'Put Forum Surveilled Card into your graveyard' },
  ];

  it('forum-of-amity-viewer-surveil — pays through normal activation and surveils into the graveyard', () => {
    const { state, seat, onBattlefield, offered } = run('forum-of-amity-viewer-surveil', steps);
    expect(offered.flat()).toContain('Keep Forum Surveilled Card on top');
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Forum Surveilled Card']);
    expect(seat('P1').library).toEqual([]);
    expect(onBattlefield('Forum of Amity')[0]?.tapped).toBe(true);
    expect(
      state.battlefield.filter((permanent) => permanent.controllerId === 'P1' && !permanent.tapped),
    ).toEqual([]);
    expect(state.eventLog.some((event) => event.type === 'activateAbility')).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'surveil')).toBe(true);
    replays('forum-of-amity-viewer-surveil', steps);
  });
});

describe('Attune with Aether Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Cast Attune with Aether' },
    { action: 'Put Island into your hand' },
  ];

  it('attune-with-aether-viewer-reveal-to-hand — casts normally, reveals the Island to hand, shuffles, and gives energy', () => {
    const { state, seat, offered } = run('attune-with-aether-viewer-reveal-to-hand', steps);
    expect(offered.flat()).toContain('Find nothing');
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Island']);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Attune with Aether']);
    expect(seat('P1').energy).toBe(2);
    expect(state.eventLog.find((event) => event.type === 'searchFound')?.payload).toMatchObject({
      name: 'Island',
      to: 'hand',
      revealed: true,
    });
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    replays('attune-with-aether-viewer-reveal-to-hand', steps);
  });
});

describe('Beacon of Unrest Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Cast Beacon of Unrest', targets: ['Lab Ox'] }];

  it('beacon-of-unrest-viewer-reanimate-and-shuffle — reanimates the creature card and shuffles Beacon into its library', () => {
    const { state, seat, onBattlefield } = run(
      'beacon-of-unrest-viewer-reanimate-and-shuffle',
      steps,
    );
    expect(onBattlefield('Lab Ox')[0]?.controllerId).toBe('P1');
    expect(seat('P1').graveyard).toEqual([]);
    expect(seat('P1').library.map((card) => card.name)).toEqual(['Beacon of Unrest']);
    const types = state.eventLog.map((event) => event.type);
    expect(types.lastIndexOf('shuffle')).toBeGreaterThan(types.indexOf('graveyardToBattlefield'));
    replays('beacon-of-unrest-viewer-reanimate-and-shuffle', steps);
  });
});

describe('Canoptek Spyder Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Cast Lab Skiff' }];

  it('canoptek-spyder-viewer-vehicle-draw — a noncreature Vehicle entering triggers the draw', () => {
    const { state, seat, onBattlefield } = run('canoptek-spyder-viewer-vehicle-draw', steps);
    expect(onBattlefield('Lab Skiff')).toHaveLength(1);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Spyder Drawn Card']);
    expect(seat('P1').library).toEqual([]);
    expect(state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(1);
    replays('canoptek-spyder-viewer-vehicle-draw', steps);
  });
});

describe('Canoptek Wraith Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Declare attackers', targets: ['P2'] },
    { action: 'Pay {3} and sacrifice Canoptek Wraith' },
    { action: 'Choose Island' },
    { action: 'Put Island onto the battlefield tapped' },
    { action: 'Put Island onto the battlefield tapped' },
  ];

  it('canoptek-wraith-viewer-scout-same-name-search — unblocked combat damage, payment, sacrifice, and same-name search', () => {
    const { state, seat, onBattlefield, offered } = run(
      'canoptek-wraith-viewer-scout-same-name-search',
      steps,
    );
    expect(offered.flat()).toContain('Choose Forest');
    expect(seat('P2').life).toBe(38);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Canoptek Wraith']);
    expect(onBattlefield('Island')).toHaveLength(5);
    expect(onBattlefield('Island').every((land) => land.tapped)).toBe(true);
    expect(seat('P1').library.map((card) => card.name)).toEqual(['Forest']);
    expect(state.eventLog.some((event) => event.type === 'sacrifice')).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    replays('canoptek-wraith-viewer-scout-same-name-search', steps);
  });
});
