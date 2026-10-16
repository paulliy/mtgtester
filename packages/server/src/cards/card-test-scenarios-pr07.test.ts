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

describe('Firkraag Card Test Lab scenarios', () => {
  it('firkraag-viewer-dragon-attack-goads — attacking P2 with Firkraag goads the chosen Lab Ox, not Lab Servo', () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Targets for Firkraag', targets: ['Lab Ox'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'firkraag-viewer-dragon-attack-goads',
      steps,
    );
    // Goad is public in the event log: one goad, on Lab Ox, by Firkraag's controller's trigger.
    expect(
      state.eventLog.filter((event) => event.type === 'goad').map((event) => event.payload),
    ).toMatchObject([{ target: 'Lab Ox', source: expect.stringContaining('Firkraag') }]);
    expect(onBattlefield('Lab Servo')).toHaveLength(1);
    expect(seat('P2').life).toBe(37);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('firkraag-viewer-dragon-attack-goads', steps);
  });

  it('firkraag-viewer-goaded-damage-draws — the goaded Lab Ox attacks P3 (not you), so Firkraag gets a counter and you draw', () => {
    const steps: Step[] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'firkraag-viewer-goaded-damage-draws',
      steps,
    );
    expect(seat('P3').life).toBe(36);
    expect(seat('P1').life).toBe(40);
    expect(onBattlefield('Firkraag, Cunning Instigator')[0]?.counters['+1/+1']).toBe(1);
    expect(seat('P1').hand).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('firkraag-viewer-goaded-damage-draws', steps);
  });
});

describe('Eriette of the Charmed Apple Card Test Lab scenarios', () => {
  it("eriette-viewer-enchanted-cant-attack-you — P2's enchanted Lab Ox is never offered you as a defender and attacks P3", () => {
    const steps: Step[] = [];
    const offers: string[][] = [];
    const { scenario, state, seat } = run(
      'eriette-viewer-enchanted-cant-attack-you',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P2' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offers.length).toBeGreaterThan(0);
    for (const options of offers) expect(options).not.toContain('P1');
    expect(seat('P1').life).toBe(40);
    expect(seat('P3').life).toBe(34);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('eriette-viewer-enchanted-cant-attack-you', steps);
  });

  it('eriette-viewer-end-step-drain — two Auras you control: each opponent loses 2 and you gain 2', () => {
    const steps: Step[] = [];
    const { scenario, state, seat } = run('eriette-viewer-end-step-drain', steps);
    expect(seat('P1').life).toBe(42);
    for (const id of ['P2', 'P3', 'P4']) expect(seat(id).life, id).toBe(38);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('eriette-viewer-end-step-drain', steps);
  });
});

describe('Rite of the Raging Storm Card Test Lab scenarios', () => {
  it("rite-of-the-raging-storm-viewer-named-cant-attack-you — P2's Lightning Rager is never offered you as a defender (Lab Servo is) and attacks P3", () => {
    const steps: Step[] = [];
    // Slot 0 is Lightning Rager, slot 1 is Lab Servo (battlefield order).
    const offers: string[][] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'rite-of-the-raging-storm-viewer-named-cant-attack-you',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P2' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offers).toHaveLength(2);
    expect(offers[0]).not.toContain('P1');
    expect(offers[0]).toContain('P3');
    // Lab Servo, which is not named Lightning Rager, may attack you.
    expect(offers[1]).toContain('P1');
    expect(seat('P1').life).toBe(40);
    expect(seat('P3').life).toBe(34);
    expect(onBattlefield('Lab Servo')).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('rite-of-the-raging-storm-viewer-named-cant-attack-you', steps);
  });

  it('rite-of-the-raging-storm-viewer-upkeep-token — P2 gets a hasty Lightning Rager at upkeep, it attacks P3 and is sacrificed at the end step', () => {
    const steps: Step[] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'rite-of-the-raging-storm-viewer-upkeep-token',
      steps,
    );
    const created = state.eventLog.filter(
      (event) =>
        event.type === 'tokenCreated' && JSON.stringify(event.payload).includes('Lightning Rager'),
    );
    expect(created).toHaveLength(1);
    expect(seat('P3').life).toBe(35);
    expect(seat('P1').life).toBe(40);
    // Sacrificed at P2's end step: no Lightning Rager remains, and it is not in a graveyard (tokens
    // cease to exist).
    expect(onBattlefield('Lightning Rager')).toEqual([]);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('rite-of-the-raging-storm-viewer-upkeep-token', steps);
  });
});

