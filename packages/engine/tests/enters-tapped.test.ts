/**
 * As-enters tapped-ness (CR 614.1c) — `CardDefinition.entersTappedUnless` (ADR 0010, Inc 1).
 *
 * The mechanic is a *replacement*, not a trigger: the permanent's tapped-ness is decided before
 * it exists on the battlefield. Modeled as a trigger it would enter untapped and be tapped
 * afterwards, which is observably different (it could be tapped for mana in response).
 *
 * These are behavioral tests. That the cards report `modeled: true` is asserted separately in
 * `urdragon-coverage.test.ts`; passing that alone would not prove the lands enter correctly.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, mountain, oracle, pick, pump, spawn } from './fixtures';

const land = (name: string, typeLine: string, oracleText: string): ReturnType<typeof oracle> =>
  oracle({ name, typeLine, oracleText, manaCost: null, cmc: 0, power: null, toughness: null });

/** Blood Crypt — "As this land enters, you may pay 2 life. If you don't, it enters tapped." */
const shockland = (): ReturnType<typeof oracle> =>
  land(
    'Test Shockland',
    'Land — Swamp Mountain',
    "As this land enters, you may pay 2 life. If you don't, it enters tapped.",
  );

/** Rootbound Crag — "enters tapped unless you control a Mountain or a Forest." */
const checkland = (): ReturnType<typeof oracle> =>
  land(
    'Test Checkland',
    'Land',
    'This land enters tapped unless you control a Mountain or a Forest.',
  );

/** Rejuvenating Springs — "enters tapped unless you have two or more opponents." */
const opponentLand = (): ReturnType<typeof oracle> =>
  land('Test Pod Land', 'Land', 'This land enters tapped unless you have two or more opponents.');

/** Dreamroot Cascade — "enters tapped unless you control two or more other lands." */
const slowland = (): ReturnType<typeof oracle> =>
  land(
    'Test Slowland',
    'Land',
    'This land enters tapped unless you control two or more other lands.',
  );

function ctxWithSeats(seats: number): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(4, forest) })),
      { seed: 'enters-tapped' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/** Move a card from hand onto the battlefield, answering any as-enters choice via `answer`. */
function playFromHand(
  ctx: GameContext,
  card: ReturnType<typeof oracle>,
  answer?: (d: ReturnType<typeof pick> extends never ? never : Parameters<typeof pick>[0]) => ReturnType<typeof pick>,
): boolean {
  const obj = conjure(ctx, 'P1', card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield' }), answer);
  const perm = ctx.state.battlefield.find((p) => p.cardId === obj.cardId);
  expect(perm).toBeDefined();
  return perm?.tapped === true;
}

describe('as-enters tapped conditions (CR 614.1c)', () => {
  it('parses both printed templates into a condition rather than a trigger', () => {
    const shock = interpretCard(shockland());
    expect(shock.modeled).toBe(true);
    expect(shock.entersTappedUnless).toEqual({ kind: 'mayPayLife', n: 2 });
    // Critically: NOT a trigger, and not the unconditional `entersTapped` flag.
    expect(shock.triggers).toHaveLength(0);
    expect(shock.entersTapped).toBe(false);

    const check = interpretCard(checkland());
    expect(check.modeled).toBe(true);
    expect(check.entersTappedUnless?.kind).toBe('countPermanents');
  });

  describe('shockland — the choice is the player\'s', () => {
    it('enters untapped and costs 2 life when the controller pays', () => {
      const ctx = ctxWithSeats(4);
      const before = ctx.state.players[0]!.life;

      const tapped = playFromHand(ctx, shockland(), (d) => pick(d, 'Pay 2 life'));

      expect(tapped).toBe(false);
      expect(ctx.state.players[0]!.life).toBe(before - 2);
    });

    it('enters tapped and costs nothing when the controller declines', () => {
      const ctx = ctxWithSeats(4);
      const before = ctx.state.players[0]!.life;

      const tapped = playFromHand(ctx, shockland(), (d) => pick(d, "Don't pay"));

      expect(tapped).toBe(true);
      expect(ctx.state.players[0]!.life).toBe(before);
    });
  });

  describe('checkland — a state predicate over current characteristics', () => {
    it('enters untapped when the enabling land type is on the battlefield', () => {
      const ctx = ctxWithSeats(4);
      spawn(ctx, 'P1', mountain());

      expect(playFromHand(ctx, checkland())).toBe(false);
    });

    it('enters tapped when it is not', () => {
      const ctx = ctxWithSeats(4);

      expect(playFromHand(ctx, checkland())).toBe(true);
    });

    it('does not count an opponent\'s enabling land', () => {
      const ctx = ctxWithSeats(4);
      spawn(ctx, 'P2', mountain());

      expect(playFromHand(ctx, checkland())).toBe(true);
    });
  });

  describe('count conditions', () => {
    it('slowland counts OTHER lands you control, excluding itself', () => {
      const ctx = ctxWithSeats(4);
      spawn(ctx, 'P1', forest());
      // One other land — "two or more" is not met.
      expect(playFromHand(ctx, slowland())).toBe(true);

      const ctx2 = ctxWithSeats(4);
      spawn(ctx2, 'P1', forest());
      spawn(ctx2, 'P1', forest());
      expect(playFromHand(ctx2, slowland())).toBe(false);
    });

    it('opponent-count land reads the pod size, not the battlefield', () => {
      // Four seats → three opponents → "two or more" met → untapped.
      expect(playFromHand(ctxWithSeats(4), opponentLand())).toBe(false);
      // Two seats → one opponent → not met → tapped.
      expect(playFromHand(ctxWithSeats(2), opponentLand())).toBe(true);
    });
  });
});
