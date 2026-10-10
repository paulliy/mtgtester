import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { createCardTestScenario } from './card-test-scenarios';

function run(): ReturnType<typeof createCardTestScenario> extends infer T
  ? Exclude<T, null>
  : never {
  const scenario = createCardTestScenario(
    'conclave-tribunal-viewer-convoke-szeras',
    'card-lab-pr02-follow-up',
  );
  expect(scenario).not.toBeNull();
  const objectNames = new Map<string, string>();
  for (;;) {
    const step = scenario!.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    for (const perm of scenario!.engine.getState().battlefield) objectNames.set(perm.id, perm.name);
    for (const player of scenario!.engine.getState().players) {
      objectNames.set(player.id, player.id);
      for (const card of player.graveyard) objectNames.set(card.id, card.name);
    }
    const tribunalAction = request.legalActions.find((action) =>
      action.description.includes('Cast Conclave Tribunal'),
    );
    if (tribunalAction !== undefined) {
      scenario!.engine.submit({ requestId: request.requestId, actionId: tribunalAction.id });
      continue;
    }
    const targetAction = request.legalActions.find((action) => {
      const slots =
        (
          action.interaction as
            { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
        )?.targetSlots ??
        action.targets ??
        [];
      return (
        action.type !== 'pass' &&
        slots.some((slot) => slot.options.some((id) => objectNames.get(id) === 'Lab Ox'))
      );
    });
    if (targetAction !== undefined) {
      const slots =
        (
          targetAction.interaction as
            { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
        )?.targetSlots ??
        targetAction.targets ??
        [];
      const slot = slots.find((candidate) =>
        candidate.options.some((id) => objectNames.get(id) === 'Lab Ox'),
      )!;
      const targetId = slot.options.find((id) => objectNames.get(id) === 'Lab Ox')!;
      scenario!.engine.submit({
        requestId: request.requestId,
        actionId: targetAction.id,
        targets: [{ slot: slot.slot, choice: targetId }],
      });
      continue;
    }
    const pass =
      request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
    scenario!.engine.submit({ requestId: request.requestId, actionId: pass.id });
  }
  expect(scenario!.engine.getResult()?.haltReason ?? null).toBeNull();
  return scenario!;
}

function runCounted(id: string, targetNames: string[]) {
  const scenario = createCardTestScenario(id, `card-lab-${id}`)!;
  const remaining = [...targetNames];
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request;
    const cast = request.legalActions.find(
      (action) =>
        action.description.includes('Cast Lab Counted Target Contract') &&
        (targetNames.length === 0 || action.description.includes('reduced for target slot 1')),
    );
    if (cast !== undefined) {
      scenario.engine.submit({ requestId: request.requestId, actionId: cast.id });
      continue;
    }
    const name = remaining.shift();
    const choice = request.legalActions.find((action) =>
      name === undefined
        ? action.description === 'Choose no more targets'
        : action.description === `Target ${name}`,
    );
    if (choice === undefined)
      throw new Error(
        `No counted-target choice for ${name ?? 'stop'}: ${request.legalActions.map((action) => action.description).join(' | ')}`,
      );
    scenario.engine.submit({ requestId: request.requestId, actionId: choice.id });
  }
  expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
  return scenario;
}

function runCountedReplicate() {
  const scenario = createCardTestScenario(
    'lab-replicate-counted-targets-original-countered-contract',
    'card-lab-replicate-follow-up',
  )!;
  const initialTargets = ['Lab Ox', 'Lab Convoke Bear'];
  const copyTargets = ['Lab Deer', 'Lab Wolf'];
  let originalTargetsDone = false;
  let copyTargetIndex = 0;
  let originalCastDone = false;
  let counterCastDone = false;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request;
    if (request.decidingPlayer === 'P2') {
      const counter = !counterCastDone
        ? request.legalActions.find((action) => action.description.includes('Cast Arcane Denial'))
        : undefined;
      if (counter !== undefined) {
        const slots =
          counter.interaction?.kind === 'source'
            ? (counter.interaction.targetSlots ?? counter.targets ?? [])
            : (counter.targets ?? []);
        const target = slots[0]?.options[0];
        scenario.engine.submit({
          requestId: request.requestId,
          actionId: counter.id,
          ...(target === undefined ? {} : { targets: [{ slot: slots[0]!.slot, choice: target }] }),
        });
        counterCastDone = true;
        continue;
      }
      const pass =
        request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
      scenario.engine.submit({ requestId: request.requestId, actionId: pass.id });
      continue;
    }
    if (!originalCastDone) {
      const cast = request.legalActions.find(
        (action) =>
          action.description.includes('Cast Lab Replicate Count Contract') &&
          action.description.includes('replicate 1'),
      );
      if (cast !== undefined) {
        scenario.engine.submit({ requestId: request.requestId, actionId: cast.id });
        originalCastDone = true;
        continue;
      }
    }
    if (!originalTargetsDone) {
      const next = initialTargets.shift();
      const choice = request.legalActions.find(
        (action) =>
          action.description === (next === undefined ? 'Choose no more targets' : `Target ${next}`),
      );
      if (choice !== undefined) {
        scenario.engine.submit({ requestId: request.requestId, actionId: choice.id });
        if (next === undefined) originalTargetsDone = true;
        continue;
      }
    }
    if (copyTargetIndex < copyTargets.length) {
      const target = copyTargets[copyTargetIndex]!;
      const choice = request.legalActions.find(
        (action) => action.description === `Target ${target}`,
      );
      if (choice !== undefined) {
        scenario.engine.submit({ requestId: request.requestId, actionId: choice.id });
        copyTargetIndex++;
        continue;
      }
    }
    const pass =
      request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
    scenario.engine.submit({ requestId: request.requestId, actionId: pass.id });
  }
  expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
  expect(originalCastDone).toBe(true);
  expect(counterCastDone).toBe(true);
  expect(copyTargetIndex).toBe(2);
  return scenario;
}