describe('Nils, Discipline Enforcer Card Test Lab scenarios', () => {
  it('nils-viewer-end-step-counters — the trigger asks for a creature for each player: Lab Servo and Lab Ox grow, Nils and Lab Bird do not', () => {
    const prompts: string[] = [];
    const steps: Step[] = [{ action: 'Target Lab Servo' }, { action: 'Target Lab Ox' }];
    const { scenario, state, onBattlefield } = run(
      'nils-viewer-end-step-counters',
      steps,
      (request) => {
        if (/controlled by P\d/.test(request.prompt)) prompts.push(request.prompt);
      },
    );
    expect(prompts.map((prompt) => /controlled by (P\d)/.exec(prompt)?.[1])).toEqual(['P1', 'P2']);
    const grew = (name: string) => onBattlefield(name)[0]?.counters['+1/+1'];
    expect(grew('Lab Servo')).toBe(1);
    expect(grew('Lab Ox')).toBe(1);
    expect(grew('Lab Bird')).toBeUndefined();
    expect(grew('Nils, Discipline Enforcer')).toBeUndefined();
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('nils-viewer-end-step-counters', steps);
  });

  it('nils-viewer-counters-attack-tax — P2 pays {2} for the two counters on Lab Ox, which then hits you for 6', () => {
    const steps: Step[] = [{ action: 'Declare blockers', targets: ['__no_block__'] }];
    const { scenario, state, seat, onBattlefield } = run('nils-viewer-counters-attack-tax', steps);
    expect(seat('P1').life).toBe(34);
    expect(onBattlefield('Forest').filter((land) => land.controllerId === 'P2')).toHaveLength(2);
    expect(
      onBattlefield('Forest').filter((land) => land.controllerId === 'P2' && land.tapped),
    ).toHaveLength(2);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('nils-viewer-counters-attack-tax', steps);
  });
});

describe('Combat Calligrapher Card Test Lab scenarios', () => {
  it('combat-calligrapher-viewer-inkling-cant-attack-you — P2’s Lab Inkling is never offered you as a defender, and its attack on P3 makes P2 an Inkling token attacking P3', () => {
    const steps: Step[] = [];
    const offers: string[][] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'combat-calligrapher-viewer-inkling-cant-attack-you',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P2' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).not.toContain('P1');
    expect(offers[0]).toContain('P3');
    expect(seat('P1').life).toBe(40);
    expect(seat('P3').life).toBe(36);
    const [token] = onBattlefield('Inkling');
    expect(token?.controllerId).toBe('P2');
    expect(token?.tapped).toBe(true);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('combat-calligrapher-viewer-inkling-cant-attack-you', steps);
  });

  it('combat-calligrapher-viewer-attacker-creates-inkling — your attack on P2 creates a tapped Inkling for you attacking P2', () => {
    const steps: Step[] = [{ action: 'Declare attackers', targets: ['__no_attack__', 'P2'] }];
    const { scenario, state, seat, onBattlefield } = run(
      'combat-calligrapher-viewer-attacker-creates-inkling',
      steps,
    );
    const [token] = onBattlefield('Inkling');
    expect(token?.controllerId).toBe('P1');
    expect(token?.tapped).toBe(true);
    expect(seat('P2').life).toBe(34);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('combat-calligrapher-viewer-attacker-creates-inkling', steps);
  });
});

describe('Goblin Spymaster Card Test Lab scenarios', () => {
  it('goblin-spymaster-viewer-opponent-end-step-token — at P2’s end step P2 creates the Goblin token, and you do not', () => {
    const steps: Step[] = [];
    const { scenario, state, onBattlefield } = run(
      'goblin-spymaster-viewer-opponent-end-step-token',
      steps,
    );
    const goblins = onBattlefield('Goblin');
    expect(goblins).toHaveLength(1);
    expect(goblins[0]?.controllerId).toBe('P2');
    const created = state.eventLog.filter(
      (event) => event.type === 'tokenCreated' && JSON.stringify(event.payload).includes('Goblin'),
    );
    expect(created).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('goblin-spymaster-viewer-opponent-end-step-token', steps);
  });
});

