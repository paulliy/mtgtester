import type { CardDefinition } from '../cards/definition';
import { getCached, setCached } from '../effects/layer-cache';
import type { EngineCardObject, EngineStackObject, GameContext } from '../state/types';

/** Fixture-only settled stack entry; arranging a scenario does not perform or emit a cast. */
export function preparedScenarioSpell(
  card: EngineCardObject,
  definition: CardDefinition,
  controllerId = card.ownerId,
): EngineStackObject {
  if (definition.spellAbility === null)
    throw new Error(`prepared scenario stack card ${card.name} has no spell ability`);
  return {
    id: card.id,
    sourceId: card.id,
    controllerId,
    kind: 'spell',
    description: card.name,
    targets: [],
    card,
    ability: definition.spellAbility,
    spellDefinition: definition,
    sourceColors: [...definition.colors],
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
  };
}

/** CR 601.2a projection for pure previews: the card has already left its source zone. */
export function castingPreviewContext(
  ctx: GameContext,
  card: EngineCardObject,
  controllerId = card.ownerId,
  spellDefinition?: CardDefinition,
): GameContext {
  const proposedCard: EngineCardObject = {
    ...card,
    id: `o-${ctx.state.nextObjectNum}`,
    zone: 'stack',
  };
  const proposed: EngineStackObject = {
    id: proposedCard.id,
    sourceId: proposedCard.id,
    sourceCardId: card.cardId,
    sourceOracleId: card.oracleId,
    controllerId,
    kind: 'spell',
    description: card.name,
    card: proposedCard,
    ability: null,
    targets: [],
    isCommanderCast: card.zone === 'command',
    castInProgress: true,
    ...(spellDefinition === undefined ? {} : { spellDefinition }),
  };
  const without = (cards: EngineCardObject[]) => cards.filter((entry) => entry !== card);
  // A preview is speculative: it records nothing in the diagnostics sink (ADR 0034 decision 4).
  const { diagnostics: _diagnostics, ...game } = ctx;
  const preview: GameContext = {
    ...game,
    state: {
      ...ctx.state,
      exile: without(ctx.state.exile),
      players: ctx.state.players.map((player) =>
        player.id === card.ownerId
          ? {
              ...player,
              hand: without(player.hand),
              graveyard: without(player.graveyard),
              library: without(player.library),
              commandZone: without(player.commandZone),
            }
          : player,
      ),
      stack: [...ctx.state.stack, proposed],
    },
  };
  // Start from the layer results of the last preview of this state, or of the state itself.
  // Previews of one state differ only in which card left which zone, which the layer digest
  // sees as zone sizes, so the last preview's results usually serve the next one; every read
  // checks them against a digest of the preview's own state. A cold start cost a full layer pass
  // for every card considered at every priority, the largest cost left on a big board.
  const last = LAST_PREVIEW.get(ctx);
  const layers = (last === undefined ? undefined : getCached(last)) ?? getCached(ctx);
  if (layers !== undefined) setCached(preview, layers);
  LAST_PREVIEW.set(ctx, preview);
  return preview;
}

/** The last preview made of each context, whose layer results seed the next one. */
const LAST_PREVIEW = new WeakMap<GameContext, GameContext>();
