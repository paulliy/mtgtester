/**
 * Coverage PR02 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
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
 * Take the scripted steps strictly in order; each step is consumed once. While the next step is
 * not offered, pass priority (so the stack resolves), and the scenario ends once every player
 * passes with an empty stack.
 */
function scripted(steps: Step[]) {
  const remaining = [...steps];
  return (request: DecisionRequest, scenario: CardTestScenario): Choice => {
    for (const [index, step] of remaining.slice(0, 1).entries()) {
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
        )?.targetSlots ??
        action.targets ??
        [];
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
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr02');
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
  // A clean lab run ends after its priority window; an engine halt (an unmodeled card reached
  // play) is a broken scenario, not an outcome.
  expect(scenario!.engine.getResult()?.haltReason ?? null, scenarioId).toBeNull();
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

describe('Retrofitter Foundry Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Create a 1/1 colorless Servo artifact creature token.' },
    { action: 'Untap this artifact.' },
    { action: 'Sacrifice a Servo' },
    { action: 'Untap this artifact.' },
    { action: 'Sacrifice a Thopter' },
  ];

  it('retrofitter-foundry-viewer-servo-thopter-construct — chains all four abilities through normal activation', () => {
    const { state, onBattlefield, offered } = run(
      'retrofitter-foundry-viewer-servo-thopter-construct',
      steps,
    );
    expect(offered.flat().some((action) => action.includes('Untap this artifact.'))).toBe(true);
    expect(onBattlefield('Servo')).toEqual([]);
    expect(onBattlefield('Thopter')).toEqual([]);
    expect(onBattlefield('Construct')).toHaveLength(1);
    expect(onBattlefield('Construct')[0]).toMatchObject({ power: 4, toughness: 4 });
    expect(onBattlefield('Forest').every((forest) => forest.tapped)).toBe(true);
    expect(
      state.eventLog.filter((event) => event.type === 'activateAbility').length,
    ).toBeGreaterThanOrEqual(5);
    replays('retrofitter-foundry-viewer-servo-thopter-construct', steps);
  });
});

describe('Aether Hub Card Test Lab scenarios', () => {
  const energySteps: Step[] = [{ action: 'Play Aether Hub' }, { action: 'Cast Lab Green Bear' }];

  it('aether-hub-viewer-energy-any-color — enters for one energy, then spends it for {G}', () => {
    const { seat, onBattlefield, state } = run('aether-hub-viewer-energy-any-color', energySteps);
    expect(onBattlefield('Lab Green Bear')).toHaveLength(1);
    expect(onBattlefield('Aether Hub')[0]?.tapped).toBe(true);
    expect(seat('P1').energy).toBe(0);
    expect(seat('P1').hand).toEqual([]);
    expect(state.eventLog.find((event) => event.type === 'energy')?.payload).toMatchObject({
      player: 'P1',
      amount: 1,
      total: 1,
    });
    replays('aether-hub-viewer-energy-any-color', energySteps);
  });

  const colorlessSteps: Step[] = [{ action: 'Cast Lab Generic Bear' }];

  it('aether-hub-viewer-colorless — taps for {C} with no energy; {G} stays unpayable', () => {
    const { seat, onBattlefield, offered } = run('aether-hub-viewer-colorless', colorlessSteps);
    expect(offered.flat().some((action) => action.includes('Cast Lab Green Bear'))).toBe(false);
    expect(onBattlefield('Lab Generic Bear')).toHaveLength(1);
    expect(onBattlefield('Aether Hub')[0]?.tapped).toBe(true);
    expect(seat('P1').energy).toBe(0);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Green Bear']);
    replays('aether-hub-viewer-colorless', colorlessSteps);
  });
});

