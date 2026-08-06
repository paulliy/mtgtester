/**
 * The combat presentation hints (brief — player-experience overhaul, Workstream 5).
 *
 * Both attackers and blockers (ADR 0023 items 13/14, Phase 4) are ONE decision each, so there is
 * no "remaining subjects" list to check for continuity — instead, `attackDeclaration`'s /
 * `blockDeclaration`'s `subjects` must name exactly the eligible creatures, in the same order the
 * wire-level `targets` slots use.
 */

import { describe, expect, it } from 'vitest';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import {
  bear,
  conjure,
  copies,
  declareAttacks,
  declareNoAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  pump,
  spawn,
} from './fixtures';

function combatContext(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed: 'combat-present' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  for (const p of ctx.state.players) conjure(ctx, p.id, forest(), 'library');
  return ctx;
}

describe('combat presentation hint', () => {
  it('attackDeclaration names exactly the eligible creatures, in the same order as the target slots', () => {
    const ctx = combatContext();
    const bears = [spawn(ctx, 'P1', bear()), spawn(ctx, 'P1', bear()), spawn(ctx, 'P1', bear())];

    const { decisions } = pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareNoAttacks(d);
      // No one attacked, so `declareBlockers` never surfaces (CR 508.8) — every other decision
      // here is a plain priority window.
      return { index: 0, targets: new Map() };
    });

    const attackerDecisions = decisions.filter((d) => d.decisionType === 'declareAttackers');
    expect(attackerDecisions.length).toBe(1); // one batched decision, not one per creature
    const decision = attackerDecisions[0]!;
    const subjects = decision.presentationAttackDeclaration?.subjects;
    expect(subjects?.map((s) => s.subjectId).sort()).toEqual(bears.map((b) => b.id).sort());
    const option = decision.options[0]!;
    expect(option.targets?.map((t) => t.slot)).toEqual(subjects!.map((_, i) => i));
    // Every slot's options are that subject's own legal defenders plus "decline" — never another
    // creature's id, and never a subject the whole declaration doesn't cover.
    for (let i = 0; i < subjects!.length; i++) {
      const expected = [...subjects![i]!.defenders.map((d) => d.playerId), NO_ATTACK_TARGET];
      expect(option.targets?.[i]?.options.sort()).toEqual(expected.sort());
    }
  });

  it('blockDeclaration names exactly the eligible blockers, in the same order as the target slots', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', bear()); // an attacker, so P2 actually gets a declareBlockers decision
    const blockers = [spawn(ctx, 'P2', bear()), spawn(ctx, 'P2', bear())];

    const { decisions } = pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => 'P2');
      if (d.decisionType === 'declareBlockers') return declareNoBlocks(d);
      return { index: 0, targets: new Map() };
    });

    const blockerDecisions = decisions.filter((d) => d.decisionType === 'declareBlockers');
    expect(blockerDecisions.length).toBe(1); // one batched decision, not one per creature
    const decision = blockerDecisions[0]!;
    const subjects = decision.presentationBlockDeclaration?.subjects;
    expect(subjects?.map((s) => s.subjectId).sort()).toEqual(blockers.map((b) => b.id).sort());
    const option = decision.options[0]!;
    expect(option.targets?.map((t) => t.slot)).toEqual(subjects!.map((_, i) => i));
    // Every slot's options are that subject's own legal attackers plus "decline" — never another
    // creature's id, and never a subject the whole declaration doesn't cover.
    for (let i = 0; i < subjects!.length; i++) {
      const expected = [...subjects![i]!.attackers.map((a) => a.attackerId), NO_BLOCK_TARGET];
      expect(option.targets?.[i]?.options.sort()).toEqual(expected.sort());
    }
  });
});
