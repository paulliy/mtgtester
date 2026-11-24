/**
 * State-based actions (CR 704, brief §5.6) and the "checkpoint" every player passes
 * through before receiving priority: repeat SBA checks until none apply, then put waiting
 * triggered abilities on the stack (CR 603.3b), repeating until stable (CR 704.3).
 *
 * Player loss processing implements the multiplayer leave-the-game rules (CR 800.4a):
 * all objects the player owns leave the game, and the game continues among survivors.
 */

import { runCheckpointHook } from '../testing/checkpoint-hook';
import type { TargetingSource } from '../targets/context';
import { COMMANDER_DAMAGE_LETHAL } from '@mtg/shared';
import type { LossReason, ObjectId, PlayerId } from '@mtg/shared';
import { playerProtectedFromEverything } from '../state/phasing';
import { queueBecomesTargetedTriggers, queueWardTriggers } from '../actions/apply';
import {
  abilityForModes,
  abilityModeLabel,
  abilityModeTargetSlots,
  legalAbilityModeSelections,
  slotIsActive,
} from '../actions/ability-modes';
import { computeTargetOptions, withinTotalManaValue } from '../actions/legal';
import type { Ability, Effect } from '../cards/ability';
import type { GameGen } from '../decisions';
import { optionAt } from '../decisions';
import { battlefieldCharacteristics, matchesSelector } from '../effects/continuous';
import { withReadScope } from '../effects/layer-cache';
import { evaluateValueIn } from '../effects/values';
import { debug, emit } from '../log/log';
import { GameOverSignal } from '../signals';
import { legalTargetMenus, type TargetMenu } from '../targets/announcement';
import { targetingSourceFields } from '../targets/context';
import { expandPerPlayerTargets } from '../targets/per-player';
import { breakYieldsForStop } from '../turn/stops';
import {
  consumeRegenerationShield,
  controlledBy,
  enchantAllows,
  moveObject,
  movePermanentsToGraveyard,
  refreshControlEffects,
  retainAttackDefender,
  returnExiledUntilLeaves,
} from '../state/objects';
import {
  gatherRuleStatics,
  getDefByOracleId,
  hasProtectionFrom,
  isCreaturePermanent,
  playersInApnapOrder,
  sourceTraitsOf,
  playerCantLose,
  preparedCopyHolder,
  sagaFinalChapter,
} from '../state/queries';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
  EffectExpiry,
  EngineStackObject,
  GameContext,
  PendingTrigger,
} from '../state/types';

/** Mark a player as having lost; the caller then runs `processEliminations`. */
function markLoss(ctx: GameContext, player: EnginePlayerState, reason: LossReason): void {
  if (player.hasLost) return;
  player.hasLost = true;
  player.lossReason = reason;
  debug(ctx, 'sba', `${player.id} loses: ${reason}`);
}

/**
 * CR 800.4m: when `departedId` leaves, a continuous effect lasting until their next turn, or until
 * a point in it, lasts until that turn would have begun: neither ending now nor lasting forever.
 * Their turn would begin as the turn of the player seated before them ends, so each such expiry
 * (goad included, CR 701.15a) moves to the end of that player's next turn. An expiry already
 * waiting on the departed player's own seat moves to the seat before theirs, unless this is that
 * seat's normal turn: then the earlier player's turn would begin as this turn ends, and the
 * expiry stays on it for the aborted turn's end (`expireDepartedPlayerEffects`).
 */
function outlastDepartedPlayer(s: GameContext['state'], departedId: PlayerId): void {
  const seat = s.turnOrder.indexOf(departedId);
  if (seat < 0) return;
  let afterTurnOf: PlayerId | undefined;
  for (let step = 1; step < s.turnOrder.length; step++) {
    const id = s.turnOrder[(seat - step + s.turnOrder.length) % s.turnOrder.length] as PlayerId;
    if (!s.players.find((p) => p.id === id)?.hasLost) {
      afterTurnOf = id;
      break;
    }
  }
  if (afterTurnOf === undefined) return;
  const departed = { afterTurnOf, fromTurn: s.turnNumber };
  const keepsBoundary = departedId === s.currentTurnPlayer && s.normalTurnResumeAfter === undefined;
  const remap = <T extends { expires: EffectExpiry }>(entries: T[] | undefined): void => {
    for (const entry of entries ?? []) {
      const expires = entry.expires;
      if (
        (expires.kind === 'untilNextTurn' || expires.kind === 'endOfNextTurn') &&
        expires.playerId === departedId
      )
        entry.expires = { kind: 'departedNextTurn', ...departed };
      else if (
        expires.kind === 'departedNextTurn' &&
        expires.afterTurnOf === departedId &&
        !keepsBoundary
      )
        entry.expires = { ...expires, afterTurnOf };
    }
  };
  remap(s.attackRequirements);
  remap(s.attackDirections);
  remap(s.attackLifeTaxes);
  remap(s.blockRestrictions);
  for (const perm of [...s.battlefield, ...(s.phasedOut ?? []).map((record) => record.permanent)]) {
    for (const goad of perm.goadedBy ?? []) {
      if (goad.permanent === true) continue;
      if (goad.departed === undefined && goad.goaderId === departedId) goad.departed = departed;
      else if (goad.departed?.afterTurnOf === departedId && !keepsBoundary)
        goad.departed = { ...goad.departed, afterTurnOf };
    }
  }
}

/**
 * Remove players marked `hasLost` from the game (CR 800.4a): objects they own leave the
 * game (no dies/leave triggers — they cease to be in the game), spells/abilities they
 * control leave the stack, combat assignments against them are cleaned up.
 */
