/**
 * Coverage PR02 Card Test Lab scenarios (docs/plans/card-coverage-chunks.md), driven headlessly
 * through the same Engine the real viewer session uses. The Playwright spec drives the identical
 * scenarios through the real frontend; this suite pins their authoritative outcomes and replay.
 */
import type { DecisionRequest } from '@mtg/shared';
import { formatPlayerLog } from '@mtg/engine';
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

describe('Endless Atlas Card Test Lab scenarios', () => {
  const steps: Step[] = [{ action: 'Endless Atlas: {2}, {T}: Draw a card.' }];

  it('endless-atlas-viewer-same-name-draw — three Forests unlock the {2}, {T} draw', () => {
    const { seat, onBattlefield, offered } = run('endless-atlas-viewer-same-name-draw', steps);
    expect(offered.flat().some((action) => action.includes('Endless Atlas'))).toBe(true);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Atlas Drawn Page']);
    expect(onBattlefield('Endless Atlas')[0]?.tapped).toBe(true);
    expect(onBattlefield('Forest').filter((land) => land.tapped)).toHaveLength(2);
    replays('endless-atlas-viewer-same-name-draw', steps);
  });

  it('endless-atlas-viewer-mixed-names-blocked — no activation without three same-name lands', () => {
    const { seat, onBattlefield, offered } = run('endless-atlas-viewer-mixed-names-blocked', []);
    expect(offered.flat().some((action) => action.includes('Endless Atlas'))).toBe(false);
    expect(seat('P1').hand).toEqual([]);
    expect(onBattlefield('Endless Atlas')[0]?.tapped).toBe(false);
  });
});

describe('Sceptre of Eternal Glory Card Test Lab scenarios', () => {
  it('sceptre-of-eternal-glory-viewer-three-black — three Forests unlock three black mana', () => {
    const steps: Step[] = [{ action: 'Cast Lab Black Ogre' }];
    const { seat, onBattlefield } = run('sceptre-of-eternal-glory-viewer-three-black', steps);
    expect(onBattlefield('Lab Black Ogre')).toHaveLength(1);
    expect(onBattlefield('Sceptre of Eternal Glory')[0]?.tapped).toBe(true);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Black Bear']);
    replays('sceptre-of-eternal-glory-viewer-three-black', steps);
  });

  it('sceptre-of-eternal-glory-viewer-one-mana — mixed lands leave only one mana of any color', () => {
    const steps: Step[] = [{ action: 'Cast Lab Black Bear' }];
    const { seat, onBattlefield, offered } = run('sceptre-of-eternal-glory-viewer-one-mana', steps);
    expect(offered.flat().some((action) => action.includes('Cast Lab Black Ogre'))).toBe(false);
    expect(onBattlefield('Lab Black Bear')).toHaveLength(1);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Black Ogre']);
    replays('sceptre-of-eternal-glory-viewer-one-mana', steps);
  });
});

describe('Weathered Wayfarer Card Test Lab scenarios', () => {
  const steps: Step[] = [
    { action: 'Weathered Wayfarer: {W}, {T}: Search your library' },
    { action: 'Put Wayfarer Revealed Land into your hand' },
  ];

  it('weathered-wayfarer-viewer-reveal-land — behind on lands, the search reveals a land into hand', () => {
    const { state, seat, onBattlefield } = run('weathered-wayfarer-viewer-reveal-land', steps);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Wayfarer Revealed Land']);
    expect(onBattlefield('Weathered Wayfarer')[0]?.tapped).toBe(true);
    expect(state.eventLog.find((event) => event.type === 'searchFound')?.payload).toMatchObject({
      name: 'Wayfarer Revealed Land',
      to: 'hand',
      revealed: true,
    });
    replays('weathered-wayfarer-viewer-reveal-land', steps);
  });

  it('weathered-wayfarer-viewer-equal-lands-blocked — equal land counts offer no activation', () => {
    const { seat, onBattlefield, offered } = run(
      'weathered-wayfarer-viewer-equal-lands-blocked',
      [],
    );
    expect(offered.flat().some((action) => action.includes('Weathered Wayfarer'))).toBe(false);
    expect(seat('P1').hand).toEqual([]);
    expect(onBattlefield('Weathered Wayfarer')[0]?.tapped).toBe(false);
  });
});

