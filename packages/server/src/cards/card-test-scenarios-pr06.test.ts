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

describe('Brash Taunter Card Test Lab scenario', () => {
  it('brash-taunter-viewer-fight-and-reflect — fighting Lab Ox, the indestructible Taunter survives 4 damage and reflects exactly 4 at P3', () => {
    const steps: Step[] = [
      { action: 'Brash Taunter: This creature fights', targets: ['Lab Ox'] },
      { action: 'Targets for Brash Taunter', targets: ['P3'] },
    ];
    const targetOptions: string[][] = [];
    const { scenario, state, seat, onBattlefield } = run(
      'brash-taunter-viewer-fight-and-reflect',
      steps,
      (request, current) => {
        const names = objectNames(current);
        for (const action of request.legalActions) {
          const slot = action.targets?.[0];
          if (slot !== undefined && slot !== null)
            targetOptions.push(slot.options.map((id) => names.get(id) ?? id).sort());
        }
      },
    );
    // The fight offered the other creatures only (never the Taunter), then the reflection offered
    // the three opponents only (never its controller).
    expect(targetOptions).toEqual([
      ['Lab Ox', 'Lab Servo'],
      ['P2', 'P3', 'P4'],
    ]);
    const [taunter] = onBattlefield('Brash Taunter');
    expect(taunter?.damageMarked).toBe(4);
    expect(taunter?.tapped).toBe(true);
    expect(onBattlefield('Lab Ox')[0]?.damageMarked).toBe(1);
    expect(onBattlefield('Lab Servo')[0]?.damageMarked).toBe(0);
    const reflected = state.eventLog.filter(
      (event) => event.type === 'damage' && event.payload['target'] === 'P3',
    );
    expect(reflected.map((event) => event.payload)).toMatchObject([
      { controller: 'P1', amount: 4 },
    ]);
    expect(String(reflected[0]?.payload['source'])).toContain('Brash Taunter');
    expect(seat('P3').life).toBe(36);
    for (const id of ['P1', 'P2', 'P4']) expect(seat(id).life).toBe(40);
    expect(onBattlefield('Mountain').filter((mountain) => mountain.tapped)).toHaveLength(3);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('brash-taunter-viewer-fight-and-reflect', steps);
  });
});

describe('Tomb Blade Card Test Lab scenario', () => {
  it('tomb-blade-viewer-sacrifice-or-lose — each damaged player alone chooses: P2 declines and loses 3, P3 sacrifices Lab Servo and loses nothing more', () => {
    const steps: Step[] = [
      { action: 'Unearth' },
      { action: 'Declare attackers', targets: ['P2', 'P3'] },
    ];
    const asked: Array<{ player: string; prompt: string }> = [];
    const { scenario, state, seat, onBattlefield } = run(
      'tomb-blade-viewer-sacrifice-or-lose',
      steps,
      (request) => {
        if (request.legalActions.some((action) => action.type === 'decline'))
          asked.push({ player: request.decidingPlayer, prompt: request.prompt ?? '' });
      },
    );
    // Only the two damaged players were asked, each with their own creature count.
    expect(asked.map((entry) => entry.player).sort()).toEqual(['P2', 'P3']);
    expect(asked.find((entry) => entry.player === 'P2')?.prompt).toMatch(/lose 3 life/);
    expect(asked.find((entry) => entry.player === 'P3')?.prompt).toMatch(/lose 2 life/);
    expect(seat('P2').life).toBe(40 - 5 - 3);
    expect(seat('P3').life).toBe(40 - 5);
    expect(seat('P4').life).toBe(40);
    expect(seat('P1').life).toBe(40);
    const creaturesOf = (id: string) =>
      state.battlefield
        .filter((perm) => perm.controllerId === id && perm.typeLine.includes('Creature'))
        .map((perm) => perm.name)
        .sort();
    expect(creaturesOf('P2')).toEqual(['Lab Bird', 'Lab Ox', 'Lab Servo']);
    expect(creaturesOf('P3')).toEqual(['Lab Ox']);
    expect(seat('P3').graveyard.map((card) => card.name)).toEqual(['Lab Servo']);
    expect(onBattlefield('Tomb Blade')).toHaveLength(2);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('tomb-blade-viewer-sacrifice-or-lose', steps);
  });
});

