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

describe('Vigean Graftmage Card Test Lab scenario', () => {
  it('vigean-graftmage-viewer-graft-and-untap — Graft moves a counter onto the next creature, then the untap ability targets a creature with a counter', () => {
    const steps: Step[] = [
      { action: 'Cast Vigean Graftmage' },
      { action: 'Cast Lab Servo' },
      { action: 'Yes' },
      { action: 'Untap target creature', targets: ['Lab Ox'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, onBattlefield, prompts } = run(
      'vigean-graftmage-viewer-graft-and-untap',
      steps,
    );
    // Graft asked, and a real answer moved one of Graftmage's two counters onto Lab Servo.
    expect(prompts.some((prompt) => /use this ability/.test(prompt))).toBe(true);
    const [graftmage] = onBattlefield('Vigean Graftmage');
    expect(graftmage?.counters).toEqual({ '+1/+1': 1 });
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.counters).toEqual({ '+1/+1': 1 });
    // The untap ability resolved on the prepared tapped Lab Ox, which carries a counter.
    const [ox] = onBattlefield('Lab Ox');
    expect(ox?.counters).toEqual({ '+1/+1': 1 });
    expect(ox?.tapped).toBe(false);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('vigean-graftmage-viewer-graft-and-untap', steps);
  });
});

describe('Elite Scaleguard Card Test Lab scenario', () => {
  it('elite-scaleguard-viewer-bolster-and-tap — bolster counters the smallest creature, and its attack taps a defending creature', () => {
    const steps: Step[] = [
      { action: 'Cast Elite Scaleguard' },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'elite-scaleguard-viewer-bolster-and-tap',
      steps,
    );
    // Bolster 2 went on Lab Servo, the creature with the least toughness; Elite Scaleguard is 2/3.
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.counters).toEqual({ '+1/+1': 2 });
    expect(servo?.tapped).toBe(true);
    const [scaleguard] = onBattlefield('Elite Scaleguard');
    expect(scaleguard?.counters ?? {}).toEqual({});
    // The countered attacker's trigger tapped the only creature the defending player controls.
    const [ox] = onBattlefield('Lab Ox');
    expect(ox?.tapped).toBe(true);
    // Lab Ox was tapped before blockers, so Lab Servo (1/1 plus two counters) connected for 3.
    expect(seat('P2').life).toBe(37);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('elite-scaleguard-viewer-bolster-and-tap', steps);
  });
});

describe('Forgotten Ancient Card Test Lab scenario', () => {
  it('forgotten-ancient-viewer-cast-and-move — a cast grows it, and its upkeep trigger moves counters onto other creatures', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Shock', targets: ['P2'] },
      { action: 'Yes' },
      { action: 'Move a +1/+1 counter onto Lab Servo' },
      { action: 'Move a +1/+1 counter onto Lab Ox' },
      { action: 'Move no more counters' },
    ];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'forgotten-ancient-viewer-cast-and-move',
      steps,
    );
    // The cast counter made three; two were moved (one to each other creature) and one stayed.
    const [ancient] = onBattlefield('Forgotten Ancient');
    expect(ancient?.counters).toEqual({ '+1/+1': 1 });
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.counters).toEqual({ '+1/+1': 1 });
    const [ox] = onBattlefield('Lab Ox');
    expect(ox?.counters).toEqual({ '+1/+1': 1 });
    expect(seat('P2').life).toBe(38);
    // Only the cast counter asks "use this ability?": moving none is the upkeep trigger's decline.
    expect(prompts.filter((prompt) => /use this ability/.test(prompt))).toHaveLength(1);
    expect(state.turnOrder[state.activePlayerIndex]).toBe('P1');
    expect(state.step).toBe('upkeep');
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('forgotten-ancient-viewer-cast-and-move', steps);
  });
});