function* processEliminations(ctx: GameContext): GameGen<void> {
  const s = ctx.state;
  for (const player of s.players) {
    if (!player.hasLost || s.eliminatedPlayers.includes(player.id)) continue;

    emit(ctx, 'playerEliminated', { player: player.id, reason: player.lossReason }, player.id);

    // Objects owned by the player leave the battlefield and the stack (CR 800.4a).
    const leaving = [
      ...s.battlefield,
      ...(s.phasedOut ?? []).map((record) => record.permanent),
    ].filter((p) => p.ownerId === player.id);
    s.phasedOut = (s.phasedOut ?? []).filter((record) => record.permanent.ownerId !== player.id);
    // zone-mutation: a player who leaves the game takes every object they own with them (CR 800.4a): they leave the game, not to a zone
    s.battlefield = s.battlefield.filter((p) => p.ownerId !== player.id);
    for (const perm of leaving) {
      debug(ctx, 'zoneChange', `${perm.name} leaves the game with its owner ${player.id}`);
    }
    // Control-change effects end here too, with the shared refresh: entries naming a departed
    // player expire (even underneath newer records), and source-bound entries expire because the
    // sources the departing player owned just left the battlefield (all CR 800.4a durations).
    for (const perm of [
      ...s.battlefield,
      ...(s.phasedOut ?? []).map((record) => record.permanent),
    ]) {
      refreshControlEffects(ctx, perm);
      const controller = controlledBy(perm);
      if (s.players.find((p) => p.id === controller)?.hasLost) {
        // Its initial controller is gone as well: it leaves the game (CR 800.4a) — no die
        // triggers, no reversion to a player no longer playing.
        leaving.push(perm);
        s.phasedOut = (s.phasedOut ?? []).filter((record) => record.permanent !== perm);
        yield* moveObject(ctx, perm, { zone: 'exile' });
      }
    }
    // Leaving the game ends linked-exile durations too, although it queues no dies triggers.
    for (const perm of leaving) yield* returnExiledUntilLeaves(ctx, perm.cardId);
    s.delayedTriggers = s.delayedTriggers.filter((t) => t.controllerId !== player.id);
    // Effects they made that last until their next turn, or a point in it, last until that turn
    // would have begun (CR 800.4m); every other duration runs as written.
    outlastDepartedPlayer(s, player.id);
    if (s.combatChoices !== undefined)
      s.combatChoices = s.combatChoices.filter((entry) => entry.casterId !== player.id);
    s.stack = s.stack.filter(
      (so) => so.controllerId !== player.id && so.card?.ownerId !== player.id,
    );
    s.pendingTriggers = s.pendingTriggers.filter((t) => t.controllerId !== player.id);
    // zone-mutation: as above: the departed player's objects leave the game (CR 800.4a)
    s.exile = s.exile.filter((o) => o.ownerId !== player.id);
    // Every other object they own leaves the game too: nothing may still count their graveyard
    // (Tarmogoyf), target a card in it (Reanimate), or count their hand or library.
    // zone-mutation: as above: the departed player's objects leave the game (CR 800.4a)
    player.hand = [];
    player.library = [];
    player.graveyard = [];
    player.commandZone = [];

    // Combat cleanup: their creatures are gone; attackers pointed at them stand down
    // (CR 800.4e — no combat damage is assigned to a player who has left).
    const leavingIds = new Set(leaving.map((p) => p.id));
    // An attacker whose blocker left stays blocked (CR 509.1h); the departed blocker just no
    // longer exists to receive damage, so `blockedByOrdered` keeps its id.
    for (const perm of s.battlefield) {
      if (perm.attacking === player.id) {
        retainAttackDefender(perm);
        perm.attacking = null;
        perm.attackingPlaneswalker = null;
        perm.attackedPlaneswalkerRemoved = false;
      }
      if (perm.blocking !== null && leavingIds.has(perm.blocking)) perm.blocking = null;
    }

    // Seating: survivors only (brief §5.2). Keep activePlayerIndex pointing at the same
    // player when possible; the turn loop tracks the active player by id.
    const activeId = s.turnOrder[s.activePlayerIndex];
    s.turnOrder = s.turnOrder.filter((id) => id !== player.id);
    s.eliminatedPlayers.push(player.id);
    if (activeId !== undefined && activeId !== player.id) {
      const idx = s.turnOrder.indexOf(activeId);
      if (idx >= 0) s.activePlayerIndex = idx;
    } else if (s.activePlayerIndex >= s.turnOrder.length) {
      s.activePlayerIndex = 0;
    }

    // CR 725.4: if the monarch leaves, the active player becomes the monarch — or, when the
    // active player is the one leaving, the next player in turn order (who now sits at
    // `activePlayerIndex`, since the leaving player's seat was just removed).
    if (s.monarchPlayerId === player.id) {
      const active = s.players.find((p) => p.id === s.currentTurnPlayer);
      const successor =
        active !== undefined && !active.hasLost
          ? active.id
          : (s.turnOrder[s.activePlayerIndex] ?? null);
      s.monarchPlayerId = successor;
      if (successor !== null) emit(ctx, 'monarch', { player: successor }, successor);
    }
  }

  // End of game? One survivor wins; zero is a drawn game — halt as a probable rules
  // bug rather than silently rerolling (brief §4).
  if (s.turnOrder.length === 1) {
    throw new GameOverSignal(s.turnOrder[0] as PlayerId);
  }
  if (s.turnOrder.length === 0) {
    throw new GameOverSignal(null, 'all remaining players lost simultaneously (draw)');
  }
}

/**
 * One full SBA pass (CR 704.5 subset per brief §5.6). Returns true if anything happened.
 * A generator: the legend rule and CR 903.9a command-zone returns are player choices.
 */
