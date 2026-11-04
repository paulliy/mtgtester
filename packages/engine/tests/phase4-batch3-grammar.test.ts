/**
 * EDHREC coverage plan, Phase 4 batch 3: keywords and short line shapes. The runner scenarios of
 * one card per feature (Monastery Swiftspear, Noble Hierarch, Arcbound Worker, Myr Convert, Grim
 * Monolith, Vivid Creek, Razortrap Gorge, Fervent Charge) drive each through the engine; this file
 * covers the edges those positions do not reach (D1).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { evaluateCondition } from '../src/cards/condition';
import { interpretCard } from '../src/cards/interpret';
import { dealDamageToPlayer } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pumpStrict } from './fixtures';

const creature = (oracleText: string, typeLine = 'Creature — Rat'): OracleCard =>
  oracle({ name: 'P4 Probe', typeLine, manaCost: '{1}', power: '1', toughness: '1', oracleText });

function pod(seed: string): GameContext {
  return createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
}
const player = (ctx: GameContext, id: string) => ctx.state.players.find((p) => p.id === id)!;

describe('Phase 4 batch 3', () => {
  it('toxic instances add up to the total toxic value (CR 702.164b)', () => {
    expect(interpretCard(creature('Toxic 1\nToxic 2')).toxic).toBe(3);
  });

  it('toxic gives poison counters for combat damage only (CR 702.164c)', () => {
    const ctx = pod('p4-toxic');
    const source = { cardId: 'p4-toxic', name: 'P4 Probe', oracleId: 'p4', controllerId: 'P1' };
    const opts = { sourceIsCommander: false, sourceHasLifelink: false, sourceToxic: 2 };
    pumpStrict(dealDamageToPlayer(ctx, source, player(ctx, 'P2'), 1, { ...opts, combat: false }));
    expect(player(ctx, 'P2').poisonCounters).toBe(0);
    pumpStrict(dealDamageToPlayer(ctx, source, player(ctx, 'P2'), 1, { ...opts, combat: true }));
    expect(player(ctx, 'P2').poisonCounters).toBe(2);
    expect(player(ctx, 'P2').life).toBe(38);
  });

  it('modular reads as entry counters and an optional dies trigger at an artifact creature', () => {
    const def = interpretCard(creature('Modular 2', 'Artifact Creature — Construct'));
    expect(def.entersWithCounters).toEqual({ '+1/+1': 2 });
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.optional).toBe(true);
    expect(def.triggers[0]!.targets).toEqual([
      { kind: 'creature', filter: { kind: 'type', value: 'Artifact' } },
    ]);
  });

  it('"enters tapped with N counters" refuses stun counters, which the engine does not model', () => {
    const def = interpretCard(
      creature('This creature enters tapped with six stun counters on it.', 'Creature — Beast'),
    );
    expect(def.modeled).toBe(false);
  });

  it('"a player has 13 or less life" ignores a player who has lost', () => {
    const ctx = pod('p4-life');
    const condition = { kind: 'anyPlayerLifeAtMost', n: 13 } as const;
    const source = { cardId: 'p4-gorge', controllerId: 'P1' };
    expect(evaluateCondition(ctx, condition, source)).toBe(false);
    player(ctx, 'P3').life = 0;
    player(ctx, 'P3').hasLost = true;
    expect(evaluateCondition(ctx, condition, source)).toBe(false);
    player(ctx, 'P2').life = 13;
    expect(evaluateCondition(ctx, condition, source)).toBe(true);
  });

  it('a granted "prowess" is not read: only a printed keyword line expands', () => {
    const def = interpretCard(
      oracle({
        name: 'P4 Anthem',
        typeLine: 'Enchantment',
        manaCost: '{1}',
        oracleText: 'Creatures you control have prowess.',
      }),
    );
    expect(def.modeled).toBe(false);
  });
});