describe('Toby, Beastie Befriender Card Test Lab scenarios', () => {
  it('toby-viewer-beast-cant-block-alone — the Beast alone is rejected, then Beast and Toby block Lab Ox together', () => {
    const rejections: string[] = [];
    const steps: Step[] = [
      { action: 'Cast Toby, Beastie Befriender' },
      // Slot 0 is Toby, slot 1 is the Beast (battlefield order): the Beast alone.
      { action: 'Declare blockers', targets: ['__no_block__', 'Lab Ox'] },
      { action: 'Declare blockers', targets: ['Lab Ox', 'Lab Ox'] },
    ];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'toby-viewer-beast-cant-block-alone',
      steps,
      (request) => {
        if (/fix the flagged problem/.test(request.prompt ?? '')) rejections.push(request.prompt);
      },
    );
    expect(rejections).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.startsWith('Declare blockers'))).toHaveLength(2);
    const beast = onBattlefield('Beast')[0];
    expect(beast?.controllerId).toBe('P1');
    expect(seat('P1').life).toBe(40);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('toby-viewer-beast-cant-block-alone', steps);
  });

  it('toby-viewer-flying-with-four-tokens — the Beast and three Servos have flying once you control four creature tokens', () => {
    const steps: Step[] = [
      { action: 'Cast Toby, Beastie Befriender' },
      { action: 'Cast Lab Token Forge' },
      { action: 'Cast Lab Token Forge' },
      { action: 'Cast Lab Token Forge' },
    ];
    const { scenario, state, onBattlefield } = run('toby-viewer-flying-with-four-tokens', steps);
    expect(onBattlefield('Servo')).toHaveLength(3);
    expect(onBattlefield('Beast')).toHaveLength(1);
    const flying = (name: string) =>
      scenario.engine
        .view('P1')
        .battlefield.filter((perm) => perm.name === name)
        .map((perm) => perm.keywords?.includes('flying') === true);
    expect(flying('Beast')).toEqual([true]);
    expect(flying('Servo')).toEqual([true, true, true]);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('toby-viewer-flying-with-four-tokens', steps);
  });
});