describe('Idol of Oblivion Card Test Lab scenarios', () => {
  const drawSteps: Step[] = [
    { action: 'Lab Token Maker: {1}: Create a 1/1 colorless Servo' },
    { action: 'Idol of Oblivion: {T}: Draw a card.' },
  ];

  it('idol-of-oblivion-viewer-token-then-draw — the draw unlocks only after a token is created', () => {
    const { seat, onBattlefield, offered } = run(
      'idol-of-oblivion-viewer-token-then-draw',
      drawSteps,
    );
    expect(offered[0]?.some((action) => action.includes('Idol of Oblivion: {T}: Draw'))).toBe(
      false,
    );
    expect(onBattlefield('Servo')).toHaveLength(1);
    expect(onBattlefield('Idol of Oblivion')[0]?.tapped).toBe(true);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Idol Drawn Page']);
    replays('idol-of-oblivion-viewer-token-then-draw', drawSteps);
  });

  const eldraziSteps: Step[] = [{ action: 'Create a 10/10 colorless Eldrazi' }];

  it('idol-of-oblivion-viewer-eldrazi — {8}, {T}, sacrifice: a 10/10 Eldrazi creature token', () => {
    const { seat, onBattlefield } = run('idol-of-oblivion-viewer-eldrazi', eldraziSteps);
    expect(onBattlefield('Idol of Oblivion')).toEqual([]);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Idol of Oblivion']);
    expect(onBattlefield('Eldrazi')[0]).toMatchObject({ power: 10, toughness: 10 });
    replays('idol-of-oblivion-viewer-eldrazi', eldraziSteps);
  });
});

describe('Mistveil Plains Card Test Lab scenarios', () => {
  const steps: Step[] = [
    { action: 'on the bottom of your library', targets: ['Mistveil Buried Card'] },
  ];

  it('mistveil-plains-viewer-bottom-of-library — the targeted graveyard card goes under the library', () => {
    const { seat, onBattlefield } = run('mistveil-plains-viewer-bottom-of-library', steps);
    expect(seat('P1').graveyard).toEqual([]);
    expect(seat('P1').library.map((card) => card.name)).toEqual([
      'Mistveil Library Top',
      'Mistveil Buried Card',
    ]);
    expect(onBattlefield('Mistveil Plains')[0]?.tapped).toBe(true);
    replays('mistveil-plains-viewer-bottom-of-library', steps);
  });

  it('mistveil-plains-viewer-one-white-blocked — one white permanent offers no activation', () => {
    const { seat, offered } = run('mistveil-plains-viewer-one-white-blocked', []);
    expect(offered.flat().some((action) => action.includes('on the bottom of your library'))).toBe(
      false,
    );
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Mistveil Buried Card']);
  });
});

describe('Carrion Feeder Card Test Lab scenarios', () => {
  const sacrificeSteps: Step[] = [
    { action: 'Carrion Feeder: Sacrifice a creature' },
    { action: 'Sacrifice Lab Thrull' },
    // Let the first activation resolve before activating again.
    { action: 'Pass priority' },
    { action: 'Carrion Feeder: Sacrifice a creature' },
    { action: 'Sacrifice Carrion Feeder' },
  ];

  it('carrion-feeder-viewer-sacrifice — sacrifices another creature for a counter, then itself', () => {
    const { seat, onBattlefield, state } = run('carrion-feeder-viewer-sacrifice', sacrificeSteps);
    expect(onBattlefield('Carrion Feeder')).toEqual([]);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Carrion Feeder', 'Lab Thrull']);
    // The first activation's counter lands on the Feeder; the second has no Feeder to grow.
    expect(
      state.eventLog.filter((event) => event.type === 'counters').map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ target: 'Carrion Feeder', counter: '+1/+1', added: 1, total: 1 }),
    ]);
    replays('carrion-feeder-viewer-sacrifice', sacrificeSteps);
  });

  const blockSteps: Step[] = [
    { action: 'Declare attackers', targets: ['P1'] },
    { action: 'Declare blockers', targets: ['__no_block__'] },
  ];

  it('carrion-feeder-viewer-cant-block — only Lab Thrull is eligible to block; the Feeder never is', () => {
    const { seat, offered } = run('carrion-feeder-viewer-cant-block', blockSteps);
    const block = offered.find((options) => options.some((o) => o.startsWith('Declare blockers')))!;
    expect(block).toContain('Declare blockers (1 eligible creature)');
    expect(seat('P1').life).toBe(36);
    replays('carrion-feeder-viewer-cant-block', blockSteps);
  });
});

