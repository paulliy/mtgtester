import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, pump, spawn } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/target-untap-oracle.json', import.meta.url), 'utf8'),
) as {
  cards: { sha256: string; card: OracleCard }[];
};
const expectations = [
  ['Arachnoid Adaptation', 2, 2, 'reach', 0],
  ["Riverguard's Reflexes", 2, 2, 'first strike', 0],
  ['Acrobatic Leap', 1, 3, 'flying', 0],
  ['Burst of Strength', 0, 0, undefined, 1],
  ['Vines of the Recluse', 1, 2, 'reach', 0],
  ['Dragonscale Boon', 0, 0, undefined, 2],
  ["Witch's Web", 3, 3, 'reach', 0],
  ['Pillar Launch', 2, 2, 'reach', 0],
  ["Bull's Strength", 2, 2, 'trample', 0],
  ['High Stride', 1, 3, 'reach', 0],
  ['Wings of the Cosmos', 1, 3, 'flying', 0],
  ["Tethermage's Advantage", 2, 2, 'reach', 0],
  ['Vault Skyward', 0, 0, 'flying', 0],
  ['Leaping Ambush', 1, 3, 'reach', 0],
  ['Escape from Orthanc', 1, 3, 'flying', 0],
  ['Soldier On', 0, 0, undefined, 2],
] as const;

describe('one target followed by an untap pronoun', () => {
  it.each(expectations)(
    'target-untap-normal-path — binds both instructions to %s’s one target',
    (name, power, toughness, keyword, counters) => {
      const pinned = fixture.cards.find((row) => row.card.name === name)!;
      expect(createHash('sha256').update(JSON.stringify(pinned.card)).digest('hex')).toBe(
        pinned.sha256,
      );
      const ctx = createGame(
        gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]),
      );
      const player = ctx.state.players[0]!;
      ctx.state.currentTurnPlayer = player.id;
      ctx.state.phase = 'precombatMain';
      const card = conjure(ctx, player.id, pinned.card, 'hand');
      const selected = spawn(ctx, 'P2', bear());
      const other = spawn(ctx, 'P2', bear());
      selected.tapped = other.tapped = true;
      for (const symbol of ['W', 'U', 'B', 'R', 'G', 'C'] as const)
        addMana(
          player,
          Array.from({ length: 4 }, () => ({ symbol })),
        );
      const option = computePriorityOptions(ctx, player).find(
        (option) => (option.payload as { objectId?: string }).objectId === card.id,
      )!;
      expect(option.targets).toHaveLength(1);
      pump(
        applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map([[0, selected.id]]),
        }),
      );
      pump(resolveTopOfStack(ctx));
      const chars = computeCharacteristics(ctx, selected);
      expect([chars.power, chars.toughness]).toEqual([
        2 + power + counters,
        2 + toughness + counters,
      ]);
      if (keyword !== undefined) expect(chars.keywords).toContain(keyword);
      expect(selected.counters['+1/+1'] ?? 0).toBe(counters);
      expect(selected.tapped).toBe(false);
      expect(other.tapped).toBe(true);
      expect([
        computeCharacteristics(ctx, other).power,
        computeCharacteristics(ctx, other).toughness,
      ]).toEqual([2, 2]);
      expect(player.graveyard.some((object) => object.cardId === card.cardId)).toBe(true);
    },
  );
});
