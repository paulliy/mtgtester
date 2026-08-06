/**
 * Behavioral test for Sarkhan, Soul Aflame's "Dragon ETB copy" trigger (previously a `noOp`
 * stub — see `cards/interpret.ts`). Confirms the engine actually applies CR 707's
 * become-a-copy effect rather than doing nothing: power/toughness/type line/oracle text/
 * abilities all switch to the entering Dragon's, while the name stays "Sarkhan, Soul Aflame"
 * and Legendary is retained even if the Dragon copied isn't legendary itself.
 */

import { describe, expect, it } from 'vitest';
import { getDefByOracleId } from '../src/state/queries';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { computeCharacteristics } from '../src/effects/continuous';
import type { EffectSource } from '../src/effects/resolve';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

const sarkhanOracle = () =>
  oracle({
    oracleId: 'bbcae463-ba05-4cfe-9c25-13f2e64698c7',
    name: 'Sarkhan, Soul Aflame',
    manaCost: '{1}{U}{R}',
    typeLine: 'Legendary Creature — Human Shaman',
    types: ['Creature'],
    subtypes: ['Human', 'Shaman'],
    supertypes: ['Legendary'],
    power: '2',
    toughness: '4',
    oracleText:
      "Dragon spells you cast cost {1} less to cast.\nWhenever a Dragon you control enters, you may have Sarkhan become a copy of it until end of turn, except its name is Sarkhan, Soul Aflame and it's legendary in addition to its other types.",
  });

// A non-legendary Dragon, so the test also proves the "legendary in addition to its other
// types" clause — not just a name/name check that a legendary Dragon would pass by accident.
const dragonWhelp = () =>
  oracle({
    name: 'Dragon Whelp',
    manaCost: '{2}{R}',
    typeLine: 'Creature — Dragon',
    types: ['Creature'],
    subtypes: ['Dragon'],
    supertypes: [],
    power: '2',
    toughness: '2',
    oracleText: 'Flying\nAt the beginning of your upkeep, this creature deals 1 damage to you.',
    keywords: ['Flying'],
  });

describe('Sarkhan, Soul Aflame', () => {
  it('becomes a copy of the entering Dragon, keeping its own name and gaining Legendary', () => {
    const ctx = pod('sarkhan-soul-aflame');
    const sarkhan = spawn(ctx, 'P1', sarkhanOracle());
    const dragon = spawn(ctx, 'P1', dragonWhelp());

    registerDef(ctx, sarkhanOracle());
    const def = getDefByOracleId(ctx, sarkhan.oracleId, sarkhan.name);
    const trigger = def.triggers.find((t) => t.description === 'Dragon ETB copy');
    if (trigger === undefined) throw new Error('Sarkhan, Soul Aflame is missing its Dragon ETB copy trigger');

    const source: EffectSource = {
      cardId: sarkhan.cardId,
      name: sarkhan.name,
      oracleId: sarkhan.oracleId,
      controllerId: sarkhan.controllerId,
    };

    pump(executeAbility(ctx, source, trigger, [], dragon.cardId));

    const perm = ctx.state.battlefield.find((p) => p.cardId === sarkhan.cardId)!;
    expect(perm.name).toBe('Sarkhan, Soul Aflame');
    expect(perm.power).toBe(2);
    expect(perm.toughness).toBe(2);
    expect(perm.oracleId).toBe(dragon.oracleId);

    const chars = computeCharacteristics(ctx, perm);
    expect(chars.subtypes).toContain('Dragon');
    expect(chars.supertypes).toContain('Legendary');
    expect(chars.keywords).toContain('flying');
  });
});