describe('Nullmage Shepherd Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Tap four untapped creatures you control', targets: ['Lab Hex'] },
  ];

  it('nullmage-shepherd-viewer-tap-four — taps itself and three Thrulls to destroy Lab Hex', () => {
    const { seat, onBattlefield } = run('nullmage-shepherd-viewer-tap-four', steps);
    expect(onBattlefield('Lab Hex')).toEqual([]);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Hex']);
    expect(onBattlefield('Nullmage Shepherd')[0]?.tapped).toBe(true);
    expect(onBattlefield('Lab Thrull').every((thrull) => thrull.tapped)).toBe(true);
    replays('nullmage-shepherd-viewer-tap-four', steps);
  });
});

describe('Sage of Fables Card Test Lab scenario', () => {
  const steps: Step[] = [
    { action: 'Cast Lab Wizard' },
    { action: 'Sage of Fables: {2}, Remove a +1/+1 counter' },
  ];

  it('sage-of-fables-viewer-wizard-counter-draw — the Wizard enters with a counter that then pays for the draw', () => {
    const { seat, onBattlefield, state } = run('sage-of-fables-viewer-wizard-counter-draw', steps);
    expect(onBattlefield('Lab Wizard')[0]?.counters['+1/+1'] ?? 0).toBe(0);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Sage Drawn Page']);
    const counterEvents = state.eventLog
      .filter((event) => event.type === 'counters')
      .map((event) => event.payload);
    // Entering with the counter is not a "counters" event; removing it to pay the cost is, and
    // leaves zero — so the Wizard entered with exactly one.
    expect(counterEvents).toEqual([
      expect.objectContaining({ target: 'Lab Wizard', counter: '+1/+1', added: -1, total: 0 }),
    ]);
    replays('sage-of-fables-viewer-wizard-counter-draw', steps);
  });
});

describe('Illuminor Szeras Card Test Lab scenario', () => {
  const steps: Step[] = [{ action: 'Cast Lab Black Ogre' }];

  it('illuminor-szeras-viewer-sacrifice-for-black — sacrifices Lab Ox for four black to cast the Ogre', () => {
    const { seat, onBattlefield } = run('illuminor-szeras-viewer-sacrifice-for-black', steps);
    expect(onBattlefield('Lab Black Ogre')).toHaveLength(1);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(onBattlefield('Illuminor Szeras')[0]?.tapped).toBe(true);
    replays('illuminor-szeras-viewer-sacrifice-for-black', steps);
  });
});

describe('Peema Trailblazer Card Test Lab scenarios', () => {
  const exhaustSteps: Step[] = [{ action: 'Exhaust' }];

  it('peema-trailblazer-viewer-exhaust — two counters, five cards, and the ability is gone', () => {
    const { seat, onBattlefield, offered } = run('peema-trailblazer-viewer-exhaust', exhaustSteps);
    expect(onBattlefield('Peema Trailblazer')[0]?.counters['+1/+1']).toBe(2);
    expect(seat('P1').hand).toHaveLength(5);
    expect(seat('P1').energy).toBe(0);
    expect(offered.filter((options) => options.some((o) => o.includes('Exhaust')))).toHaveLength(1);
    replays('peema-trailblazer-viewer-exhaust', exhaustSteps);
  });

  const combatSteps: Step[] = [{ action: 'Declare attackers', targets: ['P2'] }];

  it('peema-trailblazer-viewer-combat-energy — three combat damage to P2 gives three energy', () => {
    const { seat, scenario } = run('peema-trailblazer-viewer-combat-energy', combatSteps);
    expect(seat('P2').life).toBe(37);
    expect(seat('P1').energy).toBe(3);
    const peema = scenario.engine
      .view('P1')
      .battlefield.find((permanent) => permanent.name === 'Peema Trailblazer');
    expect(peema?.keywords).toContain('trample');
    replays('peema-trailblazer-viewer-combat-energy', combatSteps);
  });
});