describe('Pensive Professor Card Test Lab scenario', () => {
  it('pensive-professor-viewer-increment-draw — casting a one-mana spell grows the 0-power Professor, and the counter draws a card', () => {
    const steps: Step[] = [{ action: 'Cast Lab Ripple' }, { action: 'Pass priority' }];
    const { scenario, state, seat, onBattlefield } = run(
      'pensive-professor-viewer-increment-draw',
      steps,
    );
    // Increment put exactly one +1/+1 counter on the Professor, making it a 1/3.
    const [professor] = onBattlefield('Pensive Professor');
    expect(professor?.counters).toEqual({ '+1/+1': 1 });
    // Lab Ripple left the hand, and the counters trigger drew one card to replace it.
    const p1 = seat('P1');
    expect(p1.hand.map((card) => card.name)).toEqual(['Island']);
    expect(p1.graveyard.map((card) => card.name)).toEqual(['Lab Ripple']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('pensive-professor-viewer-increment-draw', steps);
  });
});

describe('Mikey & Leo, Chaos & Order Card Test Lab scenario', () => {
  it('mikey-and-leo-viewer-counter-draw — the first counter you put each turn draws a card, the second does not', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Graft', targets: ['Lab Servo'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Graft', targets: ['Lab Servo'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'mikey-and-leo-viewer-counter-draw',
      steps,
    );
    // Both Lab Grafts resolved onto Lab Servo.
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.counters).toEqual({ '+1/+1': 2 });
    // Only the first counter drew: both Lab Grafts left the hand and exactly one new card arrived.
    const p1 = seat('P1');
    expect(p1.hand).toHaveLength(1);
    expect(p1.library).toHaveLength(1);
    expect(p1.graveyard.map((card) => card.name)).toEqual(['Lab Graft', 'Lab Graft']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('mikey-and-leo-viewer-counter-draw', steps);
  });
});

describe('Bess, Soul Nourisher Card Test Lab scenario', () => {
  it('bess-soul-nourisher-viewer-counter-and-pump — a base-1/1 entering grows Bess, and her attack pumps the other base-1/1', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Servo' },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'bess-soul-nourisher-viewer-counter-and-pump',
      steps,
    );
    const [bess] = onBattlefield('Bess, Soul Nourisher');
    expect(bess?.counters).toEqual({ '+1/+1': 1 });
    expect(bess?.tapped).toBe(true);
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.counters ?? {}).toEqual({});
    // Bess connected as a 2/2 (1/1 plus her counter).
    expect(seat('P2').life).toBe(38);
    // Her attack trigger pumped only Lab Servo, by X = 1.
    const pumps = state.eventLog.filter((event) => event.type === 'pump');
    expect(pumps).toHaveLength(1);
    expect(pumps[0]?.payload).toMatchObject({ targets: ['Lab Servo'], power: 1, toughness: 1 });
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('bess-soul-nourisher-viewer-counter-and-pump', steps);
  });
});

describe('Aetheric Amplifier Card Test Lab scenario', () => {
  it('aetheric-amplifier-viewer-double-counters — the target mode doubles every kind of counter on Lab Servo and leaves your energy alone', () => {
    const steps: Step[] = [
      { action: 'target permanent', targets: ['Lab Servo'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'aetheric-amplifier-viewer-double-counters',
      steps,
    );
    // Both modes are offered as separate activations (CR 700.2a).
    const first = offered[0] ?? [];
    expect(first.filter((action) => /Aetheric Amplifier/.test(action))).toHaveLength(2);
    const [servo] = onBattlefield('Lab Servo');
    expect(servo?.counters).toEqual({ '+1/+1': 4, charge: 2 });
    const [amplifier] = onBattlefield('Aetheric Amplifier');
    expect(amplifier?.tapped).toBe(true);
    expect(seat('P1').energy).toBe(3);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('aetheric-amplifier-viewer-double-counters', steps);
  });
});

describe('The Thing Card Test Lab scenario', () => {
  it('the-thing-viewer-counters-and-double — a noncreature spell earns four counters, and paying on attack doubles them', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Ripple' },
      { action: 'Declare attackers', targets: ['P2'] },
      { action: 'Pay' },
      { action: 'Target The Thing' },
      { action: 'Target Lab Hex' },
      { action: 'Choose no more targets' },
    ];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'the-thing-viewer-counters-and-double',
      steps,
    );
    const [thing] = onBattlefield('The Thing');
    expect(thing?.counters).toEqual({ '+1/+1': 8 });
    const [hex] = onBattlefield('Lab Hex');
    expect(hex?.counters).toEqual({ charge: 2 });
    // The Thing connected as a 13/13 (5/5 plus eight counters).
    expect(seat('P2').life).toBe(27);
    expect(prompts.some((prompt) => /Pay it\?/.test(prompt))).toBe(true);
    // All five lands were tapped: one for Lab Ripple and four for {R}{G}{W}{U}.
    expect(
      state.battlefield.filter((permanent) => /Land/.test(permanent.typeLine) && permanent.tapped),
    ).toHaveLength(5);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('the-thing-viewer-counters-and-double', steps);
  });
});