function* sbaPass(ctx: GameContext): GameGen<boolean> {
  const s = ctx.state;
  let acted = false;

  // CR 704.5e: copies of cards can be cast during the creating effect, then cease if
  // they remain in exile or have left the stack. This is not a zone change.
  const removeCopies = (cards: EngineCardObject[]): EngineCardObject[] =>
    cards.filter((card) => {
      if (card.isCardCopy !== true) return true;
      // A prepare spell's copy stays in exile while its permanent stays prepared (CR 722.3c).
      if (card.zone === 'exile' && preparedCopyHolder(ctx, card) !== undefined) return true;
      emit(ctx, 'cardCopyCeased', { name: card.name, cardId: card.cardId });
      acted = true;
      return false;
    });
  // zone-mutation: a card copy outside the stack and battlefield ceases to exist (CR 704.5e); it goes nowhere
  s.exile = removeCopies(s.exile);
  for (const player of s.players) {
    // zone-mutation: as above: card copies cease to exist (CR 704.5e)
    player.hand = removeCopies(player.hand);
    player.library = removeCopies(player.library);
    player.graveyard = removeCopies(player.graveyard);
    player.commandZone = removeCopies(player.commandZone);
  }

  // --- Player checks ---
  for (const player of s.players) {
    if (player.hasLost) {
      // A "you lose the game" effect (CR 104.3a) marks the player directly; they still have to
      // leave the game here, or they would keep their seat, permanents and turns.
      if (!s.eliminatedPlayers.includes(player.id)) {
        player.lossReason ??= 'other';
        acted = true;
      }
      continue;
    }
    if (playerCantLose(ctx, player.id)) {
      // CR 704.5b looks only at draws since the last check: this one is spent, not deferred.
      player.attemptedDrawFromEmptyLibrary = false;
      continue;
    }
    if (player.life <= 0) {
      markLoss(ctx, player, 'lifeZeroOrLess');
      acted = true;
    } else if (player.attemptedDrawFromEmptyLibrary) {
      markLoss(ctx, player, 'emptyLibraryDraw');
      acted = true;
    } else if (player.poisonCounters >= 10) {
      markLoss(ctx, player, 'poisonCounters');
      acted = true;
    } else if (
      Object.values(player.commanderDamageTaken).some((dmg) => dmg >= COMMANDER_DAMAGE_LETHAL)
    ) {
      markLoss(ctx, player, 'commanderDamage');
      acted = true;
    }
  }
  if (acted) {
    // Simultaneous losses processed together; may end the game via GameOverSignal.
    yield* processEliminations(ctx);
    return true;
  }

  // Determine all lethal/zero-characteristic deaths from one board state. Moving
  // the first creature early loses dying watchers and can remove an anthem before
  // deciding whether another creature belongs to this event (CR 704.3/603.10).
  const dying: EnginePermanent[] = [];
  // One layer pass for the whole board, retaken after a regeneration changes it.
  let charsOf = battlefieldCharacteristics(ctx);
  for (const perm of s.battlefield) {
    const chars = charsOf(perm);
    let reason: string | undefined;
    if (chars.types.includes('Creature')) {
      if (chars.toughness <= 0) reason = 'zeroToughness';
      else if (
        perm.damageMarked > 0 &&
        (perm.damageMarked >= chars.toughness || perm.damagedByDeathtouch) &&
        !chars.keywords.includes('indestructible')
      ) {
        if (consumeRegenerationShield(ctx, perm)) {
          acted = true;
          charsOf = battlefieldCharacteristics(ctx);
          continue;
        }
        reason = 'lethalDamage';
      }
    }
    if (reason !== undefined) {
      emit(ctx, 'sbaCreatureDies', { name: perm.name, reason });
      dying.push(perm);
    } else if (chars.types.includes('Planeswalker') && (perm.counters['loyalty'] ?? 0) <= 0) {
      emit(ctx, 'sbaPlaneswalkerDies', { name: perm.name });
      dying.push(perm);
    } else if (chars.types.includes('Battle') && (perm.counters['defense'] ?? 0) <= 0) {
      emit(ctx, 'sbaBattleDies', { name: perm.name });
      dying.push(perm);
    }
  }
  if (dying.length > 0) {
    yield* movePermanentsToGraveyard(ctx, dying);
    return true;
  }
  if (acted) return true;

  // --- Other battlefield checks, then the legend rule ---
  // Every check reads the board and changes nothing until one fires, and the first that fires
  // ends the pass, so they are judged in one read scope: the board is digested once instead of
  // once per characteristics query, and the change is made after the scope closes.
  const found = withReadScope(ctx, () => findBattlefieldSba(ctx));
  if (found !== undefined) {
    const perm = found.kind === 'legendRule' ? undefined : found.perm;
    switch (found.kind) {
      case 'bestowEnded':
        debug(ctx, 'sba', `bestowed ${perm!.name} unattached — it is a creature again`);
        emit(ctx, 'bestowEnded', { name: perm!.name });
        perm!.attachedTo = null;
        delete perm!.bestowed;
        return true;
      case 'auraDies':
        debug(
          ctx,
          'sba',
          `aura ${perm!.name} attached to nothing or an illegal host — to graveyard`,
        );
        emit(ctx, 'sbaAuraDies', { name: perm!.name });
        yield* moveObject(ctx, perm!, { zone: 'graveyard' });
        return true;
      case 'equipmentUnattached':
        debug(ctx, 'sba', `equipment ${perm!.name} illegally attached — unattached`);
        emit(ctx, 'sbaEquipmentUnattached', { name: perm!.name });
        perm!.attachedTo = null;
        return true;
      case 'sagaSacrificed':
        emit(ctx, 'sbaSagaSacrificed', { name: perm!.name });
        yield* moveObject(ctx, perm!, { zone: 'graveyard', reason: 'sacrifice' });
        return true;
      case 'countersAnnihilate': {
        const plus = perm!.counters['+1/+1'] ?? 0;
        const minus = perm!.counters['-1/-1'] ?? 0;
        const n = Math.min(plus, minus);
        perm!.counters['+1/+1'] = plus - n;
        perm!.counters['-1/-1'] = minus - n;
        if (perm!.counters['+1/+1'] === 0) delete perm!.counters['+1/+1'];
        if (perm!.counters['-1/-1'] === 0) delete perm!.counters['-1/-1'];
        debug(ctx, 'sba', `${perm!.name}: ${n} +1/+1 and -1/-1 counter pair(s) annihilate`);
        emit(ctx, 'sbaCountersAnnihilate', { name: perm!.name, count: n });
        return true;
      }
      case 'legendRule': {
        const { player, name, group } = found;
        debug(ctx, 'sba', `legend rule: ${player} controls ${group.length}× ${name}`);
        const outcome = yield {
          decisionType: 'legendRule',
          player,
          prompt: `You control ${group.length} legendary permanents named ${name}. Choose one to keep; the rest go to their owners' graveyards.`,
          options: group.map((p) => ({
            type: 'keepLegend',
            description: `Keep ${name} (${p.id})`,
            payload: p.id,
          })),
        };
        const keepId = (group[outcome.index] as EnginePermanent).id;
        emit(ctx, 'sbaLegendRule', { name, kept: keepId }, player);
        for (const p of group) {
          if (p.id !== keepId) yield* moveObject(ctx, p, { zone: 'graveyard' });
        }
        return true;
      }
    }
  }

  // --- CR 903.9a: commander newly in graveyard/exile may move to the command zone. ---
  for (const player of s.players) {
    const zones: EngineCardObject[][] = [player.graveyard, [...s.exile]];
    for (const zoneArr of zones) {
      for (const obj of [...zoneArr]) {
        if (obj.ownerId !== player.id || !obj.isCommander || obj.commanderSbaPending !== true) {
          continue;
        }
        if (player.hasLost) {
          obj.commanderSbaPending = false;
          continue;
        }
        // Default to command zone: Phase 2 models no graveyard/exile recursion, so
        // leaving a commander out of the command zone is never correct. By offering a
        // single option, isForced() auto-resolves this without querying the AI.
        const outcome = yield {
          decisionType: 'commanderReplacement',
          player: player.id,
          prompt: `${obj.name} is in ${obj.zone === 'graveyard' ? 'your graveyard' : 'exile'}. Move it to the command zone?`,
          options: [
            { type: 'commanderToCommandZone', description: `Move ${obj.name} to the command zone` },
          ],
        };
        obj.commanderSbaPending = false;
        if (outcome.index === 0) {
          emit(ctx, 'commanderToCommandZone', { name: obj.name, from: obj.zone }, player.id);
          yield* moveObject(ctx, obj, { zone: 'command' });
          return true;
        }
      }
    }
  }

  return false;
}

