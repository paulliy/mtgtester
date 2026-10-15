/**
 * Coverage PR07 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
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
  /** Only take this step once this holds (e.g. the stack is empty); until then pass. */
  ready?: (scenario: CardTestScenario) => boolean;
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
      if (step.ready !== undefined && !step.ready(scenario)) continue;
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
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr07');
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

describe('Promise of Loyalty Card Test Lab scenario', () => {
  it("promise-of-loyalty-viewer-vowed-creature-cant-attack-you — each kept Lab Ox gets a vow counter, and on P2's turn the vowed Lab Ox is not offered you as a defender and hits P3 instead", () => {
    const steps: Step[] = [{ action: 'Cast Promise of Loyalty' }, { action: 'Keep Lab Ox' }];
    const attackOffers: string[][] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'promise-of-loyalty-viewer-vowed-creature-cant-attack-you',
      steps,
      (request) => {
        if (request.decidingPlayer !== 'P2') return;
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (declare !== undefined)
          for (const slot of declare.targets ?? []) attackOffers.push(slot.options);
      },
    );
    const oxen = onBattlefield('Lab Ox');
    expect(oxen.map((ox) => [ox.controllerId, ox.counters['vow']])).toEqual([
      ['P1', 1],
      ['P2', 1],
    ]);
    expect(onBattlefield('Lab Servo')).toEqual([]);
    expect(attackOffers.length).toBeGreaterThan(0);
    for (const options of attackOffers) {
      expect(options).not.toContain('P1');
      expect(options).toContain('P3');
    }
    expect(seat('P1').life).toBe(40);
    expect(seat('P3').life).toBe(36);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('promise-of-loyalty-viewer-vowed-creature-cant-attack-you', steps);
  });
});

describe('Lightning Runner Card Test Lab scenario', () => {
  it('lightning-runner-viewer-pay-energy-extra-combat — paying eight energy untaps Lab Ox and runs a second combat phase in which both attack', () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Pay 8 energy' },
      { action: 'Declare attackers', targets: ['P2', 'P2'] },
    ];
    const declarations: number[] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'lightning-runner-viewer-pay-energy-extra-combat',
      steps,
      (request) => {
        if (
          request.legalActions.some((action) => action.description.startsWith('Declare attackers'))
        )
          declarations.push(
            request.legalActions.find((action) =>
              action.description.startsWith('Declare attackers'),
            )!.targets?.length ?? 0,
          );
      },
    );
    // One eligible attacker in the first combat (Lab Ox is tapped), two in the additional one.
    expect(declarations).toEqual([1, 2]);
    expect(seat('P1').energy).toBe(2);
    expect(seat('P2').life).toBe(28);
    expect(onBattlefield('Lab Ox')[0]?.tapped).toBe(true);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('lightning-runner-viewer-pay-energy-extra-combat', steps);
  });
});
