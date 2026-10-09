/**
 * Coverage PR03 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
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
  const scenario = createCardTestScenario(scenarioId, 'card-lab-pr03');
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

describe('Triarch Praetorian Card Test Lab scenario', () => {
  it('triarch-praetorian-viewer-unearth — unearth returns it and the graveyard-origin trigger draws two', () => {
    const steps: Step[] = [{ action: 'Unearth' }];
    const { seat, onBattlefield } = run('triarch-praetorian-viewer-unearth', steps);
    const p1 = seat('P1');
    expect(p1.hand.map((card) => card.name).sort()).toEqual(['Lab Ox', 'Lab Zombie']);
    expect(p1.life).toBe(38);
    expect(p1.graveyard).toEqual([]);
    expect(onBattlefield('Triarch Praetorian')).toHaveLength(1);
    expect(onBattlefield('Swamp').every((swamp) => swamp.tapped)).toBe(true);
    replays('triarch-praetorian-viewer-unearth', steps);
  });
});

describe('Canoptek Tomb Sentinel Card Test Lab scenario', () => {
  it("canoptek-tomb-sentinel-viewer-unearth-exile — unearth returns it and the graveyard-origin trigger exiles P2's Lab Ox", () => {
    const steps: Step[] = [{ action: 'Unearth' }, { action: 'Target Lab Ox' }];
    const { state, onBattlefield, offered } = run(
      'canoptek-tomb-sentinel-viewer-unearth-exile',
      steps,
    );
    expect(onBattlefield('Canoptek Tomb Sentinel')).toHaveLength(1);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(offered.some((actions) => actions.includes('Choose no more targets'))).toBe(true);
    replays('canoptek-tomb-sentinel-viewer-unearth-exile', steps);
  });
});

describe('Glen Elendra Archmage Card Test Lab scenario', () => {
  it("glen-elendra-archmage-viewer-counter-persist — sacrificing it counters P3's spell and persist returns it with a -1/-1 counter", () => {
    const steps: Step[] = [
      { action: 'Counter target noncreature spell', targets: ['Lab Pending Spell'] },
    ];
    const { seat, onBattlefield } = run('glen-elendra-archmage-viewer-counter-persist', steps);
    expect(seat('P3').graveyard.map((card) => card.name)).toEqual(['Lab Pending Spell']);
    expect(seat('P3').hand).toEqual([]);
    const [mage] = onBattlefield('Glen Elendra Archmage');
    expect(mage?.counters).toEqual({ '-1/-1': 1 });
    expect(onBattlefield('Island')[0]?.tapped).toBe(true);
    replays('glen-elendra-archmage-viewer-counter-persist', steps);
  });
});

describe('Flayer of the Hatebound Card Test Lab scenario', () => {
  it('flayer-of-the-hatebound-viewer-undying-damage — Lab Doom kills it, undying returns it as a 5/3, and it deals 5 to P2', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Doom', targets: ['Flayer of the Hatebound'] },
      { action: 'Flayer of the Hatebound', targets: ['P2'] },
    ];
    const { seat, onBattlefield } = run('flayer-of-the-hatebound-viewer-undying-damage', steps);
    const [flayer] = onBattlefield('Flayer of the Hatebound');
    expect(flayer?.counters).toEqual({ '+1/+1': 1 });
    expect(seat('P2').life).toBe(35);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Doom']);
    replays('flayer-of-the-hatebound-viewer-undying-damage', steps);
  });
});

describe('Kambal, Consul of Allocation Card Test Lab scenario', () => {
  it("kambal-viewer-opponent-noncreature-spell — only P2's Lab Shock taxes P2 2 life and gains you 2", () => {
    // The second step is P2's: in the real viewer its scripted provider casts Lab Shock at P1.
    const steps: Step[] = [
      { action: 'Cast Lab Pending Spell' },
      { action: 'Cast Lab Shock', targets: ['P1'] },
    ];
    const { state, seat } = run('kambal-viewer-opponent-noncreature-spell', steps);
    expect(seat('P1').life).toBe(40);
    expect(seat('P2').life).toBe(38);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Shock']);
    const lifeEvents = state.eventLog.filter(
      (event) => event.type === 'lifeLoss' || event.type === 'lifeGain',
    );
    expect(lifeEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({ player: 'P2', amount: 2 }),
      expect.objectContaining({ player: 'P1', amount: 2 }),
    ]);
    replays('kambal-viewer-opponent-noncreature-spell', steps);
  });
});

describe('Gleeful Arsonist Card Test Lab scenario', () => {
  it('gleeful-arsonist-viewer-burn-and-undying — P2’s Lab Shock costs P2 1 damage, then undying returns the Arsonist', () => {
    // The second step is P2's response: in the real viewer its scripted provider casts it.
    const steps: Step[] = [
      { action: 'Cast Lab Doom', targets: ['Gleeful Arsonist'] },
      { action: 'Cast Lab Shock', targets: ['P1'] },
    ];
    const { seat, onBattlefield } = run('gleeful-arsonist-viewer-burn-and-undying', steps);
    expect(seat('P2').life).toBe(39);
    expect(seat('P1').life).toBe(38);
    const [arsonist] = onBattlefield('Gleeful Arsonist');
    expect(arsonist?.counters).toEqual({ '+1/+1': 1 });
    replays('gleeful-arsonist-viewer-burn-and-undying', steps);
  });
});

describe('Shard of the Nightbringer Card Test Lab scenario', () => {
  it('shard-of-the-nightbringer-viewer-cast-drain — cast, its trigger drains half of P2’s life', () => {
    const steps: Step[] = [
      { action: 'Cast Shard of the Nightbringer' },
      { action: 'Shard of the Nightbringer', targets: ['P2'] },
    ];
    const { seat, onBattlefield } = run('shard-of-the-nightbringer-viewer-cast-drain', steps);
    expect(onBattlefield('Shard of the Nightbringer')).toHaveLength(1);
    expect(seat('P2').life).toBe(20);
    expect(seat('P1').life).toBe(60);
    replays('shard-of-the-nightbringer-viewer-cast-drain', steps);
  });
});
