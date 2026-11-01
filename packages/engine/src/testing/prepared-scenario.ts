import type { Phase, PlayerId, Step } from '@mtg/shared';
import { makePermanent, transformPermanent } from '../state/objects';
import { subtractGeneric } from '../mana/cost';
import { preparedScenarioSpell } from '../casting/preview';
import type { EngineCardObject, EnginePermanent, GameContext } from '../state/types';

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
    /**
     * Arrange each named Aura or Equipment as already attached to the named permanent that
     * `playerId` controls on the battlefield (it may be listed later in `battlefield`). Only the
     * position is arranged: whether the attachment is legal is still decided by the state-based
     * actions, so an illegal arrangement falls off exactly as in a real game.
     */
    attachedToCard?: { playerId: PlayerId; cardName: string };
    /**
     * Arrange each named permanent as already goaded (CR 701.15a) by this player, as if a goad
     * effect had applied it on that player's previous turn: it lasts until that player's next
     * turn, and the engine's untap step, combat requirement and expiry all run as normal. This
     * arranges the starting position only; the effect that applies a goad is exercised by the
     * scenario where it triggers.
     */
    goadedBy?: PlayerId;
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
  /** Finish the arranged active turn, then run exactly the next surviving player's full turn. */
  continueThroughNextTurn?: boolean;
  /** Card Lab continuation: visit successive upkeeps, including a full rotation to your own. */
  continueThroughUpkeeps?: number;
  /** One subsequent turn's production untap, upkeep, draw and precombat main window. */
  continueThroughNextPrecombatMain?: true;
  /** Finite production turn beginnings/main windows, including inserted extra turns. */
  continueThroughPrecombatMains?: number;
  /** Advance to the next player and run their production beginning, main, and combat phases. */
  continueThroughNextCombat?: true;
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

  const pendingAttachments: Array<{
    permanent: EnginePermanent;
    host: { playerId: PlayerId; cardName: string };
  }> = [];
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
      if (entry.goadedBy !== undefined) {
        if (!ctx.state.players.some((candidate) => candidate.id === entry.goadedBy))
          throw new Error(`prepared scenario has unknown goading player ${entry.goadedBy}`);
        // A goad lasts until the goader's next turn begins (CR 701.15a), so on the goader's own
        // turn the arranged goad would already have ended.
        if (entry.goadedBy === spec.currentTurnPlayer)
          throw new Error(
            `prepared scenario cannot arrange a goad by ${entry.goadedBy} on that player's own turn`,
          );
        permanent.goadedBy = [{ goaderId: entry.goadedBy, appliedTurn: spec.turnNumber - 1 }];
      }
      if (entry.attachedToCard !== undefined) {
        pendingAttachments.push({ permanent, host: entry.attachedToCard });
      }
      if (entry.transformed && !transformPermanent(ctx, permanent)) {
        throw new Error(`prepared scenario cannot transform ${name}`);
      }
    }
  }
  // Resolved once the whole battlefield exists, so the host may be listed after its attachment.
  for (const { permanent, host } of pendingAttachments) {
    const target = ctx.state.battlefield.find(
      (candidate) =>
        candidate !== permanent &&
        candidate.name === host.cardName &&
        candidate.controllerId === host.playerId,
    );
    if (target === undefined) {
      throw new Error(
        `prepared scenario cannot attach ${permanent.name}: ${host.playerId} controls no ${host.cardName} on the battlefield`,
      );
    }
    permanent.attachedTo = target.id;
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
      card.exiledFaceDown = true;
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
