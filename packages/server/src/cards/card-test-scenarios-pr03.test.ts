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

describe('Satoru, the Infiltrator Card Test Lab scenario', () => {
  it('satoru-viewer-free-cast-draws — the free Ornithopter draws a card; the paid Lab Zombie does not', () => {
    const steps: Step[] = [{ action: 'Cast Lab Ornithopter' }, { action: 'Cast Lab Zombie' }];
    const { seat, onBattlefield, state } = run('satoru-viewer-free-cast-draws', steps);
    expect(onBattlefield('Lab Ornithopter')).toHaveLength(1);
    expect(onBattlefield('Lab Zombie')).toHaveLength(1);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(1);
    replays('satoru-viewer-free-cast-draws', steps);
  });
});

describe('Keeper of Secrets Card Test Lab scenario', () => {
  it('keeper-of-secrets-viewer-flashback — a flashback from the graveyard pings P2 for its mana value', () => {
    const steps: Step[] = [
      { action: 'Lab Flash Bolt', targets: ['P3'] },
      { action: 'Keeper of Secrets', targets: ['P2'] },
    ];
    const { seat, state, offered } = run('keeper-of-secrets-viewer-flashback', steps);
    expect(offered.flat().filter((action) => action.includes('Lab Flash Bolt'))).not.toHaveLength(
      0,
    );
    expect(seat('P2').life).toBe(39);
    expect(seat('P3').life).toBe(39);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Flash Bolt']);
    replays('keeper-of-secrets-viewer-flashback', steps);
  });
});

describe('River Kelpie Card Test Lab scenario', () => {
  it('river-kelpie-viewer-flashback-and-persist — the flashback draws, then persist returns it and it draws again', () => {
    const steps: Step[] = [
      { action: 'Lab Flash Bolt', targets: ['P2'] },
      { action: 'Cast Lab Doom', targets: ['River Kelpie'] },
    ];
    const { seat, onBattlefield } = run('river-kelpie-viewer-flashback-and-persist', steps);
    expect(
      seat('P1')
        .hand.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Ox', 'Lab Zombie']);
    expect(seat('P2').life).toBe(39);
    expect(onBattlefield('River Kelpie')[0]?.counters).toEqual({ '-1/-1': 1 });
    replays('river-kelpie-viewer-flashback-and-persist', steps);
  });
});

describe('Aurora Phoenix Card Test Lab scenario', () => {
  it('aurora-phoenix-viewer-cascade-return — casting Lab Cascader returns the Phoenix from the graveyard to hand', () => {
    const steps: Step[] = [{ action: 'Cast Lab Cascader' }];
    const { seat, onBattlefield } = run('aurora-phoenix-viewer-cascade-return', steps);
    expect(onBattlefield('Lab Cascader')).toHaveLength(1);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Aurora Phoenix']);
    expect(seat('P1').graveyard).toEqual([]);
    replays('aurora-phoenix-viewer-cascade-return', steps);
  });
});

describe('Watcher for Tomorrow Card Test Lab scenario', () => {
  it('watcher-for-tomorrow-viewer-hideaway-leaves — the hidden card goes to hand when Watcher dies', () => {
    // Pass first, so Hideaway resolves before Lab Doom is cast.
    const steps: Step[] = [
      { action: 'Cast Watcher for Tomorrow' },
      { action: 'Pass priority' },
      { action: 'Exile face down' },
      { action: 'Cast Lab Doom', targets: ['Watcher for Tomorrow'] },
    ];
    const { seat, state } = run('watcher-for-tomorrow-viewer-hideaway-leaves', steps);
    expect(state.exile).toEqual([]);
    expect(seat('P1').hand).toHaveLength(1);
    expect(['Lab Ox', 'Lab Zombie', 'Lab Servo', 'Lab Bird']).toContain(seat('P1').hand[0]?.name);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Doom', 'Watcher for Tomorrow']);
    replays('watcher-for-tomorrow-viewer-hideaway-leaves', steps);
  });
});

describe('Psychomancer Card Test Lab scenario', () => {
  it('psychomancer-viewer-artifact-drain — destroying your own artifact drains P2 for 1', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Shatter', targets: ['Lab Anrakyr Relic'] },
      { action: 'Psychomancer', targets: ['P2'] },
    ];
    const { seat, onBattlefield } = run('psychomancer-viewer-artifact-drain', steps);
    expect(onBattlefield('Lab Anrakyr Relic')).toEqual([]);
    expect(seat('P2').life).toBe(39);
    expect(seat('P1').life).toBe(41);
    replays('psychomancer-viewer-artifact-drain', steps);
  });
});

