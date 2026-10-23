import type { PlayerId } from '@mtg/shared';
import type { Selector } from '../cards/definition';
import type { CardDefinition } from '../cards/definition';
import { freeCardIsCastable, resolveFreeCard } from '../casting/free';
import type { GameGen } from '../decisions';
import { chooseCard } from './choose';
import type { EffectSource } from './resolve';
import { selectMatches } from '../cards/selector';
import { cardZoneCandidate } from '../state/queries';
import { moveObject } from '../state/objects';
import type { EngineCardObject, GameContext } from '../state/types';
import { emit } from '../log/log';

export interface LibraryCastSpec {
  count: number;
  filter?: Selector;
  maxManaValue?: number;
  visibility?: 'look' | 'reveal' | 'exile';
}

/**
 * Look at, reveal, or exile the top cards, optionally cast one eligible spell for free, then
 * randomly put the remaining cards on the bottom. `look` leaves the identities private to the
 * acting player; `reveal` records each card as public information before any choice is made.
 * Cards cast this way use the ordinary free-cast path and go onto the normal spell stack, where
 * targets, additional costs, resolution, and the spell's final zone are handled as usual.
 */
export function* lookAtLibraryAndCast(
  ctx: GameContext,
  source: EffectSource,
  playerId: PlayerId,
  spec: LibraryCastSpec,
): GameGen<void> {
  if (!Number.isInteger(spec.count) || spec.count < 0) {
    throw new RangeError(`library look count must be a non-negative integer, got ${spec.count}`);
  }

  const player = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined || player.hasLost) return;

  const lookedAt = player.library.slice(0, spec.count);
  const visibility = spec.visibility ?? 'look';
  if (visibility === 'reveal') {
    for (const card of lookedAt) {
      emit(
        ctx,
        'revealCard',
        { player: player.id, cardId: card.cardId, name: card.name, revealed: true },
        player.id,
      );
    }
  }

  let castCandidates: EngineCardObject[];
  if (visibility === 'exile') {
    castCandidates = [];
    for (const card of lookedAt) {
      const moved = yield* moveObject(ctx, card, { zone: 'exile' });
      if (moved !== null && moved.zone === 'exile') castCandidates.push(moved as EngineCardObject);
    }
  } else {
    castCandidates = lookedAt;
  }

  const selectorSource = {
    cardId: source.cardId,
    controllerId: source.controllerId,
    ...(source.id === undefined ? {} : { objectId: source.id }),
  };
  const manaValueLessThan = spec.maxManaValue === undefined ? Infinity : spec.maxManaValue + 1;
  const spellAllowedFor =
    (card: EngineCardObject) =>
    (definition: CardDefinition): boolean =>
      spec.filter === undefined ||
      selectMatches(
        cardZoneCandidate(ctx, card, player.id, definition),
        spec.filter,
        selectorSource,
      );
  const eligible = castCandidates.filter((card) =>
    freeCardIsCastable(ctx, card, player.id, manaValueLessThan, 0, spellAllowedFor(card)),
  );

  if (eligible.length > 0) {
    const chosen = yield* chooseCard(ctx, {
      player: player.id,
      prompt: `${source.name}: you may cast one of the looked-at cards without paying its mana cost.`,
      cards: eligible,
      type: 'castFree',
      verb: 'Cast',
      describe: (card) => `Cast ${card.name} without paying its mana cost`,
      decline: { type: 'decline', description: 'Cast no spell', verb: 'Skip' },
    });
    if (chosen !== null && chosen !== undefined) {
      yield* resolveFreeCard(ctx, chosen, player.id, manaValueLessThan, 0, spellAllowedFor(chosen));
    }
  }

  if (visibility === 'exile') {
    const remainder = castCandidates.filter((card) => ctx.state.exile.includes(card));
    ctx.rng.shuffle(remainder);
    for (const card of remainder) {
      // Keep this exact exile incarnation. A card that left exile during casting is absent above
      // and must never be recovered by matching its physical cardId.
      if (ctx.state.exile.includes(card)) {
        yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
      }
    }
    return;
  }

  const remainder = lookedAt.filter((card) => player.library.includes(card));
  ctx.rng.shuffle(remainder);
  const remainderSet = new Set(remainder);
  const untouched = player.library.filter((card) => !remainderSet.has(card));
  player.library.splice(0, player.library.length, ...untouched, ...remainder);
}