describe('Life of the Party Card Test Lab scenarios', () => {
  it('life-of-the-party-viewer-attack-pump — attacking alone with three creatures, it hits for 0 + 3', () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2', '__no_attack__', '__no_attack__'] },
    ];
    const { scenario, state, seat } = run('life-of-the-party-viewer-attack-pump', steps);
    expect(seat('P2').life).toBe(37);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('life-of-the-party-viewer-attack-pump', steps);
  });

  it('life-of-the-party-viewer-goaded-copies — each opponent gets a copy, and P2’s goaded copy attacks someone other than you', () => {
    const offers: string[][] = [];
    const steps: Step[] = [
      { action: 'Cast Life of the Party' },
      { action: 'Declare attackers', targets: ['__no_attack__'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'life-of-the-party-viewer-goaded-copies',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P2' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    const tokens = onBattlefield('Life of the Party').filter((perm) => perm.controllerId !== 'P1');
    expect(tokens.map((perm) => perm.controllerId).sort()).toEqual(['P2', 'P3', 'P4']);
    expect(offers).toHaveLength(1);
    expect(offers[0]).not.toContain('P1');
    expect(offers[0]).not.toContain('__no_attack__');
    expect(seat('P1').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('life-of-the-party-viewer-goaded-copies', steps);
  });
});

describe('Kardur, Doomscourge Card Test Lab scenarios', () => {
  it('kardur-viewer-must-attack-not-you — until your next turn P2’s Lab Ox is not offered you and must attack, so it hits P3', () => {
    const offers: string[][] = [];
    const steps: Step[] = [{ action: 'Cast Kardur, Doomscourge' }];
    const { scenario, state, seat } = run('kardur-viewer-must-attack-not-you', steps, (request) => {
      const declare = request.legalActions.find((action) =>
        action.description.startsWith('Declare attackers'),
      );
      if (request.decidingPlayer === 'P2' && declare !== undefined)
        for (const slot of declare.targets ?? []) offers.push(slot.options);
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]).not.toContain('P1');
    expect(offers[0]).not.toContain('__no_attack__');
    expect(seat('P1').life).toBe(40);
    expect(seat('P3').life).toBe(36);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('kardur-viewer-must-attack-not-you', steps);
  });

  it('kardur-viewer-attacker-dies-drain — Lab Servo dies attacking into the blocking Lab Ox: each opponent loses 1 and you gain 1', () => {
    const steps: Step[] = [{ action: 'Declare attackers', targets: ['__no_attack__', 'P2'] }];
    const { scenario, state, seat, onBattlefield } = run(
      'kardur-viewer-attacker-dies-drain',
      steps,
    );
    expect(onBattlefield('Lab Servo')).toEqual([]);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(seat('P1').life).toBe(41);
    for (const id of ['P2', 'P3', 'P4']) expect(seat(id).life).toBe(39);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('kardur-viewer-attacker-dies-drain', steps);
  });
});

describe('Galactus, Devourer of Worlds Card Test Lab scenarios', () => {
  it('galactus-viewer-attacks-most-life — Galactus has exactly one legal declaration, so it attacks P3, the opponent with the most life, without being asked', () => {
    const declarations: string[] = [];
    const steps: Step[] = [];
    const { scenario, state, seat } = run('galactus-viewer-attacks-most-life', steps, (request) => {
      if (
        request.decidingPlayer === 'P1' &&
        request.legalActions.some((action) => action.description.startsWith('Declare attackers'))
      )
        declarations.push(request.prompt);
    });
    // A declaration with a single legal answer is made for you, as for any forced choice.
    expect(declarations).toEqual([]);
    expect(seat('P3').life).toBe(28);
    expect(seat('P2').life).toBe(20);
    expect(seat('P4').life).toBe(30);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('galactus-viewer-attacks-most-life', steps);
  });

  it('galactus-viewer-herald-lifts-requirement — with Silver Surfer, Galactus’s Herald, Galactus may attack P2', () => {
    const offers: string[][] = [];
    const steps: Step[] = [{ action: 'Declare attackers', targets: ['P2', '__no_attack__'] }];
    const { scenario, state, seat } = run(
      'galactus-viewer-herald-lifts-requirement',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P1' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offers[0]).toEqual(expect.arrayContaining(['P2', 'P3', 'P4', '__no_attack__']));
    expect(seat('P2').life).toBe(8);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('galactus-viewer-herald-lifts-requirement', steps);
  });
});

describe('Silver Surfer, Galactus’s Herald Card Test Lab scenarios', () => {
  it('silver-surfer-viewer-search-galactus — the enters trigger finds Galactus: it goes to your hand and the library is shuffled', () => {
    const steps: Step[] = [
      { action: "Cast Silver Surfer, Galactus's Herald" },
      { action: 'Yes' },
      { action: 'Put Galactus, Devourer of Worlds into your hand' },
    ];
    const { scenario, state } = run('silver-surfer-viewer-search-galactus', steps);
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand.map((entry) => entry.name)).toEqual(['Galactus, Devourer of Worlds']);
    expect(p1.library.map((entry) => entry.name)).not.toContain('Galactus, Devourer of Worlds');
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('silver-surfer-viewer-search-galactus', steps);
  });

  it('silver-surfer-viewer-attack-that-player — the targeted Lab Ox must attack P3 on P2’s turn and cannot attack you', () => {
    const offers: string[][] = [];
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P3'] },
      { action: 'Targets for Silver Surfer', targets: ['Lab Ox'] },
    ];
    const { scenario, state, seat } = run(
      'silver-surfer-viewer-attack-that-player',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P2' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offers.every((options) => !options.includes('P1'))).toBe(true);
    expect(seat('P1').life).toBe(40);
    expect(seat('P3').life).toBe(32);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('silver-surfer-viewer-attack-that-player', steps);
  });
});

describe('Taunt from the Rampart Card Test Lab scenario', () => {
  it('taunt-viewer-goad-and-cant-block — Lab Ox is not offered as a blocker, and on its own turn it must attack P3 and not you', () => {
    const offers: string[][] = [];
    let blockDecisions = 0;
    const steps: Step[] = [
      { action: 'Cast Taunt from the Rampart' },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat } = run('taunt-viewer-goad-and-cant-block', steps, (request) => {
      const declare = request.legalActions.find((action) =>
        action.description.startsWith('Declare attackers'),
      );
      if (request.decidingPlayer === 'P2' && declare !== undefined)
        for (const slot of declare.targets ?? []) offers.push(slot.options);
      if (request.legalActions.some((action) => action.description.startsWith('Declare blockers')))
        blockDecisions++;
    });
    expect(blockDecisions).toBe(0);
    expect(offers.every((options) => !options.includes('P1'))).toBe(true);
    expect(seat('P2').life).toBe(39);
    expect(seat('P3').life).toBe(36);
    expect(seat('P1').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('taunt-viewer-goad-and-cant-block', steps);
  });
});

describe('Hexmark Destroyer Card Test Lab scenario', () => {
  it('hexmark-viewer-needs-six-blockers — three blockers are rejected and dropped, so Hexmark Destroyer deals 6 to P2', () => {
    const steps: Step[] = [{ action: 'Declare attackers', targets: ['P2'] }];
    const rejections: string[] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'hexmark-viewer-needs-six-blockers',
      steps,
      (request) => {
        if (/fix the flagged problem/.test(request.prompt ?? '')) rejections.push(request.prompt);
      },
    );
    expect(rejections.length).toBeGreaterThan(0);
    expect(seat('P2').life).toBe(34);
    expect(onBattlefield('Lab Servo')).toHaveLength(3);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('hexmark-viewer-needs-six-blockers', steps);
  });
});

describe('Champion of Lambholt Card Test Lab scenario', () => {
  it('champion-of-lambholt-viewer-weaker-cant-block — only Lab Ox is offered as a blocker of Lab Servo; Lab Bird, with less power than the Champion, is not', () => {
    const steps: Step[] = [{ action: 'Declare attackers', targets: ['__no_attack__', 'P2'] }];
    const blockSlots: number[] = [];
    const { scenario, state, onBattlefield } = run(
      'champion-of-lambholt-viewer-weaker-cant-block',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare blockers'),
        );
        if (request.decidingPlayer === 'P2' && declare !== undefined)
          blockSlots.push(declare.targets?.length ?? 0);
      },
    );
    // One eligible blocker (Lab Ox) out of two creatures.
    expect(blockSlots).toEqual([1]);
    expect(onBattlefield('Lab Servo')).toEqual([]);
    expect(onBattlefield('Lab Bird')).toHaveLength(1);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('champion-of-lambholt-viewer-weaker-cant-block', steps);
  });
});

