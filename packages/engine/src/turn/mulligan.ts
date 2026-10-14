/**
 * Opening hands and the London mulligan with the multiplayer free first mulligan
 * (CR 103.4/103.4c, brief §5.8): draw 7; in turn order declare keep/mulligan; all
 * mulliganing players re-draw simultaneously; on keeping, bottom `max(0, taken − 1)`
 * cards (first mulligan free); at 8 mulligans a player must keep (and bottoms all 7).
 * Bottomed cards are private — the events carry card ids for replay, but nothing here is
 * ever surfaced to another player's view (brief §5.8/§7.1).
 */

import type { GameGen } from '../decisions';
import { drawCards } from '../effects/resolve';
import { emit, debug } from '../log/log';
import { moveObject } from '../state/objects';
import { playersInApnapOrder, requireModeled } from '../state/queries';
import type { EngineCardObject, EnginePlayerState, GameContext } from '../state/types';

const MAX_MULLIGANS = 8;

function shuffleLibrary(ctx: GameContext, player: EnginePlayerState): void {
  ctx.rng.shuffle(player.library);
  emit(ctx, 'shuffle', { player: player.id }, player.id);
}

function* bottomCards(ctx: GameContext, player: EnginePlayerState, count: number): GameGen<void> {
  for (let i = 0; i < count; i++) {
    const outcome = yield {
      decisionType: 'bottomCards',
      player: player.id,
      prompt: `Keeping after ${player.mulligansTaken} mulligan(s): put ${count - i} more card(s) on the bottom of your library. Choose one.`,
      options: player.hand.map((card) => ({
        type: 'bottomCard',
        description: `Bottom ${card.name}`,
        payload: card.id,
        interaction: { kind: 'choice' as const, subjectId: card.id },
      })),
    };
    const card = player.hand[outcome.index] as EngineCardObject;
    // Card identity stays out of the public prompt stream; the event carries it for the
    // replay log only (bottoms are private — brief §5.8).
    yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
  }
  emit(ctx, 'bottomedCards', { player: player.id, count }, player.id);
}

/** Shuffle, draw opening hands, run the mulligan rounds. */
export function* runOpeningHands(ctx: GameContext): GameGen<void> {
  const players = playersInApnapOrder(ctx); // turn order from the starting player

  for (const player of players) {
    shuffleLibrary(ctx, player);
    yield* drawCards(ctx, player, 7);
  }
  emit(ctx, 'openingHandsDrawn', {});

  let undecided = [...players];
  while (undecided.length > 0) {
    const mulliganing: EnginePlayerState[] = [];

    for (const player of undecided) {
      if (player.mulligansTaken >= MAX_MULLIGANS) {
        debug(ctx, 'engine', `${player.id} reached the mulligan cap — must keep`);
        yield* keepHand(ctx, player);
        continue;
      }
      const outcome = yield {
        decisionType: 'mulligan',
        player: player.id,
        prompt:
          player.mulligansTaken === 0
            ? 'Keep this hand or mulligan? (Your first mulligan is free in multiplayer.)'
            : `Keep this hand or mulligan? (You have mulliganed ${player.mulligansTaken} time(s); keeping will bottom ${Math.max(0, player.mulligansTaken - 1)} card(s).)`,
        options: [
          { type: 'keep', description: 'Keep this hand' },
          { type: 'mulligan', description: 'Mulligan' },
        ],
      };
      if (outcome.index === 0) {
        yield* keepHand(ctx, player);
      } else {
        mulliganing.push(player);
        emit(ctx, 'mulligan', { player: player.id, number: player.mulligansTaken + 1 }, player.id);
      }
    }

    // All mulliganing players re-draw (CR 103.4 — simultaneously; sequential shuffles
    // keep the PRNG call order deterministic).
    for (const player of mulliganing) {
      for (const card of [...player.hand]) {
        yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
      }
      shuffleLibrary(ctx, player);
      yield* drawCards(ctx, player, 7);
      player.mulligansTaken += 1;
    }
    undecided = mulliganing;
  }
  emit(ctx, 'openingHandsKept', {
    hands: ctx.state.players.map((p) => ({
      player: p.id,
      size: p.hand.length,
      mulligans: p.mulligansTaken,
    })),
  });
  yield* runOpeningHandBattlefieldActions(ctx);
}

/** CR 103.6: after all mulligans, each player may take opening-hand actions in any order. */
export function* runOpeningHandBattlefieldActions(ctx: GameContext): GameGen<void> {
  for (const player of playersInApnapOrder(ctx)) {
    while (true) {
      const cards = player.hand.filter((card) =>
        ctx.defs
          .get(card.oracleId)
          ?.ruleStatics.some((rule) => rule.kind === 'beginOnBattlefieldFromOpeningHand'),
      );
      if (cards.length === 0) break;
      for (const card of cards)
        requireModeled(ctx.defs.get(card.oracleId)!, 'opening-hand battlefield action');
      const choice = yield {
        decisionType: 'general',
        player: player.id,
        prompt: 'You may begin the game with a card from your opening hand on the battlefield.',
        options: [
          ...cards.map((card) => ({
            type: 'beginOnBattlefield',
            description: `Begin with ${card.name} on the battlefield`,
            payload: card.id,
          })),
          { type: 'decline', description: 'Keep the remaining cards in hand' },
        ],
      };
      const card = cards[choice.index];
      if (card === undefined) break;
      yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: player.id });
    }
  }
}

function* keepHand(ctx: GameContext, player: EnginePlayerState): GameGen<void> {
  const toBottom = Math.max(0, player.mulligansTaken - 1); // first mulligan free (103.4c)
  emit(
    ctx,
    'keepHand',
    { player: player.id, mulligans: player.mulligansTaken, bottoming: toBottom },
    player.id,
  );
  if (toBottom > 0) {
    yield* bottomCards(ctx, player, Math.min(toBottom, player.hand.length));
  }
}
