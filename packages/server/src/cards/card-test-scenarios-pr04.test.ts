/**
 * Coverage PR04 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
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
        // A name, or a literal option such as a player id or "__no_block__".
        const choice =
          slot.options.find((id) => names.get(id) === name) ??
          (slot.options.includes(name) ? name : undefined);
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
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr04');
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

describe('Sautekh Immortal Card Test Lab scenario', () => {
  it('sautekh-immortal-viewer-flash-counters — two creatures died this turn, so it enters with two +1/+1 counters', () => {
    // Each Lab Doom is passed through to resolution before the next step, so both deaths are real
    // engine events recorded before Sautekh Immortal is cast.
    const steps: Step[] = [
      { action: 'Cast Lab Doom', targets: ['Lab Ox'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Servo'] },
      { action: 'Pass priority' },
      { action: 'Cast Sautekh Immortal' },
    ];
    const { scenario, state, onBattlefield } = run('sautekh-immortal-viewer-flash-counters', steps);
    expect(onBattlefield('Lab Ox')).toHaveLength(0);
    expect(onBattlefield('Lab Servo')).toHaveLength(0);
    const [sautekh] = onBattlefield('Sautekh Immortal');
    expect(onBattlefield('Sautekh Immortal')).toHaveLength(1);
    expect(sautekh?.counters).toEqual({ '+1/+1': 2 });
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('sautekh-immortal-viewer-flash-counters', steps);
  });
});

describe('Iron Apprentice Card Test Lab scenario', () => {
  it('iron-apprentice-viewer-dies-moves-counters — it dies to Lab Doom and its counter moves to Lab Bird', () => {
    const steps: Step[] = [
      { action: 'Cast Iron Apprentice' },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Iron Apprentice'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, onBattlefield, seat } = run(
      'iron-apprentice-viewer-dies-moves-counters',
      steps,
    );
    // Dead through a real Lab Doom, the counter moved to P1's only other creature.
    expect(onBattlefield('Iron Apprentice')).toHaveLength(0);
    expect(seat('P1').graveyard.map((card) => card.name)).toContain('Iron Apprentice');
    const [bird] = onBattlefield('Lab Bird');
    expect(onBattlefield('Lab Bird')).toHaveLength(1);
    expect(bird?.counters).toEqual({ '+1/+1': 1 });
    // The opponent's creature is never a legal target of the trigger.
    const [ox] = onBattlefield('Lab Ox');
    expect(ox?.counters ?? {}).toEqual({});
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('iron-apprentice-viewer-dies-moves-counters', steps);
  });
});
