/**
 * The damage replacement/prevention pipeline (CR 614, 615, 616). Every damage event, combat or
 * not, to a player or a permanent, runs through `applyDamageModifiers` before anything is marked,
 * lost or gained, so each effect that modifies damage lives in one place.
 *
 * When two or more effects apply to the same damage and the order changes the outcome, the
 * affected player (the damaged player, or the damaged permanent's controller) chooses which one
 * applies first (CR 616.1, 616.1e); an effect that has applied can't apply again to that event
 * (CR 616.1f), and the rest are re-checked after each one.
 */

import type { Color, ObjectId, PlayerId } from '@mtg/shared';
import type { GameGen } from '../decisions';
import { emit } from '../log/log';
import { cardOption, plainOption, presentedSource } from '../present';
import { createToken, queuePlayerTriggersForEvent } from '../state/objects';
import { gatherRuleStatics, hasProtectionFrom, triggersOf } from '../state/queries';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../state/types';
import { matchesSelector } from './continuous';
import type { EffectSource } from './resolve';
import type { SelectorSource } from '../cards/selector';

/** One source dealing damage to one recipient (CR 120.1), before any modifier applies. */
export interface DamageEvent {
  source: EffectSource;
  recipient:
    | { kind: 'player'; player: EnginePlayerState }
    | { kind: 'permanent'; permanent: EnginePermanent };
  amount: number;
  combat: boolean;
  /** The source's colors, for protection (CR 702.16e). Omitted means protection never applies. */
  sourceColors?: readonly Color[];
}

export type DamageModifier =
  | {
      kind: 'replacement';
      /** Stable for one rule static instance across re-collection during one event. */
      id: string;
      label: string;
      apply(amount: number): number;
    }
  | {
      kind: 'prevention';
      id: string;
      label: string;
      /** The `damagePrevented` log reason. */
      reason: string;
      /** Runs when this prevention is applied, with the amount it prevented (always above 0). */
      onPrevented?: (prevented: number) => void;
      /** It has a follow-up (tokens, a reflection) that depends on the amount it prevents. */
      outcomeBearing: boolean;
    };

export interface DamageResult {
  /** The damage that will actually be dealt after every modifier; 0 when fully prevented. */
  amount: number;
  prevented: { modifierId: string; amount: number }[];
}

/** The player who decides replacement order for damage to this recipient (CR 616.1). */
function affectedPlayerId(event: DamageEvent): PlayerId {
  return event.recipient.kind === 'player'
    ? event.recipient.player.id
    : event.recipient.permanent.controllerId;
}

function recipientName(event: DamageEvent): string {
  return event.recipient.kind === 'player'
    ? event.recipient.player.id
    : event.recipient.permanent.name;
}