describe('Lockjaw, Slobbering Teleporter Card Test Lab scenario', () => {
  it('lockjaw-viewer-counter-and-unblockable — a noncreature spell grows Lockjaw, and it and one other creature get past a blocker', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Ripple' },
      { action: 'Declare attackers', targets: ['P2', 'P2'] },
      { action: 'Target Lab Servo' },
    ];
    const { scenario, state, seat, onBattlefield, offered, prompts } = run(
      'lockjaw-viewer-counter-and-unblockable',
      steps,
    );
    const [jaw] = onBattlefield('Lockjaw, Slobbering Teleporter');
    expect(jaw?.counters).toEqual({ '+1/+1': 1 });
    // Vigilance: attacking did not tap it. Lab Servo, which has no vigilance, did tap.
    expect(jaw?.tapped).toBe(false);
    expect(onBattlefield('Lab Servo')[0]?.tapped).toBe(true);
    // Lockjaw (2) and Lab Servo (1) both connected, and Lab Ox was never asked to block.
    expect(seat('P2').life).toBe(37);
    expect(onBattlefield('Lab Ox')[0]?.damageMarked).toBe(0);
    expect(prompts.some((prompt) => /choose a target/.test(prompt))).toBe(true);
    expect(offered.flat().some((action) => /block/i.test(action))).toBe(false);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('lockjaw-viewer-counter-and-unblockable', steps);
  });
});

describe('Belladonna Took Card Test Lab scenario', () => {
  it('belladonna-took-viewer-three-tokens — the first token gains life, the second draws, the third counters every creature', () => {
    const forge = { action: 'Cast Lab Token Forge' };
    // Each token spell resolves, and then Belladonna’s trigger resolves, before the next cast.
    const pass = { action: 'Pass priority' };
    const steps: Step[] = [forge, pass, pass, forge, pass, pass, forge];
    const { scenario, state, seat, onBattlefield } = run(
      'belladonna-took-viewer-three-tokens',
      steps,
    );
    const p1 = seat('P1');
    expect(p1.life).toBe(41);
    // Three Forges left the hand; exactly one card was drawn (the second resolution).
    expect(p1.hand).toHaveLength(1);
    expect(p1.graveyard.map((card) => card.name)).toEqual([
      'Lab Token Forge',
      'Lab Token Forge',
      'Lab Token Forge',
    ]);
    // The third resolution put a counter on each creature P1 controls, tokens included.
    expect(onBattlefield('Belladonna Took')[0]?.counters).toEqual({ '+1/+1': 1 });
    expect(onBattlefield('Lab Ox')[0]?.counters).toEqual({ '+1/+1': 1 });
    const servos = onBattlefield('Servo');
    expect(servos).toHaveLength(3);
    for (const servo of servos) expect(servo.counters).toEqual({ '+1/+1': 1 });
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('belladonna-took-viewer-three-tokens', steps);
  });
});

describe('Rumor Gatherer Card Test Lab scenario', () => {
  it('rumor-gatherer-viewer-scry-then-draw — the first and third creatures scry, the second draws instead', () => {
    const forge = { action: 'Cast Lab Token Forge' };
    // Each token spell resolves, and then Rumor Gatherer’s trigger resolves, before the next cast.
    const pass = { action: 'Pass priority' };
    const steps: Step[] = [forge, pass, pass, forge, pass, pass, forge];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'rumor-gatherer-viewer-scry-then-draw',
      steps,
    );
    // Exactly two scry prompts: the second resolution drew instead.
    expect(prompts.filter((prompt) => /: scry — /.test(prompt))).toHaveLength(2);
    const p1 = seat('P1');
    expect(p1.graveyard.map((card) => card.name)).toEqual([
      'Lab Token Forge',
      'Lab Token Forge',
      'Lab Token Forge',
    ]);
    // Three Forges left the hand and exactly one card was drawn.
    expect(p1.hand).toHaveLength(1);
    expect(onBattlefield('Servo')).toHaveLength(3);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('rumor-gatherer-viewer-scry-then-draw', steps);
  });
});
