/**
 * Coverage PR06 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
 * through the same Engine the real viewer session uses. The Playwright spec drives the identical
 * scenarios through the real frontend; this suite pins their authoritative outcomes and replay.
 */
import type { DecisionRequest } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
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

function run(
  scenarioId: string,
  steps: Step[],
  /** Called with each request just before the scripted choice is submitted. */
  inspect?: (request: DecisionRequest, scenario: CardTestScenario) => void,
) {
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr06');
  expect(scenario, scenarioId).not.toBeNull();
  const choose = scripted(steps);
  const prompts: string[] = [];
  const offered: string[][] = [];
  const requests: Array<{ seat: string; request: DecisionRequest }> = [];
  /** P1's view of its battlefield (name and effective P/T) at every decision. */
  const views: Array<Array<{ name: string; power: number | null; toughness: number | null }>> = [];
  let decisions = 0;
  for (;;) {
    const step = scenario!.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions++;
    prompts.push(step.request.prompt ?? '');
    offered.push(step.request.legalActions.map((action) => action.description));
    inspect?.(step.request, scenario!);
    requests.push({ seat: step.request.decidingPlayer, request: step.request });
    views.push(
      scenario!.engine.view('P1').battlefield.map((perm) => ({
        name: perm.name,
        power: perm.power ?? null,
        toughness: perm.toughness ?? null,
      })),
    );
    // A seat the scenario scripts (an opponent's own turn) answers as in the viewer.
    const override = scenario!.decisionProviderOverrides?.[step.request.decidingPlayer];
    scenario!.engine.submit(
      override === undefined
        ? { requestId: step.request.requestId, ...choose(step.request, scenario!) }
        : override.decide(step.request),
    );
    if (decisions > 60) throw new Error(`${scenarioId} did not terminate`);
  }
  // A clean lab run ends after its priority window; an engine halt (an unmodeled card reached
  // play) is a broken scenario, not an outcome.
  expect(scenario!.engine.getResult()?.haltReason ?? null, scenarioId).toBeNull();
  const state = scenario!.engine.getState();
  const seat = (id: string) => state.players.find((candidate) => candidate.id === id)!;
  const onBattlefield = (name: string) =>
    state.battlefield.filter((permanent) => permanent.name === name);
  return { scenario: scenario!, state, seat, onBattlefield, prompts, offered, requests, views };
}

function replays(scenarioId: string, steps: Step[]): void {
  const first = run(scenarioId, steps).state;
  const second = run(scenarioId, steps).state;
  expect(second.eventLog).toEqual(first.eventLog);
}

describe('Dragon Tempest Card Test Lab scenario', () => {
  it('dragon-tempest-viewer-dragon-deals-damage — Lab Skydrake enters, gains haste, and deals 1 damage to P2 itself, so its lifelink gains P1 life', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Skydrake' },
      { action: 'Targets for Dragon Tempest', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'dragon-tempest-viewer-dragon-deals-damage',
      steps,
    );
    // Both Tempest triggers are ordered by the controller, and the damage trigger names P2.
    expect(offered.some((options) => options.includes('Targets for Dragon Tempest'))).toBe(true);
    const [drake] = onBattlefield('Lab Skydrake');
    expect(drake?.controllerId).toBe('P1');
    const chars = computeCharacteristics(
      (scenario.engine as unknown as { ctx: GameContext }).ctx,
      drake as unknown as EnginePermanent,
    );
    expect(chars.keywords).toEqual(expect.arrayContaining(['flying', 'lifelink', 'haste']));
    // The Dragon, not the enchantment, is the damage source: X is 1 and its lifelink works.
    expect(
      state.eventLog.filter((event) => event.type === 'damage').map((event) => event.payload),
    ).toMatchObject([{ source: 'Lab Skydrake', controller: 'P1', target: 'P2', amount: 1 }]);
    expect(seat('P1').life).toBe(41);
    expect(seat('P2').life).toBe(39);
    expect(onBattlefield('Mountain').filter((mountain) => mountain.tapped)).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('dragon-tempest-viewer-dragon-deals-damage', steps);
  });
});