/** Every damage modifier that applies to `event` right now. */
export function collectDamageModifiers(ctx: GameContext, event: DamageEvent): DamageModifier[] {
  const modifiers: DamageModifier[] = [];
  const { recipient } = event;
  const targetControllerId = affectedPlayerId(event);

  // The Fog-style combat shield: every combat damage, or combat damage to listed players.
  const shield = ctx.state.combatDamagePrevention;
  if (
    event.combat &&
    (shield.all || (recipient.kind === 'player' && shield.players[recipient.player.id] === true))
  ) {
    const tokenSpec =
      recipient.kind === 'player' ? shield.tokenSpecs?.[recipient.player.id] : undefined;
    modifiers.push({
      kind: 'prevention',
      id: 'combatShield',
      label: 'Prevent all combat damage this turn',
      reason: 'combatShield',
      outcomeBearing: tokenSpec !== undefined,
      ...(tokenSpec !== undefined && recipient.kind === 'player'
        ? {
            onPrevented: (prevented: number) => {
              for (let i = 0; i < prevented; i++) createToken(ctx, tokenSpec, recipient.player.id);
            },
          }
        : {}),
    });
  }

  // "Prevent all damage that would be dealt to you this turn" shields, oldest first.
  if (recipient.kind === 'player') {
    for (const damageShield of ctx.state.damageShields) {
      if (damageShield.playerId !== recipient.player.id) continue;
      if (
        damageShield.sourceObjectId !== undefined &&
        !sourceIsObject(ctx, event.source, damageShield.sourceObjectId)
      )
        continue;
      const owed = damageShield.reflectToSourceController === true;
      modifiers.push({
        kind: 'prevention',
        id: `shield:${damageShield.id}`,
        label: `${damageShield.effectSource.name}: prevent ${damageShield.sourceObjectId === undefined ? 'all' : 'that'} damage to ${recipient.player.id}`,
        reason: 'damageShield',
        // Reflection and one-shot shields have consequences beyond the amount prevented.
        outcomeBearing: owed || damageShield.oneShot === true,
        onPrevented: (prevented) => {
          if (damageShield.oneShot === true)
            ctx.state.damageShields = ctx.state.damageShields.filter(
              (entry) => entry.id !== damageShield.id,
            );
          if (owed)
            ctx.state.damageReflections.push({
              effectSource: damageShield.effectSource,
              toPlayerId: event.source.controllerId,
              amount: prevented,
            });
        },
      });
    }
  }

  const statics = gatherRuleStatics(ctx);
  const sourcePerm = ctx.state.battlefield.find((p) => p.cardId === event.source.cardId);
  const perCard = new Map<string, number>();
  const idFor = (cardId: string, kind: string): string => {
    const key = `${cardId}:${kind}`;
    const n = perCard.get(key) ?? 0;
    perCard.set(key, n + 1);
    return `${key}:${n}`;
  };
  const nameOf = (cardId: string): string =>
    ctx.state.battlefield.find((p) => p.cardId === cardId)?.name ?? cardId;

  // "Prevent all combat damage that would be dealt to this creature" (Guard Gomazoa). The static
  // is only gathered while the permanent still has its abilities.
  for (const entry of statics) {
    if (entry.static.kind !== 'preventCombatDamageToSelf') continue;
    if (!event.combat || recipient.kind !== 'permanent') continue;
    if (entry.sourceCardId !== recipient.permanent.cardId) continue;
    modifiers.push({
      kind: 'prevention',
      id: idFor(entry.sourceCardId, entry.static.kind),
      label: `${nameOf(entry.sourceCardId)}: prevent all combat damage to it`,
      reason: 'preventCombatDamageToSelf',
      outcomeBearing: false,
    });
  }

  // Protection (CR 702.16e): damage from a source of a protected-from color is prevented.
  if (
    recipient.kind === 'permanent' &&
    event.sourceColors !== undefined &&
    hasProtectionFrom(ctx, recipient.permanent, event.sourceColors)
  ) {
    modifiers.push({
      kind: 'prevention',
      id: 'protection',
      label: `${recipient.permanent.name}: protection prevents the damage`,
      reason: 'protection',
      outcomeBearing: false,
    });
  }

  // Each damage replacement static is its own modifier (CR 616.1), keeping the applicability
  // test and rounding each one always had.
  for (const entry of statics) {
    const label = nameOf(entry.sourceCardId);
    if (entry.static.kind === 'damageDoubled') {
      if (sourcePerm === undefined) continue;
      const from: SelectorSource = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
      if (!matchesSelector(ctx, sourcePerm, entry.static.sourceFilter, from)) continue;
      modifiers.push({
        kind: 'replacement',
        id: idFor(entry.sourceCardId, entry.static.kind),
        label: `${label}: it deals double that damage`,
        apply: (amount) => amount * 2,
      });
    } else if (entry.static.kind === 'damageDoubledToOpponents') {
      if (
        targetControllerId !== entry.controllerId &&
        (entry.static.sourceControllerOnly !== true ||
          event.source.controllerId === entry.controllerId)
      ) {
        modifiers.push({
          kind: 'replacement',
          id: idFor(entry.sourceCardId, entry.static.kind),
          label: `${label}: it deals double that damage`,
          apply: (amount) => amount * 2,
        });
      }
    } else if (entry.static.kind === 'damageHalvedToYou') {
      if (targetControllerId === entry.controllerId) {
        modifiers.push({
          kind: 'replacement',
          id: idFor(entry.sourceCardId, entry.static.kind),
          label: `${label}: prevent half of that damage, rounded up`,
          apply: (amount) => Math.floor(amount / 2),
        });
      }
    }
  }
  // A prevention whose amount is observable (a "whenever damage that would be dealt to you is
  // prevented" trigger will count it) is not interchangeable with another that prevents the same
  // damage, so the order between them matters.
  if (
    recipient.kind === 'player' &&
    modifiers.some((modifier) => modifier.kind === 'prevention') &&
    hasPreventionListener(ctx, recipient.player.id)
  ) {
    return modifiers.map((modifier) =>
      modifier.kind === 'prevention' ? { ...modifier, outcomeBearing: true } : modifier,
    );
  }
  return modifiers;
}

/** Is `source` this object: a permanent, or a spell on the stack, by object id (CR 400.7)? */
function sourceIsObject(ctx: GameContext, source: EffectSource, objectId: ObjectId): boolean {
  if (source.resolvingStackObject !== undefined) return source.resolvingStackObject.id === objectId;
  if (source.id !== undefined) return source.id === objectId;
  // Combat and fight damage name the card; the object is the one on the battlefield now.
  return ctx.state.battlefield.some((p) => p.id === objectId && p.cardId === source.cardId);
}

