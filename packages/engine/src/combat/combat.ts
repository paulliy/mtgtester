/**
 * The combat phase (CR 506–511, brief §5.3/§5.4). Multiplayer: each attacker chooses
 * which opponent it attacks (CR 802). Declarations are sequential per-creature decisions
 * (one menu each — fits the pick-one decision contract; recorded in ADR 0003).
 *
 * Damage assignment follows the CR defaults deterministically: lethal damage to each
 * blocker in the chosen order, excess to the last blocker, or to the defending player
 * with trample (CR 510.1c-d, 702.19). First/double strike create the extra combat damage
 * step when present (CR 510.5).
 */

import type { ObjectId, PlayerId } from '@mtg/shared';
import type { GameGen } from '../decisions';
import {
  combatDamageTraits,
  dealDamageToCreature,
  dealDamageToPlayer,
  permanentSource,
} from '../effects/resolve';
import { emit, debug } from '../log/log';
import { playerById } from '../state/objects';
import {
  controlledPermanents,
  effectivePT,
  findPermanent,
  hasKeyword,
  isCreaturePermanent,
  playersInApnapOrder,
} from '../state/queries';
import type { EnginePermanent, GameContext } from '../state/types';
import { emptyManaPools, runPrioritySequence } from '../turn/priority';

function setStep(ctx: GameContext, step: NonNullable<GameContext['state']['step']>): void {
  ctx.state.step = step;
  emit(ctx, 'stepBegin', { step });
  debug(ctx, 'turn', `step: ${step}`);
}

function creaturesOf(ctx: GameContext, playerId: PlayerId): EnginePermanent[] {
  return controlledPermanents(ctx, playerId).filter((p) => isCreaturePermanent(ctx, p));
}

function canAttack(ctx: GameContext, perm: EnginePermanent): boolean {
  if (perm.tapped) return false;
  if (hasKeyword(ctx, perm, 'defender')) return false;
  if (perm.summoningSick && !hasKeyword(ctx, perm, 'haste')) return false;
  return true;
}

/** Evasion check: may `blocker` block `attacker`? (Phase 2: flying/reach.) */
function canBlock(ctx: GameContext, blocker: EnginePermanent, attacker: EnginePermanent): boolean {
  if (blocker.tapped) return false;
  if (hasKeyword(ctx, attacker, 'flying')) {
    return hasKeyword(ctx, blocker, 'flying') || hasKeyword(ctx, blocker, 'reach');
  }
  return true;
}

function attackers(ctx: GameContext): EnginePermanent[] {
  return ctx.state.battlefield.filter((p) => p.attacking !== null);
}

function blockersInCombat(ctx: GameContext): EnginePermanent[] {
  return ctx.state.battlefield.filter((p) => p.blocking !== null);
}

/** Declare attackers (CR 508.1): one decision per eligible creature. */
function* declareAttackers(ctx: GameContext): GameGen<void> {
  const ap = playerById(ctx, ctx.state.currentTurnPlayer);
  const opponents = playersInApnapOrder(ctx).filter((p) => p.id !== ap.id);

  for (const creature of creaturesOf(ctx, ap.id)) {
    if (!canAttack(ctx, creature)) continue;
    const pt = effectivePT(ctx, creature);
    const outcome = yield {
      decisionType: 'declareAttackers',
      player: ap.id,
      prompt: `Declare attackers: does ${creature.name} (${pt.power}/${pt.toughness}) attack?`,
      options: [
        { type: 'noAttack', description: `${creature.name} does not attack` },
        ...opponents.map((opp) => ({
          type: 'attack',
          description: `${creature.name} attacks ${opp.id} (${opp.life} life)`,
          payload: opp.id,
        })),
      ],
    };
    if (outcome.index === 0) continue;
    const target = opponents[outcome.index - 1];
    if (target === undefined) throw new Error('engine bug: attack target out of range');
    creature.attacking = target.id;
    creature.statuses.push('attacking');
    if (!hasKeyword(ctx, creature, 'vigilance')) creature.tapped = true; // CR 508.1f
    emit(
      ctx,
      'attack',
      { attacker: creature.name, attackerCardId: creature.cardId, defender: target.id },
      ap.id,
    );
    debug(ctx, 'combat', `${creature.name} attacks ${target.id}`);
  }

  const declared = attackers(ctx);
  ctx.state.combat = {
    defendingPlayers: [...new Set(declared.map((a) => a.attacking as PlayerId))],
  };
  emit(ctx, 'attackersDeclared', { count: declared.length }, ap.id);
}