describe("Duelist's Heritage Card Test Lab scenario", () => {
  it('duelists-heritage-viewer-double-strike-attacker — one trigger for the two-creature attack, only the attackers on offer, and Lab Servo strikes twice', () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2', 'P2'] },
      { action: 'Targets for', targets: ['Lab Servo'] },
      { action: 'Yes' },
    ];
    const targetOptions: string[][] = [];
    let mayPrompts = 0;
    const { scenario, state, seat, onBattlefield } = run(
      'duelists-heritage-viewer-double-strike-attacker',
      steps,
      (request, current) => {
        const slots = request.legalActions.find((action) =>
          /^Targets for Duelist/.test(action.description),
        )?.targets;
        if (slots !== undefined && slots !== null) {
          const live = current.engine.getState().battlefield;
          targetOptions.push(
            slots[0]!.options.map((id) => {
              const perm = live.find((candidate) => candidate.id === id);
              return `${perm?.controllerId}:${perm?.name}`;
            }),
          );
        }
        if (request.legalActions.some((action) => action.type === 'acceptTrigger')) mayPrompts++;
      },
    );
    // One target prompt and one "you may" for the whole attack, offering only P1's two attackers.
    expect(targetOptions).toHaveLength(1);
    expect([...targetOptions[0]!].sort()).toEqual(['P1:Lab Ox', 'P1:Lab Servo']);
    expect(mayPrompts).toBe(1);
    const [servo] = onBattlefield('Lab Servo').filter((perm) => perm.controllerId === 'P1');
    const chars = computeCharacteristics(
      (scenario.engine as unknown as { ctx: GameContext }).ctx,
      servo as unknown as EnginePermanent,
    );
    expect(chars.keywords).toContain('double strike');
    // Lab Ox 4 + Lab Servo 1 in each of two damage steps.
    expect(seat('P2').life).toBe(40 - 4 - 2);
    expect(seat('P3').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('duelists-heritage-viewer-double-strike-attacker', steps);
  });
});

describe('Thunderbreak Regent Card Test Lab scenario', () => {
  it("thunderbreak-regent-viewer-opponent-targets-dragon — P2's Lab Doom on the Regent makes the Regent deal 3 to P2 first, then destroys it", () => {
    const steps: Step[] = [{ action: 'Play Forest' }];
    const { scenario, state, seat, onBattlefield } = run(
      'thunderbreak-regent-viewer-opponent-targets-dragon',
      steps,
    );
    const damage = state.eventLog.filter((event) => event.type === 'damage');
    expect(damage).toHaveLength(1);
    expect(damage[0]?.payload).toMatchObject({
      controller: 'P1',
      target: 'P2',
      amount: 3,
      sourceCardId: 'c-1',
    });
    expect(String(damage[0]?.payload['source'])).toContain('Thunderbreak Regent');
    expect(seat('P2').life).toBe(37);
    for (const id of ['P1', 'P3', 'P4']) expect(seat(id).life).toBe(40);
    // The trigger resolved above Lab Doom, which then destroyed the Regent.
    expect(onBattlefield('Thunderbreak Regent')).toEqual([]);
    expect(onBattlefield('Forest')).toHaveLength(1);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Thunderbreak Regent']);
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Doom']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('thunderbreak-regent-viewer-opponent-targets-dragon', steps);
  });
});

describe('Invisible Woman Card Test Lab scenario', () => {
  it('invisible-woman-viewer-pay-pump-unblockable — paying when Lab Ox attacks pumps it by the four creatures you control (the Wall included) and makes it unblockable, so Lab Bird cannot stop it', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Free Trinket' },
      { action: 'Declare attackers', targets: ['__no_attack__', 'P2', '__no_attack__'] },
      { action: 'Pay {' },
      { action: 'Targets for Invisible Woman', targets: ['Lab Ox'] },
    ];
    const order: string[] = [];
    let blockDecisions = 0;
    const { scenario, state, seat, onBattlefield } = run(
      'invisible-woman-viewer-pay-pump-unblockable',
      steps,
      (request) => {
        if (request.legalActions.some((action) => action.type === 'payMana')) order.push('pay');
        if (request.legalActions.some((action) => action.type === 'chooseTargets'))
          order.push('target');
        if (request.decidingPlayer === 'P2' && request.legalActions[0]?.type === 'blockDeclaration')
          blockDecisions++;
      },
    );
    // The noncreature spell earned a 0/3 Wall with defender and reach at the beginning of combat.
    const [wall] = onBattlefield('Wall');
    expect(onBattlefield('Wall')).toHaveLength(1);
    expect(
      scenario.engine.view('P1').battlefield.find((perm) => perm.name === 'Wall'),
    ).toMatchObject({ power: 0, toughness: 3 });
    expect(wall?.controllerId).toBe('P1');
    // One payment prompt for the attack, then the reflexive trigger's own target prompt.
    expect(order).toEqual(['pay', 'target']);
    expect(
      scenario.engine.view('P1').battlefield.find((perm) => perm.name === 'Lab Ox'),
    ).toMatchObject({ power: 8, toughness: 4 });
    expect(
      scenario.engine.view('P1').battlefield.find((perm) => perm.name === 'Lab Servo'),
    ).toMatchObject({ power: 1, toughness: 1 });
    // Lab Ox cannot be blocked, so Lab Bird was never offered a block and all 8 damage landed.
    expect(blockDecisions).toBe(0);
    expect(onBattlefield('Lab Bird')).toHaveLength(1);
    expect(seat('P2').life).toBe(40 - 8);
    expect(
      onBattlefield('Mountain')
        .concat(onBattlefield('Forest'), onBattlefield('Plains'), onBattlefield('Island'))
        .filter((land) => land.tapped),
    ).toHaveLength(4);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('invisible-woman-viewer-pay-pump-unblockable', steps);
  });
});

