import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, spawn } from './fixtures';

const spinerockKnoll = () =>
  oracle({
    name: 'Spinerock Knoll',
    typeLine: 'Land',
    oracleText:
      'Hideaway 4 (When this land enters, look at the top four cards of your library, exile one face down, then put the rest on the bottom in a random order.)\nThis land enters tapped.\n{T}: Add {R}.\n{R}, {T}: You may play the exiled card without paying its mana cost if an opponent was dealt 7 or more damage this turn.',
  });

const mosswortBridge = () =>
  oracle({
    name: 'Mosswort Bridge',
    typeLine: 'Land',
    oracleText:
      'Hideaway 4 (When this land enters, look at the top four cards of your library, exile one face down, then put the rest on the bottom in a random order.)\nThis land enters tapped.\n{T}: Add {G}.\n{G}, {T}: You may play the exiled card without paying its mana cost if creatures you control have total power 10 or greater.',
  });

function pod(seed = 'hideaway-test'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Increment 17: Hideaway Lands', () => {
  it('correctly models Spinerock Knoll and Mosswort Bridge', () => {
    expect(interpretCard(spinerockKnoll()).modeled).toBe(true);
    expect(interpretCard(mosswortBridge()).modeled).toBe(true);
  });

  it('exiles top card of library on Hideaway 4 ETB trigger', function* () {
    const ctx = pod();
    const land = spawn(ctx, 'P1', spinerockKnoll());

    const etbAbility = interpretCard(spinerockKnoll()).triggers[0]!;

    yield* executeAbility(
      ctx,
      { cardId: land.cardId, name: land.name, oracleId: land.oracleId, controllerId: 'P1' },
      etbAbility,
      [],
    );

    // One card should be in exile tagged with attachedToCardId = land.cardId
    const exiledCard = ctx.state.exile.find((c) => c.attachedToCardId === land.cardId);
    expect(exiledCard).toBeDefined();
  });
});
