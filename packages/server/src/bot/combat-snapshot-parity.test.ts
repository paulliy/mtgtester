/**
 * Parity between the bot's `CombatSnapshot` simulator and the real engine — ADR 0024 Phase 7a.
 *
 * ADR 0024 accepted one significant cost: a second, parallel combat-resolution model that must
 * stay in sync with `combat.ts`'s keyword and damage rules, or "the search starts scoring against
 * rules the engine no longer has". This suite is the mitigation it prescribed. Each case builds
 * one board, runs it through the actual combat phase, and asserts the simulator predicts the same
 * deaths, the same damage to the player, and the same lifelink gain.
 *
 * It lives here, not in `packages/bot`, on purpose: `@mtg/bot` depends only on `@mtg/shared`
 * (ADR 0023 item 1) and must not gain an engine dependency even for tests. `packages/server` is
 * the one package that already depends on both, so it is the natural seam for a cross-check.
 *
 * A failure here means the two models disagree. Which one is wrong is a question for the diff —
 * but the simulator's job is to predict the engine, so unless the engine itself is being fixed in
 * the same change, the simulator is the side that moves.
 */

import { describe, expect, it } from 'vitest';
import { resolveCombatSnapshot } from '@mtg/bot';
import type { CombatSnapshot, SnapshotCreature } from '@mtg/bot';
import { runCombatPhase } from '../../../engine/src/combat/combat';
import { createGame } from '../../../engine/src/state/game';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import {
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  keywordCreature,
  pump,
  spawn,
  splitDamage,
} from '../../../engine/tests/fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(4, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  return ctx;
}

/** Read a live permanent the way the projection does, so the snapshot sees computed values. */
function snapshotOf(ctx: GameContext, perm: EnginePermanent): SnapshotCreature {
  const chars = computeCharacteristics(ctx, perm);
  return {
    id: perm.id,
    controller: perm.controllerId,
    power: chars.power ?? 0,
    toughness: chars.toughness ?? 0,
    damageMarked: perm.damageMarked,
    keywords: [...chars.keywords],
  };
}

interface Observed {
  deaths: string[];
  damageToPlayers: Record<string, number>;
  lifeGained: Record<string, number>;
}

/**
 * Run the real combat phase and report the same three things the simulator reports, read from
 * before/after engine state rather than from the simulator's vocabulary.
 */
function runRealCombat(
  ctx: GameContext,
  attackerIds: string[],
  blocks: Map<string, string | null>,
  divisions?: Map<string, Record<string, number>>,
): Observed {
  const before = new Set(ctx.state.battlefield.map((p) => p.id));
  const lifeBefore = new Map(ctx.state.players.map((p) => [p.id, p.life]));

  pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      return declareAttacks(decision, (subjectId) =>
        attackerIds.includes(subjectId) ? 'P2' : null,
      );
    }
    if (decision.decisionType === 'declareBlockers') {
      return declareBlocks(decision, (subjectId) => blocks.get(subjectId) ?? null);
    }
    if (decision.decisionType === 'assignCombatDamage' && divisions !== undefined) {
      // One division per attacker in these fixtures, so the single registered split is the
      // right answer for whichever attacker is being asked (ADR 0023 item 18 retimed this
      // decision out of `declareBlockers` into its own step).
      const [chosen] = [...divisions.values()];
      if (chosen !== undefined) return splitDamage(chosen);
    }
    return { index: 0, targets: new Map() };
  });

  const after = new Set(ctx.state.battlefield.map((p) => p.id));
  const damageToPlayers: Record<string, number> = {};
  const lifeGained: Record<string, number> = {};
  for (const player of ctx.state.players) {
    const delta = (lifeBefore.get(player.id) ?? 0) - player.life;
    if (delta > 0) damageToPlayers[player.id] = delta;
    if (delta < 0) lifeGained[player.id] = -delta;
  }
  return {
    deaths: [...before].filter((id) => !after.has(id)),
    damageToPlayers,
    lifeGained,
  };
}

/** Compare both models on the same board. Deaths compared as sets — order is not meaningful. */
function expectParity(observed: Observed, snapshot: CombatSnapshot): void {
  const predicted = resolveCombatSnapshot(snapshot);
  expect([...predicted.deaths].sort()).toEqual([...observed.deaths].sort());
  expect(predicted.damageToPlayers).toEqual(observed.damageToPlayers);
  expect(predicted.lifeGained).toEqual(observed.lifeGained);
}

