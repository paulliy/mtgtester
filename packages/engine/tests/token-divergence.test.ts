/**
 * Behavioral tests for the token divergences the shared catalog (`cards/tokens.ts`) closed.
 *
 * Tokens are pure data, so a token written out by hand in each override file is a token that
 * drifts — and it had. These pin the corrected behavior rather than the corrected literal, per
 * `overrides/index.ts`'s rule 3 (behavioral test, never a `modeled === true` test).
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import { executeAbility } from '../src/effects/resolve';
import type { EffectSource } from '../src/effects/resolve';
import type { GameContext } from '../src/state/types';
import { getOverride } from '../src/cards/overrides';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { TREASURE } from '../src/cards/tokens';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

const sourceOf = (perm: ReturnType<typeof spawn>): EffectSource => ({
  cardId: perm.cardId,
  name: perm.name,
  oracleId: perm.oracleId,
  controllerId: perm.controllerId,
});

describe('Trostani Discordant', () => {
  it('creates white Soldier tokens, not white-green ones', () => {
    // The card's own handled line reads "two 1/1 white Soldier creature tokens with lifelink";
    // the hand-written spec had colors ['W','G'] — the commander's identity, not the token's.
    const def = getOverride('9a2fdc0e-e0de-47fc-95e4-04e725ddf060');
    const trigger = def?.def.triggers?.[0];
    const create = trigger?.effects.find((e) => e.op === 'createToken');
    expect(create).toBeDefined();
    expect((create as { spec: { colors: string[]; keywords?: string[] } }).spec.colors).toEqual([
      'W',
    ]);
    expect((create as { spec: { keywords?: string[] } }).spec.keywords).toEqual(['lifelink']);
  });

  it('actually puts white Soldiers onto the battlefield', () => {
    const ctx = pod('trostani');
    const trostani = spawn(
      ctx,
      'P1',
      oracle({
        oracleId: '9a2fdc0e-e0de-47fc-95e4-04e725ddf060',
        name: 'Trostani Discordant',
        typeLine: 'Legendary Creature — Dryad',
        manaCost: '{2}{G}{W}',
        power: '0',
        toughness: '4',
      }),
    );
    const ability = getOverride('9a2fdc0e-e0de-47fc-95e4-04e725ddf060')!.def.triggers![0]!;

    pump(executeAbility(ctx, sourceOf(trostani), ability, []));

    const soldiers = ctx.state.battlefield.filter((p) => p.name === 'Soldier');
    expect(soldiers).toHaveLength(2);
    for (const soldier of soldiers) {
      expect(ctx.defs.get(soldier.oracleId)?.colors).toEqual(['W']);
    }
  });
});

describe('Treasure tokens', () => {
  it('cost both {T} and a sacrifice to activate', () => {
    // Three Treasures existed across override files: one correct, one missing the {T}, and one
    // with no costs at all — which made it a free, repeatable any-color mana source.
    expect(TREASURE.manaAbilities).toHaveLength(1);
    expect(TREASURE.manaAbilities?.[0]?.costs).toEqual([
      { kind: 'tap' },
      { kind: 'sacrificeSelf' },
    ]);
    expect(TREASURE.manaAbilities?.[0]?.units).toEqual([['W', 'U', 'B', 'R', 'G']]);
  });

  it('uses the same Treasure catalog entry from supported trigger and granted ability paths', () => {
    const mahadi = getOverride('1b3e841e-0f8f-467d-9983-f9b8d081a67f');
    const stash = getOverride('d1deba03-b26a-4a0d-b242-24bb3a3f9ea6');
    const triggerToken = mahadi?.def.triggers?.[0]?.effects.find(
      (effect) => effect.op === 'createToken',
    );
    const granted = stash?.def.staticEffects?.find((effect) => 'addActivatedAbility' in effect.op);
    const abilityToken =
      granted && 'addActivatedAbility' in granted.op
        ? granted.op.addActivatedAbility.ability.effects.find(
            (effect) => effect.op === 'createToken',
          )
        : undefined;

    expect(triggerToken?.op).toBe('createToken');
    expect(abilityToken?.op).toBe('createToken');
    if (triggerToken?.op !== 'createToken' || abilityToken?.op !== 'createToken') return;
    expect(triggerToken.spec).toEqual(TREASURE);
    expect(abilityToken.spec).toEqual(TREASURE);
  });
});