describe('Solar Transformer Card Test Lab scenarios', () => {
  const energySteps: Step[] = [
    { action: 'Cast Solar Transformer' },
    { action: 'Cast Lab Red Bear' },
  ];

  it('solar-transformer-viewer-cast-and-energy-mana — enters tapped with three energy, then the other pays {R}', () => {
    const { seat, onBattlefield } = run(
      'solar-transformer-viewer-cast-and-energy-mana',
      energySteps,
    );
    expect(onBattlefield('Lab Red Bear')).toHaveLength(1);
    expect(onBattlefield('Solar Transformer').map((source) => source.tapped)).toEqual([true, true]);
    expect(onBattlefield('Forest').every((forest) => forest.tapped)).toBe(true);
    expect(seat('P1').energy).toBe(2);
    replays('solar-transformer-viewer-cast-and-energy-mana', energySteps);
  });

  const colorlessSteps: Step[] = [{ action: 'Cast Lab Generic Bear' }];

  it('solar-transformer-viewer-colorless — taps for {C} with no energy; {R} stays unpayable', () => {
    const { seat, onBattlefield, offered } = run(
      'solar-transformer-viewer-colorless',
      colorlessSteps,
    );
    expect(offered.flat().some((action) => action.includes('Cast Lab Red Bear'))).toBe(false);
    expect(onBattlefield('Lab Generic Bear')).toHaveLength(1);
    expect(onBattlefield('Solar Transformer')[0]?.tapped).toBe(true);
    expect(seat('P1').energy).toBe(0);
    replays('solar-transformer-viewer-colorless', colorlessSteps);
  });
});

describe('Bespoke Battlewagon Card Test Lab scenarios', () => {
  type State = ReturnType<typeof run>['state'];
  /** Battlewagon has an active becomes-an-artifact-creature effect (crew or energy). */
  const animated = (state: State) =>
    state.effects.some(
      (effect) =>
        effect.description === 'Bespoke Battlewagon becomes an artifact creature until end of turn',
    );

  const crewSteps: Step[] = [{ action: 'You get {E}{E}' }, { action: 'Crew 4' }];

  it('bespoke-battlewagon-viewer-energy-and-crew — taps for two energy, then Crew 4 still animates it', () => {
    const { seat, onBattlefield, state } = run(
      'bespoke-battlewagon-viewer-energy-and-crew',
      crewSteps,
    );
    expect(seat('P1').energy).toBe(2);
    expect(onBattlefield('Bespoke Battlewagon')[0]?.tapped).toBe(true);
    expect(onBattlefield('Lab Giant')[0]?.tapped).toBe(true);
    expect(animated(state)).toBe(true);
    replays('bespoke-battlewagon-viewer-energy-and-crew', crewSteps);
  });

  const animateSteps: Step[] = [
    { action: 'becomes an artifact creature' },
    { action: 'Draw a card' },
  ];

  it('bespoke-battlewagon-viewer-animate-and-draw — four energy animates it without crew; three more draw', () => {
    const { seat, onBattlefield, state } = run(
      'bespoke-battlewagon-viewer-animate-and-draw',
      animateSteps,
    );
    const wagon = onBattlefield('Bespoke Battlewagon')[0]!;
    expect(animated(state)).toBe(true);
    expect(wagon.tapped).toBe(true);
    expect(seat('P1').energy).toBe(0);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Forest']);
    replays('bespoke-battlewagon-viewer-animate-and-draw', animateSteps);
  });

  const tapSteps: Step[] = [{ action: 'Tap target creature', targets: ['Lab Ox'] }];

  it('bespoke-battlewagon-viewer-tap-target — two energy taps P2’s Lab Ox', () => {
    const { seat, onBattlefield } = run('bespoke-battlewagon-viewer-tap-target', tapSteps);
    expect(onBattlefield('Lab Ox')[0]?.tapped).toBe(true);
    expect(onBattlefield('Bespoke Battlewagon')[0]?.tapped).toBe(true);
    expect(seat('P1').energy).toBe(0);
    replays('bespoke-battlewagon-viewer-tap-target', tapSteps);
  });
});