describe('Soul-Guide Lantern Card Test Lab scenarios', () => {
  it('soul-guide-lantern-viewer-enters-exile — the enters trigger exiles the chosen graveyard card', () => {
    const steps: Step[] = [
      { action: 'Cast Soul-Guide Lantern' },
      { action: 'Targets for Soul-Guide Lantern', targets: ['Lantern P2 Card'] },
    ];
    const { state, seat } = run('soul-guide-lantern-viewer-enters-exile', steps);
    expect(seat('P2').graveyard).toEqual([]);
    expect(seat('P3').graveyard.map((card) => card.name)).toEqual(['Lantern P3 Card']);
    expect(state.exile.map((card) => card.name)).toEqual(['Lantern P2 Card']);
    replays('soul-guide-lantern-viewer-enters-exile', steps);
  });

  it("soul-guide-lantern-viewer-exile-graveyards — {T}, sacrifice: both opponents' graveyards are exiled", () => {
    const steps: Step[] = [{ action: "Exile each opponent's graveyard" }];
    const { state, seat, onBattlefield } = run('soul-guide-lantern-viewer-exile-graveyards', steps);
    expect(seat('P2').graveyard).toEqual([]);
    expect(seat('P3').graveyard).toEqual([]);
    expect(state.exile.map((card) => card.name).sort()).toEqual([
      'Lantern P2 Card',
      'Lantern P3 Card',
    ]);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Soul-Guide Lantern']);
    expect(onBattlefield('Forest')[0]?.tapped).toBe(false);
    replays('soul-guide-lantern-viewer-exile-graveyards', steps);
  });

  it('soul-guide-lantern-viewer-draw — {1}, {T}, sacrifice: draws and leaves the graveyards', () => {
    const steps: Step[] = [{ action: 'Draw a card' }];
    const { seat } = run('soul-guide-lantern-viewer-draw', steps);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lantern Drawn Page']);
    expect(seat('P2').graveyard).toHaveLength(1);
    replays('soul-guide-lantern-viewer-draw', steps);
  });
});

describe('Ghost Ark Card Test Lab scenario', () => {
  it('ghost-ark-viewer-crew-and-unearth — crewing grants unearth {3}; the Thopter returns with haste', () => {
    const steps: Step[] = [
      { action: 'Crew 2' },
      { action: 'Lab Ark Thopter (graveyard): Unearth {3}' },
    ];
    const { state, seat, onBattlefield, offered } = run('ghost-ark-viewer-crew-and-unearth', steps);
    expect(onBattlefield('Lab Giant')[0]?.tapped).toBe(true);
    const effects = state.effects.map((effect) => effect.description);
    expect(effects).toContain('Ghost Ark becomes an artifact creature until end of turn');
    expect(effects).toContain('Lab Ark Thopter gains haste until end of turn');
    expect(onBattlefield('Lab Ark Thopter')).toHaveLength(1);
    expect(onBattlefield('Forest').every((forest) => forest.tapped)).toBe(true);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Ark Spirit']);
    // Never offered before the crewed trigger resolved, and never for the non-artifact Spirit.
    expect(offered[0]?.some((action) => action.includes('Unearth'))).toBe(false);
    expect(offered.flat().some((action) => action.startsWith('Lab Ark Spirit'))).toBe(false);
    replays('ghost-ark-viewer-crew-and-unearth', steps);
  });
});

