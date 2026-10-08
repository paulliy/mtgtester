import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/hideaway-casting-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const bridge = pinned.cards[0]!.card;

function setup(hidden: OracleCard) {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], {
      seed: 'hideaway-cast-contract',
    }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const land = conjure(ctx, 'P1', bridge, 'hand');
  const top = conjure(ctx, 'P1', hidden, 'library');
  const option = computePriorityOptions(ctx, player).find(
    (option) => (option.payload as PriorityActionPayload).kind === 'playLand',
  )!;
  pump(
    applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  pump(priorityCheckpoint(ctx));
  pump(resolveTopOfStack(ctx));
  const permanent = ctx.state.battlefield.find((p) => p.cardId === land.cardId)!;
  // Starting the next own turn is fixture setup; the tested activation and free play use the
  // production action, payment, resolution, casting, and zone-change paths.
  permanent.tapped = false;
  player.landsPlayedThisTurn = 0;
  spawn(ctx, 'P1', forest());
  for (let i = 0; i < 5; i++) spawn(ctx, 'P1', bear());
  const activate = () => {
    const option = computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === permanent.id;
    })!;
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
  };
  return { ctx, player, top, activate };
}

describe('pinned Mosswort Bridge casting and land permission', () => {
  it('announces a hidden permanent as a spell and leaves it on the stack for responses', () => {
    const hidden = oracle({
      name: 'Hideaway creature probe',
      typeLine: 'Creature',
      manaCost: '{7}',
      power: '3',
      toughness: '3',
    });
    const { ctx, top, activate } = setup(hidden);
    activate();
    expect(ctx.state.stack.map((entry) => entry.card?.cardId)).toEqual([top.cardId]);
    expect(ctx.state.battlefield.some((p) => p.cardId === top.cardId)).toBe(false);
    expect(ctx.state.eventLog.filter((e) => e.type === 'castSpell')).toHaveLength(1);
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((p) => p.cardId === top.cardId)).toBe(true);
  });

  it('playing a hidden land consumes a land play and is not a cast', () => {
    const { ctx, player, top, activate } = setup(forest());
    activate();
    expect(player.landsPlayedThisTurn).toBe(1);
    expect(ctx.state.battlefield.some((p) => p.cardId === top.cardId)).toBe(true);
    expect(ctx.state.eventLog.filter((e) => e.type === 'castSpell')).toHaveLength(0);
  });

  it.each(['used land play', 'opponent turn'])(
    'leaves a hidden land in exile when the permission is blocked: %s',
    (reason) => {
      const { ctx, player, top, activate } = setup(forest());
      if (reason === 'used land play') player.landsPlayedThisTurn = 1;
      else {
        ctx.state.currentTurnPlayer = 'P2';
        ctx.state.activePlayerIndex = 1;
      }
      activate();
      expect(ctx.state.exile.some((card) => card.cardId === top.cardId)).toBe(true);
      expect(ctx.state.battlefield.some((p) => p.cardId === top.cardId)).toBe(false);
    },
  );
});
