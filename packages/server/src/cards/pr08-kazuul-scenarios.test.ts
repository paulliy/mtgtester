import { describe, expect, it } from 'vitest';
import { strictCardTestScenario } from './card-test-scenarios';
import type { GameContext } from '../../../engine/src/state/types';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import { NO_BLOCK_TARGET } from '@mtg/shared';

async function replay(mode: 'decline' | 'pay' | 'other-defender') {
  const scenario = strictCardTestScenario(`kazuul-viewer-${mode}`, 'kazuul-production-replay')!;
  const engine = scenario.engine;
  const ctx = (engine as unknown as { ctx: GameContext }).ctx;
  let cast = false,
    seenStack = false,
    payments = 0,
    blockers = false;
  for (let count = 0; count < 120; count++) {
    const step = engine.advance();
    if (
      ctx.state.stack.some(
        (entry) => entry.kind === 'spell' && entry.description === 'Kazuul, Tyrant of the Cliffs',
      )
    ) {
      seenStack = true;
      expect(
        ctx.state.battlefield.filter((entry) => entry.controllerId === 'P1' && entry.tapped),
      ).toHaveLength(5);
    }
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request,
      actions = request.legalActions;
    if (request.decidingPlayer === 'P2') {
      if (actions.some((action) => action.description === 'Pay {3}')) {
        payments++;
        expect(
          ctx.state.battlefield.filter((entry) => entry.isToken && entry.name === 'Ogre'),
        ).toHaveLength(0);
      }
      engine.submit(await scenario.decisionProviderOverrides!['P2']!.decide(request));
      continue;
    }
    let action = actions.find((entry) => entry.type === 'pass') ?? actions[0]!;
    const offer = actions.find(
      (entry) => entry.type === 'castSpell' && entry.description.startsWith('Cast Kazuul,'),
    );
    if (!cast && request.decidingPlayer === 'P1' && offer) {
      cast = true;
      action = offer;
    }
    if (ctx.state.step === 'declareBlockers') {
      blockers = true;
      expect(
        ctx.state.battlefield.filter((entry) => entry.isToken && entry.name === 'Ogre'),
      ).toHaveLength(mode === 'decline' ? 1 : 0);
    }
    engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      targets: (action.targets ?? []).map((slot) => {
        expect(action.type).toBe('blockDeclaration');
        expect(slot.options).toContain(NO_BLOCK_TARGET);
        return { slot: slot.slot, choice: NO_BLOCK_TARGET };
      }),
    });
    if (count === 119) throw Error('Kazuul replay exceeded bound');
  }
  expect(engine.getResult()?.haltReason ?? null).toBeNull();
  expect(cast && seenStack).toBe(true);
  expect(payments).toBe(mode === 'other-defender' ? 0 : 1);
  expect(blockers).toBe(true);
  const ogres = ctx.state.battlefield.filter((entry) => entry.isToken && entry.name === 'Ogre');
  expect(ogres).toHaveLength(mode === 'decline' ? 1 : 0);
  for (const ogre of ogres) {
    expect(ogre).toMatchObject({ controllerId: 'P1', ownerId: 'P1' });
    expect(computeCharacteristics(ctx, ogre)).toMatchObject({
      power: 3,
      toughness: 3,
      colors: ['R'],
      subtypes: ['Ogre'],
    });
  }
  expect(
    ctx.state.battlefield.filter(
      (entry) => entry.controllerId === 'P2' && entry.tapped && entry.name === 'Forest',
    ),
  ).toHaveLength(mode === 'pay' ? 3 : 0);
  expect(ctx.state.eventLog.filter((entry) => entry.type === 'unlessPaid')).toHaveLength(
    mode === 'pay' ? 1 : 0,
  );
  expect(ctx.state.eventLog.filter((entry) => entry.type === 'unlessNotPaid')).toHaveLength(
    mode === 'decline' ? 1 : 0,
  );
  return ctx.state.eventLog;
}

describe('Kazuul production lab', () => {
  it.each(['decline', 'pay', 'other-defender'] as const)(
    'kazuul-lab-%s — normal cast and attack replay',
    async (mode) => {
      expect(await replay(mode)).toEqual(await replay(mode));
    },
  );
});
