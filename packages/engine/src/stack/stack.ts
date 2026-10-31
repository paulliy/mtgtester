/**
 * Stack resolution (CR 608, brief §5.5). LIFO: the top (last-pushed) object resolves once
 * all players pass in succession. Target legality is rechecked on resolution; a spell or
 * ability whose targets are ALL illegal doesn't resolve — it fizzles (CR 608.2b).
 */

import type { GameGen } from '../decisions';
import { evaluateCondition } from '../cards/condition';
import { isPermanentCard } from '../cards/definition';
import { executeAbility, drawCards } from '../effects/resolve';
import { TREASURE } from '../cards/tokens';
import { captureResolutionTargets } from '../targets/resolution';
import { emit, debug } from '../log/log';
import { makePermanent, moveObject, queueTriggersForObject, createTokens } from '../state/objects';
import { roomDoorOf } from '../cards/spell-faces';
import { spellDefinitionOf, stackSourceTraits } from '../state/queries';
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
  // A mode chosen as the permanent entered (Frontier Siege's Khans or Dragons) is not an
  // intervening-if: it decides which ability the permanent has, so it is checked when the ability
  // triggers and the ability resolves even if the permanent has left by then (CR 113.7a).
  const condition = top.ability?.trigger?.condition;
  const intervening = condition?.kind === 'chosenOptionIs' ? undefined : condition;
  if (
    intervening !== undefined &&
    !evaluateCondition(ctx, intervening, {
      ...top.triggerScope,
      cardId: top.sourceCardId,
      objectId: top.sourceId,
      controllerId: top.controllerId,
      ...(top.sourceFacts === undefined ? {} : { sourceFacts: top.sourceFacts }),
      ...(top.triggerObjectCardId === undefined
        ? {}
        : { triggerObjectCardId: top.triggerObjectCardId }),
      ...(top.triggerScope?.eventPlayerId === undefined
        ? {}
        : { eventPlayerId: top.triggerScope.eventPlayerId }),
    })
  ) {
    emit(ctx, 'triggerConditionFailed', { description: top.description }, top.controllerId);
    debug(ctx, 'stack', `${top.description} removed — intervening-if false on resolution`);
    return;
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
  const sourceTraits = stackSourceTraits(ctx, top);
  const resolutionTargets = captureResolutionTargets(
    ctx,
    specs,
    top.targets,
    top.countTargets ?? {},
    {
      controllerId: top.controllerId,
      sourceCardId: top.sourceCardId,
      sourceTraits,
      sourceKind: top.kind === 'spell' ? 'spell' : 'ability',
      ...(top.sourceFacts === undefined ? {} : { sourceFacts: top.sourceFacts }),
      ...(top.triggerScope?.eventPlayerId === undefined
        ? {}
        : { eventPlayerId: top.triggerScope.eventPlayerId }),
    },
  );
  const { anyChosen, anyLegal } = resolutionTargets;
  // CR 702.103e, 608.3b: a bestowed Aura spell whose target is illegal ceases to be bestowed and
  // resolves as the creature spell it is printed as, instead of being removed.
  if (anyChosen && !anyLegal && top.kind === 'spell' && top.alternativeCastKind === 'bestow') {
    delete top.alternativeCastKind;
    delete top.spellDefinition;
    top.targets = [];
    emit(ctx, 'bestowTargetIllegal', { description: top.description }, top.controllerId);
  } else if (anyChosen && !anyLegal) {
    emit(ctx, 'fizzle', { description: top.description }, top.controllerId);
    debug(ctx, 'stack', `${top.description} fizzles — all targets illegal`);
    if (top.card !== null) {
      yield* moveObject(ctx, top.card, {
        zone: top.exileOnResolution === true ? 'exile' : 'graveyard',
      });
    }
    return;
  }

  // Optional ("you may") triggered ability: the yes/no choice is made on resolution, after the
  // fizzle check — an ability whose targets are all illegal is removed without anyone choosing
  // anything (CR 608.2b).
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

  if (top.kind === 'spell' && top.giftRecipientId !== undefined) {
    const gift = spellDefinitionOf(ctx, top).gift;
    const recipient = s.players.find(
      (player) => player.id === top.giftRecipientId && !player.hasLost,
    );
    if (recipient !== undefined) {
      if (gift === 'treasure') createTokens(ctx, TREASURE, 1, recipient.id);
      else if (gift === 'card') yield* drawCards(ctx, recipient, 1);
      else if (gift === 'extraTurn') (s.extraTurns ??= []).unshift(recipient.id);
      else throw new Error('gift promise has no supported gift');
      emit(ctx, 'giftFulfilled', { recipient: recipient.id, gift }, top.controllerId);
    }
  }
  if (top.ability !== null) {
    yield* executeAbility(
      ctx,
      {
        id: top.sourceId,
        cardId: top.sourceCardId,
        name: top.card?.name ?? top.description,
        oracleId: top.sourceOracleId,
        controllerId: top.controllerId,
        resolutionTargets,
        ...(top.sourceFacts === undefined ? {} : { lastKnownFacts: top.sourceFacts }),
        ...(top.sourceTransformations === undefined
          ? {}
          : { transformationsAtStack: top.sourceTransformations }),
        ...(top.kind === 'spell' ? { resolvingStackObject: top } : {}),
        ...(top.sourceColors !== undefined ? { lastKnownColors: top.sourceColors } : {}),
        ...(top.kind === 'spell' ? { lastKnownTypes: stackSourceTraits(ctx, top).types } : {}),
        ...(top.sourceDamageKeywords !== undefined
          ? { lastKnownDamageKeywords: top.sourceDamageKeywords }
          : {}),
      },
      top.ability,
      top.targets,
      top.triggerObjectCardId,
      {
        ...top.triggerScope,
        giftPromised: top.giftRecipientId !== undefined,
        ...(top.announcedX === undefined ? {} : { x: top.announcedX }),
      },
      top.countTargets,
      top.divisionAmounts,
    );
  }

  if (top.kind === 'spell') {
    const player = s.players.find((player) => player.id === top.controllerId);
    if (player !== undefined)
      (player.resolvedSpellNames ??= []).push(spellDefinitionOf(ctx, top).name);
  }

  // Destination (CR 608.3): permanent spells enter the battlefield under their caster;
  // instants/sorceries go to their owner's graveyard.
  if (top.kind === 'spell' && top.card !== null) {
    yield* finishSpellCard(ctx, top);
  } else if (top.kind === 'spell' && top.permanentSpellCopy !== undefined) {
    putPermanentSpellCopyOntoBattlefield(ctx, top);
  }
  emit(ctx, 'resolved', { description: top.description }, top.controllerId);
}

