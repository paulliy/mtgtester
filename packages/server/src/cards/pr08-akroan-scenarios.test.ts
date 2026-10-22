import { describe, expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { GameContext } from '../../../engine/src/state/types';
function replay(upkeep: boolean) {
  const scenario = createCardTestScenario(
    `akroan-horse-viewer-${upkeep ? 'recipient-upkeep' : 'cast-and-gift'}`,
    'akroan-production-replay',
  )!;
  expect(scenario).not.toBeNull();
  const engine = scenario.engine,
    ctx = (engine as unknown as { ctx: GameContext }).ctx;
  let cast = false,
    gift = false,
    sawStack = false,
    choices = 0;
  for (;;) {
    const step = engine.advance(),
      state = engine.getState();
    if (state.stack.some((s) => s.kind === 'spell' && s.description === 'Akroan Horse')) {
      sawStack = true;
      expect(state.battlefield.filter((p) => p.name === 'Swamp' && p.tapped)).toHaveLength(4);
    }
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++choices > 120) throw Error('Akroan replay did not terminate');
    const request = step.request,
      actions = request.legalActions;
    let action = actions.find((a) => a.type === 'pass') ?? actions[0]!;
    if (!cast && request.decidingPlayer === 'P1') {
      const offer = actions.find(
        (a) => a.type === 'castSpell' && a.description.startsWith('Cast Akroan Horse'),
      );
      if (offer) {
        cast = true;
        action = offer;
      }
    }
    if (actions.some((a) => a.type === 'choosePlayer')) {
      expect(request.decidingPlayer).toBe('P1');
      expect(gift).toBe(false);
      expect(actions.map((a) => a.description)).toEqual([
        'P2 gains control of Akroan Horse',
        'P3 gains control of Akroan Horse',
        'P4 gains control of Akroan Horse',
      ]);
      expect(
        actions.every(
          (a) =>
            a.interaction?.kind === 'choice' &&
            a.interaction.subjectId === undefined &&
            (a.targets ?? []).length === 0,
        ),
      ).toBe(true);
      expect(ctx.state.battlefield.find((p) => p.name === 'Akroan Horse')?.ownerId).toBe('P1');
      expect(ctx.state.battlefield.filter((p) => p.isToken)).toHaveLength(0);
      gift = true;
      action = actions[0]!;
    }
    engine.submit({ requestId: request.requestId, actionId: action.id });
  }
  expect(engine.getResult()?.haltReason ?? null).toBeNull();
  expect(cast && gift && sawStack).toBe(true);
  const horse = ctx.state.battlefield.find((p) => p.name === 'Akroan Horse')!;
  expect(horse).toMatchObject({ ownerId: 'P1', controllerId: 'P2', tapped: false });
  expect(computeCharacteristics(ctx, horse)).toMatchObject({
    power: 0,
    toughness: 4,
    keywords: ['defender'],
  });
  const soldiers = ctx.state.battlefield.filter((p) => p.isToken);
  expect(soldiers.map((p) => p.controllerId).sort()).toEqual(upkeep ? ['P1', 'P3', 'P4'] : []);
  for (const token of soldiers) {
    expect(token.ownerId).toBe(token.controllerId);
    expect(computeCharacteristics(ctx, token)).toMatchObject({
      colors: ['W'],
      types: ['Creature'],
      subtypes: ['Soldier'],
      power: 1,
      toughness: 1,
    });
    expect(token.tapped).toBe(false);
  }
  expect(
    ctx.state.eventLog.filter((e) => e.type === 'tapForMana').map((e) => e.payload['name']),
  ).toEqual(['Swamp', 'Swamp', 'Swamp', 'Swamp']);
  if (upkeep) {
    expect(ctx.state.currentTurnPlayer).toBe('P2');
    expect(
      ctx.state.eventLog
        .filter((e) => e.type === 'tokenCreated')
        .map((e) => e.payload['controller'])
        .sort(),
    ).toEqual(['P1', 'P3', 'P4']);
  }
  return ctx.state.eventLog;
}
describe('Akroan Horse Card Test Lab', () => {
  it.each([false, true])(
    'akroan-lab-normal-cast-gift-and-upkeep-%s — production replay is deterministic',
    (upkeep) => {
      expect(replay(upkeep)).toEqual(replay(upkeep));
    },
  );
});
