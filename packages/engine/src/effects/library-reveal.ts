import type { PlayerId } from '@mtg/shared';
import { computeTargetOptions } from '../actions/legal';
import { freeCardIsCastable, resolveFreeCard } from '../casting/free';
import type { CardDefinition } from '../cards/definition';
import type { GameGen } from '../decisions';
import { cardOption, plainOption } from '../present';
import { chooseCard } from './choose';
import { emit } from '../log/log';
import { moveObject, spellManaValue, playerById } from '../state/objects';
import { getDefByOracleId, hasProtectionFrom, playersInApnapOrder } from '../state/queries';
import type { EngineCardObject, GameContext } from '../state/types';
import type { EffectSource } from './resolve';

/**
 * Randomize a set of cards onto the bottoms of their libraries.
 *
 * A card already in a library stays the same zone object and only participates in an in-zone
 * reorder. A card in exile changes zones through `moveObject`, which creates its new library
 * object and honors replacements. Membership checks use exact object identity throughout; a
 * later incarnation of the same physical card is never swept into this operation.
 */
export function* bottomCards(ctx: GameContext, cards: readonly EngineCardObject[]): GameGen<void> {
  const unique = [...new Set(cards)];
  const inLibraries = new Map<PlayerId, EngineCardObject[]>();
  const inExile: EngineCardObject[] = [];

  for (const card of unique) {
    if (ctx.state.exile.includes(card) && card.zone === 'exile') {
      inExile.push(card);
      continue;
    }
    const owner = ctx.state.players.find(
      (player) => player.library.includes(card) && card.zone === 'library',
    );
    if (owner === undefined) continue;
    const group = inLibraries.get(owner.id) ?? [];
    group.push(card);
    inLibraries.set(owner.id, group);
  }

  for (const [ownerId, group] of inLibraries) {
    const library = playerById(ctx, ownerId).library;
    const members = new Set(group);
    const current = group.filter((card) => library.includes(card));
    ctx.rng.shuffle(current);
    playerById(ctx, ownerId).library = library.filter((card) => !members.has(card));
    playerById(ctx, ownerId).library.push(...current);
  }

  ctx.rng.shuffle(inExile);
  for (const card of inExile) {
    if (!ctx.state.exile.includes(card) || card.zone !== 'exile') continue;
    yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
  }
}

function revealCard(ctx: GameContext, playerId: PlayerId, card: EngineCardObject): void {
  emit(
    ctx,
    'revealCard',
    { player: playerId, cardId: card.cardId, name: card.name, revealed: true },
    playerId,
  );
}

function cardDefinition(ctx: GameContext, card: EngineCardObject): CardDefinition {
  return getDefByOracleId(ctx, card.oracleId, card.name);
}

function mayCastDiscoverHit(maximum: number) {
  return (definition: CardDefinition): boolean =>
    !definition.types.includes('Land') && spellManaValue(definition, 0) <= maximum;
}

/**
 * Reveal until the first Aura, revealing every card encountered.
 *
 * The Aura can be put onto the battlefield only when the current battlefield has a legal
 * enchantment host. If there is no such host, the Aura goes to hand; otherwise the controller
 * chooses between battlefield and hand. All other revealed cards are randomized onto the
 * library bottom without changing zones.
 */
export function* revealUntilAura(
  ctx: GameContext,
  source: EffectSource,
  controllerId: PlayerId,
): GameGen<void> {
  const player = playerById(ctx, controllerId);
  const revealed: EngineCardObject[] = [];
  let aura: EngineCardObject | undefined;

  while (revealed.length < player.library.length) {
    const card = player.library[revealed.length];
    if (card === undefined) break;
    revealCard(ctx, controllerId, card);
    revealed.push(card);
    if (cardDefinition(ctx, card).subtypes.includes('Aura')) {
      aura = card;
      break;
    }
  }

  if (aura === undefined) {
    yield* bottomCards(ctx, revealed);
    return;
  }

  const definition = cardDefinition(ctx, aura);
  const enchant = definition.spellAbility?.targets[0];
  const hosts =
    enchant === undefined
      ? []
      : computeTargetOptions(
          ctx,
          enchant,
          controllerId,
          definition.colors,
          undefined,
          undefined,
          aura.cardId,
          false,
        ).filter((id) => {
          const host = ctx.state.battlefield.find((permanent) => permanent.id === id);
          return host === undefined || !hasProtectionFrom(ctx, host, definition.colors);
        });
  let destination: 'battlefield' | 'hand' = 'hand';
  if (hosts.length > 0) {
    const outcome = yield {
      decisionType: 'general' as const,
      player: controllerId,
      prompt: `${source.name}: you may put ${aura.name} onto the battlefield. Otherwise, put it into your hand.`,
      options: [
        cardOption(ctx, aura, {
          viewerId: controllerId,
          type: 'putAuraOntoBattlefield',
          description: `Put ${aura.name} onto the battlefield`,
          verb: 'Put onto battlefield',
        }),
        cardOption(ctx, aura, {
          viewerId: controllerId,
          type: 'putAuraIntoHand',
          description: `Put ${aura.name} into your hand`,
          verb: 'Put into hand',
        }),
      ],
    };
    destination = outcome.index === 0 ? 'battlefield' : 'hand';
  }

  if (destination === 'battlefield') {
    const moved = yield* moveObject(ctx, aura, { zone: 'battlefield', controllerId });
    if (moved === null && player.library.includes(aura)) {
      yield* moveObject(ctx, aura, { zone: 'hand' });
    }
  } else {
    yield* moveObject(ctx, aura, { zone: 'hand' });
  }
  yield* bottomCards(
    ctx,
    revealed.filter((card) => card !== aura),
  );
}

