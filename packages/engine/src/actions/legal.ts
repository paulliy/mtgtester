/**
 * Legal-action generation (brief §1.2 — the engine computes EVERY legal option; the AI
 * only picks). This is the completeness-critical module: an option omitted here can never
 * be taken, and an option offered here must be applicable without further legality checks.
 *
 * Unmodeled cards: the moment an unmodeled card is in a player's hand (or command zone)
 * at one of their decision points, the engine cannot know that card's legality, so it
 * halts loudly (brief §6.3) rather than silently excluding it.
 */

import type { ObjectId, PlayerId } from '@mtg/shared';
import type { CardDefinition } from '../cards/definition';
import { effectTargetKind } from '../cards/definition';
import type { EngineActionOption } from '../decisions';
import { addGeneric, canPay, emptyCost } from '../mana/cost';
import type { ParsedManaCost } from '../mana/cost';
import {
  findPermanent,
  getDefByOracleId,
  hasKeyword,
  isCreaturePermanent,
  manaSourcesFor,
  playersInApnapOrder,
  requireModeled,
} from '../state/queries';
import type { EngineCardObject, EnginePlayerState, GameContext } from '../state/types';

/** Payloads attached to priority-window options, interpreted by `applyPriorityAction`. */
export type PriorityActionPayload =
  | { kind: 'pass' }
  | { kind: 'playLand'; objectId: ObjectId }
  | { kind: 'castSpell'; objectId: ObjectId; fromCommand: boolean }
  | { kind: 'companionToHand' };

const COMPANION_COST: ParsedManaCost = { ...emptyCost(), generic: 3 };

/** Legal target object-ids (or player ids) for one target kind, from `caster`'s seat. */
export function computeTargetOptions(
  ctx: GameContext,
  kind: 'creature' | 'anyTarget' | 'spell',
  casterId: PlayerId,
): ObjectId[] {
  if (kind === 'spell') {
    return ctx.state.stack.filter((s) => s.kind === 'spell').map((s) => s.id);
  }
  const creatures = ctx.state.battlefield
    .filter((p) => isCreaturePermanent(ctx, p))
    // Hexproof: can't be the target of spells/abilities OPPONENTS control (CR 702.11).
    .filter((p) => p.controllerId === casterId || !hasKeyword(ctx, p, 'hexproof'))
    .map((p) => p.id);
  if (kind === 'creature') return creatures;
  const players = playersInApnapOrder(ctx).map((p) => p.id);
  return [...creatures, ...players];
}

/** Target slots for casting a card, or null when a required slot has zero options. */
function computeCastTargets(
  ctx: GameContext,
  def: CardDefinition,
  casterId: PlayerId,
): { slot: number; options: ObjectId[] }[] | null {
  const slots: { slot: number; options: ObjectId[] }[] = [];
  let slotNum = 0;
  for (const effect of def.spellEffects) {
    const kind = effectTargetKind(effect);
    if (kind === null) continue;
    const options = computeTargetOptions(ctx, kind, casterId);
    if (options.length === 0) return null; // can't cast without a legal target (CR 601.2c)
    slots.push({ slot: slotNum++, options });
  }
  return slots;
}

function describeCost(def: CardDefinition, tax: number): string {
  const base = def.manaCost;
  if (base === null) return '';
  const parts: string[] = [];
  const generic = base.generic + tax;
  if (generic > 0) parts.push(`{${generic}}`);
  for (const c of ['W', 'U', 'B', 'R', 'G'] as const) {
    parts.push(`{${c}}`.repeat(base.colored[c]));
  }
  parts.push('{C}'.repeat(base.colorless));
  return parts.join('');
}

/**
 * All legal actions for `player` at a priority window (brief §5.4). Pass is always legal
 * and always option 0 — auto-pass when it is the only option (brief §7.4).
 */
export function computePriorityOptions(
  ctx: GameContext,
  player: EnginePlayerState,
): EngineActionOption[] {
  const s = ctx.state;
  const options: EngineActionOption[] = [
    { type: 'pass', description: 'Pass priority', payload: { kind: 'pass' } },
  ];

  const isActive = s.turnOrder[s.activePlayerIndex] === player.id;
  const sorcerySpeed =
    isActive &&
    s.stack.length === 0 &&
    (s.phase === 'precombatMain' || s.phase === 'postcombatMain');

  const sources = manaSourcesFor(ctx, player.id);
  const seen = new Set<string>();

  const considerCast = (obj: EngineCardObject, fromCommand: boolean): void => {
    const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
    requireModeled(def, fromCommand ? 'in the command zone' : 'in hand');

    if (def.types.includes('Land')) {
      // Lands are played, not cast — one per turn, main phase, empty stack (CR 305).
      if (sorcerySpeed && player.landsPlayedThisTurn < 1) {
        const key = `playLand:${obj.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          options.push({
            type: 'playLand',
            description: `Play ${obj.name}`,
            payload: { kind: 'playLand', objectId: obj.id },
          });
        }
      }
      return;
    }

    if (def.manaCost === null) return; // cost-less nonland card: not castable
    const instantSpeed = def.types.includes('Instant') || def.keywords.includes('flash');
    if (!instantSpeed && !sorcerySpeed) return;

    const tax = fromCommand ? 2 * (player.commanderCastCount[obj.cardId] ?? 0) : 0;
    const cost = addGeneric(def.manaCost, tax);
    if (!canPay(cost, player.manaPool, sources)) return;

    const targets = computeCastTargets(ctx, def, player.id);
    if (targets === null) return;

    const key = `cast:${obj.name}:${fromCommand}`;
    if (seen.has(key)) return; // duplicate copies are interchangeable
    seen.add(key);
    const option: EngineActionOption = {
      type: 'castSpell',
      description:
        `Cast ${obj.name} (${describeCost(def, tax)})` +
        (fromCommand ? ` from the command zone${tax > 0 ? `, commander tax {${tax}}` : ''}` : ''),
      payload: { kind: 'castSpell', objectId: obj.id, fromCommand },
    };
    if (targets.length > 0) option.targets = targets;
    options.push(option);
  };

  for (const obj of player.hand) considerCast(obj, false);
  for (const obj of player.commandZone) considerCast(obj, true);

  // Companion: pay {3} at sorcery speed to move it to hand, once per game (brief §5.7).
  if (
    sorcerySpeed &&
    player.companion !== null &&
    !player.companionMovedToHand &&
    canPay(COMPANION_COST, player.manaPool, sources)
  ) {
    options.push({
      type: 'companionToHand',
      description: `Pay {3}: put your companion ${player.companion.name} into your hand`,
      payload: { kind: 'companionToHand' },
    });
  }

  return options;
}

/** Re-validate a chosen target set at cast time (defensive; options came from us). */
export function validateChosenTargets(
  ctx: GameContext,
  def: CardDefinition,
  casterId: PlayerId,
  chosen: ReadonlyMap<number, ObjectId>,
): ObjectId[] {
  const targets: ObjectId[] = [];
  let slotNum = 0;
  for (const effect of def.spellEffects) {
    const kind = effectTargetKind(effect);
    if (kind === null) continue;
    const choice = chosen.get(slotNum);
    if (choice === undefined) {
      throw new Error(`missing target for slot ${slotNum} of ${def.name}`);
    }
    const legal = computeTargetOptions(ctx, kind, casterId);
    if (!legal.includes(choice)) {
      throw new Error(`illegal target ${choice} for slot ${slotNum} of ${def.name}`);
    }
    targets.push(choice);
    slotNum++;
  }
  return targets;
}

export { findPermanent };