describe('Shard of the Void Dragon Card Test Lab scenario', () => {
  it('shard-of-the-void-dragon-viewer-attack-edict — P2 sacrifices its Relic, the Shard grows and hits for 9', () => {
    const steps: Step[] = [{ action: 'Declare attackers', targets: ['P2'] }];
    const { seat, onBattlefield } = run('shard-of-the-void-dragon-viewer-attack-edict', steps);
    expect(onBattlefield('Lab Anrakyr Relic')).toEqual([]);
    expect(onBattlefield('Shard of the Void Dragon')[0]?.counters).toEqual({ '+1/+1': 2 });
    expect(seat('P2').life).toBe(31);
    replays('shard-of-the-void-dragon-viewer-attack-edict', steps);
  });
});

describe('Scavenging Ooze Card Test Lab scenario', () => {
  it('scavenging-ooze-viewer-exile-creature — exiling Lab Ox grows the Ooze and gains 1 life', () => {
    const steps: Step[] = [{ action: 'Exile target card from a graveyard', targets: ['Lab Ox'] }];
    const { seat, state, onBattlefield } = run('scavenging-ooze-viewer-exile-creature', steps);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(onBattlefield('Scavenging Ooze')[0]?.counters).toEqual({ '+1/+1': 1 });
    expect(seat('P1').life).toBe(41);
    replays('scavenging-ooze-viewer-exile-creature', steps);
  });
});

describe('Imotekh the Stormlord Card Test Lab scenario', () => {
  it('imotekh-viewer-phaeron-and-strategist — reanimating the Construct makes two Warriors, then it is buffed at combat', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Reanimate', targets: ['Lab Construct'] },
      { action: 'Imotekh the Stormlord', targets: ['Lab Construct'] },
      { action: 'Declare attackers', targets: ['__no_attack__'] },
    ];
    const { state, onBattlefield } = run('imotekh-viewer-phaeron-and-strategist', steps);
    expect(onBattlefield('Necron Warrior')).toHaveLength(2);
    expect(onBattlefield('Lab Construct')).toHaveLength(1);
    expect(state.effects.some((effect) => effect.description.includes('Lab Construct'))).toBe(true);
    replays('imotekh-viewer-phaeron-and-strategist', steps);
  });
});

describe('The Ooze Card Test Lab scenario', () => {
  it('the-ooze-viewer-leave-and-exile — a creature leaving with two counters makes two Mutagens, and the exile makes a third', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Banish', targets: ['Lab Mutant'] },
      { action: 'Exile target card from a graveyard', targets: ['Lab Ox'] },
    ];
    const { state, onBattlefield } = run('the-ooze-viewer-leave-and-exile', steps);
    expect(onBattlefield('Mutagen')).toHaveLength(3);
    expect(state.exile.map((card) => card.name).sort()).toEqual(['Lab Mutant', 'Lab Ox']);
    expect(onBattlefield('The Ooze')[0]?.tapped).toBe(true);
    replays('the-ooze-viewer-leave-and-exile', steps);
  });
});

describe('God-Eternal Rhonas Card Test Lab scenario', () => {
  it('god-eternal-rhonas-viewer-double-and-return — Lab Ox is doubled, then exiled Rhonas goes third from the top', () => {
    const steps: Step[] = [
      { action: 'Cast God-Eternal Rhonas' },
      { action: 'Cast Lab Banish', targets: ['God-Eternal Rhonas'] },
      { action: 'Yes' },
    ];
    const { state, seat, onBattlefield } = run(
      'god-eternal-rhonas-viewer-double-and-return',
      steps,
    );
    expect(onBattlefield('God-Eternal Rhonas')).toEqual([]);
    expect(state.exile).toEqual([]);
    expect(
      seat('P1')
        .library.map((card) => card.name)
        .slice(0, 4),
    ).toEqual(['Lab Ox', 'Lab Ox', 'God-Eternal Rhonas', 'Lab Ox']);
    expect(state.effects.some((effect) => effect.description === 'Double power of Lab Ox')).toBe(
      true,
    );
    replays('god-eternal-rhonas-viewer-double-and-return', steps);
  });
});

