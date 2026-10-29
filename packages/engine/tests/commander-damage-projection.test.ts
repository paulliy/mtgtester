// ADR 0032 decision 5: the projection says whether commander damage is lethal and how far off,
// from the same constant the state-based action uses (CR 903.10a), so no client holds the 21.
import { describe, expect, it } from 'vitest';
import { COMMANDER_DAMAGE_LETHAL } from '@mtg/shared';
import { buildPlayerBoardState } from '../src';
import { createGame } from '../src/state/game';
import { buildSpectatorState } from '../src/view/spectator';
import { commanderFor, copies, forest, gameConfig } from './fixtures';

const game = () =>
  createGame(
    gameConfig(
      [1, 2, 3, 4].map((seat) => ({
        commander: commanderFor('G', `General ${seat}`),
        cards: copies(10, forest),
      })),
      { seed: 'commander-damage' },
    ),
  );

describe('commander damage entries', () => {
  it('carries lethal and remaining for every nonzero cell, in both views', () => {
    const ctx = game();
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    const p3 = ctx.state.players.find((p) => p.id === 'P3')!;
    const [commander2, commander4] = [
      ctx.state.players.find((p) => p.id === 'P2')!.commanderCardIds[0]!,
      ctx.state.players.find((p) => p.id === 'P4')!.commanderCardIds[0]!,
    ];
    p1.commanderDamageTaken = { [commander2]: 15, [commander4]: COMMANDER_DAMAGE_LETHAL };
    p3.commanderDamageTaken = { [commander2]: 3 };

    for (const board of [buildSpectatorState(ctx), buildPlayerBoardState(ctx, 'P2')]) {
      const cell = (victim: string, source: string) =>
        board.commanderDamage.find((e) => e.victimSeat === victim && e.sourceSeat === source);
      expect(cell('P1', 'P2')).toMatchObject({ damage: 15, lethal: false, remaining: 6 });
      expect(cell('P1', 'P4')).toMatchObject({ damage: 21, lethal: true, remaining: 0 });
      expect(cell('P3', 'P2')).toMatchObject({ damage: 3, lethal: false, remaining: 18 });
    }
  });

  it('keeps remaining at zero past the lethal amount', () => {
    const ctx = game();
    const victim = ctx.state.players.find((p) => p.id === 'P1')!;
    const commander = ctx.state.players.find((p) => p.id === 'P2')!.commanderCardIds[0]!;
    victim.commanderDamageTaken = { [commander]: 27 };
    expect(buildSpectatorState(ctx).commanderDamage[0]).toMatchObject({
      damage: 27,
      lethal: true,
      remaining: 0,
    });
  });
});
