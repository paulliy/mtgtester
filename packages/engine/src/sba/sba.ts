/**
 * State-based actions (CR 704, brief §5.6) and the "checkpoint" every player passes
 * through before receiving priority: repeat SBA checks until none apply, then put waiting
 * triggered abilities on the stack (CR 603.3b), repeating until stable (CR 704.3).
 *
 * Player loss processing implements the multiplayer leave-the-game rules (CR 800.4a):
 * all objects the player owns leave the game, and the game continues among survivors.
 */

import type { LossReason, ObjectId, PlayerId } from '@mtg/shared';
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
import { computeCharacteristics } from '../effects/continuous';
import { evaluateValueIn } from '../effects/values';
import { debug, emit } from '../log/log';
import { GameOverSignal } from '../signals';
import { breakYieldsForStop } from '../turn/stops';
import {
  consumeRegenerationShield,
  moveObject,
  movePermanentsToGraveyard,
  returnExiledUntilLeaves,
} from '../state/objects';
import { isCreaturePermanent, playersInApnapOrder, sourceColorsOf } from '../state/queries';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
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
    const leaving = s.battlefield.filter((p) => p.ownerId === player.id);
    s.battlefield = s.battlefield.filter((p) => p.ownerId !== player.id);
    for (const perm of leaving) {
      debug(ctx, 'zoneChange', `${perm.name} leaves the game with its owner ${player.id}`);
    }
    // End effects giving a departed player control. A permanent put onto the
    // battlefield under that player's control has no such effect to end (CR 800.4a).
    for (const perm of [...s.battlefield]) {
      if (perm.controllerId !== player.id) continue;
      perm.controlChanges = (perm.controlChanges ?? []).filter(
        (id) => !s.players.find((p) => p.id === id)?.hasLost,
      );
      const controller = perm.controlChanges.at(-1) ?? perm.defaultControllerId ?? perm.ownerId;
      if (s.players.find((p) => p.id === controller)?.hasLost) {
        leaving.push(perm);
        yield* moveObject(ctx, perm, { zone: 'exile' });
        continue;
      }
      perm.controllerId = controller;
      perm.timestamp = s.nextTimestamp++;
      perm.summoningSick = true;
      perm.attacking = null;
      perm.blocking = null;
      perm.statuses = perm.statuses.filter((st) => st !== 'attacking' && st !== 'blocking');
    }
    // Leaving the game ends linked-exile durations too, although it queues no dies triggers.
    for (const perm of leaving) yield* returnExiledUntilLeaves(ctx, perm.cardId);
    s.delayedTriggers = s.delayedTriggers.filter((t) => t.controllerId !== player.id);
    s.stack = s.stack.filter(
      (so) => so.controllerId !== player.id && so.card?.ownerId !== player.id,
    );
    s.pendingTriggers = s.pendingTriggers.filter((t) => t.controllerId !== player.id);
    s.exile = s.exile.filter((o) => o.ownerId !== player.id);
    // Every other object they own leaves the game too: nothing may still count their graveyard
    // (Tarmogoyf), target a card in it (Reanimate), or count their hand or library.
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
      if (perm.attacking === player.id) perm.attacking = null;
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
    if (player.life <= 0) {
      markLoss(ctx, player, 'lifeZeroOrLess');
      acted = true;
    } else if (player.attemptedDrawFromEmptyLibrary) {
      markLoss(ctx, player, 'emptyLibraryDraw');
      acted = true;
    } else if (player.poisonCounters >= 10) {
      markLoss(ctx, player, 'poisonCounters');
      acted = true;
    } else if (Object.values(player.commanderDamageTaken).some((dmg) => dmg >= 21)) {
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
  for (const perm of s.battlefield) {
    const chars = computeCharacteristics(ctx, perm);
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

  // --- Other battlefield checks ---
  for (const perm of [...s.battlefield]) {
    if (!s.battlefield.includes(perm)) continue;
    const chars = computeCharacteristics(ctx, perm);

    // An Aura must remain attached to a permanent allowed by its enchant restriction (CR 704.5m).
    if (chars.subtypes.includes('Aura')) {
      const host =
        perm.attachedTo === null ? undefined : s.battlefield.find((p) => p.id === perm.attachedTo);
      if (host === undefined) {
        debug(ctx, 'sba', `aura ${perm.name} attached to nothing — to graveyard`);
        emit(ctx, 'sbaAuraDies', { name: perm.name });
        yield* moveObject(ctx, perm, { zone: 'graveyard' });
        return true;
      }
    }

    // Equipment illegally attached becomes unattached (CR 704.5p).
    if (chars.subtypes.includes('Equipment') && perm.attachedTo !== null) {
      const host = s.battlefield.find((p) => p.id === perm.attachedTo);
      if (host === undefined || !isCreaturePermanent(ctx, host)) {
        debug(ctx, 'sba', `equipment ${perm.name} illegally attached — unattached`);
        emit(ctx, 'sbaEquipmentUnattached', { name: perm.name });
        perm.attachedTo = null;
        return true;
      }
    }

    // +1/+1 and -1/-1 counters annihilate in pairs (CR 704.5r).
    {
      const plus = perm.counters['+1/+1'] ?? 0;
      const minus = perm.counters['-1/-1'] ?? 0;
      if (plus > 0 && minus > 0) {
        const n = Math.min(plus, minus);
        perm.counters['+1/+1'] = plus - n;
        perm.counters['-1/-1'] = minus - n;
        if (perm.counters['+1/+1'] === 0) delete perm.counters['+1/+1'];
        if (perm.counters['-1/-1'] === 0) delete perm.counters['-1/-1'];
        debug(ctx, 'sba', `${perm.name}: ${n} +1/+1 and -1/-1 counter pair(s) annihilate`);
        emit(ctx, 'sbaCountersAnnihilate', { name: perm.name, count: n });
        return true;
      }
    }
  }

  // --- Legend rule (CR 704.5j) — controller chooses which to keep (brief §5.6). ---
  for (const player of playersInApnapOrder(ctx)) {
    const byName = new Map<string, EnginePermanent[]>();
    for (const perm of s.battlefield) {
      if (perm.controllerId !== player.id) continue;
      if (!computeCharacteristics(ctx, perm).supertypes.includes('Legendary')) continue;
      const group = byName.get(perm.name) ?? [];
      group.push(perm);
      byName.set(perm.name, group);
    }
    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      debug(ctx, 'sba', `legend rule: ${player.id} controls ${group.length}× ${name}`);
      const outcome = yield {
        decisionType: 'legendRule',
        player: player.id,
        prompt: `You control ${group.length} legendary permanents named ${name}. Choose one to keep; the rest go to their owners' graveyards.`,
        options: group.map((perm) => ({
          type: 'keepLegend',
          description: `Keep ${name} (${perm.id})`,
          payload: perm.id,
        })),
      };
      const keepId = (group[outcome.index] as EnginePermanent).id;
      emit(ctx, 'sbaLegendRule', { name, kept: keepId }, player.id);
      for (const perm of group) {
        if (perm.id !== keepId) yield* moveObject(ctx, perm, { zone: 'graveyard' });
      }
      return true;
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

function* pushTriggerOnStack(ctx: GameContext, trigger: PendingTrigger): GameGen<void> {
  const s = ctx.state;
  // A modal trigger's controller chooses the mode as the ability is put on the stack, BEFORE
  // its targets (CR 603.3c, 700.2b): a mode whose targets cannot be chosen cannot be chosen,
  // only the chosen modes' targets are announced, and with no choosable mode the ability is
  // removed. Choosing at resolution instead (as this once did) asked for a target the chosen
  // mode never used, let that target's illegality fizzle a targetless mode, and dropped the
  // whole trigger when only one mode lacked a target.
  // Protection (CR 702.16): a triggered ability can't target what is protected from its source.
  const sourceColors = sourceColorsOf(
    ctx,
    trigger.sourceCardId,
    trigger.sourceOracleId,
    trigger.sourceColors,
  );
  let ability: Ability = trigger.ability;
  let activeSlots: number[] | undefined;
  let modeLabel: string | undefined;
  const modes = trigger.ability.modes;
  if (modes !== undefined) {
    const selections = legalAbilityModeSelections(
      trigger.ability,
      (spec) =>
        computeTargetOptions(
          ctx,
          spec,
          trigger.controllerId,
          sourceColors,
          trigger.scope?.eventPlayerId,
          undefined,
          trigger.sourceCardId,
          true,
          trigger.sourceFacts,
        ).length,
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
      selection = selections[outcome.index] ?? selection;
    }
    ability = abilityForModes(trigger.ability, selection);
    activeSlots = abilityModeTargetSlots(modes, selection);
    modeLabel = abilityModeLabel(modes, selection);
  }
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
      sourceColors,
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
    ordinarySlots.push({ slot: i, options });
  }

  if (ordinarySlots.length > 0) {
    // `trigger.sourceCardId` is the STABLE card identity (`EnginePermanent.cardId`), which
    // survives zone changes — it is NOT the battlefield object id the web UI keys permanents by
    // (`EnginePermanent.id`, freshly minted every zone change, incl. entering the battlefield;
    // see `reincarnate`). Look the permanent up by its stable id to get the live board id a
    // click can actually match; `undefined` when the source already left the battlefield (e.g.
    // a "dies" trigger), in which case there is nothing to click and the option falls back to
    // the generic decision panel instead of a dangling, never-matching source id.
    const sourcePermanent = ctx.state.battlefield.find((p) => p.cardId === trigger.sourceCardId);

    // One decision carrying every ordinary slot. `isForced` auto-resolves it when each slot has
    // a single candidate, so the common "ETB, destroy the only creature" costs no AI call.
    const outcome = yield {
      decisionType: 'chooseTargets',
      player: trigger.controllerId,
      prompt: `Choose targets for ${trigger.sourceName} — ${ability.description ?? ''}`,
      options: [
        {
          type: 'chooseTargets',
          description: `Targets for ${trigger.sourceName}`,
          targets: ordinarySlots,
          // Route through the same "click the permanent, then its targets" UI a cast spell or
          // activated ability uses. Without this, the option falls back to the generic decision
          // panel, which has no per-slot picker and would submit with no targets chosen at all.
          interaction:
            sourcePermanent !== undefined
              ? { kind: 'source', sourceId: sourcePermanent.id, targetSlots: ordinarySlots }
              : { kind: 'choice', targetSlots: ordinarySlots },
        },
      ],
    };
    for (const { slot, options } of ordinarySlots) {
      chosen[slot] = outcome.targets.get(slot) ?? (options[0] as ObjectId);
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
          sourceColors,
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
          // "Any number of" has no upper bound to show.
          `(${picked.length}${Number.isFinite(effectiveMax) ? `/${effectiveMax}` : ''} chosen)` +
          `${canStop ? ', or stop choosing' : ''}.`,
        options: [
          ...candidates.map((id) => ({
            type: 'pickTarget',
            description: `Target ${describeTargetForLog(ctx, id)}`,
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
        const amount = choices[outcome.index] ?? 1;
        divisionAmounts[targetId] = amount;
        remaining -= amount;
      }
    }
  }

  const id = `o-${s.nextObjectNum++}` as ObjectId;
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
    sourceColors,
    sourceOracleId: trigger.sourceOracleId,
    sourceCardId: trigger.sourceCardId,
    isCommanderCast: false,
    ...(trigger.sourceFacts === undefined ? {} : { sourceFacts: trigger.sourceFacts }),
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
    if (!placed && !sbaActed) return anything;
  }
}
