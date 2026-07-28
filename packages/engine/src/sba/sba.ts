/**
 * State-based actions (CR 704, brief §5.6) and the "checkpoint" every player passes
 * through before receiving priority: repeat SBA checks until none apply, then put waiting
 * triggered abilities on the stack (CR 603.3b), repeating until stable (CR 704.3).
 *
 * Player loss processing implements the multiplayer leave-the-game rules (CR 800.4a):
 * all objects the player owns leave the game, and the game continues among survivors.
 */

import type { LossReason, ObjectId, PlayerId } from '@mtg/shared';
import { computeTargetOptions } from '../actions/legal';
import type { Effect } from '../cards/ability';
import type { GameGen } from '../decisions';
import { computeCharacteristics } from '../effects/continuous';
import { evaluateValueIn } from '../effects/values';
import { debug, emit } from '../log/log';
import { GameOverSignal } from '../signals';
import { resetOpponentYields } from '../turn/priority';
import { moveObject } from '../state/objects';
import {
  effectivePT,
  hasKeyword,
  isCreaturePermanent,
  playersInApnapOrder,
} from '../state/queries';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
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
function processEliminations(ctx: GameContext): void {
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
    s.stack = s.stack.filter(
      (so) => so.controllerId !== player.id && so.card?.ownerId !== player.id,
    );
    s.pendingTriggers = s.pendingTriggers.filter((t) => t.controllerId !== player.id);
    s.exile = s.exile.filter((o) => o.ownerId !== player.id);

    // Combat cleanup: their creatures are gone; attackers pointed at them stand down
    // (CR 800.4e — no combat damage is assigned to a player who has left).
    const leavingIds = new Set(leaving.map((p) => p.id));
    for (const perm of s.battlefield) {
      if (perm.attacking === player.id) perm.attacking = null;
      if (perm.blocking !== null && leavingIds.has(perm.blocking)) perm.blocking = null;
      perm.blockedByOrdered = perm.blockedByOrdered.filter((id) => !leavingIds.has(id));
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
    if (player.hasLost) continue;
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
    processEliminations(ctx);
    return true;
  }

  // --- Battlefield checks ---
  for (const perm of [...s.battlefield]) {
    if (!s.battlefield.includes(perm)) continue; // removed by an earlier action this pass
    const chars = computeCharacteristics(ctx, perm);

    if (isCreaturePermanent(ctx, perm)) {
      const pt = effectivePT(ctx, perm);
      if (pt.toughness <= 0) {
        debug(ctx, 'sba', `${perm.name} has toughness ${pt.toughness} ≤ 0 — to graveyard`);
        emit(ctx, 'sbaCreatureDies', { name: perm.name, reason: 'zeroToughness' });
        yield* moveObject(ctx, perm, { zone: 'graveyard' });
        return true;
      }
      if (
        (perm.damageMarked >= pt.toughness || perm.damagedByDeathtouch) &&
        perm.damageMarked > 0 &&
        !hasKeyword(ctx, perm, 'indestructible')
      ) {
        debug(
          ctx,
          'sba',
          `${perm.name} destroyed (damage ${perm.damageMarked}/${pt.toughness}${perm.damagedByDeathtouch ? ', deathtouch' : ''})`,
        );
        emit(ctx, 'sbaCreatureDies', { name: perm.name, reason: 'lethalDamage' });
        yield* moveObject(ctx, perm, { zone: 'graveyard' });
        return true;
      }
    }

    // Planeswalker with zero loyalty (CR 704.5i). Types are computed, not printed: a
    // permanent animated into (or out of) a planeswalker gets the matching SBA.
    if (chars.types.includes('Planeswalker') && (perm.counters['loyalty'] ?? 0) <= 0) {
      debug(ctx, 'sba', `${perm.name} has 0 loyalty — to graveyard`);
      emit(ctx, 'sbaPlaneswalkerDies', { name: perm.name });
      yield* moveObject(ctx, perm, { zone: 'graveyard' });
      return true;
    }

    // Battle with zero defense (CR 704.5s). Enters with printed defense; when it hits 0
    // its controller puts it into its owner's graveyard.
    if (chars.types.includes('Battle') && (perm.counters['defense'] ?? 0) <= 0) {
      debug(ctx, 'sba', `${perm.name} has 0 defense — to graveyard`);
      emit(ctx, 'sbaBattleDies', { name: perm.name });
      yield* moveObject(ctx, perm, { zone: 'graveyard' });
      return true;
    }

    // Aura attached to nothing/illegally (CR 704.5m). Auras enter Phase 2 only via test
    // fixtures, but the SBA is real.
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
          options: mine.map((t) => ({
            type: 'placeTrigger',
            description: `${t.sourceName}: ${t.ability.description ?? ''}`,
            interaction: { kind: 'order' as const, subjectIds: [t.sourceCardId] },
          })),
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
  return ctx.state.players.find((p) => p.id === id)?.id ?? id;
}

function* pushTriggerOnStack(ctx: GameContext, trigger: PendingTrigger): GameGen<void> {
  const s = ctx.state;
  const specs = trigger.ability.targets;
  const chosen: ObjectId[] = [];
  const countTargets: Record<number, ObjectId[]> = {};
  const divisionAmounts: Record<ObjectId, number> = {};

  // Ordinary (single-target) slots first — unchanged from before count slots existed. By
  // convention every count slot (below) is allocated AFTER all of an ability's ordinary slots,
  // so `chosen` stays a dense array with nothing at a count slot's position.
  const ordinarySlots: { slot: number; options: ObjectId[] }[] = [];
  for (const [i, spec] of specs.entries()) {
    if (spec.count !== undefined) continue;
    const options = computeTargetOptions(ctx, spec, trigger.controllerId);
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
    // One decision carrying every ordinary slot. `isForced` auto-resolves it when each slot has
    // a single candidate, so the common "ETB, destroy the only creature" costs no AI call.
    const outcome = yield {
      decisionType: 'chooseTargets',
      player: trigger.controllerId,
      prompt: `Choose targets for ${trigger.sourceName} — ${trigger.ability.description ?? ''}`,
      options: [
        {
          type: 'chooseTargets',
          description: `Targets for ${trigger.sourceName}`,
          targets: ordinarySlots,
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
    if (spec.count === undefined) continue;
    const count = spec.count;
    const alreadyChosen = new Set<ObjectId>([
      ...Object.values(chosen),
      ...Object.values(countTargets).flat(),
    ]);

    // A `dealDamageDivided` effect over this slot caps the count at the total available — CR
    // 601.2d requires every target to receive at least 1, so choosing more targets than the
    // total supports is not a legal announcement. The total is knowable now: it never depends
    // on which targets get chosen, only on the board.
    const dividedEffect = trigger.ability.effects.find(
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
      const candidates = computeTargetOptions(ctx, spec, trigger.controllerId).filter(
        (id) => !alreadyChosen.has(id) && !picked.includes(id),
      );
      if (candidates.length === 0) break;
      const canStop = picked.length >= count.min;
      const outcome = yield {
        decisionType: 'general',
        player: trigger.controllerId,
        prompt:
          `${trigger.sourceName}: choose ${picked.length > 0 ? 'another' : 'a'} target ` +
          `(${picked.length}/${effectiveMax} chosen)${canStop ? ', or stop choosing' : ''}.`,
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
  const description = trigger.ability.description ?? trigger.sourceName;
  s.stack.push({
    id,
    sourceId: trigger.sourceCardId,
    controllerId: trigger.controllerId,
    kind: 'triggeredAbility',
    description: `${trigger.sourceName} — ${description}`,
    targets: chosen,
    card: null,
    ability: trigger.ability,
    sourceOracleId: trigger.sourceOracleId,
    sourceCardId: trigger.sourceCardId,
    isCommanderCast: false,
    ...(trigger.triggerObjectCardId !== undefined
      ? { triggerObjectCardId: trigger.triggerObjectCardId }
      : {}),
    ...(trigger.scope !== undefined ? { triggerScope: trigger.scope } : {}),
    ...(Object.keys(countTargets).length > 0 ? { countTargets } : {}),
    ...(Object.keys(divisionAmounts).length > 0 ? { divisionAmounts } : {}),
  });
  resetOpponentYields(ctx, trigger.controllerId);
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