describe('Scourge of Valkas Card Test Lab scenario', () => {
  it('scourge-of-valkas-viewer-dragons-deal-damage — Scourge deals 1 as it enters, then Lab Skydrake entering deals 2 itself, so its lifelink gains P1 life, and {R} pumps Scourge', () => {
    const steps: Step[] = [
      { action: 'Cast Scourge of Valkas' },
      { action: 'Targets for Scourge of Valkas', targets: ['P2'] },
      { action: 'Cast Lab Skydrake', phase: 'precombatMain' },
      { action: 'Targets for Scourge of Valkas', targets: ['P2'] },
      { action: 'Scourge of Valkas: {R}' },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'scourge-of-valkas-viewer-dragons-deal-damage',
      steps,
    );
    expect(onBattlefield('Scourge of Valkas')).toHaveLength(1);
    expect(onBattlefield('Lab Skydrake')).toHaveLength(1);
    // Each Dragon is the damage source for the trigger its own entry caused.
    expect(
      state.eventLog.filter((event) => event.type === 'damage').map((event) => event.payload),
    ).toMatchObject([
      { source: 'Scourge of Valkas', controller: 'P1', target: 'P2', amount: 1 },
      { source: 'Lab Skydrake', controller: 'P1', target: 'P2', amount: 2 },
    ]);
    expect(seat('P1').life).toBe(42);
    expect(seat('P2').life).toBe(37);
    expect(onBattlefield('Mountain').filter((mountain) => mountain.tapped)).toHaveLength(7);
    // The {R} pump made Scourge a 5/4 flier until end of turn.
    expect(
      scenario.engine.view('P1').battlefield.find((perm) => perm.name === 'Scourge of Valkas'),
    ).toMatchObject({ power: 5, toughness: 4, keywords: ['flying'] });
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('scourge-of-valkas-viewer-dragons-deal-damage', steps);
  });
});

describe("Tyrant's Familiar Card Test Lab scenario", () => {
  it("tyrants-familiar-viewer-lieutenant-attack — attacking P2, the trigger offers only P2's creatures and its 7 damage kills Lab Ox", () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2', '__no_attack__'] },
      { action: 'Targets for', targets: ['Lab Ox'] },
    ];
    const targetOptions: string[][] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'tyrants-familiar-viewer-lieutenant-attack',
      steps,
      (request, current) => {
        const slots = request.legalActions.find((action) =>
          /^Targets for/.test(action.description),
        )?.targets;
        if (slots === undefined || slots === null) return;
        const names = objectNames(current);
        targetOptions.push(slots[0]!.options.map((id) => names.get(id) ?? id).sort());
      },
    );
    // Only the creatures of the player attacked (P2) were on offer: not P3's Lab Bird, nor Lab General.
    expect(targetOptions).toEqual([['Lab Ox', 'Lab Servo']]);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(seat('P2').graveyard.map((card) => card.name)).toContain('Lab Ox');
    expect(onBattlefield('Lab Servo')).toHaveLength(1);
    expect(onBattlefield('Lab Bird')).toHaveLength(1);
    expect(
      scenario.engine.view('P1').battlefield.find((perm) => perm.name === "Tyrant's Familiar"),
    ).toMatchObject({ power: 7, toughness: 7 });
    const triggerDamage = state.eventLog.filter(
      (event) => event.type === 'damage' && event.payload['combat'] === false,
    );
    expect(triggerDamage.map((event) => event.payload)).toMatchObject([
      { target: 'Lab Ox', amount: 7 },
    ]);
    expect(seat('P2').life).toBe(33);
    expect(seat('P3').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('tyrants-familiar-viewer-lieutenant-attack', steps);
  });
});
