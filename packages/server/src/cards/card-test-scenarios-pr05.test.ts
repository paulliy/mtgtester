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

describe('Sunforger Card Test Lab scenario', () => {
  it('sunforger-viewer-unattach-search-and-cast — Equip {3} onto Lab Green Bear, then {R}{W} unattaches it to cast Lab Quick Gain for free', () => {
    const steps: Step[] = [
      { action: 'Equip {3}', targets: ['Lab Green Bear'] },
      { action: '{R}{W}, Unattach this Equipment' },
      { action: 'Cast Lab Quick Gain without paying' },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'sunforger-viewer-unattach-search-and-cast',
      steps,
    );
    // Unattached, Sunforger offers only Equip {3}; once attached it offers only the search (the
    // three Forests that paid for Equip leave no mana for another Equip).
    const sunforgerActions = (options: string[]) =>
      options.filter((action) => /Sunforger/.test(action));
    expect(sunforgerActions(offered[0] ?? [])).toHaveLength(1);
    expect(sunforgerActions(offered[0] ?? [])[0]).toMatch(/Equip \{3\}/);
    expect(sunforgerActions(offered[0] ?? [])[0]).not.toMatch(/Unattach/);
    expect(sunforgerActions(offered[1] ?? [])).toHaveLength(1);
    expect(sunforgerActions(offered[1] ?? [])[0]).toMatch(/\{R\}\{W\}, Unattach this Equipment/);
    // The search offered only the red instant (and finding nothing).
    const search = offered.find((options) =>
      options.some((option) => /^Cast .* without paying its mana cost$/.test(option)),
    );
    expect(search).toEqual(['Cast Lab Quick Gain without paying its mana cost', 'Find nothing']);
    // Equip attached it to the Bear, and the cost then took it off again.
    expect(
      state.eventLog.filter((event) => event.type === 'attach').map((event) => event.payload),
    ).toEqual([{ equipment: 'Sunforger', to: 'Lab Green Bear' }]);
    const [sunforger] = onBattlefield('Sunforger');
    expect(sunforger).toBeDefined();
    expect(sunforger?.attachedTo ?? null).toBeNull();
    // The found instant was cast for free, resolved, and the rest of the library was shuffled.
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Quick Gain']);
    expect(seat('P1').life).toBe(41);
    expect(
      seat('P1')
        .library.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Sun Blue Instant', 'Lab Sun Red Sorcery']);
    expect(state.eventLog.filter((event) => event.type === 'shuffle')).toHaveLength(1);
    const lands = state.battlefield.filter((perm) => /Basic Land/.test(perm.typeLine));
    expect(lands).toHaveLength(5);
    expect(lands.filter((land) => land.tapped)).toHaveLength(5);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('sunforger-viewer-unattach-search-and-cast', steps);
  });
});

describe('Screams from Within Card Test Lab scenario', () => {
  it('screams-from-within-viewer-return-and-enchant — cast it on Lab Green Bear, destroy the Bear, and the Aura returns onto the hexproof Lab Hexproof Elf', () => {
    const steps: Step[] = [
      { action: 'Cast Screams from Within', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Green Bear'] },
      { action: 'Enchant Lab Hexproof Elf' },
    ];
    const { scenario, state, seat, onBattlefield, prompts, offered } = run(
      'screams-from-within-viewer-return-and-enchant',
      steps,
    );
    // The return asked its controller for a host once, offering the other creatures but not the
    // Bear that died: a choice on entering, so the hexproof Elf is among them.
    expect(prompts.filter((prompt) => /choose a permanent to enchant/.test(prompt))).toHaveLength(
      1,
    );
    const hosts = offered.find((options) => options.some((option) => /^Enchant /.test(option)));
    expect([...(hosts ?? [])].sort()).toEqual(['Enchant Lab Hexproof Elf', 'Enchant Lab Ox']);
    // The Aura came back off its trigger as a new object under P1, enchanting the Elf.
    const [screams] = onBattlefield('Screams from Within');
    const [elf] = onBattlefield('Lab Hexproof Elf');
    expect(onBattlefield('Screams from Within')).toHaveLength(1);
    expect(screams?.attachedTo).toBe(elf?.id);
    expect(screams?.controllerId).toBe('P1');
    expect(state.eventLog.filter((event) => event.type === 'graveyardToBattlefield')).toHaveLength(
      1,
    );
    expect(onBattlefield('Lab Green Bear')).toEqual([]);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Doom', 'Lab Green Bear']);
    expect(seat('P2').graveyard).toEqual([]);
    expect(onBattlefield('Swamp').filter((swamp) => swamp.tapped)).toHaveLength(5);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('screams-from-within-viewer-return-and-enchant', steps);
  });
});

describe('Ghoulish Impetus Card Test Lab scenario', () => {
  it('ghoulish-impetus-viewer-return-at-end-step — cast it on Lab Green Bear, destroy the Bear, and the Aura returns at the end step onto Lab Ox', () => {
    const steps: Step[] = [
      { action: 'Cast Ghoulish Impetus', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Green Bear'] },
      { action: 'Enchant Lab Ox' },
    ];
    const { scenario, state, seat, onBattlefield, prompts, offered } = run(
      'ghoulish-impetus-viewer-return-at-end-step',
      steps,
    );
    // The host was chosen once, as it entered, among the other creatures (not the dead Bear).
    expect(prompts.filter((prompt) => /choose a permanent to enchant/.test(prompt))).toHaveLength(
      1,
    );
    const hosts = offered.find((options) => options.some((option) => /^Enchant /.test(option)));
    expect([...(hosts ?? [])].sort()).toEqual(['Enchant Lab Hexproof Elf', 'Enchant Lab Ox']);
    // It returned at the beginning of the end step, not when the Bear died.
    const returned = state.eventLog.findIndex((event) => event.type === 'graveyardToBattlefield');
    const destroyed = state.eventLog.findIndex((event) => event.type === 'destroy');
    const endStepBegan = state.eventLog.findIndex(
      (event) => event.type === 'phaseBegin' && (event.payload as { step?: string }).step === 'end',
    );
    expect(destroyed).toBeGreaterThanOrEqual(0);
    expect(endStepBegan).toBeGreaterThan(destroyed);
    expect(returned).toBeGreaterThan(endStepBegan);
    expect(state.eventLog.filter((event) => event.type === 'graveyardToBattlefield')).toHaveLength(
      1,
    );
    // It came back as a new object under P1, enchanting Lab Ox.
    const [impetus] = onBattlefield('Ghoulish Impetus');
    const [ox] = onBattlefield('Lab Ox');
    expect(onBattlefield('Ghoulish Impetus')).toHaveLength(1);
    expect(impetus?.attachedTo).toBe(ox?.id);
    expect(impetus?.controllerId).toBe('P1');
    expect(onBattlefield('Lab Green Bear')).toEqual([]);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Doom', 'Lab Green Bear']);
    expect(seat('P2').graveyard).toEqual([]);
    expect(onBattlefield('Swamp').filter((swamp) => swamp.tapped)).toHaveLength(5);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('ghoulish-impetus-viewer-return-at-end-step', steps);
  });
});

describe('Gift of Immortality Card Test Lab scenario', () => {
  it('gift-of-immortality-viewer-owner-return-then-aura — the stolen Bear returns to its owner at once, then the Aura returns attached to it at the end step', () => {
    const steps: Step[] = [
      { action: 'Cast Gift of Immortality', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Green Bear'] },
    ];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'gift-of-immortality-viewer-owner-return-then-aura',
      steps,
    );
    // No host was ever chosen: the Aura returns attached to that creature.
    expect(prompts.filter((prompt) => /choose a permanent to enchant/.test(prompt))).toEqual([]);
    // The Bear came back first, under its owner P2 (not P1, who controlled it when it died).
    const [bear] = onBattlefield('Lab Green Bear');
    expect(onBattlefield('Lab Green Bear')).toHaveLength(1);
    expect(bear?.ownerId).toBe('P2');
    expect(bear?.controllerId).toBe('P2');
    // The Aura came back at the end step, under P1, attached to the new Bear.
    const [gift] = onBattlefield('Gift of Immortality');
    expect(onBattlefield('Gift of Immortality')).toHaveLength(1);
    expect(gift?.controllerId).toBe('P1');
    expect(gift?.attachedTo).toBe(bear?.id);
    const returns = state.eventLog.filter((event) => event.type === 'graveyardToBattlefield');
    expect(returns.map((event) => (event.payload as { target?: string }).target)).toEqual([
      'Lab Green Bear',
      'Gift of Immortality',
    ]);
    const bearBack = state.eventLog.findIndex(
      (event) =>
        event.type === 'graveyardToBattlefield' &&
        (event.payload as { target?: string }).target === 'Lab Green Bear',
    );
    const endStepBegan = state.eventLog.findIndex(
      (event) => event.type === 'phaseBegin' && (event.payload as { step?: string }).step === 'end',
    );
    const auraBack = state.eventLog.findIndex(
      (event) =>
        event.type === 'graveyardToBattlefield' &&
        (event.payload as { target?: string }).target === 'Gift of Immortality',
    );
    expect(bearBack).toBeLessThan(endStepBegan);
    expect(auraBack).toBeGreaterThan(endStepBegan);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Doom']);
    expect(seat('P2').graveyard).toEqual([]);
    expect(
      state.battlefield.filter((perm) => /Basic Land/.test(perm.typeLine) && perm.tapped),
    ).toHaveLength(5);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('gift-of-immortality-viewer-owner-return-then-aura', steps);
  });
});

describe("Ajani's Chosen Card Test Lab scenario", () => {
  it('ajanis-chosen-viewer-aura-moves-to-cat — the Cat is made and Lab Aegis is attached to it, leaving Lab Green Bear a 2/2', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Aegis', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: 'Attach Lab Aegis to Cat' },
    ];
    const { scenario, state, onBattlefield, prompts, offered } = run(
      'ajanis-chosen-viewer-aura-moves-to-cat',
      steps,
    );
    const [aegis] = onBattlefield('Lab Aegis');
    const cats = onBattlefield('Cat');
    expect(onBattlefield('Lab Aegis')).toHaveLength(1);
    expect(cats).toHaveLength(1);
    expect(cats[0]?.typeLine).toBe('Creature — Cat');
    expect(cats[0]?.controllerId).toBe('P1');
    expect(aegis?.attachedTo).toBe(cats[0]?.id);
    // Asked once, with the Cat to attach to or the choice not to.
    expect(prompts.filter((prompt) => /attach Lab Aegis/.test(prompt))).toHaveLength(1);
    const asked = offered.find((options) =>
      options.some((option) => /^Attach Lab Aegis/.test(option)),
    );
    expect(asked).toEqual(['Attach Lab Aegis to Cat', "Don't attach Lab Aegis"]);
    expect(
      state.eventLog.filter((event) => event.type === 'attach').map((event) => event.payload),
    ).toEqual([{ equipment: 'Lab Aegis', to: 'Cat' }]);
    expect(onBattlefield('Plains').filter((plains) => plains.tapped)).toHaveLength(1);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('ajanis-chosen-viewer-aura-moves-to-cat', steps);
  });
});

describe('Shielded by Faith Card Test Lab scenario', () => {
  it('shielded-by-faith-viewer-attach-to-entering-creature — it moves onto Lab Green Bear when it enters and Lab Doom cannot destroy the Bear', () => {
    const steps: Step[] = [
      { action: 'Cast Shielded by Faith', targets: ['Lab Ox'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Green Bear' },
      { action: 'Pass priority' },
      { action: 'Yes' },
      { action: 'Cast Lab Doom', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'shielded-by-faith-viewer-attach-to-entering-creature',
      steps,
    );
    const [aura] = onBattlefield('Shielded by Faith');
    const [bear] = onBattlefield('Lab Green Bear');
    const [ox] = onBattlefield('Lab Ox');
    expect(onBattlefield('Shielded by Faith')).toHaveLength(1);
    expect(bear).toBeDefined();
    expect(ox).toBeDefined();
    expect(aura?.attachedTo).toBe(bear?.id);
    // Asked once, then Lab Doom was cast at the indestructible Bear and did nothing.
    expect(prompts.filter((prompt) => /use this ability/.test(prompt))).toHaveLength(1);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Doom']);
    expect(
      state.eventLog.filter((event) => event.type === 'attach').map((event) => event.payload),
    ).toEqual([{ equipment: 'Shielded by Faith', to: 'Lab Green Bear' }]);
    expect(
      state.battlefield.filter((perm) => /Basic Land/.test(perm.typeLine) && perm.tapped),
    ).toHaveLength(6);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('shielded-by-faith-viewer-attach-to-entering-creature', steps);
  });
});

describe('Forum Filibuster Card Test Lab scenario', () => {
  it('forum-filibuster-viewer-inkling-and-aura — the Inkling is made and Lab Aegis returns attached to it, with Lab Green Bear never offered', () => {
    const steps: Step[] = [{ action: 'Target Lab Aegis' }];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'forum-filibuster-viewer-inkling-and-aura',
      steps,
    );
    const [inkling] = onBattlefield('Inkling');
    const [aegis] = onBattlefield('Lab Aegis');
    expect(onBattlefield('Inkling')).toHaveLength(1);
    expect(inkling?.controllerId).toBe('P1');
    expect(aegis?.controllerId).toBe('P1');
    expect(aegis?.attachedTo).toBe(inkling?.id);
    // The target prompt offered the Aura and nothing else from the graveyard.
    const targeting = offered.find((options) => options.some((option) => /^Target /.test(option)));
    expect(targeting?.filter((option) => /^Target /.test(option))).toEqual(['Target Lab Aegis']);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Green Bear']);
    expect(state.turnOrder[state.activePlayerIndex]).toBe('P1');
    expect(state.step).toBe('upkeep');
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('forum-filibuster-viewer-inkling-and-aura', steps);
  });
});

describe("Karametra's Favor Card Test Lab scenario", () => {
  it('karametras-favor-viewer-granted-mana-pays-spell — the enters draw gives the Plains, then the tapped Lab Green Bear pays {R} for Lab Shock', () => {
    const steps: Step[] = [
      { action: "Cast Karametra's Favor", targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Shock', targets: ['P2'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'karametras-favor-viewer-granted-mana-pays-spell',
      steps,
    );
    const [favor] = onBattlefield("Karametra's Favor");
    const [bear] = onBattlefield('Lab Green Bear');
    expect(favor?.attachedTo).toBe(bear?.id);
    // Lab Green Bear paid for the Shock: the Forests paid for the Aura.
    expect(bear?.tapped).toBe(true);
    expect(onBattlefield('Forest').filter((forest) => forest.tapped)).toHaveLength(2);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Plains']);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Lab Shock']);
    expect(seat('P2').life).toBe(38);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('karametras-favor-viewer-granted-mana-pays-spell', steps);
  });
});

describe('Redemption Arc Card Test Lab scenario', () => {
  it('redemption-arc-viewer-exile-enchanted-creature — the Aura goes on Lab Green Bear, then {1}{W} exiles it with no target and the Aura falls off', () => {
    const steps: Step[] = [
      { action: 'Cast Redemption Arc', targets: ['Lab Green Bear'] },
      { action: 'Exile enchanted creature' },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'redemption-arc-viewer-exile-enchanted-creature',
      steps,
    );
    // The activation was offered with the Aura on the battlefield and took no target.
    expect(
      offered.some((options) => options.some((option) => /Exile enchanted creature/.test(option))),
    ).toBe(true);
    expect(onBattlefield('Lab Green Bear')).toEqual([]);
    expect(onBattlefield('Redemption Arc')).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Green Bear']);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Redemption Arc']);
    expect(
      onBattlefield('Plains')
        .concat(onBattlefield('Swamp'))
        .filter((land) => land.tapped),
    ).toHaveLength(5);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('redemption-arc-viewer-exile-enchanted-creature', steps);
  });
});

