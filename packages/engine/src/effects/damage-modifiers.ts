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
import { playerLifeLocked } from '../state/phasing';
import { gatherRuleStatics, hasProtectionFrom, triggersOf } from '../state/queries';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../state/types';
import { computeCharacteristics, matchesSelector } from './continuous';
import type { EffectSource } from './resolve';
import type { SelectorSource } from '../cards/selector';
import { GameOverSignal } from '../signals';

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
      /** How much of `amount` it prevents; omitted means all of it ("prevent half", Gisela). */
      prevents?: (amount: number) => number;
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

  // Protection from everything (Teferi's Protection): all damage to the player is prevented,
  // combat or not, while the player's shield lasts.
  if (recipient.kind === 'player' && playerLifeLocked(ctx, recipient.player.id)) {
    modifiers.push({
      kind: 'prevention',
      id: 'protectionFromEverything',
      label: 'Protection from everything: prevent the damage',
      reason: 'protectionFromEverything',
      outcomeBearing: false,
    });
  }

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
      label:
        tokenSpec === undefined
          ? 'Prevent all combat damage this turn'
          : 'Prevent all combat damage this turn, creating a token for each 1 damage prevented',
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

  // "Prevent all damage that would be dealt to you ..." shields, oldest first. What each covers is
  // checked as the damage would be dealt: its player, or a planeswalker that player controls now.
  for (const damageShield of ctx.state.damageShields) {
    if (damageShield.combatOnly === true && !event.combat) continue;
    const shielded = damageShield.object;
    const covered =
      shielded !== undefined
        ? (shielded.dealtTo &&
            recipient.kind === 'permanent' &&
            recipient.permanent.id === shielded.id) ||
          (shielded.dealtBy && sourceIsObject(ctx, event.source, shielded.id))
        : recipient.kind === 'player'
          ? damageShield.playerId === recipient.player.id
          : damageShield.andPlaneswalkersTheyControl === true &&
            recipient.permanent.controllerId === damageShield.playerId &&
            computeCharacteristics(ctx, recipient.permanent).types.includes('Planeswalker');
    if (!covered) continue;
    if (
      damageShield.sourceObjectId !== undefined &&
      !sourceIsObject(ctx, event.source, damageShield.sourceObjectId)
    )
      continue;
    if (
      damageShield.sourceNotControlledBy !== undefined &&
      event.source.controllerId === damageShield.sourceNotControlledBy
    )
      continue;
    modifiers.push({
      kind: 'prevention',
      id: `shield:${damageShield.id}`,
      label: `${damageShield.effectSource.name}: prevent ${damageShield.sourceObjectId === undefined ? 'the' : 'that'} damage to ${recipientName(event)}`,
      reason: 'damageShield',
      // Reflection and one-shot shields have consequences beyond the amount prevented.
      outcomeBearing: damageShield.reflect !== undefined || damageShield.oneShot === true,
      onPrevented: (prevented) => {
        if (damageShield.oneShot === true)
          ctx.state.damageShields = ctx.state.damageShields.filter(
            (entry) => entry.id !== damageShield.id,
          );
        if (damageShield.reflect === undefined) return;
        const toId = reflectionTarget(ctx, event.source, damageShield.reflect);
        if (toId === null) return;
        // The same shield preventing the same amount to the same recipient again, with no choice
        // anywhere in between, repeats forever: a mandatory loop, so the game is a draw (CR 104.4b).
        const step = `${damageShield.id}>${recipientKey(event)}>${prevented}`;
        if (ctx.state.damageChain.includes(step))
          throw new GameOverSignal(
            null,
            `unbreakable mandatory damage-prevention loop (draw, CR 104.4b): ${damageShield.effectSource.name}`,
          );
        ctx.state.damageReflections.push({
          effectSource: damageShield.effectSource,
          toId,
          amount: prevented,
          chain: [...ctx.state.damageChain, step],
        });
      },
    });
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
        // Gisela's "prevent half that damage, rounded up" is a prevention (CR 615), so it is
        // seen by "whenever damage that would be dealt to you is prevented" (Selfless Squire).
        modifiers.push({
          kind: 'prevention',
          id: idFor(entry.sourceCardId, entry.static.kind),
          label: `${label}: prevent half of that damage, rounded up`,
          reason: entry.static.kind,
          prevents: (amount) => Math.ceil(amount / 2),
          outcomeBearing: false,
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

function recipientKey(event: DamageEvent): string {
  return event.recipient.kind === 'player'
    ? event.recipient.player.id
    : event.recipient.permanent.id;
}

/**
 * Who a reflecting shield's effect deals the prevented damage to: the source's controller, or for
 * a creature source (as it is on the battlefield, else as last known) the creature itself, which
 * is only dealt damage if it is still that object on the battlefield. A creature that is already
 * gone has nothing to deal damage to, and its controller is not a substitute.
 */
function reflectionTarget(
  ctx: GameContext,
  source: EffectSource,
  mode: 'toSourceController' | 'toSourceCreatureElseController',
): string | null {
  if (mode === 'toSourceController') return source.controllerId;
  const permanent = ctx.state.battlefield.find((p) =>
    source.id !== undefined ? p.id === source.id : p.cardId === source.cardId,
  );
  const isCreature =
    permanent !== undefined
      ? computeCharacteristics(ctx, permanent).types.includes('Creature')
      : (source.lastKnownFacts?.candidate.types.includes('Creature') ?? false);
  if (!isCreature) return source.controllerId;
  return permanent?.id ?? null;
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
        viewerId: playerId,
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
          viewerId: playerId,
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
      const prevented = preventedBy(modifier, amount);
      if (modifier.outcomeBearing) preventions.push([modifier.id, prevented]);
      amount -= prevented;
    }
  }
  return JSON.stringify([amount, preventions]);
}

/** The part of `amount` a prevention prevents: all of it unless it prevents only some. */
function preventedBy(modifier: Extract<DamageModifier, { kind: 'prevention' }>, amount: number) {
  return modifier.prevents === undefined ? amount : Math.min(amount, modifier.prevents(amount));
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
 * Apply every modifier to one damage event (CR 616.1). A prevention prevents all of the damage it
 * applies to unless it says how much (`prevents`); the rest stays in the event.
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
    const preventedAmount = preventedBy(next, amount);
    if (preventedAmount <= 0) continue;
    emit(ctx, 'damagePrevented', {
      source: event.source.name,
      target:
        event.recipient.kind === 'player'
          ? event.recipient.player.id
          : event.recipient.permanent.name,
      ...(event.recipient.kind === 'permanent'
        ? { targetCardId: event.recipient.permanent.cardId }
        : {}),
      amount: preventedAmount,
      reason: next.reason,
    });
    prevented.push({ modifierId: next.id, amount: preventedAmount });
    next.onPrevented?.(preventedAmount);
    // One "damage that would be dealt to you is prevented" event per prevention applied to one
    // source's damage to the player, carrying the amount it prevented.
    if (event.recipient.kind === 'player')
      queuePlayerTriggersForEvent(
        ctx,
        'damagePreventedToPlayer',
        event.recipient.player.id,
        preventedAmount,
      );
    amount -= preventedAmount;
  }
  return { amount, prevented };
}
