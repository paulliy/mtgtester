/**
 * Dedicated unit tests for the 5 Engine Auto-Passing & Decision Optimization rules:
 * 1. Upkeep & Draw Step Auto-Passing
 * 2. Bystander Auto-Passing in 4-Player Combat
 * 3. Action Utility & Phase Filtering
 * 4. Commander Auto-Routing to Command Zone
 * 5. Single-Basic-Land Search Auto-Selection
 */

import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@mtg/shared';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { computePriorityOptions } from '../src/actions/legal';
import { priorityCheckpoint } from '../src/sba/sba';
import { moveObject } from '../src/state/objects';
import { executeAbility } from '../src/effects/resolve';
import {
  bear,
  bolt,
  conjure,
  copies,
  forest,
  gameConfig,
  giantGrowth,
  mountain,
  oracle,
  pick,
  pump,
  registerDef,
  spawn,
} from './fixtures';

function setup4PlayerContext(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'auto-pass-optimizations' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 2;
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  for (const p of ctx.state.players) {
    conjure(ctx, p.id, forest(), 'library');
  }
  return ctx;
}

describe('Engine Auto-Passing & Decision Optimizations', () => {
  describe('1. Upkeep & Draw Step Auto-Passing', () => {
    it('offers priority to all players during upkeep when stack is empty', () => {
      const ctx = setup4PlayerContext();
      ctx.state.step = 'upkeep';
      // Give everyone instant-speed spells so they would normally have choices
      for (const p of ctx.state.players) {
        spawn(ctx, p.id, mountain());
        conjure(ctx, p.id, bolt(), 'hand');
      }

      const surfaced: PlayerId[] = [];
      pump(runPrioritySequence(ctx), (d) => {
        surfaced.push(d.player);
        return pick(d, 'Pass');
      });

      // An empty stack does not remove the right to cast an instant.
      expect(surfaced).toEqual(['P1', 'P2', 'P3', 'P4']);
    });

    it('offers priority to all players during draw step when stack is empty', () => {
      const ctx = setup4PlayerContext();
      ctx.state.step = 'draw';
      for (const p of ctx.state.players) {
        spawn(ctx, p.id, mountain());
        conjure(ctx, p.id, bolt(), 'hand');
      }

      const surfaced: PlayerId[] = [];
      pump(runPrioritySequence(ctx), (d) => {
        surfaced.push(d.player);
        return pick(d, 'Pass');
      });

      expect(surfaced).toEqual(['P1', 'P2', 'P3', 'P4']);
    });

    it('surfaces priority during upkeep when a trigger is queued or on the stack', () => {
      const ctx = setup4PlayerContext();
      ctx.state.step = 'upkeep';
      for (const p of ctx.state.players) {
        spawn(ctx, p.id, mountain());
        conjure(ctx, p.id, bolt(), 'hand');
      }

      // Add a trigger to the stack
      ctx.state.stack.push({
        id: 'o-upkeep-trigger',
        sourceId: 'c-test',
        controllerId: 'P1',
        kind: 'triggeredAbility',
        description: 'Upkeep Trigger',
        targets: [],
        card: null,
        ability: { kind: 'triggered', description: 'gain 1 life', effects: [], targets: [] },
        sourceOracleId: 'oracle-upkeep-test',
        sourceCardId: 'c-test',
        isCommanderCast: false,
      });

      const surfaced: PlayerId[] = [];
      pump(runPrioritySequence(ctx), (d) => {
        surfaced.push(d.player);
        return pick(d, 'Pass');
      });

      // With an object on stack, priority IS surfaced
      expect(surfaced.length).toBeGreaterThan(0);
    });
  });

  describe('2. Bystander Auto-Passing in Combat', () => {
    it('offers bystanders priority during combat sub-steps', () => {
      const ctx = setup4PlayerContext();
      ctx.state.phase = 'combat';
      ctx.state.step = 'declareBlockers';
      ctx.state.currentTurnPlayer = 'P2'; // P2 is attacker
      ctx.state.combat = { defendingPlayers: ['P4'] }; // P4 is defender

      // Give P1 and P3 (bystanders) bolts and mountains
      for (const p of ctx.state.players) {
        spawn(ctx, p.id, mountain());
        conjure(ctx, p.id, bolt(), 'hand');
      }

      const surfaced: PlayerId[] = [];
      pump(runPrioritySequence(ctx), (d) => {
        surfaced.push(d.player);
        return pick(d, 'Pass');
      });

      // Bystanders can legally intervene in combat.
      expect(surfaced).toContain('P1');
      expect(surfaced).toContain('P3');
      expect(surfaced).toContain('P2');
      expect(surfaced).toContain('P4');
    });
  });

  describe('3. Action Utility & Phase Filtering', () => {
    it('offers pump instants during precombat main phase', () => {
      const ctx = setup4PlayerContext();
      ctx.state.phase = 'precombatMain';
      ctx.state.step = null;
      const p1 = ctx.state.players[0]!;

      spawn(ctx, 'P1', forest());
      conjure(ctx, 'P1', giantGrowth(), 'hand');
      spawn(ctx, 'P1', bear());

      const options = computePriorityOptions(ctx, p1);

      // A pump can protect a creature from damage or enable a power-based ability.
      expect(options.some((o) => o.description.includes('Test Growth'))).toBe(true);
    });

    it('retains combat trick instants during combat phase when creatures are in combat', () => {
      const ctx = setup4PlayerContext();
      ctx.state.phase = 'combat';
      ctx.state.step = 'declareBlockers';
      const p1 = ctx.state.players[0]!;

      const bearPerm = spawn(ctx, 'P1', bear());
      bearPerm.attacking = 'P2'; // Bear is attacking in combat
      spawn(ctx, 'P1', forest());
      conjure(ctx, 'P1', giantGrowth(), 'hand');

      const options = computePriorityOptions(ctx, p1);

      // Giant Growth is retained because we are in combat phase with creatures in combat
      expect(options.some((o) => o.description.includes('Test Growth'))).toBe(true);
    });
  });

  describe('4. Commander Auto-Routing to Command Zone', () => {
    it('auto-routes dying commander to command zone without surfacing AI decision', () => {
      const ctx = setup4PlayerContext();
      const commanderCard = oracle({
        name: 'King Meng',
        typeLine: 'Legendary Creature — Bear',
        manaCost: '{2}{G}',
        power: '4',
        toughness: '4',
      });
      const perm = spawn(ctx, 'P1', commanderCard, { isCommander: true });
      const p1 = ctx.state.players[0]!;
      p1.commandZone = [];

      pump(moveObject(ctx, perm, { zone: 'graveyard' }));
      expect(p1.graveyard.some((c) => c.cardId === perm.cardId)).toBe(true);

      const { decisions } = pump(priorityCheckpoint(ctx));

      // Auto-routes to command zone without surfacing a prompt
      expect(decisions.filter((d) => d.decisionType === 'commanderReplacement')).toHaveLength(0);
      expect(p1.commandZone.some((c) => c.cardId === perm.cardId)).toBe(true);
      expect(p1.graveyard.some((c) => c.cardId === perm.cardId)).toBe(false);
    });
  });

  describe('5. Basic Land Search Auto-Selection', () => {
    it('auto-selects when all matching cards in library share the same name', () => {
      const ctx = setup4PlayerContext();
      const p1 = ctx.state.players[0]!;
      p1.library = [];

      // Library contains 3 Forests (all same name)
      conjure(ctx, 'P1', forest(), 'library');
      conjure(ctx, 'P1', forest(), 'library');
      conjure(ctx, 'P1', forest(), 'library');

      const rampCard = oracle({
        name: 'Test Ramp',
        typeLine: 'Sorcery',
        manaCost: '{1}{G}',
        oracleText: 'Search your library for a basic land card, put it onto the battlefield tapped.',
      });

      const def = registerDef(ctx, rampCard);

      const searchAbility = {
        kind: 'spell' as const,
        targets: [],
        effects: [
          {
            op: 'searchLibrary' as const,
            filter: { kind: 'type' as const, value: 'Land' },
            destinations: [{ zone: 'battlefield' as const, tapped: true }],
          },
        ],
      };

      const { decisions } = pump(
        executeAbility(
          ctx,
          { cardId: 'c-ramp', name: 'Test Ramp', oracleId: def.oracleId, controllerId: 'P1' },
          searchAbility,
          [],
        ),
      );

      // Single distinct basic land name auto-selects without surfacing an AI decision
      expect(decisions.some((d) => d.prompt.includes('search your library'))).toBe(false);
      expect(ctx.state.battlefield.some((p) => p.name === 'Forest')).toBe(true);
    });
  });
});
