import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { bear, conjure, copies, forest, gameConfig, pump, spawn } from './fixtures';

function setup() {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  const source = spawn(ctx, 'P1', bear());
  const target = conjure(ctx, 'P2', bear(), 'graveyard');
  const ability: Ability = {
    kind: 'activated',
    targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'any' }],
    effects: [{ op: 'exileTargetGraveyardAndBuffIfCreature', targetSlot: 0 }],
  };
  return { ctx, source, target, ability };
}
function resolve({ ctx, source, ability }: ReturnType<typeof setup>, id: string) {
  pump(
    executeAbility(
      ctx,
      {
        id: source.id,
        cardId: source.cardId,
        name: source.name,
        oracleId: source.oracleId,
        controllerId: 'P1',
      },
      ability,
      [id],
    ),
  );
}

describe('graveyard exile effect uses exact zone transitions', () => {
  it('creates a new exile incarnation and applies the creature rider', () => {
    const state = setup();
    const oldId = state.target.id;
    const life = state.ctx.state.players[0]!.life;
    resolve(state, oldId);
    const exiled = state.ctx.state.exile.find((card) => card.cardId === state.target.cardId)!;
    expect(exiled.id).not.toBe(oldId);
    expect(state.ctx.state.players[1]!.graveyard).not.toContain(state.target);
    expect(state.source.counters['+1/+1']).toBe(1);
    expect(state.ctx.state.players[0]!.life).toBe(life + 1);
  });

  it('exiles a noncreature without applying the creature rider', () => {
    const state = setup();
    const land = conjure(state.ctx, 'P2', forest(), 'graveyard');
    const life = state.ctx.state.players[0]!.life;
    resolve(state, land.id);
    expect(state.ctx.state.exile.find((card) => card.cardId === land.cardId)?.id).not.toBe(land.id);
    expect(state.source.counters['+1/+1']).toBeUndefined();
    expect(state.ctx.state.players[0]!.life).toBe(life);
  });

  it('does not recover a stale target by physical card identity', () => {
    const state = setup();
    const oldId = state.target.id;
    const exiled = pump(moveObject(state.ctx, state.target, { zone: 'exile' })).value!;
    const returned = pump(moveObject(state.ctx, exiled, { zone: 'graveyard' })).value!;
    const life = state.ctx.state.players[0]!.life;
    resolve(state, oldId);
    expect(state.ctx.state.players[1]!.graveyard).toContain(returned);
    expect(state.ctx.state.exile).toHaveLength(0);
    expect(state.source.counters['+1/+1']).toBeUndefined();
    expect(state.ctx.state.players[0]!.life).toBe(life);
  });

  it('lets a later instruction follow the exact public-zone move', () => {
    const state = setup();
    state.ability.effects.push({ op: 'graveyardToLibraryTop', target: 0 });
    resolve(state, state.target.id);
    const returned = state.ctx.state.players[1]!.library[0]!;
    expect(returned).toBeDefined();
    expect(returned.cardId).toBe(state.target.cardId);
    expect(returned.id).not.toBe(state.target.id);
    expect(state.ctx.state.exile).toHaveLength(0);
  });
});