/** Declare blockers (CR 509.1): defending players in APNAP order, one decision each. */
function* declareBlockers(ctx: GameContext): GameGen<void> {
  const defending = ctx.state.combat?.defendingPlayers ?? [];
  for (const defenderId of playersInApnapOrder(ctx).map((p) => p.id)) {
    if (!defending.includes(defenderId)) continue;
    const incoming = attackers(ctx).filter((a) => a.attacking === defenderId);
    if (incoming.length === 0) continue;

    for (const blocker of creaturesOf(ctx, defenderId)) {
      const blockable = incoming.filter(
        (a) => canBlock(ctx, blocker, a) && findPermanent(ctx, a.id) !== undefined,
      );
      if (blocker.tapped || blockable.length === 0) continue;
      const pt = effectivePT(ctx, blocker);
      const outcome = yield {
        decisionType: 'declareBlockers',
        player: defenderId,
        prompt: `Declare blockers: does ${blocker.name} (${pt.power}/${pt.toughness}) block?`,
        options: [
          { type: 'noBlock', description: `${blocker.name} does not block` },
          ...blockable.map((a) => {
            const apt = effectivePT(ctx, a);
            return {
              type: 'block',
              description: `${blocker.name} blocks ${a.name} (${apt.power}/${apt.toughness})`,
              payload: a.id,
            };
          }),
        ],
      };
      if (outcome.index === 0) continue;
      const attacker = blockable[outcome.index - 1];
      if (attacker === undefined) throw new Error('engine bug: block target out of range');
      blocker.blocking = attacker.id;
      blocker.statuses.push('blocking');
      attacker.blockedByOrdered.push(blocker.id);
      emit(
        ctx,
        'block',
        { blocker: blocker.name, blockerCardId: blocker.cardId, attacker: attacker.name },
        defenderId,
      );
      debug(ctx, 'combat', `${blocker.name} blocks ${attacker.name}`);
    }
  }

  // Damage assignment order among multiple blockers (CR 509.2) — attacker's controller
  // chooses, via sequential "who is dealt damage next" picks.
  for (const attacker of attackers(ctx)) {
    if (attacker.blockedByOrdered.length < 2) continue;
    let remaining = [...attacker.blockedByOrdered];
    const ordered: ObjectId[] = [];
    while (remaining.length > 1) {
      const outcome = yield {
        decisionType: 'assignCombatDamage',
        player: attacker.controllerId,
        prompt: `Choose the damage assignment order for ${attacker.name}: which blocker is dealt damage ${ordered.length === 0 ? 'first' : 'next'}?`,
        options: remaining.map((id) => ({
          type: 'damageOrder',
          description: `${findPermanent(ctx, id)?.name ?? id} next`,
          payload: id,
        })),
      };
      const picked = remaining[outcome.index];
      if (picked === undefined) throw new Error('engine bug: damage order pick out of range');
      ordered.push(picked);
      remaining = remaining.filter((id) => id !== picked);
    }
    ordered.push(...remaining);
    attacker.blockedByOrdered = ordered;
    emit(
      ctx,
      'damageAssignmentOrder',
      { attacker: attacker.name, order: ordered },
      attacker.controllerId,
    );
  }
}

interface DamageAssignment {
  source: EnginePermanent;
  targetCreature: EnginePermanent | null;
  targetPlayer: PlayerId | null;
  amount: number;
}

/** Does this creature deal damage in the given combat damage step? (CR 510.5) */
function dealsInStep(ctx: GameContext, perm: EnginePermanent, step: 'first' | 'regular'): boolean {
  const first = hasKeyword(ctx, perm, 'first strike');
  const dbl = hasKeyword(ctx, perm, 'double strike');
  if (step === 'first') return first || dbl;
  return dbl || !first;
}

