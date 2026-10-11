import type { Phase, PlayerId, Step } from '@mtg/shared';
import { makePermanent, transformPermanent } from '../state/objects';
import { subtractGeneric } from '../mana/cost';
import { preparedScenarioSpell } from '../casting/preview';
import type { EngineCardObject, GameContext } from '../state/types';

export interface PreparedScenarioSpec {
  currentTurnPlayer: PlayerId;
  phase: Phase;
  step: Step | null;
  turnNumber: number;
  lifeTotals?: Array<{ playerId: PlayerId; life: number }>;
  hand: Array<{ playerId: PlayerId; cardNames: string[] }>;
  battlefield: Array<{
    transformed?: boolean;
    playerId: PlayerId;
    cardNames: string[];
    tapped?: boolean;
    controllerId?: PlayerId;
    counters?: Record<string, number>;
    /**
     * Arrange each named Aura as already enchanting this player (CR 303.4a, "enchant player"), as
     * if it had been cast on an earlier turn; the position the Aura's own triggers act from.
     */
    enchantedPlayerId?: PlayerId;
  }>;
  graveyard?: Array<{ playerId: PlayerId; cardNames: string[] }>;
  /**
   * Cards already foretold on an earlier turn (CR 702.143a): exiled face down, castable now for
   * their mana cost reduced by `reduction` generic mana (Dream Devourer's grant).
   */
  foretold?: Array<{ playerId: PlayerId; cardNames: string[]; reduction: number }>;
  /** Starting energy counters (CR 122.1) per player, standing in for energy gained earlier. */
  energy?: Array<{ playerId: PlayerId; amount: number }>;
  /** Arrange known initial library tops; subsequent moves use ordinary rules. */
  libraryTop?: Array<{ playerId: PlayerId; cardNames: string[] }>;
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

  for (const entry of spec.lifeTotals ?? []) {
    const player = ctx.state.players.find((player) => player.id === entry.playerId);
    if (player === undefined || !Number.isSafeInteger(entry.life) || entry.life <= 0)
      throw new Error('prepared scenario requires a positive life total for a known player');
    player.life = entry.life;
  }

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
      if (entry.enchantedPlayerId !== undefined) {
        if (!ctx.state.players.some((candidate) => candidate.id === entry.enchantedPlayerId))
          throw new Error(
            `prepared scenario has unknown enchanted player ${entry.enchantedPlayerId}`,
          );
        permanent.attachedTo = entry.enchantedPlayerId;
      }
      // The arranged position stands in for a settled mid-game board: arranged permanents have
      // been under the player's control since before this turn, so they are neither summoning
      // sick nor "entered this turn".
      permanent.tapped = entry.tapped ?? false;
      permanent.summoningSick = false;
      permanent.enteredTurnNumber = spec.turnNumber - 1;
      // Nor did they arrive from the library the scenario drew them out of.
      delete permanent.enteredFromZone;
      ctx.state.battlefield.push(permanent);
      if (entry.transformed && !transformPermanent(ctx, permanent)) {
        throw new Error(`prepared scenario cannot transform ${name}`);
      }
    }
  }

  for (const entry of spec.energy ?? []) {
    const player = ctx.state.players.find((candidate) => candidate.id === entry.playerId);
    if (player === undefined)
      throw new Error(`prepared scenario has unknown player ${entry.playerId}`);
    player.energy = entry.amount;
  }

  for (const entry of spec.graveyard ?? []) {
    const player = ctx.state.players.find((candidate) => candidate.id === entry.playerId)!;
    for (const name of entry.cardNames) {
      const card = takeNamedCard(ctx, entry.playerId, name);
      card.zone = 'graveyard';
      player.graveyard.push(card);
    }
  }

  for (const entry of spec.foretold ?? []) {
    for (const name of entry.cardNames) {
      const card = takeNamedCard(ctx, entry.playerId, name);
      const manaCost = ctx.defs.get(card.oracleId)?.manaCost ?? null;
      if (manaCost === null) throw new Error(`prepared foretold card ${name} has no mana cost`);
      card.zone = 'exile';
      card.foretold = {
        turn: spec.turnNumber - 1,
        cost: subtractGeneric(manaCost, entry.reduction),
      };
      ctx.state.exile.push(card);
    }
  }

  for (const entry of spec.libraryTop ?? []) {
    const player = ctx.state.players.find((candidate) => candidate.id === entry.playerId)!;
    const cards = entry.cardNames.map((name) => takeNamedCard(ctx, entry.playerId, name));
    player.library.unshift(...cards);
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