describe('Flare of Denial Card Test Lab scenario', () => {
  it("flare-of-denial-viewer-sacrifice-counter — sacrificing the Merfolk counters P2's spell", () => {
    const steps: Step[] = [{ action: 'alternate cost', targets: ['Lab Pending Spell'] }];
    const { state, seat, onBattlefield, offered } = run(
      'flare-of-denial-viewer-sacrifice-counter',
      steps,
    );
    // No lands: the alternative cost is the only way to cast it.
    expect(offered[0]?.filter((action) => action.includes('Flare of Denial'))).toEqual([
      expect.stringMatching(/alternate cost/),
    ]);
    expect(onBattlefield('Lab Blue Merfolk')).toEqual([]);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Flare of Denial', 'Lab Blue Merfolk']);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Pending Spell']);
    expect(seat('P2').hand).toEqual([]);
    expect(state.stack).toEqual([]);
    replays('flare-of-denial-viewer-sacrifice-counter', steps);
  });
});

describe('Flare of Malice Card Test Lab scenario', () => {
  it('flare-of-malice-viewer-sacrifice-edict — the Bear pays for it and P2 sacrifices Lab Ox', () => {
    const steps: Step[] = [{ action: 'alternate cost' }];
    const { seat, onBattlefield } = run('flare-of-malice-viewer-sacrifice-edict', steps);
    expect(onBattlefield('Lab Black Bear')).toEqual([]);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(onBattlefield('Lab Generic Bear')).toHaveLength(1);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Flare of Malice', 'Lab Black Bear']);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Ox']);
    replays('flare-of-malice-viewer-sacrifice-edict', steps);
  });
});

describe('Blasphemous Edict Card Test Lab scenario', () => {
  it('blasphemous-edict-viewer-pay-b — {B} casts it, and all thirteen creatures are sacrificed unasked', () => {
    const steps: Step[] = [{ action: '({B}) (alternate cost)' }];
    const { state, seat, onBattlefield, prompts } = run('blasphemous-edict-viewer-pay-b', steps);
    expect(state.battlefield.filter((perm) => perm.typeLine.includes('Creature'))).toEqual([]);
    expect(onBattlefield('Swamp')[0]?.tapped).toBe(true);
    expect(seat('P2').graveyard).toHaveLength(11);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Blasphemous Edict', 'Lab Generic Bear', 'Lab Ox']);
    expect(prompts.some((prompt) => /sacrifice/i.test(prompt))).toBe(false);
    replays('blasphemous-edict-viewer-pay-b', steps);
  });
});

describe('Dread Return Card Test Lab scenario', () => {
  it('dread-return-viewer-flashback — three Zombies pay for the flashback, Lab Ox returns, Dread Return is exiled', () => {
    const steps: Step[] = [{ action: 'from your graveyard', targets: ['Lab Ox'] }];
    const { state, seat, onBattlefield } = run('dread-return-viewer-flashback', steps);
    expect(onBattlefield('Lab Zombie')).toEqual([]);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(state.exile.map((card) => card.name)).toEqual(['Dread Return']);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual([
      'Lab Zombie',
      'Lab Zombie',
      'Lab Zombie',
    ]);
    replays('dread-return-viewer-flashback', steps);
  });
});

describe("Raffine's Guidance Card Test Lab scenario", () => {
  it('raffines-guidance-viewer-graveyard-recast — {2}{W} from the graveyard enchants Lab Ox', () => {
    const steps: Step[] = [{ action: 'from your graveyard', targets: ['Lab Ox'] }];
    const { seat, onBattlefield } = run('raffines-guidance-viewer-graveyard-recast', steps);
    const ox = onBattlefield('Lab Ox')[0]!;
    expect(onBattlefield("Raffine's Guidance")[0]?.attachedTo).toBe(ox.id);
    expect(seat('P1').graveyard).toEqual([]);
    expect(onBattlefield('Plains')[0]?.tapped).toBe(true);
    expect(onBattlefield('Forest').every((forest) => forest.tapped)).toBe(true);
    replays('raffines-guidance-viewer-graveyard-recast', steps);
  });
});

