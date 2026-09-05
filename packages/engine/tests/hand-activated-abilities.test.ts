/**
 * Activated abilities that function from the HAND (CR 112.6a) — cycling and its typed variants.
 *
 * These abilities parsed correctly for a long time but were never reachable: nothing in
 * `computePriorityOptions` iterated `player.hand` for activated abilities, and the battlefield
 * loop did not filter on `ActivatedAbility.zone` at all. The result was a silent failure in both
 * directions — a card in hand could never cycle, and the same creature ON the battlefield offered
 * its cycling ability, whose `discardSelf` cost would then have been "paid" by a card that was
 * not in hand (`canPayNonManaCosts` had no case for it and fell through to a permissive `true`).
 *
 * Oracle text below is copied verbatim from the printed cards.
 */

import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { canPayNonManaCosts } from '../src/state/queries';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, gameConfig, mountain, oracle, pump, spawn } from './fixtures';

/** Ash Barrens, verbatim — basic landcycling from hand. */
const ashBarrens = () =>
  oracle({
    name: 'Test Barrens',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}.\nBasic landcycling {1}',
  });

/** Street Wraith's shape without its life cost — plain cycling on a creature. */
const cyclingBear = () =>
  oracle({
    name: 'Test Cycler',
    typeLine: 'Creature — Bear',
    manaCost: '{2}{G}',
    power: '2',
    toughness: '2',
    oracleText: 'Cycling {2}',
  });

function pod(seed = 'hand-abilities'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, mountain) })),
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

describe('hand-activated abilities', () => {
  it('parses cycling as a hand-zone ability with a discard-self cost', () => {
    const def = interpretCard(cyclingBear());
    const cycling = def.activatedAbilities.find((a) => a.zone === 'hand');
    expect(cycling).toBeDefined();
    expect(cycling!.costs.some((c) => c.kind === 'discardSelf')).toBe(true);
    expect(def.modeled).toBe(true);
  });

  it('offers cycling from hand and pays for it by discarding the card', () => {
    const ctx = pod();
    const player = p1(ctx);
    for (let i = 0; i < 3; i += 1) spawn(ctx, 'P1', mountain());
    const card = conjure(ctx, 'P1', cyclingBear(), 'hand');

    const handBefore = player.hand.length;
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.fromHand === true && payload.objectId === card.id;
    });
    expect(option).toBeDefined();

    pump(applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));

    // The cost is paid at announcement (CR 601.2h): the card is in the graveyard while the
    // ability is still on the stack, not after it resolves.
    expect(player.hand.some((c) => c.cardId === card.cardId)).toBe(false);
    expect(player.graveyard.some((c) => c.cardId === card.cardId)).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);

    pump(resolveTopOfStack(ctx));
    expect(player.hand.length).toBe(handBefore); // discarded one, drew one
  });

  it('does not offer a hand ability the player cannot pay for', () => {
    const ctx = pod();
    const player = p1(ctx);
    const card = conjure(ctx, 'P1', cyclingBear(), 'hand'); // no lands on the battlefield

    const offered = computePriorityOptions(ctx, player).some((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.fromHand === true && payload.objectId === card.id;
    });
    expect(offered).toBe(false);
  });

  it('does not offer a permanent its own hand-zone ability from the battlefield', () => {
    const ctx = pod();
    const player = p1(ctx);
    for (let i = 0; i < 3; i += 1) spawn(ctx, 'P1', mountain());
    const perm = spawn(ctx, 'P1', ashBarrens());

    const options = computePriorityOptions(ctx, player).filter((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === perm.id;
    });
    // Ash Barrens' "{T}: Add {C}" is a mana ability (not enumerated here); its landcycling is a
    // HAND ability and must not be reachable now that the card is a permanent.
    expect(options).toHaveLength(0);
  });

  it('refuses a discard-self cost on a battlefield permanent', () => {
    const ctx = pod();
    const perm = spawn(ctx, 'P1', cyclingBear());
    // The permissive fall-through used to answer `true` here, which is what made the
    // unfiltered battlefield loop above dangerous rather than merely wrong.
    expect(canPayNonManaCosts(ctx, perm, [{ kind: 'discardSelf' }])).toBe(false);
  });
});
