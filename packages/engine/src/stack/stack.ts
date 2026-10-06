/**
 * Stack resolution (CR 608, brief §5.5). LIFO: the top (last-pushed) object resolves once
 * all players pass in succession. Target legality is rechecked on resolution; a spell or
 * ability whose targets are ALL illegal doesn't resolve — it fizzles (CR 608.2b).
 */

import type { GameGen } from '../decisions';
import { evaluateCondition } from '../cards/condition';
import { isPermanentCard } from '../cards/definition';
import { executeAbility, isTargetStillLegal } from '../effects/resolve';
import { emit, debug } from '../log/log';
import { moveObject } from '../state/objects';
import { getDefByOracleId, sourceColorsOf } from '../state/queries';
import type { EngineStackObject, GameContext } from '../state/types';

/** Resolve the top object of the stack. Caller guarantees the stack is nonempty. */
export function* resolveTopOfStack(ctx: GameContext): GameGen<void> {
  const s = ctx.state;
  const top = s.stack.pop();
  if (top === undefined) throw new Error('engine bug: resolveTopOfStack on empty stack');

  debug(ctx, 'stack', `resolving: ${top.description}`, { targets: top.targets });

  // Intervening-if, second check (CR 603.4): the condition is checked again on resolution, and
  // a trigger whose condition has since become false is simply removed. Checked before the
  // "you may" prompt, because an ability that does nothing should not be offered.
  const intervening = top.ability?.trigger?.condition;
  if (
    intervening !== undefined &&
    !evaluateCondition(ctx, intervening, {
      cardId: top.sourceCardId,
      controllerId: top.controllerId,
      ...(top.triggerScope?.eventPlayerId === undefined
        ? {}
        : { eventPlayerId: top.triggerScope.eventPlayerId }),
    })
  ) {
    emit(ctx, 'triggerConditionFailed', { description: top.description }, top.controllerId);
    debug(ctx, 'stack', `${top.description} removed — intervening-if false on resolution`);
    return;
  }

  // Optional ("you may") triggered ability: the yes/no choice is made on resolution.
  if (top.kind === 'triggeredAbility' && top.ability?.optional === true) {
    const outcome = yield {
      decisionType: 'optionalTrigger',
      player: top.controllerId,
      prompt: `${top.description} — use this ability?`,
      options: [
        { type: 'acceptTrigger', description: 'Yes' },
        { type: 'declineTrigger', description: 'No' },
      ],
    };
    if (outcome.index === 1) {
      emit(ctx, 'triggerDeclined', { description: top.description }, top.controllerId);
      return;
    }
  }

  // Fizzle check (CR 608.2b): if the object HAD targets and every one is now illegal, it
  // doesn't resolve. Spell cards go to the graveyard. A variable-count slot chosen at zero
  // (Ureni with no opponent creatures) contributes no targets and so cannot itself fizzle
  // anything — `anyChosen` tracks whether there was ever a target to check at all. Targets are
  // indexed by slot, so an unchosen mode's slot is empty: a hole, or an explicit `undefined` once
  // a copy has spread the array (`copyTargetSpell`). Neither is a target, so neither can make an
  // otherwise targetless mode fizzle.
  const specs = top.ability?.targets ?? [];
  // Protection gained in response makes a target illegal too (CR 702.16b, 608.2b).
  const sourceColors = sourceColorsOf(ctx, top.sourceCardId, top.sourceOracleId, top.sourceColors);
  let anyChosen = false;
  let anyLegal = false;
  top.targets.forEach((t, i) => {
    if (t === undefined) return;
    anyChosen = true;
    const kind = specs[i]?.kind;
    if (
      kind !== undefined &&
      isTargetStillLegal(
        ctx,
        t,
        specs[i] ?? kind,
        top.controllerId,
        sourceColors,
        top.triggerScope?.eventPlayerId,
        top.sourceCardId,
      )
    )
      anyLegal = true;
  });
  for (const [slotKey, ids] of Object.entries(top.countTargets ?? {})) {
    const spec = specs[Number(slotKey)];
    for (const id of ids) {
      anyChosen = true;
      if (
        spec !== undefined &&
        isTargetStillLegal(
          ctx,
          id,
          spec,
          top.controllerId,
          sourceColors,
          top.triggerScope?.eventPlayerId,
          top.sourceCardId,
        )
      )
        anyLegal = true;
    }
  }
  if (anyChosen && !anyLegal) {
    emit(ctx, 'fizzle', { description: top.description }, top.controllerId);
    debug(ctx, 'stack', `${top.description} fizzles — all targets illegal`);
    if (top.card !== null) {
      yield* moveObject(ctx, top.card, {
        zone: top.exileOnResolution === true ? 'exile' : 'graveyard',
      });
    }
    return;
  }

  if (top.ability !== null) {
    yield* executeAbility(
      ctx,
      {
        cardId: top.sourceCardId,
        name: top.card?.name ?? top.description,
        oracleId: top.sourceOracleId,
        controllerId: top.controllerId,
        ...(top.kind === 'spell' ? { resolvingStackObject: top } : {}),
        ...(top.sourceColors !== undefined ? { lastKnownColors: top.sourceColors } : {}),
        ...(top.sourceObjectId !== undefined ? { objectId: top.sourceObjectId } : {}),
      },
      top.ability,
      top.targets,
      top.triggerObjectCardId,
      {
        ...top.triggerScope,
        ...(top.announcedX === undefined ? {} : { x: top.announcedX }),
      },
      top.countTargets,
      top.divisionAmounts,
    );
  }

  // Destination (CR 608.3): permanent spells enter the battlefield under their caster;
  // instants/sorceries go to their owner's graveyard.
  if (top.kind === 'spell' && top.card !== null) {
    yield* finishSpellCard(ctx, top);
  }
  emit(ctx, 'resolved', { description: top.description }, top.controllerId);
}