describe('Their Number Is Legion Card Test Lab scenario', () => {
  it('their-number-is-legion-viewer-graveyard-x — X=2 from the graveyard: two tapped Warriors, 2 life, exiled', () => {
    const steps: Step[] = [{ action: 'X=2' }];
    const { state, seat, onBattlefield } = run('their-number-is-legion-viewer-graveyard-x', steps);
    const tokens = onBattlefield('Necron Warrior');
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.tapped)).toBe(true);
    expect(seat('P1').life).toBe(42);
    expect(state.exile.map((card) => card.name)).toEqual(['Their Number Is Legion']);
    expect(seat('P1').graveyard).toEqual([]);
    replays('their-number-is-legion-viewer-graveyard-x', steps);
  });
});

describe('Anrakyr the Traveller Card Test Lab scenario', () => {
  it('anrakyr-the-traveller-viewer-cast-for-life — attack, accept, and cast the Golem from the graveyard for 4 life', () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Yes' },
      { action: 'Cast Lab Anrakyr Golem from your graveyard for 4 life' },
    ];
    const { seat, onBattlefield, offered } = run(
      'anrakyr-the-traveller-viewer-cast-for-life',
      steps,
    );
    expect(offered.flat()).toContain('Cast Lab Anrakyr Relic from your hand for 3 life');
    expect(onBattlefield('Lab Anrakyr Golem')).toHaveLength(1);
    expect(seat('P1').graveyard).toEqual([]);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Anrakyr Relic']);
    expect(seat('P1').life).toBe(36);
    expect(seat('P2').life).toBe(36);
    replays('anrakyr-the-traveller-viewer-cast-for-life', steps);
  });
});

describe('Toxic Deluge Card Test Lab scenario', () => {
  it('toxic-deluge-viewer-pay-two-life — X=2 costs 2 life and kills only the 1/1', () => {
    const steps: Step[] = [{ action: 'X=2' }];
    const { state, seat, onBattlefield } = run('toxic-deluge-viewer-pay-two-life', steps);
    expect(seat('P1').life).toBe(38);
    expect(onBattlefield('Lab Zombie')).toEqual([]);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(onBattlefield('Lab Giant')).toHaveLength(1);
    expect(state.effects.map((effect) => effect.description).join(' | ')).toMatch(/-2\/-2|−2\/−2/);
    replays('toxic-deluge-viewer-pay-two-life', steps);
  });
});

describe('Conclave Tribunal Card Test Lab scenario', () => {
  it('conclave-tribunal-viewer-convoke — the Plains and three convoked creatures pay for it; the Relic is exiled', () => {
    const steps: Step[] = [{ action: 'Cast Conclave Tribunal' }];
    const { state, onBattlefield } = run('conclave-tribunal-viewer-convoke', steps);
    for (const name of ['Plains', 'Lab Ox', 'Lab Generic Bear', 'Lab Zombie']) {
      expect(onBattlefield(name)[0]?.tapped, name).toBe(true);
    }
    expect(onBattlefield('Conclave Tribunal')).toHaveLength(1);
    expect(onBattlefield('Lab Anrakyr Relic')).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Anrakyr Relic']);
    replays('conclave-tribunal-viewer-convoke', steps);
  });
});

describe('Hour of Reckoning Card Test Lab scenario', () => {
  it('hour-of-reckoning-viewer-convoke — three Plains and four convoked creatures pay; every nontoken creature dies', () => {
    const steps: Step[] = [{ action: 'Cast Hour of Reckoning' }];
    const { state, onBattlefield } = run('hour-of-reckoning-viewer-convoke', steps);
    expect(state.battlefield.filter((perm) => perm.typeLine.includes('Creature'))).toEqual([]);
    expect(onBattlefield('Plains').every((land) => land.tapped)).toBe(true);
    replays('hour-of-reckoning-viewer-convoke', steps);
  });
});

describe('Killian, Ink Duelist Card Test Lab scenario', () => {
  it('killian-ink-duelist-viewer-reduced-bolt — the bolt costs {R} at a creature', () => {
    const steps: Step[] = [{ action: 'reduced for target slot 1', targets: ['Lab Ox'] }];
    const { onBattlefield, offered } = run('killian-ink-duelist-viewer-reduced-bolt', steps);
    expect(offered[0]?.filter((action) => action.includes('Lab Killian Bolt'))).toEqual([
      expect.stringMatching(/\{R\}.*reduced for target slot 1/),
    ]);
    expect(onBattlefield('Lab Ox')[0]?.damageMarked).toBe(2);
    expect(onBattlefield('Mountain')[0]?.tapped).toBe(true);
    replays('killian-ink-duelist-viewer-reduced-bolt', steps);
  });
});

