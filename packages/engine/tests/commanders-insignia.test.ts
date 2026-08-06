/**
 * Commander's Insignia — an engine-bug regression, not just a coverage gap.
 *
 * "Creatures you control get +1/+1 for each time you've cast your commander from the command
 * zone this game" models as a layer-7d static effect whose power/toughness is a
 * `commanderCastCount` `Value`. Every characteristics query runs that effect through the layer
 * engine's `evaluateValue` (`cards/value.ts`), which is deliberately narrower than the full,
 * resolution-only `evaluateValueIn` (`effects/values.ts`) and used to THROW for any `Value`
 * kind it didn't special-case — `commanderCastCount` included, because it looked like it needed
 * a resolving ability's `x`/`targets`/`damageDealt` scope. It doesn't: it only needs to know
 * whose "you" the static effect belongs to, which the layer engine always has (the static
 * effect's source controller). `evaluateValue` now answers it directly from that.
 *
 * The layer cache (ADR 0007, `effects/layer-cache.ts`) is the second half of this bug: its
 * digest folds battlefield permanents, until-eot effects, and (conditionally) graveyards, but
 * never `commanderCastCount` — a player-level counter that changes without touching any of
 * those. Left unfixed, the buff would compute once and then never update as its owner recasts
 * their commander.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { effectivePT } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, oracle, spawn } from './fixtures';

function ctx4(): GameContext {
  const c = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed: 'commanders-insignia' },
    ),
  );
  c.state.currentTurnPlayer = 'P1';
  c.state.turnNumber = 3;
  return c;
}

const insignia = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '979a5d92-1c67-4fa4-b932-638b0cc1adcd',
    name: "Commander's Insignia",
    typeLine: 'Enchantment',
    manaCost: '{2}{W}',
    power: null,
    toughness: null,
    oracleText:
      "Creatures you control get +1/+1 for each time you've cast your commander from the command zone this game.",
  });

describe("Commander's Insignia (engine bug regression)", () => {
  it('reads the layer engine without throwing, and scales only its controller\'s creatures with commanderCastCount', () => {
    const def = interpretCard(insignia());
    expect(def.modeled).toBe(true);

    const ctx = ctx4();
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    spawn(ctx, 'P1', insignia());

    // No commander cast yet: reading P/T must not throw, and the buff is +0/+0.
    expect(() => effectivePT(ctx, mine)).not.toThrow();
    expect(effectivePT(ctx, mine)).toEqual({ power: 2, toughness: 2 });

    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('no P1');
    p1.commanderCastCount['commander-card-1'] = 2;

    // The layer cache must invalidate here: nothing about the battlefield, until-eot effects,
    // or graveyards changed — only `commanderCastCount`, which the digest now folds in.
    expect(effectivePT(ctx, mine)).toEqual({ power: 4, toughness: 4 });
    // "you control": the opponent's creature is untouched by P1's cast count.
    expect(effectivePT(ctx, theirs)).toEqual({ power: 2, toughness: 2 });

    // A second commander (partners) contributes too — the value sums every entry.
    p1.commanderCastCount['commander-card-2'] = 1;
    expect(effectivePT(ctx, mine)).toEqual({ power: 5, toughness: 5 });
  });
});