export function* finishSpellCard(ctx: GameContext, spell: EngineStackObject): GameGen<void> {
  const card = spell.card;
  if (card === null) return;
  const def = spellDefinitionOf(ctx, spell);
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
    const bestowed = spell.alternativeCastKind === 'bestow';
    const printed = ctx.defs.get(card.oracleId);
    const unlockedDoor =
      printed === undefined || spell.alternativeCastKind !== 'split' || spell.altIndex === undefined
        ? undefined
        : roomDoorOf(printed, printed.alternativeCasts?.[spell.altIndex]);
    const moved = yield* moveObject(ctx, card, {
      zone: 'battlefield',
      controllerId: spell.controllerId,
      ...(spell.alternativeCastKind === 'mdfc' ? { face: 'back' as const } : {}),
      // A Room spell cast as one door enters with that door unlocked (CR 709.5d).
      ...(unlockedDoor === undefined ? {} : { unlockedDoor }),
      ...(def.subtypes.includes('Aura') || bestowed ? { attachedTo: spell.targets[0] } : {}),
      // A bestowed Aura spell becomes a bestowed Aura (CR 702.103b).
      ...(bestowed ? { bestowed: true } : {}),
      // A face-down spell becomes a face-down permanent (CR 708.4).
      ...(spell.alternativeCastKind === 'faceDown' ? { faceDown: true } : {}),
    });
    if (card.isCardCopy === true && moved?.zone === 'battlefield') {
      moved.isToken = true;
      delete moved.isCardCopy;
    }
    // Dash (CR 702.109a): haste for as long as this object stays, and back to its owner's hand at
    // the beginning of the next end step, whoever's turn that is. A new object (CR 400.7) after
    // a flicker is neither hasty nor returned.
    if (spell.dashed === true && moved !== null && moved.zone === 'battlefield') {
      ctx.state.effects.push({
        id: `eff-${ctx.state.nextObjectNum++}`,
        sourceId: spell.sourceCardId,
        description: `${moved.name} was dashed: it has haste`,
        targetCardIds: [moved.cardId],
        targetObjectIds: [moved.id],
        kind: 'grantKeyword',
        keyword: 'haste',
        duration: 'permanent',
        timestamp: ctx.state.nextTimestamp++,
      });
      ctx.state.delayedTriggers.push({
        id: `dt-${ctx.state.nextObjectNum++}`,
        sourceCardId: moved.cardId,
        sourceOracleId: moved.oracleId,
        controllerId: spell.controllerId,
        targetId: moved.cardId,
        targetObjectId: moved.id,
        when: 'endStep',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'returnToHand', target: 'triggerObject' }],
          description: `Dash: return ${moved.name} to its owner's hand`,
        },
        expiry: 'onFire',
      });
    }
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

/**
 * A copy of a permanent spell becomes a token as it resolves (CR 608.3f, 707.10f) — not
 * "created", so no token-creation trigger or replacement applies. An Aura copy enters attached
 * to its target (CR 303.4f), as the spell it copies would.
 */
function putPermanentSpellCopyOntoBattlefield(ctx: GameContext, spell: EngineStackObject): void {
  const selected = spellDefinitionOf(ctx, spell);
  // A token copying a spell has the chosen spell's characteristics, with no unchosen faces.
  const copyOracleId = `spell-copy:${spell.id}`;
  const { alternativeCasts: _alternatives, backFace: _back, ...singleFace } = selected;
  const def = { ...singleFace, oracleId: copyOracleId };
  ctx.defs.set(copyOracleId, def);
  const perm = makePermanent(
    ctx,
    {
      id: `o-${ctx.state.nextObjectNum++}`,
      cardId: spell.sourceCardId,
      oracleId: copyOracleId,
      ownerId: spell.controllerId,
      name: def.name,
      typeLine: def.typeLine,
      oracleText: spell.permanentSpellCopy?.oracleText ?? '',
      manaCost: spell.permanentSpellCopy?.manaCost ?? null,
      isToken: true,
      isCommander: false,
      zone: 'battlefield',
    },
    spell.controllerId,
  );
  if (def.subtypes.includes('Aura')) perm.attachedTo = spell.targets[0] ?? null;
  // A copy of a bestowed Aura spell is one too (CR 702.103c), and becomes a bestowed Aura.
  if (spell.alternativeCastKind === 'bestow') {
    perm.attachedTo = spell.targets[0] ?? null;
    perm.bestowed = true;
  }
  // zone-mutation: a resolving copy of a permanent spell becomes a token (CR 608.3f), created like createToken: makePermanent applies its entry replacements
  ctx.state.battlefield.push(perm);
  emit(
    ctx,
    'permanentSpellCopyResolved',
    { name: def.name, cardId: perm.cardId },
    spell.controllerId,
  );
  queueTriggersForObject(ctx, 'enters', perm);
}