/** A battlefield state-based action `sbaPass` found, judged before anything changes. */
type BattlefieldSba =
  | {
      kind:
        | 'bestowEnded'
        | 'auraDies'
        | 'equipmentUnattached'
        | 'sagaSacrificed'
        | 'countersAnnihilate';
      perm: EnginePermanent;
    }
  | { kind: 'legendRule'; player: PlayerId; name: string; group: EnginePermanent[] };

/**
 * The first battlefield state-based action that applies, in the order `sbaPass` performs them:
 * bestow ending, Auras, Equipment, Sagas and counter annihilation per permanent, then the legend
 * rule in APNAP order. Reads only, so it can run in a read scope.
 */
function findBattlefieldSba(ctx: GameContext): BattlefieldSba | undefined {
  const s = ctx.state;
  const charsOf = battlefieldCharacteristics(ctx);
  for (const perm of s.battlefield) {
    const chars = charsOf(perm);

    // A bestowed Aura that is unattached or attached to an illegal object, by its enchant
    // restriction or protection, becomes unattached and ceases to be bestowed, staying on the
    // battlefield as the creature it is printed as (CR 702.103f, an exception to 704.5m).
    if (perm.bestowed === true) {
      const host =
        perm.attachedTo === null ? undefined : s.battlefield.find((p) => p.id === perm.attachedTo);
      if (host === undefined || enchantAllows(ctx, perm, host) !== true)
        return { kind: 'bestowEnded', perm };
    }

    // An Aura must remain attached to a permanent allowed by its enchant restriction for its
    // current controller, without protection from it (CR 704.5m, 303.4d, 702.16c).
    if (chars.subtypes.includes('Aura')) {
      const host =
        perm.attachedTo === null ? undefined : s.battlefield.find((p) => p.id === perm.attachedTo);
      // An Aura enchanting a player (Curse of Bounty) stays while that player is still one its
      // enchant ability allows ("enchant opponent" of its current controller), CR 303.4d.
      const playerHostLegal =
        perm.attachedTo !== null &&
        s.players.some((p) => p.id === perm.attachedTo) &&
        auraPlayerHostIsLegal(ctx, perm, perm.attachedTo);
      // Animate Dead before its enters trigger resolves: "enchant creature card in a graveyard"
      // is satisfied by that card while it stays there.
      const graveyardHostLegal =
        perm.attachedTo !== null &&
        perm.reanimatedHostId === undefined &&
        auraGraveyardHostIsLegal(ctx, perm, perm.attachedTo);
      // After it: only the creature put onto the battlefield with it, while it is a creature
      // without protection from the Aura (CR 702.16c).
      const reanimatedHostIllegal =
        perm.reanimatedHostId !== undefined &&
        (host === undefined ||
          host.id !== perm.reanimatedHostId ||
          !isCreaturePermanent(ctx, host) ||
          hasProtectionFrom(ctx, host, chars));
      // Any other permanent host must satisfy the enchant restriction.
      const hostIllegal =
        host !== undefined &&
        perm.reanimatedHostId === undefined &&
        enchantAllows(ctx, perm, host) === false;
      if (
        (host === undefined && !playerHostLegal && !graveyardHostLegal) ||
        reanimatedHostIllegal ||
        hostIllegal
      )
        return { kind: 'auraDies', perm };
    }

    // Equipment illegally attached becomes unattached (CR 704.5p).
    if (chars.subtypes.includes('Equipment') && perm.attachedTo !== null) {
      const host = s.battlefield.find((p) => p.id === perm.attachedTo);
      if (host === undefined || !isCreaturePermanent(ctx, host))
        return { kind: 'equipmentUnattached', perm };
    }

    // CR 714.4: a Saga at or past its final chapter is sacrificed once none of its chapter
    // abilities is still waiting to be put on, or sitting on, the stack.
    if (chars.subtypes.includes('Saga')) {
      const final = sagaFinalChapter(ctx, perm);
      const isChapter = (ability: { trigger?: object } | null): boolean =>
        ability?.trigger !== undefined && 'chapter' in ability.trigger;
      if (
        final > 0 &&
        (perm.counters['lore'] ?? 0) >= final &&
        !s.pendingTriggers.some(
          (pending) => pending.sourceObjectId === perm.id && isChapter(pending.ability),
        ) &&
        !s.stack.some((entry) => entry.sourceId === perm.id && isChapter(entry.ability))
      )
        return { kind: 'sagaSacrificed', perm };
    }

    // +1/+1 and -1/-1 counters annihilate in pairs (CR 704.5r).
    if ((perm.counters['+1/+1'] ?? 0) > 0 && (perm.counters['-1/-1'] ?? 0) > 0)
      return { kind: 'countersAnnihilate', perm };
  }

  // --- Legend rule (CR 704.5j) — controller chooses which to keep (brief §5.6). ---
  const legendRuleExemptions = gatherRuleStatics(ctx).filter(
    (entry) => entry.static.kind === 'legendRuleDoesntApply',
  );
  for (const player of playersInApnapOrder(ctx)) {
    const byName = new Map<string, EnginePermanent[]>();
    for (const perm of s.battlefield) {
      if (perm.controllerId !== player.id) continue;
      if (!charsOf(perm).supertypes.includes('Legendary')) continue;
      if (
        legendRuleExemptions.some(
          (entry) =>
            entry.controllerId === player.id &&
            entry.static.kind === 'legendRuleDoesntApply' &&
            matchesSelector(ctx, perm, entry.static.filter, {
              cardId: entry.sourceCardId,
              controllerId: entry.controllerId,
            }),
        )
      )
        continue;
      const group = byName.get(perm.name) ?? [];
      group.push(perm);
      byName.set(perm.name, group);
    }
    for (const [name, group] of byName)
      if (group.length >= 2) return { kind: 'legendRule', player: player.id, name, group };
  }
  return undefined;
}