describe('Flameblast Dragon Card Test Lab scenario', () => {
  it("flameblast-dragon-viewer-target-then-pay-x — the attack trigger is aimed at P3 before the payment is asked, and paying X=3 deals 3 to P3 on top of the Dragon's 5 combat damage to P2", () => {
    const steps: Step[] = [
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Targets for Flameblast Dragon', targets: ['P3'] },
      { action: 'Pay X=3' },
    ];
    const order: string[] = [];
    let tappedAtTarget = -1;
    const { scenario, state, seat, onBattlefield } = run(
      'flameblast-dragon-viewer-target-then-pay-x',
      steps,
      (request, current) => {
        if (request.legalActions.some((action) => action.type === 'chooseTargets')) {
          order.push('target');
          tappedAtTarget = current.engine
            .getState()
            .battlefield.filter((perm) => perm.tapped && perm.name === 'Mountain').length;
        }
        if (request.legalActions.some((action) => action.description === 'Pay X=3 ({3}{R})'))
          order.push('payment');
      },
    );
    expect(order).toEqual(['target', 'payment']);
    expect(tappedAtTarget).toBe(0);
    expect(seat('P3').life).toBe(40 - 3);
    expect(seat('P2').life).toBe(40 - 5);
    expect(seat('P4').life).toBe(40);
    expect(seat('P1').life).toBe(40);
    expect(onBattlefield('Mountain').filter((land) => land.tapped)).toHaveLength(4);
    const hit = state.eventLog.find(
      (event) => event.type === 'damage' && event.payload['target'] === 'P3',
    );
    expect(hit?.payload).toMatchObject({ controller: 'P1', amount: 3 });
    expect(String(hit?.payload['source'])).toContain('Flameblast Dragon');
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('flameblast-dragon-viewer-target-then-pay-x', steps);
  });
});

