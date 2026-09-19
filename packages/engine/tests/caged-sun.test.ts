/**
 * Caged Sun — "As this artifact enters, choose a color. Creatures you control of the chosen
 * color get +1/+1." Exercises the generic as-enters modal-choice primitive
 * (`CardDefinition.entersChoosingOption` / `EnginePermanent.chosenOption` / the `chosenColor`
 * selector), not just Caged Sun itself: the mana-doubling clause is left unhandled (still an
 * `unmodeledReasons` entry) so this only claims the two lines the override actually implements.
 */

import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../src/effects/continuous';
import { interpretCard } from '../src/cards/interpret';
import { allOf, CHOSEN_COLOR, ofType, YOURS } from '../src/cards/selector';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, gameConfig, oracle, pick, pump, registerCustomDef } from './fixtures';

const cagedSun = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '09b895ff-e729-48d1-bfc1-ea5fd7adda6a',
    name: 'Caged Sun',
    typeLine: 'Artifact',
    manaCost: '{5}',
    power: null,
    toughness: null,
    oracleText:
      "As this artifact enters, choose a color.\nCreatures you control of the chosen color get +1/+1.\nWhenever a land's ability causes you to add one or more mana of the chosen color, add an additional one mana of that color.",
  });

const choiceLens = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Choice Lens',
    typeLine: 'Artifact',
    manaCost: '{5}',
    power: null,
    toughness: null,
  });

function registerChoiceLens(ctx: GameContext): void {
  registerCustomDef(ctx, {
    ...interpretCard(choiceLens()),
    entersChoosingOption: {
      prompt: 'Choose a color',
      options: [
        { key: 'W', label: 'White' },
        { key: 'U', label: 'Blue' },
        { key: 'B', label: 'Black' },
        { key: 'R', label: 'Red' },
        { key: 'G', label: 'Green' },
      ],
    },
    staticEffects: [
      {
        affects: allOf(ofType('Creature'), YOURS, CHOSEN_COLOR),
        op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      },
    ],
  });
}

const redCreature = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Red Creature',
    typeLine: 'Creature — Test',
    manaCost: '{1}{R}',
    colors: ['R'],
    power: '2',
    toughness: '2',
  });

const blueCreature = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Blue Creature',
    typeLine: 'Creature — Test',
    manaCost: '{1}{U}',
    colors: ['U'],
    power: '2',
    toughness: '2',
  });

function ctxWithSeats(seats: number): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: [] })),
      { seed: 'caged-sun' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('as-enters chosen-color primitive', () => {
  it('keeps Caged Sun contained until its mana clause is implemented', () => {
    expect(interpretCard(cagedSun()).modeled).toBe(false);
    expect(interpretCard(cagedSun()).unmodeledReasons.join(' ')).toContain(
      'explicitly unsupported:',
    );
  });
  it('asks the controller to choose a color as it enters', () => {
    const ctx = ctxWithSeats(2);
    const obj = conjure(ctx, 'P1', choiceLens(), 'hand');
    registerChoiceLens(ctx);
    const gen = moveObject(ctx, obj, { zone: 'battlefield' });
    const step = gen.next();
    if (step.done === true) throw new Error('expected a decision');
    expect(step.value.options.map((o) => o.description)).toEqual([
      'White',
      'Blue',
      'Black',
      'Red',
      'Green',
    ]);
  });

  it('buffs creatures of the chosen color and leaves others alone', () => {
    const ctx = ctxWithSeats(2);
    const sunObj = conjure(ctx, 'P1', choiceLens(), 'hand');
    registerChoiceLens(ctx);
    pump(moveObject(ctx, sunObj, { zone: 'battlefield' }), (d) => pick(d, 'Red'));
    const sun = ctx.state.battlefield.find((p) => p.cardId === sunObj.cardId);
    expect(sun?.chosenOption).toBe('R');

    const redObj = conjure(ctx, 'P1', redCreature(), 'hand');
    pump(moveObject(ctx, redObj, { zone: 'battlefield' }));
    const red = ctx.state.battlefield.find((p) => p.cardId === redObj.cardId)!;
    expect(computeCharacteristics(ctx, red)).toMatchObject({ power: 3, toughness: 3 });

    const blueObj = conjure(ctx, 'P1', blueCreature(), 'hand');
    pump(moveObject(ctx, blueObj, { zone: 'battlefield' }));
    const blue = ctx.state.battlefield.find((p) => p.cardId === blueObj.cardId)!;
    expect(computeCharacteristics(ctx, blue)).toMatchObject({ power: 2, toughness: 2 });
  });
});