/** Compute and deal all combat damage for one damage step simultaneously (CR 510.2). */
function dealCombatDamage(ctx: GameContext, step: 'first' | 'regular'): void {
  const assignments: DamageAssignment[] = [];

  for (const attacker of attackers(ctx)) {
    if (!dealsInStep(ctx, attacker, step)) continue;
    const power = effectivePT(ctx, attacker).power;
    if (power <= 0) continue;
    const deathtouch = hasKeyword(ctx, attacker, 'deathtouch');
    const trample = hasKeyword(ctx, attacker, 'trample');

    const liveBlockers = attacker.blockedByOrdered
      .map((id) => findPermanent(ctx, id))
      .filter((b): b is EnginePermanent => b !== undefined);
    const wasBlocked = attacker.blockedByOrdered.length > 0;

    if (!wasBlocked) {
      if (attacker.attacking !== null) {
        assignments.push({
          source: attacker,
          targetCreature: null,
          targetPlayer: attacker.attacking,
          amount: power,
        });
      }
      continue;
    }

    // Blocked: assign at least lethal to each blocker in order (CR 510.1c); with
    // deathtouch, 1 damage is lethal (CR 702.2c). Excess: trample → defending player
    // (CR 702.19e); otherwise it goes to the last blocker.
    let remaining = power;
    for (let i = 0; i < liveBlockers.length && remaining > 0; i++) {
      const blocker = liveBlockers[i] as EnginePermanent;
      const bpt = effectivePT(ctx, blocker);
      const lethal = deathtouch ? 1 : Math.max(1, bpt.toughness - blocker.damageMarked);
      const isLast = i === liveBlockers.length - 1;
      let assign = Math.min(remaining, lethal);
      if (isLast && !trample) assign = remaining; // dump excess on the final blocker
      assignments.push({
        source: attacker,
        targetCreature: blocker,
        targetPlayer: null,
        amount: assign,
      });
      remaining -= assign;
    }
    if (remaining > 0 && trample && attacker.attacking !== null) {
      assignments.push({
        source: attacker,
        targetCreature: null,
        targetPlayer: attacker.attacking,
        amount: remaining,
      });
    }
    // Blocked with zero surviving blockers and no trample: deals no combat damage
    // (CR 510.1c) — nothing assigned.
  }

  for (const blocker of blockersInCombat(ctx)) {
    if (!dealsInStep(ctx, blocker, step)) continue;
    const power = effectivePT(ctx, blocker).power;
    if (power <= 0) continue;
    const target = blocker.blocking === null ? undefined : findPermanent(ctx, blocker.blocking);
    if (target === undefined) continue; // its attacker already left combat/battlefield
    assignments.push({
      source: blocker,
      targetCreature: target,
      targetPlayer: null,
      amount: power,
    });
  }

  // All combat damage in a step is dealt simultaneously (CR 510.2).
  emit(ctx, 'combatDamageStep', { step, assignments: assignments.length });
  for (const a of assignments) {
    const traits = combatDamageTraits(ctx, a.source);
    if (a.targetCreature !== null) {
      dealDamageToCreature(ctx, permanentSource(a.source), a.targetCreature, a.amount, {
        combat: true,
        sourceHasDeathtouch: traits.deathtouch,
        sourceHasLifelink: traits.lifelink,
      });
    } else if (a.targetPlayer !== null) {
      dealDamageToPlayer(
        ctx,
        permanentSource(a.source),
        playerById(ctx, a.targetPlayer),
        a.amount,
        {
          combat: true,
          sourceIsCommander: a.source.isCommander,
          sourceHasLifelink: traits.lifelink,
        },
      );
    }
    if (step === 'first') a.source.dealtFirstStrikeDamage = true;
  }
}

/** Any combatant with first or double strike ⇒ the extra damage step exists (CR 510.5). */
function firstStrikeStepNeeded(ctx: GameContext): boolean {
  return [...attackers(ctx), ...blockersInCombat(ctx)].some(
    (p) => hasKeyword(ctx, p, 'first strike') || hasKeyword(ctx, p, 'double strike'),
  );
}

function endCombatCleanup(ctx: GameContext): void {
  for (const perm of ctx.state.battlefield) {
    perm.attacking = null;
    perm.blocking = null;
    perm.blockedByOrdered = [];
    perm.dealtFirstStrikeDamage = false;
    perm.statuses = perm.statuses.filter((st) => st !== 'attacking' && st !== 'blocking');
  }
  ctx.state.combat = null;
}

/** The full combat phase (CR 506–511). */
export function* runCombatPhase(ctx: GameContext): GameGen<void> {
  setStep(ctx, 'beginCombat');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  setStep(ctx, 'declareAttackers');
  yield* declareAttackers(ctx);
  const anyAttackers = attackers(ctx).length > 0;
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // CR 508.8: no attackers ⇒ skip declare blockers and combat damage steps.
  if (anyAttackers) {
    setStep(ctx, 'declareBlockers');
    yield* declareBlockers(ctx);
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx);

    if (firstStrikeStepNeeded(ctx)) {
      setStep(ctx, 'firstStrikeCombatDamage');
      dealCombatDamage(ctx, 'first');
      yield* runPrioritySequence(ctx);
      emptyManaPools(ctx);
    }

    setStep(ctx, 'combatDamage');
    dealCombatDamage(ctx, 'regular');
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx);
  }

  setStep(ctx, 'endCombat');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);
  endCombatCleanup(ctx);
}