describe('Dragonkin Berserker Card Test Lab scenario', () => {
  it('dragonkin-berserker-viewer-reduced-boast — after attacking, Boast costs {2}{R} with two Dragons', () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2', '__no_attack__', '__no_attack__'] },
      { action: 'Create a 5/5 red Dragon' },
    ];
    const { seat, onBattlefield } = run('dragonkin-berserker-viewer-reduced-boast', steps);
    expect(onBattlefield('Dragon')).toHaveLength(1);
    expect(
      ['Mountain', 'Forest'].every((name) => onBattlefield(name).every((land) => land.tapped)),
    ).toBe(true);
    expect(seat('P2').life).toBe(38);
    replays('dragonkin-berserker-viewer-reduced-boast', steps);
  });
});

describe('Convergence of Dominion Card Test Lab scenario', () => {
  it('convergence-of-dominion-viewer-cheap-unearth — with the commander out, Unearth {3} costs {1}', () => {
    const steps: Step[] = [{ action: 'Lab Unearth Warrior (graveyard): Unearth' }];
    const { seat, onBattlefield } = run('convergence-of-dominion-viewer-cheap-unearth', steps);
    expect(onBattlefield('Lab Unearth Warrior')).toHaveLength(1);
    expect(seat('P1').graveyard).toEqual([]);
    expect(onBattlefield('Forest')[0]?.tapped).toBe(true);
    replays('convergence-of-dominion-viewer-cheap-unearth', steps);
  });
});

describe('Kogla and Yidaro Card Test Lab scenarios', () => {
  it('kogla-and-yidaro-viewer-enter-fight — cast it, choose the fight, Lab Ox dies', () => {
    const steps: Step[] = [
      { action: 'Cast Kogla and Yidaro' },
      { action: 'fights target creature' },
    ];
    const { onBattlefield } = run('kogla-and-yidaro-viewer-enter-fight', steps);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(onBattlefield('Kogla and Yidaro')[0]?.damageMarked).toBe(4);
    replays('kogla-and-yidaro-viewer-enter-fight', steps);
  });

  it('kogla-and-yidaro-viewer-discard — discard it to destroy the Relic, shuffle it in, draw', () => {
    const steps: Step[] = [
      { action: 'Kogla and Yidaro (hand)' },
      { action: 'Target Lab Anrakyr Relic' },
    ];
    const { seat, onBattlefield } = run('kogla-and-yidaro-viewer-discard', steps);
    expect(onBattlefield('Lab Anrakyr Relic')).toEqual([]);
    expect(seat('P1').graveyard).toEqual([]);
    expect(seat('P1').hand).toHaveLength(1);
    replays('kogla-and-yidaro-viewer-discard', steps);
  });
});