/** Put waiting triggers on the stack in APNAP order; same-player order is a choice (§5.5). */
function* placePendingTriggers(ctx: GameContext): GameGen<boolean> {
  const s = ctx.state;
  if (s.pendingTriggers.length === 0) return false;

  const waiting = s.pendingTriggers;
  s.pendingTriggers = [];

  for (const player of playersInApnapOrder(ctx)) {
    let mine = waiting.filter((t) => t.controllerId === player.id);
    // The controller chooses the order their simultaneous triggers go on the stack —
    // an AI decision when there is more than one (brief §5.5). Sequential picks: each
    // choice selects the NEXT trigger to put on the stack.
    while (mine.length > 0) {
      let pick = 0;
      if (mine.length > 1) {
        const outcome = yield {
          decisionType: 'orderTriggers',
          player: player.id,
          prompt:
            'Multiple of your abilities triggered simultaneously. Choose which to put on the stack next (the last one placed resolves first).',
          options: mine.map((t) => {
            const affected = t.scope?.eventPlayerId;
            return {
              type: 'placeTrigger',
              description: `${t.sourceName}: ${t.ability.description ?? ''}${affected === undefined ? '' : ` (event player: ${affected})`}`,
              interaction: { kind: 'order' as const, subjectIds: [t.sourceCardId] },
            };
          }),
        };
        pick = outcome.index;
      }
      const trigger = mine[pick] as PendingTrigger;
      mine = mine.filter((_, i) => i !== pick);
      yield* pushTriggerOnStack(ctx, trigger);
    }
  }
  return true;
}

/**
 * Put one trigger on the stack, choosing its targets on the way (CR 603.3d — a triggered
 * ability's targets are chosen as it is put on the stack, not when it resolves).
 *
 * CR 603.3d also says an ability whose targets cannot all be chosen is simply removed from
 * the stack. So a slot with zero legal options means the trigger never arrives at all —
 * distinct from fizzling, which happens later if the chosen targets stop being legal.
 */
/** A permanent's or player's name, for a variable-target decision's prompt/description. */
function describeTargetForLog(ctx: GameContext, id: ObjectId): string {
  const perm = ctx.state.battlefield.find((p) => p.id === id);
  if (perm !== undefined) return perm.name;
  // A card target in a graveyard or exile (Victimize, Forum Filibuster) is named, not its id.
  const card = [...ctx.state.players.flatMap((p) => p.graveyard), ...ctx.state.exile].find(
    (candidate) => candidate.id === id,
  );
  if (card !== undefined) return card.name;
  return ctx.state.players.find((p) => p.id === id)?.id ?? id;
}

function playerLife(ctx: GameContext, playerId: PlayerId): number | undefined {
  return ctx.state.players.find((p) => p.id === playerId)?.life;
}

/**
 * Whether choosing `id` as a damage target could kill the chooser: it is another player's
 * permanent with a "whenever this is dealt damage, it deals that much damage to …" trigger
 * (Brash Taunter), and the damage on offer (`total`) is at least the chooser's life. A hint only —
 * the amount that reaches it is still the chooser's to divide, and the reflection might target
 * someone else — so it errs towards telling the player.
 */
function reflectsDamageAtLethal(
  ctx: GameContext,
  id: ObjectId,
  chooser: PlayerId,
  total: number,
): boolean {
  const perm = ctx.state.battlefield.find((p) => p.id === id);
  if (perm === undefined || perm.controllerId === chooser) return false;
  const life = playerLife(ctx, chooser);
  if (life === undefined || total < life) return false;
  const triggers = ctx.defs.get(perm.oracleId)?.triggers ?? [];
  return triggers.some(
    (t) =>
      t.trigger?.when === 'dealtDamage' &&
      t.trigger.subject?.kind === 'self' &&
      t.effects.some((e) => e.op === 'dealDamage' && e.amount.kind === 'damageDealt'),
  );
}