describe('Fallen Ideal Card Test Lab scenario', () => {
  it('fallen-ideal-viewer-sacrifice-then-return — the Aura goes on Lab Green Bear, a sacrifice pumps it, then sacrificing the creature itself returns the Aura to hand', () => {
    const steps: Step[] = [
      { action: 'Cast Fallen Ideal', targets: ['Lab Green Bear'] },
      { action: 'sacrifice a creature' },
      { action: 'Lab Ox' },
      { action: 'Pass priority' },
      { action: 'sacrifice a creature' },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'fallen-ideal-viewer-sacrifice-then-return',
      steps,
    );
    expect(
      offered.some((options) => options.some((option) => /sacrifice a creature/.test(option))),
    ).toBe(true);
    expect(onBattlefield('Lab Green Bear')).toEqual([]);
    expect(onBattlefield('Lab Ox')).toEqual([]);
    expect(onBattlefield('Fallen Ideal')).toEqual([]);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Fallen Ideal']);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Green Bear', 'Lab Ox']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('fallen-ideal-viewer-sacrifice-then-return', steps);
  });
});

describe('Kor Spiritdancer Card Test Lab scenario', () => {
  it('kor-spiritdancer-viewer-aura-cast-draw-and-pump — casting Lab Aegis on it offers the draw and attaches the Aura, and the library card is drawn', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Aegis', targets: ['Kor Spiritdancer'] },
      { action: 'Yes' },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield, prompts } = run(
      'kor-spiritdancer-viewer-aura-cast-draw-and-pump',
      steps,
    );
    expect(prompts.filter((prompt) => /use this ability/.test(prompt))).toHaveLength(1);
    const [korPerm] = onBattlefield('Kor Spiritdancer');
    const [aegis] = onBattlefield('Lab Aegis');
    expect(aegis?.attachedTo).toBe(korPerm?.id);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Green Bear']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('kor-spiritdancer-viewer-aura-cast-draw-and-pump', steps);
  });
});

