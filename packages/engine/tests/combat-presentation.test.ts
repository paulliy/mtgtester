/**
 * The combat client-batching hint (brief — player-experience overhaul, Workstream 5):
 * `presentationCombat.remaining` on declare-attackers/blockers decision *i* must name exactly
 * the subjects actually surfaced on decisions *i+1..n* — that is the property a client combat
 * plan relies on to compose the whole assignment up front and replay it.
 */

import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, pump, spawn } from './fixtures';

function combatContext(): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })), { seed: 'combat-present' }),
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
  it('remaining attackers match the subjects of the decisions that actually follow', () => {
    const ctx = combatContext();
    const bears = [spawn(ctx, 'P1', bear()), spawn(ctx, 'P1', bear()), spawn(ctx, 'P1', bear())];

    const { decisions } = pump(runCombatPhase(ctx), (d) => {
      const passOpt = d.options.findIndex((o) => o.type === 'pass' || o.type === 'noAttack' || o.type === 'noBlock');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    const attackerDecisions = decisions.filter((d) => d.decisionType === 'declareAttackers');
    expect(attackerDecisions.length).toBe(bears.length);
    for (let i = 0; i < attackerDecisions.length; i++) {
      const decision = attackerDecisions[i]!;
      const combat = decision.presentationCombat;
      expect(combat?.kind).toBe('attackers');
      const laterSubjects = attackerDecisions.slice(i + 1).map((d) => d.presentationCombat!.subjectId);
      expect(combat!.remaining.map((r) => r.subjectId)).toEqual(laterSubjects);
    }
  });

  it('remaining blockers match the subjects of the decisions that actually follow', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());

    const { decisions } = pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const idx = d.options.findIndex((o) => o.description.includes('attacks P2'));
        if (idx >= 0) return { index: idx, targets: new Map() };
      }
      const passOpt = d.options.findIndex((o) => o.type === 'pass' || o.type === 'noAttack' || o.type === 'noBlock');
      return { index: passOpt >= 0 ? passOpt : 0, targets: new Map() };
    });

    const blockerDecisions = decisions.filter((d) => d.decisionType === 'declareBlockers');
    expect(blockerDecisions.length).toBeGreaterThan(0);
    for (let i = 0; i < blockerDecisions.length; i++) {
      const decision = blockerDecisions[i]!;
      const combat = decision.presentationCombat;
      expect(combat?.kind).toBe('blockers');
      const laterSubjects = blockerDecisions.slice(i + 1).map((d) => d.presentationCombat!.subjectId);
      expect(combat!.remaining.map((r) => r.subjectId)).toEqual(laterSubjects);
    }
  });
});