export function* finishSpellCard(ctx: GameContext, spell: EngineStackObject): GameGen<void> {
  const card = spell.card;
  if (card === null) return;
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  if (spell.alternativeCastKind === 'adventure') {
    // `moveObject` returns a NEW object for the destination zone — `card` is stale afterward,
    // so the flag has to land on `moved`, not the pre-move reference.
    const moved = yield* moveObject(ctx, card, { zone: 'exile' });
    if (moved !== null && moved.zone !== 'battlefield') moved.onAdventure = true;
    return;
  }
  if (spell.alternativeCastKind === 'omen') {
    yield* moveObject(ctx, card, { zone: 'library', libraryPosition: 'bottom' });
    const player = ctx.state.players.find((p) => p.id === card.ownerId);
    if (player) ctx.rng.shuffle(player.library);
    return;
  }
  // Permanent spells (creatures, artifacts, enchantments, planeswalkers, battles) enter
  // the battlefield under their caster; instants/sorceries head to the graveyard (CR 608.3).
  if (isPermanentCard(def)) {
    const moved = yield* moveObject(ctx, card, {
      zone: 'battlefield',
      controllerId: spell.controllerId,
    });
    if (spell.grantHasteOnResolution && moved && moved.zone === 'battlefield') {
      ctx.state.effects.push({
        id: `eff-${ctx.state.nextObjectNum++}`,
        sourceId: spell.sourceCardId,
        description: `${moved.name} gains haste until end of turn`,
        targetCardIds: [moved.cardId],
        kind: 'grantKeyword',
        keyword: 'haste',
        timestamp: ctx.state.nextTimestamp++,
      });
    }
  } else if (spell.exileOnResolution) {
    yield* moveObject(ctx, card, { zone: 'exile' });
  } else if (spell.reboundPending) {
    const moved = yield* moveObject(ctx, card, { zone: 'exile' });
    if (moved !== null && moved.zone === 'exile') {
      moved.reboundCastBy = spell.controllerId;
      ctx.state.delayedTriggers.push({
        id: 'dt-' + ctx.state.nextObjectNum++,
        sourceCardId: moved.cardId,
        sourceOracleId: moved.oracleId,
        controllerId: spell.controllerId,
        when: 'upkeep',
        // CR 702.88a: "at the beginning of YOUR NEXT upkeep" — a later turn, so this must
        // survive every intervening cleanup, and must not fire on another player's upkeep.
        expiry: 'onFire',
        player: 'you',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'reboundCastFromExile' }],
          description: moved.name + ': Rebound',
        },
      });
    }
  } else {
    yield* moveObject(ctx, card, { zone: 'graveyard' });
  }
}