describe('Hateful Eidolon Card Test Lab scenario', () => {
  it('hateful-eidolon-viewer-enchanted-creature-dies-draw — Lab Aegis on Lab Bird, then Lab Doom kills it and one card is drawn for the Aura', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Aegis', targets: ['Lab Bird'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Bird'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'hateful-eidolon-viewer-enchanted-creature-dies-draw',
      steps,
    );
    expect(onBattlefield('Lab Bird')).toEqual([]);
    expect(onBattlefield('Lab Aegis')).toEqual([]);
    expect(seat('P1').graveyard.map((card) => card.name)).toContain('Lab Aegis');
    expect(seat('P1').graveyard.map((card) => card.name)).toContain('Lab Doom');
    expect(seat('P2').graveyard.map((card) => card.name)).toEqual(['Lab Bird']);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Green Bear']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('hateful-eidolon-viewer-enchanted-creature-dies-draw', steps);
  });
});

describe('Martial Impetus Card Test Lab scenario', () => {
  it('martial-impetus-viewer-attack-pump — Lab Green Bear attacks P2 and Lab Ox attacks P3, so the Aura pumps Lab Ox and P3 takes 5', () => {
    const steps: Step[] = [
      { action: 'Cast Martial Impetus', targets: ['Lab Green Bear'] },
      { action: 'Declare attackers', targets: ['P2', 'P3'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'martial-impetus-viewer-attack-pump',
      steps,
    );
    const [impetus] = onBattlefield('Martial Impetus');
    const [bear] = onBattlefield('Lab Green Bear');
    expect(impetus?.attachedTo).toBe(bear?.id);
    // Lab Green Bear (2/2, +1/+1 from the Aura) hit P2; Lab Ox (4/4 plus the attack pump) hit P3.
    expect(seat('P2').life).toBe(37);
    expect(seat('P3').life).toBe(35);
    expect(seat('P4').life).toBe(40);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('martial-impetus-viewer-attack-pump', steps);
  });
});

describe('Killian, Decisive Mentor Card Test Lab scenario', () => {
  it('killian-decisive-mentor-viewer-tap-goad-and-attack-draw — Lab Aegis entering taps and goads Lab Bird, then the enchanted Lab Green Bear attacks and draws', () => {
    const steps: Step[] = [
      { action: 'Cast Lab Aegis', targets: ['Lab Green Bear'] },
      { action: 'Target Lab Bird' },
      { action: 'Declare attackers', targets: ['__no_attack__', 'P2'] },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'killian-decisive-mentor-viewer-tap-goad-and-attack-draw',
      steps,
    );
    // The enters trigger offered Lab Bird and the choice of none.
    const asked = offered.find((options) => options.includes('Target Lab Bird'));
    expect(asked).toBeDefined();
    expect(asked!.some((option) => /no more targets/i.test(option))).toBe(true);
    const [bird] = onBattlefield('Lab Bird');
    expect(bird?.tapped).toBe(true);
    // The engine's permanent carries the goad requirement; the spectator type does not name it.
    expect((bird as { goadedBy?: { goaderId: string }[] } | undefined)?.goadedBy).toEqual([
      expect.objectContaining({ goaderId: 'P1' }),
    ]);
    const [aegis] = onBattlefield('Lab Aegis');
    const [bear] = onBattlefield('Lab Green Bear');
    expect(aegis?.attachedTo).toBe(bear?.id);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Lab Ox']);
    expect(seat('P2').life).toBe(36);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('killian-decisive-mentor-viewer-tap-goad-and-attack-draw', steps);
  });
});

describe('Angelic Destiny Card Test Lab scenario', () => {
  it('angelic-destiny-viewer-angel-then-return — the Aura makes Lab Green Bear a 6/6 Angel, and when Lab Doom kills it the Aura returns to hand', () => {
    const steps: Step[] = [
      { action: 'Cast Angelic Destiny', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
      { action: 'Cast Lab Doom', targets: ['Lab Green Bear'] },
      { action: 'Pass priority' },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'angelic-destiny-viewer-angel-then-return',
      steps,
    );
    expect(onBattlefield('Lab Green Bear')).toEqual([]);
    expect(onBattlefield('Angelic Destiny')).toEqual([]);
    expect(seat('P1').hand.map((card) => card.name)).toEqual(['Angelic Destiny']);
    expect(
      seat('P1')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Doom', 'Lab Green Bear']);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('angelic-destiny-viewer-angel-then-return', steps);
  });
});

describe('Sheltered by Ghosts Card Test Lab scenario', () => {
  it('sheltered-by-ghosts-viewer-exile-and-lifelink — the Aura exiles Lab Bird until it leaves, and Lab Green Bear attacks as a 3/2 lifelinker', () => {
    const steps: Step[] = [
      { action: 'Cast Sheltered by Ghosts', targets: ['Lab Green Bear'] },
      { action: 'Targets for Sheltered by Ghosts', targets: ['Lab Bird'] },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield, offered } = run(
      'sheltered-by-ghosts-viewer-exile-and-lifelink',
      steps,
    );
    // The trigger offered only opposing nonland permanents: never the Forests or your own cards.
    expect(offered.some((options) => options.includes('Targets for Sheltered by Ghosts'))).toBe(
      true,
    );
    expect(onBattlefield('Lab Bird')).toEqual([]);
    expect(state.exile.map((card) => card.name)).toEqual(['Lab Bird']);
    expect(onBattlefield('Lab Hex')).toHaveLength(1);
    const [aura] = onBattlefield('Sheltered by Ghosts');
    const [bear] = onBattlefield('Lab Green Bear');
    expect(aura?.attachedTo).toBe(bear?.id);
    expect(seat('P2').life).toBe(37);
    expect(seat('P1').life).toBe(43);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('sheltered-by-ghosts-viewer-exile-and-lifelink', steps);
  });
});

describe('Eldrazi Conscription Card Test Lab scenario', () => {
  it('eldrazi-conscription-viewer-annihilator — Lab Green Bear attacks as a 12/12 trampler and P2 sacrifices both of their permanents', () => {
    const steps: Step[] = [
      { action: 'Cast Eldrazi Conscription', targets: ['Lab Green Bear'] },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'eldrazi-conscription-viewer-annihilator',
      steps,
    );
    expect(onBattlefield('Lab Bird')).toEqual([]);
    expect(onBattlefield('Lab Hex')).toEqual([]);
    expect(
      seat('P2')
        .graveyard.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Bird', 'Lab Hex']);
    const [aura] = onBattlefield('Eldrazi Conscription');
    const [bear] = onBattlefield('Lab Green Bear');
    expect(aura?.attachedTo).toBe(bear?.id);
    expect(seat('P2').life).toBe(28);
    // Only the defending player lost permanents.
    expect(seat('P3').graveyard).toEqual([]);
    expect(seat('P4').graveyard).toEqual([]);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('eldrazi-conscription-viewer-annihilator', steps);
  });
});

describe('Curse of Bounty Card Test Lab scenario', () => {
  it('curse-of-bounty-viewer-untap-on-attack — the Curse enchants P2, then attacking P2 untaps Lab Ox and the attacking Lab Green Bear but not the Forest or the Plains', () => {
    const steps: Step[] = [
      { action: 'Cast Curse of Bounty', targets: ['P2'] },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'curse-of-bounty-viewer-untap-on-attack',
      steps,
    );
    const [aura] = onBattlefield('Curse of Bounty');
    expect(aura?.attachedTo).toBe('P2');
    expect(onBattlefield('Lab Ox').map((perm) => perm.tapped)).toEqual([false]);
    expect(onBattlefield('Lab Green Bear').map((perm) => perm.tapped)).toEqual([false]);
    expect(onBattlefield('Forest').map((perm) => perm.tapped)).toEqual([true]);
    expect(onBattlefield('Plains').map((perm) => perm.tapped)).toEqual([true]);
    expect(seat('P2').life).toBe(38);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('curse-of-bounty-viewer-untap-on-attack', steps);
  });
});

describe('Tenuous Truce Card Test Lab scenario', () => {
  it('tenuous-truce-viewer-attack-sacrifices — the Aura enchants P2, then Lab Green Bear attacking P2 sacrifices it', () => {
    const steps: Step[] = [
      { action: 'Cast Tenuous Truce', targets: ['P2'] },
      { action: 'Declare attackers', targets: ['P2'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'tenuous-truce-viewer-attack-sacrifices',
      steps,
    );
    expect(onBattlefield('Tenuous Truce')).toEqual([]);
    expect(seat('P1').graveyard.map((card) => card.name)).toEqual(['Tenuous Truce']);
    expect(seat('P2').life).toBe(38);
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('tenuous-truce-viewer-attack-sacrifices', steps);
  });
});

describe('Tenuous Truce Card Test Lab end-step scenario', () => {
  it('tenuous-truce-viewer-other-attack-and-end-step — attacking P3 keeps the Aura on P2, and your own end step draws nothing', () => {
    const steps: Step[] = [
      { action: 'Cast Tenuous Truce', targets: ['P2'] },
      { action: 'Declare attackers', targets: ['P3'] },
    ];
    const { scenario, state, seat, onBattlefield } = run(
      'tenuous-truce-viewer-other-attack-and-end-step',
      steps,
    );
    const [aura] = onBattlefield('Tenuous Truce');
    expect(aura?.attachedTo).toBe('P2');
    expect(seat('P3').life).toBe(38);
    // Neither the Aura's controller nor the enchanted player drew at P1's end step.
    expect(seat('P1').hand).toEqual([]);
    expect(seat('P2').hand).toEqual([]);
    expect(seat('P1').library[0]?.name).toBe('Lab Ox');
    expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
    expect(state.stack).toEqual([]);
    replays('tenuous-truce-viewer-other-attack-and-end-step', steps);
  });
});