function* pushTriggerOnStack(ctx: GameContext, trigger: PendingTrigger): GameGen<void> {
  const s = ctx.state;
  // A modal trigger's controller chooses the mode as the ability is put on the stack, BEFORE
  // its targets (CR 603.3c, 700.2b): a mode whose targets cannot be chosen cannot be chosen,
  // only the chosen modes' targets are announced, and with no choosable mode the ability is
  // removed. Choosing at resolution instead (as this once did) asked for a target the chosen
  // mode never used, let that target's illegality fizzle a targetless mode, and dropped the
  // whole trigger when only one mode lacked a target.
  // Protection (CR 702.16): a triggered ability can't target what is protected from its source.
  const source: TargetingSource = {
    traits: sourceTraitsOf(ctx, trigger.sourceCardId, trigger.sourceOracleId, {
      ...(trigger.sourceColors === undefined ? {} : { colors: trigger.sourceColors }),
      ...(trigger.sourceFacts === undefined ? {} : { types: trigger.sourceFacts.candidate.types }),
    }),
    kind: 'ability',
  };
  let ability: Ability = trigger.ability;
  let activeSlots: number[] | undefined;
  let modeLabel: string | undefined;
  const modes = trigger.ability.modes;
  if (modes !== undefined) {
    const selections = legalAbilityModeSelections(trigger.ability, (spec) =>
      computeTargetOptions(
        ctx,
        spec,
        trigger.controllerId,
        source,
        trigger.scope?.eventPlayerId,
        undefined,
        trigger.sourceCardId,
        true,
        trigger.sourceFacts,
      ),
    );
    if (selections.length === 0) {
      emit(
        ctx,
        'triggerRemovedNoTargets',
        { source: trigger.sourceName, kind: 'mode' },
        trigger.controllerId,
      );
      debug(
        ctx,
        'stack',
        `${trigger.sourceName}: no mode can be chosen — trigger removed (CR 700.2b)`,
      );
      return;
    }
    let selection = selections[0] as number[];
    if (selections.length > 1) {
      const outcome = yield {
        decisionType: 'general',
        player: trigger.controllerId,
        prompt: `${trigger.sourceName}: choose ${modes.maxChoices === 1 ? 'a mode' : 'modes'} — ${trigger.ability.description ?? ''}`,
        options: selections.map((candidate) => ({
          type: 'chooseModes',
          description: abilityModeLabel(modes, candidate),
        })),
      };
      selection = optionAt(selections, outcome, 'sba.pushTriggerOnStack.modes');
    }
    ability = abilityForModes(trigger.ability, selection);
    activeSlots = abilityModeTargetSlots(modes, selection);
    modeLabel = abilityModeLabel(modes, selection);
  }
  // "For each player, up to one target …" (Nils): one optional slot per player in the game now.
  ability = expandPerPlayerTargets(ctx, ability, trigger.controllerId);
  const specs = ability.targets;
  const chosen: ObjectId[] = [];
  const countTargets: Record<number, ObjectId[]> = {};
  const divisionAmounts: Record<ObjectId, number> = {};

  // Ordinary (single-target) slots first — unchanged from before count slots existed. By
  // convention every count slot (below) is allocated AFTER all of an ability's ordinary slots,
  // so `chosen` has nothing at a count slot's position. A modal trigger leaves an unchosen
  // mode's slots empty too — indexed by slot, the same sparse layout a modal spell's targets use.
  const ordinarySlots: { slot: number; options: ObjectId[] }[] = [];
  for (const [i, spec] of specs.entries()) {
    if (spec.count !== undefined || !slotIsActive(activeSlots, i)) continue;
    const options = computeTargetOptions(
      ctx,
      spec,
      trigger.controllerId,
      source,
      trigger.scope?.eventPlayerId,
      undefined,
      trigger.sourceCardId,
      true,
      trigger.sourceFacts,
    );
    if (options.length === 0) {
      emit(
        ctx,
        'triggerRemovedNoTargets',
        { source: trigger.sourceName, kind: spec.kind },
        trigger.controllerId,
      );
      debug(
        ctx,
        'stack',
        `${trigger.sourceName}: no legal ${spec.kind} for slot ${i} — trigger removed (CR 603.3d)`,
      );
      return;
    }
    if (spec.random === true) {
      chosen[i] = options[ctx.rng.nextInt(options.length)]!;
      emit(
        ctx,
        'randomTarget',
        { source: trigger.sourceName, target: chosen[i] },
        trigger.controllerId,
      );
    } else ordinarySlots.push({ slot: i, options });
  }

  if (ordinarySlots.some(({ slot }) => specs[slot]?.differentPlayerTargetSlots !== undefined)) {
    for (const { slot } of ordinarySlots) {
      const options = computeTargetOptions(
        ctx,
        specs[slot]!,
        trigger.controllerId,
        source,
        trigger.scope?.eventPlayerId,
        chosen,
        trigger.sourceCardId,
        true,
        trigger.sourceFacts,
      );
      if (options.length === 0)
        throw new Error('engine bug: modal distinct-player targets have no assignment');
      const targetSlots = [{ slot, options }];
      const outcome = yield {
        decisionType: 'chooseTargets',
        player: trigger.controllerId,
        prompt: `Choose target player for ${trigger.sourceName}: ${modes?.options.find((option) => option.targetSlots?.includes(slot))?.description ?? 'ability'}`,
        options: [
          {
            type: 'chooseTargets',
            description: `Target player for ${trigger.sourceName}`,
            targets: targetSlots,
            interaction: { kind: 'choice', targetSlots },
          },
        ],
      };
      const picked = outcome.targets.get(slot) ?? options[0]!;
      if (!options.includes(picked)) throw new Error('engine bug: invalid distinct-player target');
      chosen[slot] = picked;
    }
  } else if (ordinarySlots.length > 0) {
    // `trigger.sourceCardId` is the STABLE card identity (`EnginePermanent.cardId`), which
    // survives zone changes — it is NOT the battlefield object id the web UI keys permanents by
    // (`EnginePermanent.id`, freshly minted every zone change, incl. entering the battlefield;
    // see `reincarnate`). Look the permanent up by its stable id to get the live board id a
    // click can actually match; `undefined` when the source already left the battlefield (e.g.
    // a "dies" trigger), in which case there is nothing to click and the option falls back to
    // the generic decision panel instead of a dangling, never-matching source id.
    const sourcePermanent = ctx.state.battlefield.find((p) => p.cardId === trigger.sourceCardId);

    // Slots that must name different objects ("another target creature") cannot be offered as
    // independent menus: the cross product would let one object fill both. Offer one menu per
    // legal assignment instead, as a spell's targets are, and remove the trigger when there is
    // no assignment at all (CR 603.3d).
    // A slot whose target is picked at random is already in `chosen` and not a menu here.
    const dependent =
      ordinarySlots.some(({ slot }) => specs[slot]?.differentFromSlots !== undefined) &&
      !specs.some(
        (spec, slot) =>
          spec.count === undefined && spec.random === true && slotIsActive(activeSlots, slot),
      );
    const menus: TargetMenu[][] = dependent
      ? legalTargetMenus(
          ctx,
          ability,
          {
            controllerId: trigger.controllerId,
            sourceCardId: trigger.sourceCardId,
            targeting: true,
            ...(trigger.sourceFacts === undefined ? {} : { sourceFacts: trigger.sourceFacts }),
            ...targetingSourceFields(source),
            ...(trigger.scope?.eventPlayerId === undefined
              ? {}
              : { eventPlayerId: trigger.scope.eventPlayerId }),
          },
          activeSlots,
        )
      : [ordinarySlots];
    if (menus.length === 0) {
      emit(
        ctx,
        'triggerRemovedNoTargets',
        { source: trigger.sourceName, kind: 'distinct targets' },
        trigger.controllerId,
      );
      debug(
        ctx,
        'stack',
        `${trigger.sourceName}: no legal assignment of distinct targets — trigger removed (CR 603.3d)`,
      );
      return;
    }

    // One decision carrying every ordinary slot. `isForced` auto-resolves it when each slot has
    // a single candidate, so the common "ETB, destroy the only creature" costs no AI call.
    const outcome = yield {
      decisionType: 'chooseTargets',
      player: trigger.controllerId,
      prompt: `Choose targets for ${trigger.sourceName} — ${ability.description ?? ''}`,
      options: menus.map((menu) => ({
        type: 'chooseTargets',
        description: `Targets for ${trigger.sourceName}`,
        targets: menu,
        // Route through the same "click the permanent, then its targets" UI a cast spell or
        // activated ability uses. Without this, the option falls back to the generic decision
        // panel, which has no per-slot picker and would submit with no targets chosen at all.
        interaction:
          sourcePermanent !== undefined
            ? { kind: 'source' as const, sourceId: sourcePermanent.id, targetSlots: menu }
            : { kind: 'choice' as const, targetSlots: menu },
      })),
    };
    const menu =
      menus.length === 1 ? menus[0]! : optionAt(menus, outcome, 'sba.pushTriggerOnStack.targets');
    for (const { slot, options } of menu) {
      const picked = outcome.targets.get(slot) ?? (options[0] as ObjectId);
      if (dependent && !options.includes(picked))
        throw new Error(`illegal target ${picked} for slot ${slot} of ${trigger.sourceName}`);
      chosen[slot] = picked;
    }
  }

  // Variable-count slots ("up to two OTHER targets" — Drakuseth; "any number of … target
  // creatures" — Ureni). CR 601.2b/603.3d: the COUNT itself is a choice, so it is asked as a
  // bounded sequence of decisions rather than a fixed slot with a fixed option list. Excluding
  // every id already chosen (ordinary or count) is what gives "other" its meaning without a
  // separate exclusion field, and is harmless for a slot with nothing else chosen yet (Ureni).
  for (const [i, spec] of specs.entries()) {
    if (spec.count === undefined || !slotIsActive(activeSlots, i)) continue;
    const count = spec.count;
    const alreadyChosen = new Set<ObjectId>([
      ...Object.values(chosen),
      ...Object.values(countTargets).flat(),
    ]);

    // A `dealDamageDivided` effect over this slot caps the count at the total available — CR
    // 601.2d requires every target to receive at least 1, so choosing more targets than the
    // total supports is not a legal announcement. The total is knowable now: it never depends
    // on which targets get chosen, only on the board.
    const dividedEffect = ability.effects.find(
      (e): e is Extract<Effect, { op: 'dealDamageDivided' }> =>
        e.op === 'dealDamageDivided' && e.targetSlot === i,
    );
    const total =
      dividedEffect === undefined
        ? undefined
        : evaluateValueIn(ctx, dividedEffect.total, {
            controllerId: trigger.controllerId,
            sourceCardId: trigger.sourceCardId,
          });
    const effectiveMax = total === undefined ? count.max : Math.min(count.max, total);

    const picked: ObjectId[] = [];
    for (let k = 0; k < effectiveMax; k++) {
      const candidates = withinTotalManaValue(
        ctx,
        spec,
        picked,
        computeTargetOptions(
          ctx,
          spec,
          trigger.controllerId,
          source,
          trigger.scope?.eventPlayerId,
          chosen,
          trigger.sourceCardId,
          true,
          trigger.sourceFacts,
        ).filter((id) => !alreadyChosen.has(id) && !picked.includes(id)),
      );
      if (candidates.length === 0) break;
      const canStop = picked.length >= count.min;
      const outcome = yield {
        decisionType: 'general',
        player: trigger.controllerId,
        prompt:
          `${trigger.sourceName}: choose ${picked.length > 0 ? 'another' : 'a'} target ` +
          (spec.controllerPlayer === undefined ? '' : `controlled by ${spec.controllerPlayer} `) +
          // "Any number of" has no upper bound to show.
          `(${picked.length}${Number.isFinite(effectiveMax) ? `/${effectiveMax}` : ''} chosen)` +
          `${canStop ? ', or stop choosing' : ''}.`,
        options: [
          ...candidates.map((id) => ({
            type: 'pickTarget',
            description:
              `Target ${describeTargetForLog(ctx, id)}` +
              (total !== undefined && reflectsDamageAtLethal(ctx, id, trigger.controllerId, total)
                ? ` ⚠ sends the damage back to you (you are at ${playerLife(ctx, trigger.controllerId)})`
                : ''),
          })),
          ...(canStop ? [{ type: 'decline', description: 'Choose no more targets' }] : []),
        ],
      };
      if (outcome.index >= candidates.length) break;
      picked.push(candidates[outcome.index] as ObjectId);
    }

    // CR 603.3d applies to a count slot too: if even the minimum could not be met, the whole
    // ability never arrives (our fixtures always have min 0, so this never fires today).
    if (picked.length < count.min) {
      emit(
        ctx,
        'triggerRemovedNoTargets',
        { source: trigger.sourceName, kind: spec.kind },
        trigger.controllerId,
      );
      debug(
        ctx,
        'stack',
        `${trigger.sourceName}: could not meet minimum targets for slot ${i} — trigger removed (CR 603.3d)`,
      );
      return;
    }
    countTargets[i] = picked;

    // The division itself (CR 601.2d): each target gets at least 1, and the split is decided
    // now, alongside the targets, then replayed unchanged at resolution.
    if (dividedEffect !== undefined && total !== undefined && picked.length > 0) {
      let remaining = total;
      for (const [idx, targetId] of picked.entries()) {
        const targetsLeft = picked.length - idx;
        if (targetsLeft === 1) {
          divisionAmounts[targetId] = remaining;
          break;
        }
        const maxHere = remaining - (targetsLeft - 1); // leave >=1 for each remaining target
        const choices = Array.from({ length: Math.max(maxHere, 1) }, (_, n) => n + 1);
        const outcome = yield {
          decisionType: 'general',
          player: trigger.controllerId,
          prompt:
            `${trigger.sourceName}: how much of the remaining ${remaining} damage to ` +
            `${describeTargetForLog(ctx, targetId)}?`,
          options: choices.map((n) => ({ type: 'assignDamage', description: `${n}` })),
        };
        const amount = optionAt(choices, outcome, 'sba.pushTriggerOnStack.division');
        divisionAmounts[targetId] = amount;
        remaining -= amount;
      }
    }
  }

  const id = `o-${s.nextObjectNum++}` as ObjectId;
  // A delayed trigger (no event head) is exempt from CR 701.27f, so only ordinary triggers record it.
  const transformingSource =
    ability.trigger === undefined || trigger.sourceObjectId === undefined
      ? undefined
      : s.battlefield.find((perm) => perm.id === trigger.sourceObjectId);
  const sourceTransformations =
    transformingSource === undefined ? undefined : (transformingSource.transformations ?? 0);
  // The announced mode is public (CR 700.2b) — name it on the stack, where every player sees it.
  const description =
    (ability.description ?? trigger.sourceName) +
    (modeLabel === undefined ? '' : ` [mode: ${modeLabel}]`);
  const stackEntry: EngineStackObject = {
    id,
    sourceId: trigger.sourceObjectId ?? trigger.sourceCardId,
    controllerId: trigger.controllerId,
    kind: 'triggeredAbility',
    description: `${trigger.sourceName} — ${description}`,
    targets: chosen,
    card: null,
    ability,
    sourceColors: [...source.traits.colors],
    sourceOracleId: trigger.sourceOracleId,
    sourceCardId: trigger.sourceCardId,
    isCommanderCast: false,
    ...(trigger.sourceFacts === undefined ? {} : { sourceFacts: trigger.sourceFacts }),
    ...(sourceTransformations === undefined ? {} : { sourceTransformations }),
    ...(trigger.triggerObjectCardId !== undefined
      ? { triggerObjectCardId: trigger.triggerObjectCardId }
      : {}),
    ...(trigger.scope !== undefined ? { triggerScope: trigger.scope } : {}),
    ...(trigger.sourceDamageKeywords !== undefined
      ? { sourceDamageKeywords: trigger.sourceDamageKeywords }
      : {}),
    ...(Object.keys(countTargets).length > 0 ? { countTargets } : {}),
    ...(Object.keys(divisionAmounts).length > 0 ? { divisionAmounts } : {}),
  };
  s.stack.push(stackEntry);
  breakYieldsForStop(ctx, stackEntry);
  // Ward and "becomes the target" watch every spell OR ABILITY (CR 702.21a), so a triggered
  // ability's targets count exactly like a cast spell's or an activated ability's.
  const allTargets = [
    ...chosen.filter((target): target is ObjectId => target !== undefined),
    ...Object.values(countTargets).flat(),
  ];
  queueWardTriggers(ctx, trigger.controllerId, id, allTargets);
  queueBecomesTargetedTriggers(ctx, trigger.controllerId, allTargets);
  emit(ctx, 'triggerOnStack', { source: trigger.sourceName, description }, trigger.controllerId);
  debug(ctx, 'stack', `trigger on stack: ${trigger.sourceName} — ${description}`);
}

