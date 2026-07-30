/**
 * Cloud Key — "As this artifact enters, choose a card type. Spells you cast of the chosen type
 * cost {1} less to cast." Reuses the as-enters modal-choice primitive (see `caged-sun.test.ts`)
 * for a cost-reduction filter instead of a permanent buff: `costReductionFor` has to thread the
 * REDUCTION'S SOURCE's `chosenOption` in per rule-static entry, since the `SelectorSource` it
 * builds otherwise stands for the spell being cast, not Cloud Key.
 */

import { describe, expect, it } from 'vitest';
import { costReductionFor } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pick, pump, registerDef } from './fixtures';

const cloudKey = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '2a838818-d590-4374-9a63-d9e6381a0f0d',
    name: 'Cloud Key',
    typeLine: 'Artifact',
    manaCost: '{2}',
    power: null,
    toughness: null,
    oracleText:
      'As this artifact enters, choose artifact, creature, enchantment, instant, or sorcery.\nSpells you cast of the chosen type cost {1} less to cast.',
  });

const bolt = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bolt', typeLine: 'Instant', manaCost: '{R}', power: null, toughness: null });

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

function pod(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) })), { seed: 'cloud-key' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Cloud Key (as-enters modal choice, cost-reduction filter)', () => {
  it('reduces the cost of spells of the chosen type only', () => {
    const ctx = pod();
    const keyObj = conjure(ctx, 'P1', cloudKey(), 'hand');
    pump(moveObject(ctx, keyObj, { zone: 'battlefield' }), (d) => pick(d, 'Instant'));
    const key = ctx.state.battlefield.find((p) => p.cardId === keyObj.cardId);
    expect(key?.chosenOption).toBe('Instant');

    registerDef(ctx, bolt());
    registerDef(ctx, bear());
    expect(costReductionFor(ctx, 'P1', bolt().oracleId, 'c-bolt').generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', bear().oracleId, 'c-bear').generic).toBe(0);
  });
});