describe('Changing Loyalty Card Test Lab scenarios', () => {
  it('changing-loyalty-viewer-replicate — replicate once; the copy enchants the Bear as a token', () => {
    const steps: Step[] = [
      { action: 'Cast Changing Loyalty ({3}{B}) — replicate 1', targets: ['Lab Ox'] },
      { action: 'Target Lab Generic Bear' },
    ];
    const { state, onBattlefield } = run('changing-loyalty-viewer-replicate', steps);
    const ox = onBattlefield('Lab Ox')[0]!;
    const bear = onBattlefield('Lab Generic Bear')[0]!;
    const auras = onBattlefield('Changing Loyalty');
    expect(auras).toHaveLength(2);
    // The engine state carries `isToken` beyond the shared permanent shape.
    const isToken = (aura: (typeof auras)[number] | undefined) =>
      (aura as { isToken?: boolean } | undefined)?.isToken;
    expect(isToken(auras.find((aura) => aura.attachedTo === ox.id))).toBe(false);
    expect(isToken(auras.find((aura) => aura.attachedTo === bear.id))).toBe(true);
    expect(state.battlefield.filter((perm) => perm.name === 'Swamp').every((s) => s.tapped)).toBe(
      true,
    );
    replays('changing-loyalty-viewer-replicate', steps);
  });

  it('changing-loyalty-viewer-steal — the enchanted Lab Ox dies and returns under your control', () => {
    const steps: Step[] = [
      { action: 'Cast Changing Loyalty ({1}{B})', targets: ['Lab Ox'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Ox'] },
    ];
    const { seat, onBattlefield } = run('changing-loyalty-viewer-steal', steps);
    expect(onBattlefield('Lab Ox')).toEqual([
      expect.objectContaining({ controllerId: 'P1', ownerId: 'P2' }),
    ]);
    expect(onBattlefield('Changing Loyalty')).toEqual([]);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Changing Loyalty', 'Lab Doom']);
    replays('changing-loyalty-viewer-steal', steps);
  });
});

describe('Grim Haruspex Card Test Lab scenario', () => {
  it('grim-haruspex-viewer-morph — cast it face down, turn it face up, and draw when Lab Zombie dies', () => {
    const steps: Step[] = [
      { action: 'Cast Grim Haruspex face down for {3}' },
      { action: 'Turn Grim Haruspex face up ({B})' },
      { action: 'Cast Lab Doom', targets: ['Lab Zombie'] },
    ];
    const { scenario, seat, onBattlefield } = run('grim-haruspex-viewer-morph', steps);
    const haruspex = onBattlefield('Grim Haruspex');
    expect(haruspex).toHaveLength(1);
    expect((haruspex[0] as { faceDown?: boolean }).faceDown).toBe(false);
    expect(onBattlefield('Lab Zombie')).toEqual([]);
    // Lab Doom left the hand; the Haruspex trigger drew the last Swamp.
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Swamp']);
    // Opponents read the cast by its public description, and learn the name only once it is
    // turned face up.
    const opponentLog = formatPlayerLog(scenario.engine.eventsSince(0), 'P2').map(
      (line) => line.text,
    );
    expect(opponentLog).toContain('Cast a face-down creature spell for {3}');
    const turned = opponentLog.indexOf('turns Grim Haruspex face up');
    expect(turned).toBeGreaterThan(0);
    expect(opponentLog.slice(0, turned).some((line) => line.includes('Grim Haruspex'))).toBe(false);
    replays('grim-haruspex-viewer-morph', steps);
  });
});

describe('Dream Devourer Card Test Lab scenarios', () => {
  it('dream-devourer-viewer-foretell — foretell the Bolt face down; the Devourer gets +2/+0', () => {
    const steps: Step[] = [{ action: 'Foretell Lab Foretell Bolt ({2})' }];
    const { scenario, state, seat, onBattlefield } = run('dream-devourer-viewer-foretell', steps);
    expect(seat('P1').hand).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Foretell Bolt']);
    expect(onBattlefield('Mountain').every((land) => land.tapped)).toBe(true);
    // Opponents read only that a card was foretold.
    const opponentLog = formatPlayerLog(scenario.engine.eventsSince(0), 'P2').map(
      (line) => line.text,
    );
    expect(opponentLog).toContain('Foretell a card ({2})');
    expect(opponentLog.some((line) => line.includes('Lab Foretell Bolt'))).toBe(false);
    expect(opponentLog.some((line) => /Dream Devourer.*resolves/.test(line))).toBe(true);
    replays('dream-devourer-viewer-foretell', steps);
  });

  it('dream-devourer-viewer-foretold-cast — the foretold Bolt is cast from exile for {R}', () => {
    const steps: Step[] = [{ action: 'Cast Lab Foretell Bolt ({R}) (foretold)', targets: ['P2'] }];
    const { state, seat } = run('dream-devourer-viewer-foretold-cast', steps);
    expect(seat('P2').life).toBe(38);
    expect(state.exile).toEqual([]);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Foretell Bolt']);
    replays('dream-devourer-viewer-foretold-cast', steps);
  });
});
