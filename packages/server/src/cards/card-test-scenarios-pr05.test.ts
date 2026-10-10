/**
 * Coverage PR05 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
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
  /** Only take this step while the game is in this phase (an action offered earlier is skipped). */
  phase?: string;
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
      if (step.phase !== undefined && scenario.engine.getState().phase !== step.phase) continue;
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
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr05');
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

describe('Cranial Plating Card Test Lab scenario', () => {
  it('cranial-plating-viewer-instant-attach — Equip {1} puts it on Lab Green Bear, then {B}{B} moves it to Lab Ox', () => {
    const steps: Step[] = [
      { action: 'Equip {1}', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: '{B}{B}: Attach this Equipment', targets: ['Lab Ox'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, onBattlefield, offered } = run(
      'cranial-plating-viewer-instant-attach',
      steps,
    );
    // Both abilities are offered separately in the main phase, with the stack empty.
    const first = offered[0] ?? [];
    expect(first.filter((action) => /Cranial Plating/.test(action))).toHaveLength(2);
    const [plating] = onBattlefield('Cranial Plating');
    const [ox] = onBattlefield('Lab Ox');
    expect(plating?.attachedTo).toBe(ox?.id);
    // Equip put it on Lab Green Bear first; the opponent's Lab Bird never carried it.
    expect(
      state.eventLog.filter((event) => event.type === 'attach').map((event) => event.payload),
    ).toEqual([
      { equipment: 'Cranial Plating', to: 'Lab Green Bear' },
      { equipment: 'Cranial Plating', to: 'Lab Ox' },
    ]);
    expect(onBattlefield('Swamp').filter((swamp) => swamp.tapped)).toHaveLength(3);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('cranial-plating-viewer-instant-attach', steps);
  });
});

describe('Mask of Memory Card Test Lab scenario', () => {
  it('mask-of-memory-viewer-draw-discard — Equip {1} onto Lab Green Bear, then its unblocked hit draws two and discards Lab Hex', () => {
    const steps: Step[] = [
      { action: 'Equip {1}', targets: ['Lab Green Bear'] },
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Yes' },
      { action: 'Discard Lab Hex' },
    ];
    const { scenario, state, seat, onBattlefield, prompts, offered } = run(
      'mask-of-memory-viewer-draw-discard',
      steps,
    );
    const [mask] = onBattlefield('Mask of Memory');
    const [bear] = onBattlefield('Lab Green Bear');
    expect(mask?.attachedTo).toBe(bear?.id);
    // The Mask asked once, and the discard was offered from the enlarged hand: Lab Hex and the
    // two drawn Forests.
    expect(prompts.filter((prompt) => /use this ability/.test(prompt))).toHaveLength(1);
    const discard = offered.find((options) => options.some((option) => /^Discard /.test(option)));
    expect([...(discard ?? [])].sort()).toEqual([
      'Discard Forest',
      'Discard Forest',
      'Discard Lab Hex',
    ]);
    // Hand +1 over the start, graveyard +1: two Forests held, Lab Hex discarded by choice.
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Forest', 'Forest']);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Hex']);
    expect(seat('P1').library).toHaveLength(2);
    expect(seat('P2').life).toBe(38);
    expect(onBattlefield('Swamp').filter((swamp) => swamp.tapped)).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('mask-of-memory-viewer-draw-discard', steps);
  });
});

describe('Resurrection Orb Card Test Lab scenario', () => {
  it('resurrection-orb-viewer-lifelink-and-return — Equip {4} onto the stolen Bear, lifelink on the hit, then it returns under P2 at the end step', () => {
    const steps: Step[] = [
      { action: 'Equip {4}', targets: ['Lab Green Bear'] },
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Cast Lab Doom', targets: ['Lab Green Bear'], phase: 'postcombatMain' },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'resurrection-orb-viewer-lifelink-and-return',
      steps,
    );
    // The Bear is back, under its owner P2 (not P1, who controlled it when it died), and the
    // Orb it died with is not attached to the new object.
    const [bear] = onBattlefield('Lab Green Bear');
    expect(onBattlefield('Lab Green Bear')).toHaveLength(1);
    expect(bear?.ownerId).toBe('P2');
    expect(bear?.controllerId).toBe('P2');
    const [orb] = onBattlefield('Resurrection Orb');
    expect(orb?.attachedTo ?? null).toBeNull();
    // Lifelink from the Orb: 2 combat damage to P2, 2 life to P1.
    expect(seat('P2').life).toBe(38);
    expect(seat('P1').life).toBe(42);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Doom']);
    expect(seat('P2').graveyard).toEqual([]);
    expect(onBattlefield('Swamp').filter((swamp) => swamp.tapped)).toHaveLength(6);
    expect(state.eventLog.filter((event) => event.type === 'graveyardToBattlefield')).toHaveLength(
      1,
    );
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('resurrection-orb-viewer-lifelink-and-return', steps);
  });
});
