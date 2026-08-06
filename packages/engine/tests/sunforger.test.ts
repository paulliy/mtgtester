/**
 * Sunforger (queen-marchesa-queens-gambit override).
 *
 * The override used to replace the ENTIRE `activatedAbilities` array with just the search
 * ability, which silently deleted the interpreter-parsed Equip {2} ability, and the search
 * ability itself had no "Unattach this Equipment" cost — so it could fire while unattached,
 * and it put the found card into hand instead of casting it for free. This file pins:
 *
 * - Equip {2} is still offered and attaches Sunforger to a creature;
 * - the search-and-cast ability is NOT offered while Sunforger is unattached;
 * - activating it while attached unattaches it, finds a red/white instant with mana value
 *   4 or less, and casts it without paying its mana cost (not into hand).
 */

import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { executeAbility, payAbilityCosts } from '../src/effects/resolve';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, mountain, oracle, plains, pump, spawn } from './fixtures';

function pod(seed = 'sunforger'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

const sunforger = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: 'd1421070-a3cc-4af3-bf91-0f97372f4161',
    name: 'Sunforger',
    typeLine: 'Artifact — Equipment',
    manaCost: '{4}',
    power: null,
    toughness: null,
    oracleText:
      'Equip {2}\n{R}{W}, Unattach this Equipment: Search your library for a red or white instant card with mana value 4 or less and cast that card without paying its mana cost. Then shuffle.',
  });

const redBolt = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Red Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    cmc: 1,
    power: null,
    toughness: null,
    oracleText: 'Test Red Bolt deals 3 damage to any target.',
  });

const optionsFor = (ctx: GameContext): string[] =>
  computePriorityOptions(ctx, p1(ctx)).map((o) => o.description);

describe('Sunforger', () => {
  it('models the whole card: Equip {2} plus the unattach-search-cast ability', () => {
    const def = interpretCard(sunforger());
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities).toHaveLength(2);
  });

  it('offers Equip but not the search ability while unattached', () => {
    const ctx = pod();
    spawn(ctx, 'P1', sunforger());
    spawn(ctx, 'P1', oracle({ name: 'Test Knight', typeLine: 'Creature — Knight', manaCost: '{2}', power: '2', toughness: '2' }));
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());

    const options = optionsFor(ctx);
    expect(options.some((d) => d.includes('Equip'))).toBe(true);
    expect(options.some((d) => d.includes('Unattach'))).toBe(false);
  });

  it('unattaches, searches, and casts a found instant for free once equipped', () => {
    const ctx = pod();
    const equipment = spawn(ctx, 'P1', sunforger());
    const knight = spawn(ctx, 'P1', oracle({ name: 'Test Knight', typeLine: 'Creature — Knight', manaCost: '{2}', power: '2', toughness: '2' }));
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    conjure(ctx, 'P1', redBolt(), 'library');
    const def = interpretCard(sunforger());
    const equip = def.activatedAbilities[0]!;
    const search = def.activatedAbilities[1]!;

    // Equip Sunforger onto the Knight.
    pump(payAbilityCosts(ctx, p1(ctx), equipment, equip.costs, 'tap'));
    pump(executeAbility(ctx, { cardId: equipment.cardId, name: equipment.name, oracleId: equipment.oracleId, controllerId: equipment.controllerId }, equip.ability, [knight.id]));
    expect(equipment.attachedTo).toBe(knight.id);
    expect(optionsFor(ctx).some((d) => d.includes('Unattach'))).toBe(true);

    // Activate the search ability: unattach cost fires, the bolt is found and cast free.
    pump(payAbilityCosts(ctx, p1(ctx), equipment, search.costs, 'tap'));
    expect(equipment.attachedTo).toBeNull();

    const opponent = ctx.state.players.find((p) => p.id === 'P2')!;
    const lifeBefore = opponent.life;
    pump(
      executeAbility(ctx, { cardId: equipment.cardId, name: equipment.name, oracleId: equipment.oracleId, controllerId: equipment.controllerId }, search.ability, []),
      (decision) => {
        if (decision.decisionType === 'general') {
          const found = decision.options.findIndex((o) => o.description.includes('Test Red Bolt'));
          if (found >= 0) return { index: found, targets: new Map() };
        }
        if (decision.decisionType === 'chooseTargets') {
          return { index: 0, targets: new Map([[0, opponent.id]]) };
        }
        return { index: 0, targets: new Map() };
      },
    );

    expect(opponent.life).toBe(lifeBefore - 3);
    expect(p1(ctx).hand.some((c) => c.name === 'Test Red Bolt')).toBe(false);
    expect(p1(ctx).graveyard.some((c) => c.name === 'Test Red Bolt')).toBe(true);
  });
});
