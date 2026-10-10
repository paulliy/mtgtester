/**
 * Equip and attachment timestamps (CR 613.7e, 701.3b-c): an Equipment gets a new timestamp each
 * time it becomes attached to a different creature, and equipping the creature it is already on
 * does nothing.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const SWORD = oracle({
  name: 'Lab Sword',
  typeLine: 'Artifact — Equipment',
  manaCost: '{1}',
  oracleText: 'Equipped creature gets +1/+0.\nEquip {1}',
});
const bear = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/** Activate the Sword's Equip {1} onto `host` through the normal priority path and resolve it. */
function equip(ctx: GameContext, sword: EnginePermanent, host: EnginePermanent) {
  const player = playerById(ctx, 'P1');
  addMana(player, [{ symbol: 'C' }]);
  const option = computePriorityOptions(ctx, player).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return (
      'objectId' in payload && payload.objectId === sword.id && /Equip/.test(candidate.description)
    );
  });
  expect(option, 'Equip {1} is offered').toBeDefined();
  pump(
    applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, host.id]]),
    }),
  );
  pump(resolveTopOfStack(ctx));
}

describe('equip timestamps', () => {
  it('a new timestamp each time it moves to a different creature (CR 613.7e, 701.3c)', () => {
    const ctx = pod('equip-ts');
    const sword = spawn(ctx, 'P1', SWORD);
    const first = spawn(ctx, 'P1', bear('Lab First'));
    const second = spawn(ctx, 'P1', bear('Lab Second'));
    const printed = sword.timestamp;
    equip(ctx, sword, first);
    expect(sword.attachedTo).toBe(first.id);
    const onFirst = sword.timestamp;
    expect(onFirst).toBeGreaterThan(printed);
    equip(ctx, sword, second);
    expect(sword.attachedTo).toBe(second.id);
    expect(sword.timestamp).toBeGreaterThan(onFirst);
  });

  it('an equip effect onto the creature it is already on does nothing (CR 701.3b)', () => {
    const ctx = pod('equip-same');
    const sword = spawn(ctx, 'P1', SWORD);
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    equip(ctx, sword, host);
    const attached = sword.timestamp;
    // The priority path never offers this target; the effect itself must still be a no-op.
    pump(
      executeAbility(
        ctx,
        {
          id: sword.id,
          cardId: sword.cardId,
          name: sword.name,
          oracleId: sword.oracleId,
          controllerId: 'P1',
        },
        {
          kind: 'activated',
          targets: [{ kind: 'creature', controller: 'you' }],
          effects: [{ op: 'attachSelfTo', target: 0 }],
        },
        [host.id],
      ),
    );
    expect(sword.attachedTo).toBe(host.id);
    expect(sword.timestamp).toBe(attached);
  });
});