describe('Candlekeep Sage Card Test Lab scenario', () => {
  it('candlekeep-sage-viewer-commander-enters-and-leaves — the commander draws as it enters and again as it is exiled', () => {
    const steps: Step[] = [
      { action: 'Cast Lab General' },
      { action: 'Cast Lab Banish', targets: ['Lab General'] },
    ];
    const { seat, onBattlefield } = run(
      'candlekeep-sage-viewer-commander-enters-and-leaves',
      steps,
    );
    expect(onBattlefield('Lab General')).toEqual([]);
    expect(
      seat('P1')
        .hand.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Ox', 'Lab Servo']);
    replays('candlekeep-sage-viewer-commander-enters-and-leaves', steps);
  });
});

describe('Flickerwisp Card Test Lab scenario', () => {
  it("flickerwisp-viewer-exile-and-return — Lab Ox is exiled, then returns under P2's control at the end step", () => {
    const steps: Step[] = [
      { action: 'Cast Flickerwisp' },
      { action: 'Flickerwisp', targets: ['Lab Ox'] },
    ];
    const { state, onBattlefield } = run('flickerwisp-viewer-exile-and-return', steps);
    expect(onBattlefield('Lab Ox').map((perm) => perm.controllerId)).toEqual(['P2']);
    expect(onBattlefield('Flickerwisp')).toHaveLength(1);
    expect(state.exile).toEqual([]);
    expect(state.eventLog.some((event) => event.type === 'exile')).toBe(true);
    replays('flickerwisp-viewer-exile-and-return', steps);
  });
});

describe('Venser, the Sojourner Card Test Lab scenarios', () => {
  it('venser-viewer-plus-two-blink — Lab Ox is exiled and returns under your control at the end step', () => {
    const steps: Step[] = [{ action: ': +2:', targets: ['Lab Ox'] }];
    const { state, onBattlefield } = run('venser-viewer-plus-two-blink', steps);
    expect(onBattlefield('Lab Ox').map((perm) => perm.controllerId)).toEqual(['P1']);
    expect(onBattlefield('Venser, the Sojourner')[0]?.counters['loyalty']).toBe(5);
    expect(state.exile).toEqual([]);
    replays('venser-viewer-plus-two-blink', steps);
  });

  it("venser-viewer-minus-one-unblockable — P2's Lab Ox cannot block, so P2 takes 4", () => {
    const steps: Step[] = [{ action: ': −1:' }, { action: 'Declare attackers', targets: ['P2'] }];
    const { seat, onBattlefield } = run('venser-viewer-minus-one-unblockable', steps);
    expect(onBattlefield('Venser, the Sojourner')[0]?.counters['loyalty']).toBe(2);
    expect(seat('P2').life).toBe(36);
    replays('venser-viewer-minus-one-unblockable', steps);
  });

  it("venser-viewer-minus-eight-emblem — the emblem exiles P2's Lab Ox when Lab Divination is cast", () => {
    const steps: Step[] = [
      { action: ': −8:' },
      { action: 'Cast Lab Divination' },
      { action: 'Venser, the Sojourner emblem', targets: ['Lab Ox'] },
    ];
    const { state, seat, onBattlefield } = run('venser-viewer-minus-eight-emblem', steps);
    expect(
      state.eventLog.filter((event) => event.type === 'createEmblem').map((event) => event.payload),
    ).toEqual([{ player: 'P1', name: 'Venser, the Sojourner emblem' }]);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Divination', 'Venser, the Sojourner']);
    replays('venser-viewer-minus-eight-emblem', steps);
  });
});

describe('Puppeteer Clique Card Test Lab scenario', () => {
  it('puppeteer-clique-viewer-steal-attack-exile — the stolen Lab Ox attacks with haste, then is exiled at your end step', () => {
    const steps: Step[] = [
      // Lab Ox is the only legal target, so the enters trigger takes it without asking.
      { action: 'Cast Puppeteer Clique' },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { state, seat, onBattlefield } = run('puppeteer-clique-viewer-steal-attack-exile', steps);
    expect(seat('P2').life).toBe(36);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Ox']);
    replays('puppeteer-clique-viewer-steal-attack-exile', steps);
  });
});
