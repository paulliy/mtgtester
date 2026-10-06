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

describe("Conjurer's Closet Card Test Lab scenario", () => {
  const steps: Step[] = [{ action: 'Yes' }];

  it('conjurers-closet-viewer-end-step-blink — the end-step trigger blinks the creature, which re-enters untapped', () => {
    const { state, seat, onBattlefield, prompts } = run(
      'conjurers-closet-viewer-end-step-blink',
      steps,
    );
    expect(prompts.some((prompt) => /use this ability/.test(prompt))).toBe(true);
    expect(onBattlefield('Lab Greeter')[0]?.tapped).toBe(false);
    expect(seat('P1').life).toBe(42);
    expect(state.phase).toBe('ending');
    expect(
      state.eventLog.some(
        (event) => event.type === 'zoneChange' && event.payload['to'] === 'exile',
      ),
    ).toBe(true);
    replays('conjurers-closet-viewer-end-step-blink', steps);
  });
});

describe('Harvest Season Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Cast Harvest Season' },
    { action: 'Put Island onto the battlefield tapped' },
    { action: 'Put Plains onto the battlefield tapped' },
  ];

  it('harvest-season-viewer-tapped-creature-count — two tapped creatures allow exactly two basic-land searches', () => {
    const { seat, onBattlefield, prompts } = run(
      'harvest-season-viewer-tapped-creature-count',
      steps,
    );
    expect(prompts.filter((prompt) => /search your library/.test(prompt))).toHaveLength(2);
    expect(onBattlefield('Island')[0]?.tapped).toBe(true);
    expect(onBattlefield('Plains')[0]?.tapped).toBe(true);
    expect(seat('P1').library.map((card) => card.name)).toEqual(['Swamp']);
    replays('harvest-season-viewer-tapped-creature-count', steps);
  });
});

describe('Land Tax Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Yes' },
    { action: 'Put Plains into your hand' },
    { action: 'Put Swamp into your hand' },
    { action: 'Put Island into your hand' },
  ];

  it('land-tax-viewer-upkeep-reveal-search — the upkeep trigger reveals three basics into hand and shuffles', () => {
    const { state, seat } = run('land-tax-viewer-upkeep-reveal-search', steps);
    expect(state.turnOrder[state.activePlayerIndex]).toBe('P1');
    expect(state.step).toBe('upkeep');
    expect(
      seat('P1')
        .hand.map((card) => card.name)
        .sort(),
    ).toEqual(['Island', 'Plains', 'Swamp']);
    const found = state.eventLog.filter((event) => event.type === 'searchFound');
    expect(found.map((event) => event.payload['revealed'])).toEqual([true, true, true]);
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    replays('land-tax-viewer-upkeep-reveal-search', steps);
  });
});

describe('Mordant Dragon Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Declare attackers', targets: ['P2'] },
    { action: 'Targets for Mordant Dragon', targets: ['Lab Ox'] },
    { action: 'Yes' },
  ];

  it("mordant-dragon-viewer-combat-damage-redirect — combat damage to P2, then that much damage to P2's targeted creature", () => {
    const { state, seat, onBattlefield } = run(
      'mordant-dragon-viewer-combat-damage-redirect',
      steps,
    );
    expect(seat('P2').life).toBe(35);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(onBattlefield('Lab Servo')[0]?.damageMarked).toBe(0);
    const redirect = state.eventLog.find(
      (event) => event.type === 'damage' && event.payload['target'] === 'Lab Ox',
    );
    expect(redirect?.payload['amount']).toBe(5);
    replays('mordant-dragon-viewer-combat-damage-redirect', steps);
  });
});

describe('Necron Deathmark Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Cast Necron Deathmark' },
    { action: 'Targets for Necron Deathmark', targets: ['P2'] },
    { action: 'Target Lab Ox' },
  ];

  it('necron-deathmark-viewer-destroy-up-to-one-and-mill — destroys one chosen creature and mills the target player three', () => {
    const { seat, onBattlefield, offered } = run(
      'necron-deathmark-viewer-destroy-up-to-one-and-mill',
      steps,
    );
    expect(offered.flat()).toContain('Choose no more targets');
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual([
      'Lab Ox',
      'Forest',
      'Forest',
      'Forest',
    ]);
    expect(onBattlefield('Lab Servo')).toHaveLength(1);
    expect(onBattlefield('Necron Deathmark')).toHaveLength(1);
    replays('necron-deathmark-viewer-destroy-up-to-one-and-mill', steps);
  });
});

describe('Plasmancer Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Cast Plasmancer' }, { action: 'Put Swamp into your hand' }];

  it('plasmancer-viewer-reveal-swamp — casts normally, then the enters trigger reveals a basic Swamp to hand', () => {
    const { state, seat, onBattlefield, offered } = run('plasmancer-viewer-reveal-swamp', steps);
    expect(onBattlefield('Plasmancer')).toHaveLength(1);
    const search = offered.find((options) => options.includes('Put Swamp into your hand'));
    expect(search).toEqual(['Put Swamp into your hand', 'Find nothing']);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Swamp']);
    expect(state.eventLog.find((event) => event.type === 'searchFound')?.payload).toMatchObject({
      name: 'Swamp',
      to: 'hand',
      revealed: true,
    });
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    replays('plasmancer-viewer-reveal-swamp', steps);
  });
});

