import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, island, oracle, pump, spawn } from './fixtures';

const dash = String.fromCharCode(0x2014);

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Tier 3 graveyard alternative casts', () => {
  it('parses Flashback with mana and life costs, pays it, and exiles after resolution', () => {
    const card = oracle({
      name: 'Test Deep Study',
      typeLine: 'Sorcery',
      manaCost: '{3}{U}',
      oracleText: `Draw a card.${String.fromCharCode(10)}Flashback${dash}{1}{U}, Pay 3 life.`,
    });
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.alternativeCasts?.[0]).toMatchObject({
      kind: 'nonMana',
      from: 'graveyard',
      exileOnResolution: true,
      costs: [{ kind: 'payLife', amount: 3 }],
    });

    const ctx = pod('tier3-flashback');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const spell = conjure(ctx, 'P1', card, 'graveyard');
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', island());
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id && payload.fromGraveyard === true;
    });
    expect(option).toBeDefined();
    const lifeBefore = player.life;
    pump(applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    expect(player.life).toBe(lifeBefore - 3);
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.exile.some((object) => object.cardId === spell.cardId)).toBe(true);
  });

  it('marks an escaped spell and the resulting permanent with its cast origin', () => {
    const card = oracle({
      name: 'Test Escaped Beast',
      typeLine: `Creature ${dash} Beast`,
      manaCost: '{4}{G}',
      power: '4',
      toughness: '4',
      oracleText: `Escape${dash}{G}, Exile one other card from your graveyard.`,
    });
    const ctx = pod('tier3-escaped-permanent');
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const spell = conjure(ctx, 'P1', card, 'graveyard');
    conjure(ctx, 'P1', forest(), 'graveyard');
    spawn(ctx, 'P1', forest());
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id && payload.fromGraveyard === true;
    });
    expect(option).toBeDefined();
    pump(applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    expect(ctx.state.stack.at(-1)?.escaped).toBe(true);
    expect(ctx.state.stack.at(-1)?.card?.escaped).toBe(true);

    pump(resolveTopOfStack(ctx));
    const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === spell.cardId);
    expect(permanent?.escaped).toBe(true);
  });
});