/**
 * Discover a maximum mana value from the controller's library.
 *
 * Cards are exiled one at a time until the first nonland card with mana value at most
 * `maximum`. The controller may cast that hit for free if a legal selected spell face also
 * meets the same bound; otherwise the hit must go to hand. Remaining encountered cards that
 * are still in exile are randomized onto their owner's library bottoms.
 */
export function* discover(
  ctx: GameContext,
  source: EffectSource,
  controllerId: PlayerId,
  maximum: number,
): GameGen<void> {
  const player = playerById(ctx, controllerId);
  const exiled: EngineCardObject[] = [];
  let hit: EngineCardObject | undefined;

  while (player.library.length > 0) {
    const top = player.library[0];
    if (top === undefined) break;
    const moved = (yield* moveObject(ctx, top, { zone: 'exile' })) as EngineCardObject | null;
    if (moved === null) break;
    exiled.push(moved);
    const definition = cardDefinition(ctx, moved);
    if (!definition.types.includes('Land') && spellManaValue(definition, 0) <= maximum) {
      hit = moved;
      break;
    }
  }

  if (hit !== undefined) {
    const allowed = mayCastDiscoverHit(maximum);
    if (freeCardIsCastable(ctx, hit, controllerId, Infinity, 0, allowed)) {
      const outcome = yield {
        decisionType: 'general' as const,
        player: controllerId,
        prompt: `${source.name}: you may cast ${hit.name} without paying its mana cost.`,
        options: [
          cardOption(ctx, hit, {
            viewerId: controllerId,
            type: 'castFree',
            description: `Cast ${hit.name} without paying its mana cost`,
            verb: 'Cast for free',
          }),
          plainOption({
            type: 'decline',
            description: `Put ${hit.name} into your hand`,
            verb: 'Put into hand',
            role: 'decline',
          }),
        ],
      };
      if (outcome.index === 0) {
        yield* resolveFreeCard(ctx, hit, controllerId, Infinity, 0, allowed);
      } else {
        yield* moveObject(ctx, hit, { zone: 'hand' });
      }
    } else {
      yield* moveObject(ctx, hit, { zone: 'hand' });
    }
  }

  yield* bottomCards(
    ctx,
    exiled.filter((card) => card !== hit),
  );
}

/**
 * Resolve Etali's enter trigger for every living player in APNAP order.
 *
 * Each player exiles cards from their own library until their first nonland card, and all
 * players finish before the controller is offered any casts. The controller may cast any
 * number of still-exiled hits in a chosen order, stopping at any time. Lands and uncast hits
 * remain exiled.
 */
export function* exileEachUntilNonlandAndCast(
  ctx: GameContext,
  source: EffectSource,
  controllerId: PlayerId,
): GameGen<void> {
  const hits: EngineCardObject[] = [];

  for (const player of playersInApnapOrder(ctx)) {
    while (player.library.length > 0) {
      const top = player.library[0];
      if (top === undefined) break;
      const moved = (yield* moveObject(ctx, top, { zone: 'exile' })) as EngineCardObject | null;
      if (moved === null) break;
      if (cardDefinition(ctx, moved).types.includes('Land')) continue;
      hits.push(moved);
      break;
    }
  }

  for (;;) {
    const castable = hits.filter(
      (card) => ctx.state.exile.includes(card) && freeCardIsCastable(ctx, card, controllerId),
    );
    if (castable.length === 0) return;
    const chosen = yield* chooseCard(ctx, {
      player: controllerId,
      cards: castable,
      type: 'castFree',
      verb: 'Cast for free',
      describe: (card) => `Cast ${card.name} without paying its mana cost`,
      prompt: `${source.name}: you may cast a card exiled this way without paying its mana cost.`,
      decline: { type: 'stopCasting', description: 'Stop casting cards', verb: 'Stop' },
    });
    if (chosen === null) return;
    yield* resolveFreeCard(ctx, chosen, controllerId);
  }
}

/**
 * Reveal the top card. Put a creature onto the battlefield; otherwise the controller may
 * randomize it to the library bottom or leave it on top. This operation never draws.
 */
export function* revealCreatureOrBottom(
  ctx: GameContext,
  source: EffectSource,
  controllerId: PlayerId,
): GameGen<void> {
  const player = playerById(ctx, controllerId);
  const top = player.library[0];
  if (top === undefined) return;
  revealCard(ctx, controllerId, top);
  if (cardDefinition(ctx, top).types.includes('Creature')) {
    yield* moveObject(ctx, top, { zone: 'battlefield', controllerId });
    return;
  }

  const outcome = yield {
    decisionType: 'general' as const,
    player: controllerId,
    prompt: `${source.name}: you may put ${top.name} on the bottom of your library.`,
    options: [
      plainOption({
        type: 'bottom',
        description: `Put ${top.name} on the bottom`,
        verb: 'Put on bottom',
      }),
      plainOption({
        type: 'keepTop',
        description: `Leave ${top.name} on top`,
        verb: 'Keep on top',
        role: 'decline',
      }),
    ],
  };
  if (outcome.index === 0) yield* bottomCards(ctx, [top]);
}
