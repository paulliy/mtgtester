/**
 * Bolas's Citadel's "pay life equal to its mana value rather than pay its mana cost" cast from the
 * top of the library (`libraryTopLife`): every cast it offers is one the cast accepts.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pumpStrict, spawn } from './fixtures';
import { pinned } from './pr11-helpers';
import { pinStore } from './scenario/pin-store';

/** P1's precombat main phase, turn 3, with Bolas's Citadel and `top` on top of P1's library. */
function withTop(seed: string, top: Parameters<typeof conjure>[2]) {
  const ctx: GameContext = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 3,
    phase: 'precombatMain',
    step: null,
  });
  spawn(ctx, 'P1', pinStore.get("Bolas's Citadel"));
  const card = conjure(ctx, 'P1', top, 'library');
  const library = playerById(ctx, 'P1').library;
  library.splice(library.indexOf(card), 1);
  library.unshift(card);
  const options = computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return 'objectId' in payload && payload.objectId === card.id;
  });
  return { ctx, card, options };
}

const toxicDeluge = () =>
  oracle({
    oracleId: 'afaef788-34d1-460b-b884-9d7ae6ddeb18',
    name: 'Toxic Deluge',
    manaCost: '{2}{B}',
    typeLine: 'Sorcery',
    oracleText:
      'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.',
  });

describe('libraryTopLife casts', () => {
  it('a split card is not offered as the combined card (CR 709.3)', () => {
    const { options } = withTop('life-split', pinned('Wear // Tear'));
    expect(
      options.filter(
        (option) =>
          (option.payload as { alternativeCast?: string }).alternativeCast === 'libraryTopLife',
      ),
    ).toEqual([]);
  });

  it('an X an additional cost announces is still chosen, and each offered X casts (CR 601.2b)', () => {
    const { ctx, options } = withTop('life-announced-x', toxicDeluge());
    const descriptions = options.map((option) => option.description);
    expect(descriptions).toContain(
      'Cast Toxic Deluge ({0}) by paying 3 life with X=2 from the top of your library',
    );
    const x2 = options.find((option) => option.description.includes('with X=2'))!;
    pumpStrict(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), x2.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    // Three life for its mana value and two for X.
    expect(playerById(ctx, 'P1').life).toBe(35);
    expect(ctx.state.stack.map((entry) => entry.card?.name)).toEqual(['Toxic Deluge']);
  });
});
