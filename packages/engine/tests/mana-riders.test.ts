/**
 * Mana abilities that cost the player something beyond the tap (R.3).
 *
 * Two printed shapes, and they are NOT the same mechanism:
 *
 *   Ancient Tomb / Adarkar Wastes — "{T}: Add {C}{C}. This land deals 2 damage to you."
 *       A RIDER on the mana ability. Mana abilities never use the stack (CR 605.3a), so the
 *       damage applies the instant the mana is produced and cannot be responded to.
 *   City of Brass — "Whenever this land becomes tapped, it deals 1 damage to you."
 *       A genuine triggered ability that uses the stack, and fires on ANY tap, not only a tap
 *       for mana.
 *
 * What these pin, beyond "the card is modeled":
 *
 * - `{C}{C}` is TWO mana, not one mana with a duplicated choice. The painland regex used to wrap
 *   every symbol into a single unit, which is right for "{R} or {W}" and wrong for "{C}{C}".
 * - the rider fires ONCE per activation, and only for the ability actually activated. Adarkar
 *   Wastes is the case that proves it: two mana abilities, only one of which costs life.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import { payManaCost } from '../src/effects/resolve';
import { parseManaCost } from '../src/mana/cost';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const ancientTomb = () =>
  oracle({
    name: 'Test Tomb',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}{C}. This land deals 2 damage to you.',
  });

const adarkarWastes = () =>
  oracle({
    name: 'Test Wastes',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}.\n{T}: Add {W} or {U}. This land deals 1 damage to you.',
  });

const cityOfBrass = () =>
  oracle({
    name: 'Test City',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      'Whenever this land becomes tapped, it deals 1 damage to you.\n{T}: Add one mana of any color.',
  });

function pod(seed = 'mana-riders'): GameContext {
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

describe('mana ability riders', () => {
  it('reads Ancient Tomb as two mana with one damage rider', () => {
    const def = interpretCard(ancientTomb());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    expect(def.manaAbilities).toHaveLength(1);
    // TWO units of one symbol each — not one unit offering {C} twice.
    expect(def.manaAbilities[0]!.units).toEqual([['C'], ['C']]);
    expect(def.manaAbilities[0]!.onActivate).toEqual([{ op: 'damageController', amount: 2 }]);
  });

  it('Ancient Tomb produces two mana and deals 2 damage exactly once', () => {
    const ctx = pod();
    const player = p1(ctx);
    const tomb = spawn(ctx, 'P1', ancientTomb());
    const lifeBefore = player.life;

    pump(payManaCost(ctx, player, parseManaCost('{2}' as never).cost!));

    expect(tomb.tapped).toBe(true);
    expect(player.life).toBe(lifeBefore - 2);
  });

  it('Adarkar Wastes charges life only for the ability that was activated', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', adarkarWastes());
    const lifeBefore = player.life;

    // Paying {C} must use the FREE ability. Applying every mana ability's rider — which the
    // engine used to do — would charge 1 life here.
    pump(payManaCost(ctx, player, parseManaCost('{C}' as never).cost!));
    expect(player.life).toBe(lifeBefore);
  });

  it('Adarkar Wastes does charge life for its colored ability', () => {
    const ctx = pod();
    const player = p1(ctx);
    spawn(ctx, 'P1', adarkarWastes());
    const lifeBefore = player.life;

    pump(payManaCost(ctx, player, parseManaCost('{W}' as never).cost!));
    expect(player.life).toBe(lifeBefore - 1);
  });

  it('City of Brass triggers on being tapped for mana', () => {
    const ctx = pod();
    const player = p1(ctx);
    const def = interpretCard(cityOfBrass());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    spawn(ctx, 'P1', cityOfBrass());
    const lifeBefore = player.life;
    pump(payManaCost(ctx, player, parseManaCost('{U}' as never).cost!));

    // Unlike a rider, this is a real trigger: it is QUEUED by the tap and does its damage when
    // it resolves, so life is still untouched at this point.
    expect(player.life).toBe(lifeBefore);
    expect(ctx.state.pendingTriggers.length).toBe(1);
    expect(ctx.state.pendingTriggers[0]!.sourceName).toBe('Test City');
  });

  it('offers City of Brass every color', () => {
    const ctx = pod();
    spawn(ctx, 'P1', cityOfBrass());
    const symbols = manaSourcesFor(ctx, 'P1').flatMap((s) => s.units.flat());
    expect([...new Set(symbols)].sort()).toEqual(['B', 'G', 'R', 'U', 'W']);
  });
});