describe('PR02 follow-up Card Test Lab scenarios', () => {
  it('Illuminor Szeras stateful mana and convoke both pay through the cast path', () => {
    const scenario = run();
    const state = scenario.engine.getState();
    const onBattlefield = (name: string) => state.battlefield.filter((perm) => perm.name === name);
    expect(onBattlefield('Conclave Tribunal')).toHaveLength(1);
    expect(onBattlefield('Illuminor Szeras')[0]?.tapped).toBe(true);
    expect(
      state.players.find((player) => player.id === 'P1')?.graveyard.map((card) => card.name),
    ).toContain('Lab Ox');
    expect(onBattlefield('Lab Convoke Bear')[0]?.tapped).toBe(true);
    expect(onBattlefield('Plains')[0]?.tapped).toBe(true);
    expect(state.exile.map((card) => card.name)).toContain('Lab Ox');
  });

  it('Killian counted target contract distinguishes zero targets from a single fixed discount over two creatures', () => {
    const zero = runCounted('lab-killian-counted-target-zero-contract', []);
    const zeroState = zero.engine.getState();
    expect(
      zeroState.battlefield.filter(
        (perm) => perm.name === 'Lab Ox' || perm.name === 'Lab Convoke Bear',
      ),
    ).toHaveLength(2);
    expect(
      zeroState.battlefield.filter(
        (perm) => (perm.name === 'Mountain' || perm.name === 'Forest') && perm.tapped,
      ),
    ).toHaveLength(5);
    const creatures = runCounted('lab-killian-counted-target-creatures-contract', [
      'Lab Ox',
      'Lab Convoke Bear',
    ]);
    const creatureState = creatures.engine.getState();
    expect(
      creatureState.players
        .find((player) => player.id === 'P2')
        ?.graveyard.map((card) => card.name),
    ).toEqual(expect.arrayContaining(['Lab Ox', 'Lab Convoke Bear']));
    expect(
      creatureState.battlefield.filter(
        (perm) => (perm.name === 'Mountain' || perm.name === 'Forest') && perm.tapped,
      ),
    ).toHaveLength(3);
  });

  it('Lab replicate contract retains both counted target choices after Arcane Denial counters the original', () => {
    const scenario = runCountedReplicate();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p1.graveyard.map((card) => card.name)).toContain('Lab Replicate Count Contract');
    expect(
      state.battlefield.filter((perm) => perm.controllerId === 'P2').map((perm) => perm.name),
    ).toEqual(expect.arrayContaining(['Lab Ox', 'Lab Convoke Bear']));
    expect(p2.graveyard.map((card) => card.name)).toEqual(
      expect.arrayContaining(['Lab Deer', 'Lab Wolf']),
    );
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'counterSpell' && String(event.payload['by']).startsWith('Arcane Denial'),
      ),
    ).toBe(true);
  });
});