describe('Territorial Aetherkite Card Test Lab scenario', () => {
  it('territorial-aetherkite-viewer-pay-energy-damage — paying both energy puts the reflexive trigger on the stack, and it kills every 1/1 but spares the Aetherkite and Lab Ox', () => {
    const steps: Step[] = [{ action: 'Cast Territorial Aetherkite' }, { action: 'Pay 2 energy' }];
    let payments = 0;
    const { scenario, state, seat, onBattlefield } = run(
      'territorial-aetherkite-viewer-pay-energy-damage',
      steps,
      (request) => {
        if (request.legalActions.some((action) => action.description === 'Pay 2 energy'))
          payments++;
      },
    );
    expect(payments).toBe(1);
    expect(seat('P1').energy).toBe(0);
    // Two triggers went on the stack in turn: the enter trigger, then, after the payment, the
    // separate reflexive trigger, which resolved before any of the damage was dealt.
    const log = state.eventLog;
    const onStack = log.filter((event) => event.type === 'triggerOnStack');
    expect(onStack).toHaveLength(2);
    expect(String(onStack[1]!.payload['description'])).toMatch(/^When you do/);
    const paid = log.findIndex(
      (event) => event.type === 'energy' && event.payload['amount'] === -2,
    );
    const reflexive = log.indexOf(onStack[1]!);
    const firstDamage = log.findIndex((event) => event.type === 'damage');
    expect(paid).toBeGreaterThan(log.indexOf(onStack[0]!));
    expect(reflexive).toBeGreaterThan(paid);
    expect(firstDamage).toBeGreaterThan(reflexive);
    expect(onBattlefield('Lab Servo')).toEqual([]);
    expect(onBattlefield('Lab Bird')).toEqual([]);
    expect(onBattlefield('Lab Ox')).toHaveLength(1);
    expect(onBattlefield('Territorial Aetherkite')).toHaveLength(1);
    const damage = log.filter((event) => event.type === 'damage');
    expect(damage).toHaveLength(4);
    for (const event of damage) {
      expect(event.payload).toMatchObject({ amount: 2 });
      expect(String(event.payload['source'])).toContain('Territorial Aetherkite');
    }
    for (const id of ['P1', 'P2', 'P3', 'P4']) expect(seat(id).life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('territorial-aetherkite-viewer-pay-energy-damage', steps);
  });
});

describe('Arcbond Card Test Lab scenario', () => {
  it('arcbond-viewer-reflect-damage — Lab Ox, dealt 2 by Lab Shock after Arcbond resolved, deals 2 to each other creature and each player, so the three 1/1s die and every player is at 38', () => {
    const steps: Step[] = [
      { action: 'Cast Arcbond', targets: ['Lab Ox'] },
      {
        action: 'Cast Lab Shock',
        targets: ['Lab Ox'],
        ready: (current) => current.engine.getState().stack.length === 0,
      },
    ];
    const { scenario, state, seat, onBattlefield } = run('arcbond-viewer-reflect-damage', steps);
    expect(onBattlefield('Lab Servo')).toEqual([]);
    expect(onBattlefield('Lab Bird')).toEqual([]);
    const [ox] = onBattlefield('Lab Ox');
    expect(ox?.damageMarked).toBe(2);
    for (const id of ['P1', 'P2', 'P3', 'P4']) expect(seat(id).life, id).toBe(38);
    const reflected = state.eventLog.filter(
      (event) => event.type === 'damage' && String(event.payload['source']).includes('Lab Ox'),
    );
    // Three creatures and four players, all dealt by Lab Ox rather than by Arcbond.
    expect(reflected).toHaveLength(7);
    expect(
      state.eventLog.some(
        (event) => event.type === 'damage' && String(event.payload['source']).includes('Arcbond'),
      ),
    ).toBe(false);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('arcbond-viewer-reflect-damage', steps);
  });
});

describe('Thundermaw Hellkite Card Test Lab scenario', () => {
  it('thundermaw-hellkite-viewer-damage-and-tap-fliers — the opposing fliers all take 1 and are tapped, the protected one takes none but is tapped, and the ground creature and your own flier are untouched', () => {
    const steps: Step[] = [{ action: 'Cast Thundermaw Hellkite' }];
    const { scenario, state, onBattlefield } = run(
      'thundermaw-hellkite-viewer-damage-and-tap-fliers',
      steps,
    );
    const sturdy = onBattlefield('Lab Sturdy Flier');
    expect(sturdy).toHaveLength(2);
    for (const perm of sturdy) {
      expect(perm.damageMarked, perm.controllerId).toBe(1);
      expect(perm.tapped, perm.controllerId).toBe(true);
    }
    const [guard] = onBattlefield('Lab Red Guard');
    expect(guard?.damageMarked).toBe(0);
    expect(guard?.tapped).toBe(true);
    for (const name of ['Lab Ox', 'Lab Bird']) {
      const [perm] = onBattlefield(name);
      expect(perm?.damageMarked, name).toBe(0);
      expect(perm?.tapped, name).toBe(false);
    }
    expect(onBattlefield('Thundermaw Hellkite')).toHaveLength(1);
    const hits = state.eventLog.filter(
      (event) => event.type === 'damage' && String(event.payload['source']).includes('Thundermaw'),
    );
    expect(hits).toHaveLength(2);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('thundermaw-hellkite-viewer-damage-and-tap-fliers', steps);
  });
});

describe('Backlash Card Test Lab scenario', () => {
  it('backlash-viewer-tap-and-reflect — only untapped creatures are offered, and Lab Ox is tapped and deals its 4 power to its controller P2', () => {
    const steps: Step[] = [{ action: 'Cast Backlash', targets: ['Lab Ox'] }];
    const { scenario, state, seat, onBattlefield } = run('backlash-viewer-tap-and-reflect', steps);
    const [ox] = onBattlefield('Lab Ox');
    expect(ox?.tapped).toBe(true);
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.tapped).toBe(false);
    expect(seat('P2').life).toBe(36);
    for (const id of ['P1', 'P3', 'P4']) expect(seat(id).life, id).toBe(40);
    const hits = state.eventLog.filter((event) => event.type === 'damage');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.payload).toMatchObject({ target: 'P2', amount: 4 });
    expect(String(hits[0]?.payload['source'])).toContain('Lab Ox');
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Backlash']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('backlash-viewer-tap-and-reflect', steps);
  });
});