/**
 * "A source of your choice" (CR 609.7a): the controller picks any permanent on the battlefield or
 * spell on the stack. Returns its object id, or null when there is nothing to choose.
 */
export function* chooseDamageSource(
  ctx: GameContext,
  playerId: PlayerId,
  effectSource: EffectSource,
): GameGen<ObjectId | null> {
  const candidates: { id: ObjectId; option: ReturnType<typeof cardOption> }[] = [];
  for (const perm of ctx.state.battlefield)
    candidates.push({
      id: perm.id,
      option: cardOption(ctx, perm, {
        type: 'damageSource',
        description: perm.name,
        verb: 'Choose',
        role: 'select',
      }),
    });
  for (const entry of ctx.state.stack)
    if (entry.kind === 'spell' && entry.card !== null)
      candidates.push({
        id: entry.id,
        option: cardOption(ctx, entry.card, {
          type: 'damageSource',
          description: `${entry.card.name} (spell)`,
          verb: 'Choose',
          role: 'select',
        }),
      });
  if (candidates.length === 0) return null;
  const outcome = yield {
    decisionType: 'general',
    player: playerId,
    prompt: `${effectSource.name}: choose a source of damage`,
    presentationSource: presentedSource(ctx, effectSource),
    options: candidates.map((candidate) => candidate.option),
  };
  return candidates[outcome.index]?.id ?? null;
}

/** Does a permanent watch "damage that would be dealt to" `playerId` "is prevented"? */
function hasPreventionListener(ctx: GameContext, playerId: PlayerId): boolean {
  return ctx.state.battlefield.some((perm) =>
    triggersOf(ctx, perm).some(
      (ability) =>
        ability.trigger?.when === 'damagePreventedToPlayer' &&
        (ability.trigger.player === 'each' || perm.controllerId === playerId),
    ),
  );
}

/**
 * What the event comes to if `first` applies first and the rest follow in list order: the final
 * amount, plus the amount each outcome-bearing prevention prevents. Pure — no state writes.
 */
function signature(amount: number, order: readonly DamageModifier[]): string {
  const preventions: [string, number][] = [];
  for (const modifier of order) {
    if (amount <= 0) break;
    if (modifier.kind === 'replacement') amount = modifier.apply(amount);
    else {
      if (modifier.outcomeBearing) preventions.push([modifier.id, amount]);
      amount = 0;
    }
  }
  return JSON.stringify([amount, preventions]);
}

/** True when applying the candidates in a different order changes what happens. */
function choiceMatters(amount: number, candidates: readonly DamageModifier[]): boolean {
  const signatures = new Set(
    candidates.map((first) =>
      signature(amount, [first, ...candidates.filter((other) => other !== first)]),
    ),
  );
  return signatures.size > 1;
}

/**
 * Apply every modifier to one damage event (CR 616.1). Every prevention in this pool prevents all
 * of the damage it applies to.
 */
export function* applyDamageModifiers(ctx: GameContext, event: DamageEvent): GameGen<DamageResult> {
  let amount = event.amount;
  const applied = new Set<string>();
  const prevented: DamageResult['prevented'] = [];
  while (amount > 0) {
    const pending = collectDamageModifiers(ctx, event).filter((m) => !applied.has(m.id));
    if (pending.length === 0) break;
    let next = pending[0]!;
    if (pending.length > 1 && choiceMatters(amount, pending)) {
      const outcome = yield {
        decisionType: 'general',
        player: affectedPlayerId(event),
        prompt: `Choose which effect applies first to ${amount} damage from ${event.source.name} to ${recipientName(event)}`,
        presentationSource: presentedSource(ctx, event.source),
        options: pending.map((modifier) =>
          plainOption({
            type: 'damageModifier',
            description: modifier.label,
            verb: 'Apply first',
          }),
        ),
      };
      next = pending[outcome.index] ?? next;
    }
    applied.add(next.id);
    if (next.kind === 'replacement') {
      amount = next.apply(amount);
      continue;
    }
    emit(ctx, 'damagePrevented', {
      source: event.source.name,
      target:
        event.recipient.kind === 'player'
          ? event.recipient.player.id
          : event.recipient.permanent.name,
      ...(event.recipient.kind === 'permanent'
        ? { targetCardId: event.recipient.permanent.cardId }
        : {}),
      amount,
      reason: next.reason,
    });
    prevented.push({ modifierId: next.id, amount });
    next.onPrevented?.(amount);
    // One "damage that would be dealt to you is prevented" event per prevention applied to one
    // source's damage to the player, carrying the amount it prevented.
    if (event.recipient.kind === 'player')
      queuePlayerTriggersForEvent(
        ctx,
        'damagePreventedToPlayer',
        event.recipient.player.id,
        amount,
      );
    amount = 0;
  }
  return { amount, prevented };
}