describe('Sylvan Reclamation Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Cast Sylvan Reclamation' },
    { action: 'Target Lab Servo' },
    { action: 'Target Lab Hex' },
  ];

  it('sylvan-reclamation-viewer-exile-up-to-two — casts normally and exiles the two chosen permanents', () => {
    const { state, onBattlefield, prompts, offered } = run(
      'sylvan-reclamation-viewer-exile-up-to-two',
      steps,
    );
    const targetChoices = prompts.filter((prompt) => /^Choose target \d+ for /.test(prompt));
    expect(targetChoices).toHaveLength(2);
    const firstChoice = offered.find((options) => options.includes('Target Lab Servo'))!;
    expect(firstChoice).toEqual(
      expect.arrayContaining(['Target Lab Hex', 'Target Lab Idol', 'Choose no more targets']),
    );
    expect(firstChoice).not.toContain('Target Lab Ox');
    expect(onBattlefield('Lab Servo')).toHaveLength(0);
    expect(onBattlefield('Lab Hex')).toHaveLength(0);
    expect(onBattlefield('Lab Idol')).toHaveLength(1);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(state.exile.map((card) => card.name).sort()).toEqual(['Lab Hex', 'Lab Servo']);
    replays('sylvan-reclamation-viewer-exile-up-to-two', steps);
  });
});

describe('Sylvan Reclamation basic landcycling Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Basic landcycling {2}' }];

  it('sylvan-reclamation-viewer-basic-landcycling — discards from hand and reveals the found basic land', () => {
    const { state, seat } = run('sylvan-reclamation-viewer-basic-landcycling', steps);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Sylvan Reclamation']);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Plains']);
    expect(state.eventLog.find((event) => event.type === 'searchFound')?.payload).toMatchObject({
      name: 'Plains',
      to: 'hand',
      revealed: true,
    });
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    replays('sylvan-reclamation-viewer-basic-landcycling', steps);
  });
});

describe('Thunderfoot Baloth Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Cast Thunderfoot Baloth' }];

  it('thunderfoot-baloth-viewer-lieutenant — with your commander out, it and your other creatures get the buff; noncreatures do not', () => {
    const { scenario } = run('thunderfoot-baloth-viewer-lieutenant', steps);
    const view = scenario.engine.view('P1');
    expect(view.commanders).toEqual([
      expect.objectContaining({ name: 'Lab General', zone: 'battlefield' }),
    ]);
    const seen = new Map(view.battlefield.map((permanent) => [permanent.name, permanent]));
    const shape = (name: string) => {
      const permanent = seen.get(name)!;
      return {
        power: permanent.power,
        toughness: permanent.toughness,
        trample: permanent.keywords?.includes('trample') ?? false,
      };
    };
    expect(shape('Thunderfoot Baloth')).toEqual({ power: 7, toughness: 7, trample: true });
    expect(shape('Lab General')).toEqual({ power: 4, toughness: 4, trample: true });
    expect(shape('Lab Ox')).toEqual({ power: 6, toughness: 6, trample: true });
    expect(shape('Lab Servo')).toEqual({ power: 1, toughness: 1, trample: false });
    expect(seen.get('Lab Relic')?.keywords ?? []).not.toContain('trample');
    expect(seen.get('Lab Relic')?.power ?? 0).toBe(0);
    replays('thunderfoot-baloth-viewer-lieutenant', steps);
  });
});

describe('Tomb Fortress Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Mill four cards' },
    { action: 'Return Lab Ox to the battlefield' },
  ];

  it('tomb-fortress-viewer-mill-then-return — mills four, then offers the creature cards in the graveyard, including the milled one', () => {
    const { state, seat, onBattlefield, offered } = run(
      'tomb-fortress-viewer-mill-then-return',
      steps,
    );
    const choice = offered.find((options) => options.includes('Return Lab Ox to the battlefield'));
    expect(choice).toEqual([
      'Return Lab Servo to the battlefield',
      'Return Lab Ox to the battlefield',
    ]);
    expect(onBattlefield('Lab Ox')[0]?.controllerId).toBe('P1');
    expect(onBattlefield('Tomb Fortress')).toHaveLength(0);
    expect(state.exile.map((card) => card.name)).toEqual(['Tomb Fortress']);
    expect(seat('P1').library).toEqual([]);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Forest', 'Forest', 'Forest', 'Lab Servo']);
    replays('tomb-fortress-viewer-mill-then-return', steps);
  });
});

describe('Voice of Many Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Cast Voice of Many' }];

  it('voice-of-many-viewer-draw-per-opponent — draws one card for each opponent with fewer creatures', () => {
    const { state, seat, onBattlefield } = run('voice-of-many-viewer-draw-per-opponent', steps);
    expect(onBattlefield('Voice of Many')).toHaveLength(1);
    expect(seat('P1').hand.map((card) => card.name)).toEqual([
      'Voice Drawn Card',
      'Voice Drawn Card',
    ]);
    expect(seat('P1').library).toHaveLength(1);
    expect(state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(2);
    replays('voice-of-many-viewer-draw-per-opponent', steps);
  });
});

describe('Foe-Razer Regent Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Cast Foe-Razer Regent' },
    { action: 'fight target creature', targets: ['Lab Ox'] },
    { action: 'Yes' },
  ];

  it('foe-razer-regent-viewer-fight-and-grow — fights Lab Ox on entry, then gets two +1/+1 counters at the end step', () => {
    const { state, onBattlefield, seat } = run('foe-razer-regent-viewer-fight-and-grow', steps);
    expect(onBattlefield('Lab Ox')).toHaveLength(0);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Ox']);
    const regent = onBattlefield('Foe-Razer Regent')[0]!;
    expect(regent.counters['+1/+1']).toBe(2);
    expect(state.eventLog.some((event) => event.type === 'fight')).toBe(true);
    replays('foe-razer-regent-viewer-fight-and-grow', steps);
  });
});