/**
 * The checkpoint performed whenever a player would receive priority (CR 117.5, brief
 * §5.6): repeat SBAs until none apply, then place triggers; repeat until stable.
 * Returns true if anything happened (the priority loop must then restart its passes).
 */
export function* priorityCheckpoint(ctx: GameContext): GameGen<boolean> {
  let anything = false;
  for (;;) {
    let sbaActed = false;
    for (;;) {
      debug(ctx, 'sba', 'SBA check');
      const acted = yield* sbaPass(ctx);
      if (!acted) break;
      sbaActed = true;
    }
    const placed = yield* placePendingTriggers(ctx);
    if (sbaActed || placed) anything = true;
    if (!placed && !sbaActed) {
      // Tests and tools check whole-state invariants here (ADR 0034 decision 8).
      runCheckpointHook(ctx);
      return anything;
    }
  }
}

/** Whether a player is still a legal host for `aura`'s enchant ability (CR 303.4d, 704.5m). */
function auraPlayerHostIsLegal(ctx: GameContext, aura: EnginePermanent, playerId: string): boolean {
  // Protection forbids enchantment; hexproof only forbids targeting, not attachment.
  if (playerProtectedFromEverything(ctx, playerId)) return false;
  const enchant = getDefByOracleId(ctx, aura.oracleId, aura.name).spellAbility?.targets[0];
  if (enchant === undefined || enchant.kind !== 'player') return false;
  return computeTargetOptions(
    ctx,
    enchant,
    aura.controllerId,
    undefined,
    undefined,
    undefined,
    aura.cardId,
    false,
  ).includes(playerId);
}

/** Whether a graveyard card is still a legal host for `aura`'s enchant ability (Animate Dead). */
function auraGraveyardHostIsLegal(
  ctx: GameContext,
  aura: EnginePermanent,
  cardId: string,
): boolean {
  const enchant = getDefByOracleId(ctx, aura.oracleId, aura.name).spellAbility?.targets[0];
  if (enchant === undefined || enchant.kind !== 'cardInGraveyard') return false;
  return computeTargetOptions(
    ctx,
    enchant,
    aura.controllerId,
    undefined,
    undefined,
    undefined,
    aura.cardId,
    false,
  ).includes(cardId);
}
