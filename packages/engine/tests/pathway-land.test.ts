/**
 * Modal DFC lands (CR 712.9), the Pathway-shaped case: two faces, each a plain land whose only
 * text is a single fixed-color tap ability. Modeled generically (`buildPathwayLand` in
 * interpret.ts) via the SAME as-enters modal-choice primitive Caged Sun's color pick already
 * uses (`entersChoosingOption` / `EnginePermanent.chosenOption`), plus a new `chosenColor`
 * dynamic mana kind that reads the choice back at query time. Before this, EVERY modal-DFC-layout
 * card was refused outright ("unsupported layout"), and — worse — several `staticEffects: []`
 * overrides had slipped past the empty-patch guard and silently reported these lands as
 * `modeled: true` while producing no mana at all.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { manaSourcesFor } from '../src/state/queries';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, gameConfig, oracle, pick, pump } from './fixtures';

const blightstepPathway = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: 'e580a229-e800-4746-9d37-c32fcef8de28',
    name: 'Blightstep Pathway',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    layout: 'modal_dfc',
    oracleText: '{T}: Add {B}.',
    backFace: {
      name: 'Searstep Pathway',
      typeLine: 'Land',
      oracleText: '{T}: Add {R}.',
      manaCost: null,
      colors: [],
      power: null,
      toughness: null,
    },
  });

function ctxWithSeats(seats: number): GameContext {
  const ctx = createGame(gameConfig(Array.from({ length: seats }, () => ({ cards: [] })), { seed: 'pathway' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Pathway-shaped modal DFC lands', () => {
  it('parses as modeled with a chosenColor dynamic mana ability, not "unsupported layout"', () => {
    const def = interpretCard(blightstepPathway());
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.manaAbilities).toEqual([{ units: [], dynamic: 'chosenColor' }]);
    expect(def.entersChoosingOption).toEqual({
      prompt: 'Choose a face',
      options: [
        { key: 'B', label: 'Blightstep Pathway' },
        { key: 'R', label: 'Searstep Pathway' },
      ],
    });
  });

  it('asks which face to enter as, and produces ONLY the chosen color thereafter', () => {
    const ctx = ctxWithSeats(2);
    const obj = conjure(ctx, 'P1', blightstepPathway(), 'hand');
    const gen = moveObject(ctx, obj, { zone: 'battlefield' });
    const step = gen.next();
    if (step.done === true) throw new Error('expected a decision');
    expect(step.value.options.map((o) => o.description)).toEqual(['Blightstep Pathway', 'Searstep Pathway']);
  });

  it('choosing the front face produces black and only black', () => {
    const ctx = ctxWithSeats(2);
    const obj = conjure(ctx, 'P1', blightstepPathway(), 'hand');
    pump(moveObject(ctx, obj, { zone: 'battlefield' }), (d) => pick(d, 'Blightstep Pathway'));
    const perm = ctx.state.battlefield.find((p) => p.cardId === obj.cardId)!;
    expect(perm.chosenOption).toBe('B');

    const sources = manaSourcesFor(ctx, 'P1');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.units).toEqual([['B']]);
  });

  it('choosing the back face produces red and only red', () => {
    const ctx = ctxWithSeats(2);
    const obj = conjure(ctx, 'P1', blightstepPathway(), 'hand');
    pump(moveObject(ctx, obj, { zone: 'battlefield' }), (d) => pick(d, 'Searstep Pathway'));
    const perm = ctx.state.battlefield.find((p) => p.cardId === obj.cardId)!;
    expect(perm.chosenOption).toBe('R');

    const sources = manaSourcesFor(ctx, 'P1');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.units).toEqual([['R']]);
  });
});
