import type { Phase, PlayerId, Step } from '@mtg/shared';
import { makePermanent } from '../state/objects';
import type { EngineCardObject, GameContext } from '../state/types';

export interface PreparedScenarioSpec {
  currentTurnPlayer: PlayerId;
  phase: Phase;
  step: Step | null;
  turnNumber: number;
  hand: Array<{ playerId: PlayerId; cardNames: string[] }>;
  battlefield: Array<{
    playerId: PlayerId;
    cardNames: string[];
    tapped?: boolean;
  }>;
  graveyard?: Array<{ playerId: PlayerId; cardNames: string[] }>;
  /** Arrange already-cast spells below the tested response. */
  stack?: Array<{ playerId: PlayerId; cardNames: string[] }>;
  /** Lab-only finite continuation used to exercise next-upkeep delayed triggers. */
  continueToNextUpkeep?: boolean;
}

function takeNamedCard(ctx: GameContext, playerId: PlayerId, name: string): EngineCardObject {
  const player = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error(`prepared scenario has unknown player ${playerId}`);
  const index = player.library.findIndex((card) => card.name === name);
  if (index < 0) throw new Error(`prepared scenario cannot find ${name} in ${playerId}'s library`);
  return player.library.splice(index, 1)[0] as EngineCardObject;
}

/**
 * Arrange only the starting position. Every interaction after this uses normal engine legality,
 * payment, priority, stack, targeting, and resolution paths.
 */
export function prepareScenario(ctx: GameContext, spec: PreparedScenarioSpec): void {
  const playerIndex = ctx.state.turnOrder.indexOf(spec.currentTurnPlayer);
  if (playerIndex < 0) throw new Error(`prepared scenario has invalid active player`);
  ctx.state.currentTurnPlayer = spec.currentTurnPlayer;
  ctx.state.activePlayerIndex = playerIndex;
  ctx.state.turnNumber = spec.turnNumber;
  ctx.state.phase = spec.phase;
  ctx.state.step = spec.step;
  ctx.state.priorityPlayerIndex = null;

  for (const entry of spec.hand) {
    const player = ctx.state.players.find((candidate) => candidate.id === entry.playerId)!;
    for (const name of entry.cardNames) {
      const card = takeNamedCard(ctx, entry.playerId, name);
      card.zone = 'hand';
      player.hand.push(card);
    }
  }

  for (const entry of spec.battlefield) {
    for (const name of entry.cardNames) {
      const card = takeNamedCard(ctx, entry.playerId, name);
      const permanent = makePermanent(ctx, card, entry.playerId);
      // The arranged position stands in for a settled mid-game board: arranged permanents have
      // been under the player's control since before this turn, so they are neither summoning
      // sick nor "entered this turn".
      permanent.tapped = entry.tapped ?? false;
      permanent.summoningSick = false;
      permanent.enteredTurnNumber = spec.turnNumber - 1;
      ctx.state.battlefield.push(permanent);
    }
  }

  for (const entry of spec.graveyard ?? []) {
    const player = ctx.state.players.find((candidate) => candidate.id === entry.playerId)!;
    for (const name of entry.cardNames) {
      const card = takeNamedCard(ctx, entry.playerId, name);
      card.zone = 'graveyard';
      player.graveyard.push(card);
    }
  }

  for (const entry of spec.stack ?? []) {
    for (const name of entry.cardNames) {
      const card = takeNamedCard(ctx, entry.playerId, name);
      const def = ctx.defs.get(card.oracleId);
      if (def?.spellAbility === null || def?.spellAbility === undefined) {
        throw new Error(`prepared scenario stack card ${name} has no spell ability`);
      }
      card.zone = 'stack';
      ctx.state.stack.push({
        id: card.id,
        sourceId: card.id,
        controllerId: entry.playerId,
        kind: 'spell',
        description: card.name,
        targets: [],
        card,
        ability: def.spellAbility,
        sourceOracleId: card.oracleId,
        sourceCardId: card.cardId,
        isCommanderCast: false,
      });
    }
  }
}
