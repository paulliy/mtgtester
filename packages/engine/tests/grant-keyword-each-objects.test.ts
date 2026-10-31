/**
 * "Those creatures gain indestructible until end of turn" (Inspiring Call): the set is fixed as the
 * effect resolves (CR 611.2c), so a creature that leaves the battlefield and returns the same turn
 * is a new object the keyword never applied to (CR 400.7; `releaseFixedEffects` drops it).
 */
import { describe, expect, it } from 'vitest';
import { allOf, ofType, YOURS } from '../src/cards/selector';
import { spell } from '../src/cards/templates';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { hasKeyword } from '../src/state/queries';
import { bear, copies, forest, gameConfig, oracle, pumpStrict, spawn } from './fixtures';

describe('grantKeywordEachUntilEot', () => {
  it('a creature that leaves and returns this turn no longer has the keyword', () => {
    const ctx = createGame(
      gameConfig(
        [0, 1].map(() => ({ cards: copies(8, forest) })),
        { seed: 'grant-each-objects' },
      ),
    );
    const creature = spawn(ctx, 'P1', bear());
    const source = spawn(
      ctx,
      'P1',
      oracle({ name: 'Grant Source', typeLine: 'Instant', manaCost: '{G}' }),
    );
    pumpStrict(
      executeAbility(
        ctx,
        source,
        spell({
          effects: [
            {
              op: 'grantKeywordEachUntilEot',
              selector: allOf(YOURS, ofType('Creature')),
              keyword: 'indestructible',
            },
          ],
          description: 'Your creatures gain indestructible until end of turn',
        }),
        [],
      ),
    );
    expect(hasKeyword(ctx, creature, 'indestructible')).toBe(true);

    pumpStrict(moveObject(ctx, creature, { zone: 'exile' }));
    const exiled = ctx.state.exile.find((card) => card.cardId === creature.cardId)!;
    pumpStrict(moveObject(ctx, exiled, { zone: 'battlefield' }));
    const returned = ctx.state.battlefield.find((perm) => perm.cardId === creature.cardId)!;
    expect(returned.id).not.toBe(creature.id);
    expect(hasKeyword(ctx, returned, 'indestructible')).toBe(false);
  });
});