describe('CombatSnapshot parity with the engine (ADR 0024 Phase 7a)', () => {
  it('unblocked attacker: all damage to the defending player', () => {
    const ctx = pod('parity-unblocked');
    const attacker = spawn(ctx, 'P1', keywordCreature('Runner', '', '{1}{W}', '3/3'), {
      summoningSick: false,
    });
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [] }],
      blockers: [],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map()), snapshot);
  });

  it('even trade: both creatures die', () => {
    const ctx = pod('parity-trade');
    const attacker = spawn(ctx, 'P1', keywordCreature('Bruiser', '', '{1}{W}', '3/3'), {
      summoningSick: false,
    });
    const blocker = spawn(ctx, 'P2', keywordCreature('Wall', '', '{1}{W}', '3/3'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('first strike kills before the blocker can answer', () => {
    const ctx = pod('parity-first-strike');
    const attacker = spawn(ctx, 'P1', keywordCreature('Duelist', 'First strike', '{1}{W}', '2/2'), {
      summoningSick: false,
    });
    const blocker = spawn(ctx, 'P2', keywordCreature('Footman', '', '{1}{W}', '2/2'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('deathtouch kills a bigger blocker and survives it', () => {
    const ctx = pod('parity-deathtouch');
    const attacker = spawn(ctx, 'P1', keywordCreature('Adder', 'Deathtouch', '{1}{W}', '1/4'), {
      summoningSick: false,
    });
    const blocker = spawn(ctx, 'P2', keywordCreature('Ogre', '', '{1}{W}', '3/3'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('trample sends the excess over a single blocker (CR 702.19b)', () => {
    const ctx = pod('parity-trample');
    const attacker = spawn(ctx, 'P1', keywordCreature('Behemoth', 'Trample', '{1}{W}', '5/5'), {
      summoningSick: false,
    });
    const blocker = spawn(ctx, 'P2', keywordCreature('Chump', '', '{1}{W}', '1/1'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('deathtouch plus trample: 1 is lethal, the rest tramples over', () => {
    const ctx = pod('parity-deathtouch-trample');
    const attacker = spawn(
      ctx,
      'P1',
      keywordCreature('Wurm', 'Deathtouch, trample', '{1}{W}', '5/5'),
      { summoningSick: false },
    );
    const blocker = spawn(ctx, 'P2', keywordCreature('Guard', '', '{1}{W}', '4/4'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('indestructible survives lethal damage', () => {
    const ctx = pod('parity-indestructible');
    const attacker = spawn(ctx, 'P1', keywordCreature('Smasher', '', '{1}{W}', '6/6'), {
      summoningSick: false,
    });
    const blocker = spawn(ctx, 'P2', keywordCreature('Statue', 'Indestructible', '{1}{W}', '2/2'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('lifelink credits the attacker for damage dealt to a blocker', () => {
    const ctx = pod('parity-lifelink');
    const attacker = spawn(ctx, 'P1', keywordCreature('Cleric', 'Lifelink', '{1}{W}', '3/3'), {
      summoningSick: false,
    });
    const blocker = spawn(ctx, 'P2', keywordCreature('Shield', '', '{1}{W}', '1/5'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    expectParity(runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]])), snapshot);
  });

  it('multi-block honours the attacker chosen damage division (CR 510.1c-d)', () => {
    const ctx = pod('parity-multiblock');
    const attacker = spawn(ctx, 'P1', keywordCreature('Titan', '', '{1}{W}', '5/5'), {
      summoningSick: false,
    });
    const a = spawn(ctx, 'P2', keywordCreature('First Wall', '', '{1}{W}', '2/2'));
    const b = spawn(ctx, 'P2', keywordCreature('Second Wall', '', '{1}{W}', '2/2'));
    const division = { [a.id]: 2, [b.id]: 3 };
    const snapshot: CombatSnapshot = {
      attackers: [
        {
          ...snapshotOf(ctx, attacker),
          defendingPlayer: 'P2',
          blockedBy: [a.id, b.id],
          damageDivision: division,
        },
      ],
      blockers: [
        { ...snapshotOf(ctx, a), blocking: attacker.id },
        { ...snapshotOf(ctx, b), blocking: attacker.id },
      ],
    };
    expectParity(
      runRealCombat(
        ctx,
        [attacker.id],
        new Map([
          [a.id, attacker.id],
          [b.id, attacker.id],
        ]),
        new Map([[attacker.id, division]]),
      ),
      snapshot,
    );
  });

  it('double strike plus trample, blocker dead after the first step — all excess reaches the player', () => {
    const ctx = pod('parity-double-strike-trample');
    const attacker = spawn(
      ctx,
      'P1',
      keywordCreature('Champion', 'Double strike, trample', '{1}{W}', '4/4'),
      { summoningSick: false },
    );
    const blocker = spawn(ctx, 'P2', keywordCreature('Sapling', '', '{1}{W}', '1/1'));
    const snapshot: CombatSnapshot = {
      attackers: [{ ...snapshotOf(ctx, attacker), defendingPlayer: 'P2', blockedBy: [blocker.id] }],
      blockers: [{ ...snapshotOf(ctx, blocker), blocking: attacker.id }],
    };
    const observed = runRealCombat(ctx, [attacker.id], new Map([[blocker.id, attacker.id]]));
    expectParity(observed, snapshot);
    // First strike: 1 lethal to the blocker, 3 tramples over. Regular step: the blocker is gone,
    // so CR 702.19b sends the remaining 4 damage to the player. Total = 7.
    expect(observed.damageToPlayers['P2']).toBe(7);
  });
});
