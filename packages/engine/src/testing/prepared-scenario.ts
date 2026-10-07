import type { Phase, PlayerId, Step } from '@mtg/shared';
import { makePermanent } from '../state/objects';
import { preparedScenarioSpell } from '../casting/preview';
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
    controllerId?: PlayerId;
    counters?: Record<string, number>;
  }>;
  graveyard?: Array<{ playerId: PlayerId; cardNames: string[] }>;
  /** Arrange already-cast spells below the tested response. */
  stack?: Array<{ playerId: PlayerId; cardNames: string[] }>;
  /** Lab-only finite continuation used to exercise next-upkeep delayed triggers. */
  continueToNextUpkeep?: boolean;
  /**
   * Lab-only finite continuation for combat triggers: after the arranged precombat-main priority
   * window closes, run this turn's combat phase through the production combat code, then end.
   */
  continueThroughCombat?: boolean;
  /**
   * Lab-only finite continuation for "at the beginning of each of your main phases" triggers:
   * after the arranged window (and combat, when also requested), begin this turn's postcombat
   * main phase, queue its triggers, and run its priority window.
   */
  continueToPostcombatMain?: boolean;
  /**
   * Lab-only finite continuation for "at the beginning of your end step" triggers: after the
   * arranged priority window (and combat, when also requested), move to this turn's end step,
   * queue its triggers, and run its priority window.
   */
  continueToEndStep?: boolean;
}

function takeNamedCard(
  ctx: GameContext,
  playerId: PlayerId,
  name: string,
  orCommandZone = false,
): EngineCardObject {
  const player = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) throw new Error(`prepared scenario has unknown player ${playerId}`);
  const index = player.library.findIndex((card) => card.name === name);
  if (index >= 0) return player.library.splice(index, 1)[0] as EngineCardObject;
  // A battlefield entry may name the player's commander, which starts in the command zone and
  // keeps its commander identity (CR 903.3) on the battlefield.
  const commandIndex = orCommandZone
    ? player.commandZone.findIndex((card) => card.name === name)
    : -1;
  if (commandIndex >= 0) return player.commandZone.splice(commandIndex, 1)[0] as EngineCardObject;
  throw new Error(`prepared scenario cannot find ${name} in ${playerId}'s library`);
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
      const card = takeNamedCard(ctx, entry.playerId, name, true);
      const permanent = makePermanent(ctx, card, entry.controllerId ?? entry.playerId);
      if (entry.counters !== undefined) permanent.counters = { ...entry.counters };
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
      ctx.state.stack.push(preparedScenarioSpell(card, def, entry.playerId));
    }
  }
}
