/**
 * The stateful mana planner replays activations on copies of the game. Fuzz found a 58-turn bot
 * game where deciding three uncastable cards took 225 seconds: each copy carried the spectator
 * snapshots (17 MB where nothing drains them), the debug log and every definition. The copies now
 * leave the presentation records out and share what is never edited, and planning leaves the game
 * itself as it was.
 */
import { describe, expect, it } from 'vitest';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { needsStatefulManaPayment } from '../src/mana/stateful-payment';
import { parseManaCost } from '../src/mana/cost';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, plains, spawn } from './fixtures';

/** Anything `copyData` meets that is not plain data makes it throw. */
class NotData {}

function game(): { ctx: GameContext; spell: string } {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const spell = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Two-Mana Sorcery',
      typeLine: 'Sorcery',
      manaCost: '{2}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  // An amount on a mana ability makes its production state-dependent: the stateful planner.
  const rock = spawn(
    ctx,
    'P1',
    oracle({ name: 'Counting Rock', typeLine: 'Artifact', oracleText: '{T}: Add {C}.' }),
  );
  ctx.defs.set(rock.oracleId, {
    ...ctx.defs.get(rock.oracleId)!,
    manaAbilities: [{ units: [['C']], amount: { kind: 'const', n: 1 } }],
  });
  spawn(ctx, 'P1', forest());
  return { ctx, spell: spell.id };
}

const castable = (ctx: GameContext, objectId: string) =>
  computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });

describe('stateful mana payment copies', () => {
  it('stateful-payment-copy-records — leave out the spectator snapshots and the debug log', () => {
    const { ctx, spell } = game();
    expect(
      needsStatefulManaPayment(ctx, playerById(ctx, 'P1'), parseManaCost('{2}').cost!, 0),
    ).toBe(true);
    ctx.state.sequenceSnapshots = new Map([[1, new NotData() as never]]);
    ctx.debugLog.push(new NotData() as never);

    expect(castable(ctx, spell)).toBe(true);
  });

  it('stateful-payment-copy-isolated — planning leaves the log, definitions and board as they were', () => {
    const { ctx, spell } = game();
    const log = ctx.state.eventLog.length;
    const defs = [...ctx.defs.keys()];
    const board = JSON.stringify(ctx.state.battlefield);

    expect(castable(ctx, spell)).toBe(true);
    expect(ctx.state.eventLog).toHaveLength(log);
    expect([...ctx.defs.keys()]).toEqual(defs);
    expect(JSON.stringify(ctx.state.battlefield)).toBe(board);
  });
});

describe('stateful mana payment bounds', () => {
  /** Twelve Forests and an Exotic Orchard against an opponent with `opposing` lands. */
  function orchardPod(opposing: () => ReturnType<typeof forest>, manaCost: string) {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.turnNumber = 3;
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    for (let index = 0; index < 12; index++) spawn(ctx, 'P1', forest());
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Exotic Orchard',
        typeLine: 'Land',
        oracleText:
          '{T}: Add one mana of any color that a land an opponent controls could produce.',
      }),
    );
    spawn(ctx, 'P2', opposing());
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'White Sorcery',
        typeLine: 'Sorcery',
        manaCost,
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    return { ctx, spell: spell.id };
  }

  it('stateful-payment-bound-colors — colors the sources cannot make end the search at once', () => {
    // Found by fuzz (ADR 0034 decision 8): with a dynamic source the search tried every order of
    // activations, exhausted its state budget and halted a game over a spell it could not cast.
    // Even making any type, the Orchard is one white source of the two {W}{W} needs.
    const { ctx, spell } = orchardPod(forest, '{W}{W}');
    expect(
      needsStatefulManaPayment(ctx, playerById(ctx, 'P1'), parseManaCost('{W}{W}').cost!, 0),
    ).toBe(true);
    expect(castable(ctx, spell)).toBe(false);
  });

  it('stateful-payment-bound-count — more mana than the sources can make ends it too', () => {
    const { ctx, spell } = orchardPod(plains, '{13}{W}');
    expect(castable(ctx, spell)).toBe(false);
  });

  it('stateful-payment-bound-dynamic — the dynamic source still pays the color it can make', () => {
    const { ctx, spell } = orchardPod(plains, '{1}{W}');
    expect(castable(ctx, spell)).toBe(true);
  });
});