describe('Pramikon, Sky Rampart Card Test Lab scenario', () => {
  it('pramikon-viewer-nearest-opponent — after choosing right, Lab Servo is offered only P4 as a defender and hits it', () => {
    const steps: Step[] = [
      { action: 'Cast Pramikon, Sky Rampart' },
      { action: 'Right' },
      { action: 'Declare attackers', targets: ['P4'] },
    ];
    const offers: string[][] = [];
    const { scenario, state, seat, offered } = run(
      'pramikon-viewer-nearest-opponent',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P1' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offered).toContainEqual(['Left', 'Right']);
    expect(offers).toEqual([['P4', '__no_attack__']]);
    expect(seat('P4').life).toBe(39);
    expect(seat('P2').life).toBe(40);
    expect(seat('P3').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('pramikon-viewer-nearest-opponent', steps);
  });
});

describe('Teyo, Geometric Tactician Card Test Lab scenario', () => {
  it('teyo-viewer-minus-two-direction — after the −2 chooses right, Lab Servo is offered only P4 as a defender and hits it', () => {
    const steps: Step[] = [
      { action: '−2: Choose left or right' },
      { action: 'Right' },
      { action: 'Declare attackers', targets: ['P4'] },
    ];
    const offers: string[][] = [];
    const { scenario, state, seat, offered } = run(
      'teyo-viewer-minus-two-direction',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (request.decidingPlayer === 'P1' && declare !== undefined)
          for (const slot of declare.targets ?? []) offers.push(slot.options);
      },
    );
    expect(offered).toContainEqual(['Left', 'Right']);
    expect(offers).toEqual([['P4', '__no_attack__']]);
    expect(seat('P4').life).toBe(39);
    expect(seat('P2').life).toBe(40);
    expect(seat('P3').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('teyo-viewer-minus-two-direction', steps);
  });
});

describe('Teyo, Geometric Tactician draw Card Test Lab scenario', () => {
  it('teyo-viewer-wall-and-plus-one — casting Teyo makes a Wall, and the +1 draws a card for you and P2 only', () => {
    const steps: Step[] = [
      { action: 'Cast Teyo, Geometric Tactician' },
      { action: '+1: You and target opponent each draw a card', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield } = run('teyo-viewer-wall-and-plus-one', steps);
    expect(onBattlefield('Wall')).toHaveLength(1);
    expect(seat('P1').hand).toHaveLength(1);
    expect(seat('P2').hand).toHaveLength(1);
    expect(seat('P3').hand).toHaveLength(0);
    expect(seat('P4').hand).toHaveLength(0);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('teyo-viewer-wall-and-plus-one', steps);
  });
});

describe('Triarch Stalker Card Test Lab scenario', () => {
  it('triarch-stalker-viewer-menace — after choosing P2, a lone Lab Servo cannot block the menace attacker, so P2 takes 1', () => {
    const steps: Step[] = [
      { action: 'P2' },
      { action: 'Declare attackers', targets: ['__no_attack__', 'P2'] },
    ];
    const rejections: string[] = [];
    const { scenario, state, seat, offered, onBattlefield } = run(
      'triarch-stalker-viewer-menace',
      steps,
      (request) => {
        if (/fix the flagged problem/.test(request.prompt ?? '')) rejections.push(request.prompt);
      },
    );
    expect(offered).toContainEqual(['P2', 'P3', 'P4']);
    expect(rejections.length).toBeGreaterThan(0);
    expect(seat('P2').life).toBe(39);
    expect(onBattlefield('Lab Servo')).toHaveLength(2);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('triarch-stalker-viewer-menace', steps);
  });
});

describe("Illusionist's Gambit Card Test Lab scenario", () => {
  it('illusionists-gambit-viewer-remove-and-redirect — the attackers are removed before damage, and in the additional combat they must attack someone other than you', () => {
    const steps: Step[] = [{ action: "Cast Illusionist's Gambit" }];
    const { scenario, state, seat } = run('illusionists-gambit-viewer-remove-and-redirect', steps);
    expect(seat('P1').life).toBe(40);
    expect(seat('P2').life).toBe(40);
    // Lab Ox (4) and Lab Servo (1) both hit the first player they were offered besides you.
    expect(seat('P3').life + seat('P4').life).toBe(75);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('illusionists-gambit-viewer-remove-and-redirect', steps);
  });
});

describe('Moraug, Fury of Akoum Card Test Lab scenario', () => {
  it('moraug-viewer-landfall-extra-combat — landfall adds a combat that untaps Lab Ox, and each attacker is pumped once for its one attack', () => {
    const steps: Step[] = [
      { action: 'Play Forest' },
      { action: 'Declare attackers', targets: ['P2', 'P2'] },
    ];
    const declarations: number[] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'moraug-viewer-landfall-extra-combat',
      steps,
      (request) => {
        const declare = request.legalActions.find((action) =>
          action.description.startsWith('Declare attackers'),
        );
        if (declare !== undefined) declarations.push(declare.targets?.length ?? 0);
      },
    );
    // Two attackers offered once: Lab Ox was untapped by the additional combat, and after it both
    // stay tapped for the regular combat.
    expect(declarations).toEqual([2]);
    expect(seat('P2').life).toBe(28);
    expect(onBattlefield('Lab Ox')[0]?.tapped).toBe(true);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('moraug-viewer-landfall-extra-combat', steps);
  });
});

describe("Siren's Call Card Test Lab scenario", () => {
  it('sirens-call-viewer-attack-or-die — the attackers attack P3 and the tapped Lab Bird that did not is destroyed at the end step', () => {
    const steps: Step[] = [{ action: "Cast Siren's Call" }];
    const { scenario, state, seat, onBattlefield } = run('sirens-call-viewer-attack-or-die', steps);
    expect(seat('P3').life).toBe(35);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(onBattlefield('Lab Servo')).toHaveLength(1);
    expect(onBattlefield('Lab Bird')).toHaveLength(0);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('sirens-call-viewer-attack-or-die', steps);
  });
});

describe("War's Toll Card Test Lab scenario", () => {
  it('wars-toll-viewer-taps-lands-and-forces-attack — the Forest P2 taps for mana taps all its lands, and its attack with one creature becomes an attack with both', () => {
    const steps: Step[] = [];
    const { scenario, state, seat } = run('wars-toll-viewer-taps-lands-and-forces-attack', steps);
    const forests = state.battlefield.filter(
      (perm) => perm.controllerId === 'P2' && perm.name === 'Forest',
    );
    expect(forests).toHaveLength(3);
    expect(forests.every((perm) => perm.tapped)).toBe(true);
    // Lab Ox hit you; the engine added Lab Servo, pointing it at the first free opponent, P3.
    expect(seat('P1').life).toBe(36);
    expect(seat('P3').life).toBe(39);
    expect(state.eventLog.filter((event) => event.type === 'attack')).toHaveLength(2);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('wars-toll-viewer-taps-lands-and-forces-attack', steps);
  });
});
