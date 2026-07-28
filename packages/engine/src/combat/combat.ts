/**
 * The combat phase (CR 506–511, brief §5.3/§5.4). Multiplayer: each attacker chooses
 * which opponent it attacks (CR 802). Declarations are sequential per-creature decisions
 * (one menu each — fits the pick-one decision contract; recorded in ADR 0003).
 *
 * Each declaration menu also carries batch shortcuts ("no further attacks", "everyone left
 * attacks X", "no blocks at all") so a decider that wants the whole set can say so in one
 * decision instead of one per creature — decisions are metered network calls for a remote
 * decision provider (ADR 0010). See `declareAttackers`.
 *
 * Damage assignment follows the CR defaults deterministically: lethal damage to each
 * blocker in the chosen order, excess to the last blocker, or to the defending player
 * with trample (CR 510.1c-d, 702.19). First/double strike create the extra combat damage
 * step when present (CR 510.5).
 */

import type { ObjectId, PlayerId } from '@mtg/shared';
import type { EngineActionOption, GameGen } from '../decisions';
import {
  combatDamageTraits,
  dealDamageToCreature,
  dealDamageToPlayer,
  permanentSource,
} from '../effects/resolve';
import { emit, debug } from '../log/log';
import { playerById, queueTriggersForEvent } from '../state/objects';
import {
  colorsOf,
  controlledPermanents,
  effectivePT,
  findPermanent,
  hasKeyword,
  hasProtectionFrom,
  isCreaturePermanent,
  playersInApnapOrder,
  triggersOf,
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

/** Evasion check: may `blocker` block `attacker`? (flying/reach, protection — CR 509.1b.) */
function canBlock(ctx: GameContext, blocker: EnginePermanent, attacker: EnginePermanent): boolean {
  if (blocker.tapped) return false;
  // Protection (CR 702.16), the B in DEBT: an attacker with protection from the blocker's
  // colors cannot be blocked by it.
  if (hasProtectionFrom(ctx, attacker, colorsOf(ctx, blocker))) return false;
  if (hasKeyword(ctx, attacker, 'flying')) {
    return hasKeyword(ctx, blocker, 'flying') || hasKeyword(ctx, blocker, 'reach');
  }
  return true;
}

/**
 * Menace (CR 702.111): an attacker with menace can't be blocked except by two or more
 * creatures. Enforced after the whole block set is declared, because the requirement is about
 * the set, not about any individual block — a first legal block would otherwise be refused.
 */
function menaceViolations(ctx: GameContext): EnginePermanent[] {
  return attackers(ctx).filter((attacker) => {
    if (!hasKeyword(ctx, attacker, 'menace')) return false;
    return attacker.blockedByOrdered.length === 1;
  });
}

function attackers(ctx: GameContext): EnginePermanent[] {
  return ctx.state.battlefield.filter((p) => p.attacking !== null);
}

function blockersInCombat(ctx: GameContext): EnginePermanent[] {
  return ctx.state.battlefield.filter((p) => p.blocking !== null);
}

/** Commit one creature to attacking a defender (CR 508.1a, 508.1f). */
function commitAttacker(
  ctx: GameContext,
  creature: EnginePermanent,
  defenderId: PlayerId,
  apId: PlayerId,
): void {
  creature.attacking = defenderId;
  creature.statuses.push('attacking');
  if (!hasKeyword(ctx, creature, 'vigilance')) creature.tapped = true; // CR 508.1f
  emit(
    ctx,
    'attack',
    { attacker: creature.name, attackerCardId: creature.cardId, defender: defenderId },
    apId,
  );
  debug(ctx, 'combat', `${creature.name} attacks ${defenderId}`);
}

/**
 * Declare attackers (CR 508.1): one decision per eligible creature, each of which can also
 * settle every creature still undeclared in one go.
 *
 * Attackers are legally declared as a single simultaneous set (CR 508.1), but a "pick one
 * option" menu cannot express a set without enumerating every subset — 4^creatures in a
 * four-player game. So the declaration stays sequential (ADR 0003), and the batch is offered
 * as *shortcuts* instead: alongside this creature's own choices, the menu carries "no further
 * attacks" and "everyone left attacks <opponent>". Those cover the two overwhelmingly common
 * shapes — an empty attack on a stalled board, and an all-in alpha strike — in a single
 * decision instead of one per creature, which matters because each decision surfaced to a
 * remote decision provider is a metered network call.
 *
 * The shortcuts only ever *add* options, so no per-creature choice is taken away: an AI that
 * wants a mixed attack still declares creature by creature exactly as before, and the call
 * count in that case is unchanged. They are offered only while creatures remain undeclared,
 * since with one creature left they would just restate its own menu.
 */
function* declareAttackers(ctx: GameContext): GameGen<void> {
  const ap = playerById(ctx, ctx.state.currentTurnPlayer);
  const opponents = playersInApnapOrder(ctx).filter((p) => p.id !== ap.id);
  // Snapshot up front: declaring one attacker taps it but cannot change whether any *other*
  // creature is eligible, so this is the same set the per-iteration check used to produce.
  const eligible = creaturesOf(ctx, ap.id).filter((c) => canAttack(ctx, c));

  for (let i = 0; i < eligible.length; i++) {
    const creature = eligible[i] as EnginePermanent;
    const rest = eligible.slice(i + 1);
    const pt = effectivePT(ctx, creature);
    // Descriptive only (see `EngineActionOption.data`). `hasTriggers` matters to a consumer
    // judging whether attacking could ever be worth it: a creature that puts something on the
    // stack when it attacks is worth attacking with at any power. It counts *every* trigger on
    // the creature, not only attack triggers, so it over-reports — a hint, never a rule.
    const hasTriggers = triggersOf(ctx, creature).length > 0;
    const attackData = {
      power: pt.power,
      toughness: pt.toughness,
      hasTriggers,
      subjectId: creature.id,
    };

    const options: EngineActionOption[] = [
      {
        type: 'noAttack',
        description: `${creature.name} does not attack`,
        data: attackData,
        interaction: { kind: 'attack', attackerId: creature.id },
      },
      ...opponents.map((opp) => ({
        type: 'attack',
        description: `${creature.name} attacks ${opp.id} (${opp.life} life)`,
        payload: opp.id,
        data: attackData,
        interaction: {
          kind: 'attack' as const,
          attackerId: creature.id,
          defenderId: opp.id,
        },
      })),
    ];

    // Batch shortcuts, appended so the per-creature option indices never move.
    if (rest.length > 0) {
      const group = [creature, ...rest];
      // Aggregates over the whole undeclared group, for a consumer deciding whether the batch
      // could matter at all (same reasoning as `attackData`, widened from one creature to all).
      const groupData = {
        count: group.length,
        maxPower: Math.max(...group.map((c) => effectivePT(ctx, c).power)),
        hasTriggers: group.some((c) => triggersOf(ctx, c).length > 0),
      };
      options.push({
        type: 'noAttackRest',
        description: `No further attacks: ${creature.name} and the ${rest.length} other undeclared creature(s) all stay home`,
        data: groupData,
        interaction: {
          kind: 'attack',
          attackerId: creature.id,
          appliesToRemaining: true,
        },
      });
      options.push(
        ...opponents.map((opp) => ({
          type: 'attackRest',
          description: `All ${group.length} undeclared creatures (${creature.name} + ${rest.length} more) attack ${opp.id} (${opp.life} life)`,
          payload: opp.id,
          data: groupData,
          interaction: {
            kind: 'attack' as const,
            attackerId: creature.id,
            defenderId: opp.id,
            appliesToRemaining: true,
          },
        })),
      );
    }

    const outcome = yield {
      decisionType: 'declareAttackers',
      player: ap.id,
      prompt:
        `Declare attackers: does ${creature.name} (${pt.power}/${pt.toughness}) attack?` +
        (rest.length > 0 ? ` (${rest.length} more creature(s) still to declare)` : ''),
      options,
    };

    if (outcome.index === 0) continue;
    if (outcome.index <= opponents.length) {
      const target = opponents[outcome.index - 1];
      if (target === undefined) throw new Error('engine bug: attack target out of range');
      commitAttacker(ctx, creature, target.id, ap.id);
      continue;
    }

    // A batch shortcut: either way, nothing undeclared is asked about again.
    const batchIndex = outcome.index - (opponents.length + 1);
    if (batchIndex === 0) break; // noAttackRest
    const batchTarget = opponents[batchIndex - 1];
    if (batchTarget === undefined) throw new Error('engine bug: attack target out of range');
    for (const c of [creature, ...rest]) commitAttacker(ctx, c, batchTarget.id, ap.id);
    break;
  }

  const declared = attackers(ctx);
  const defendingPlayers = [...new Set(declared.map((a) => a.attacking as PlayerId))];
  for (const defId of defendingPlayers) {
    playerById(ctx, defId).yieldUntilEndOfTurn = false;
  }
  ctx.state.combat = {
    defendingPlayers,
  };
  // CR 508.2: "whenever ~ attacks" triggers fire once the whole set is declared, not as each
  // creature is committed — so this is deliberately outside the declaration loop. They wait in
  // `pendingTriggers` until the declare-attackers step's priority checkpoint.
  //
  // The whole set goes in one call so that an aggregate trigger ("whenever one or more Dragons
  // you control attack") sees its count. Per-attacker triggers still fire once each.
  queueTriggersForEvent(
    ctx,
    'attacks',
    declared.map((permanent) => ({ permanent })),
  );
  emit(ctx, 'attackersDeclared', { count: declared.length }, ap.id);
}

/** Declare blockers (CR 509.1): defending players in APNAP order, one decision each. */
function* declareBlockers(ctx: GameContext): GameGen<void> {
  const defending = ctx.state.combat?.defendingPlayers ?? [];
  for (const defenderId of playersInApnapOrder(ctx).map((p) => p.id)) {
    if (!defending.includes(defenderId)) continue;
    const incoming = attackers(ctx).filter((a) => a.attacking === defenderId);
    if (incoming.length === 0) continue;

    // Snapshot the creatures with a legal block available: assigning one block never changes
    // whether another creature could block (it neither taps it nor removes an attacker).
    const candidates = creaturesOf(ctx, defenderId)
      .map((blocker) => ({
        blocker,
        blockable: incoming.filter(
          (a) => canBlock(ctx, blocker, a) && findPermanent(ctx, a.id) !== undefined,
        ),
      }))
      .filter(({ blocker, blockable }) => !blocker.tapped && blockable.length > 0);

    for (let i = 0; i < candidates.length; i++) {
      const { blocker, blockable } = candidates[i] as (typeof candidates)[number];
      const remaining = candidates.length - 1 - i;
      const pt = effectivePT(ctx, blocker);
      const options: EngineActionOption[] = [
        {
          type: 'noBlock',
          description: `${blocker.name} does not block`,
          interaction: { kind: 'block', blockerId: blocker.id },
        },
        ...blockable.map((a) => {
          const apt = effectivePT(ctx, a);
          return {
            type: 'block',
            description: `${blocker.name} blocks ${a.name} (${apt.power}/${apt.toughness})`,
            payload: a.id,
            interaction: {
              kind: 'block' as const,
              blockerId: blocker.id,
              attackerId: a.id,
            },
          };
        }),
      ];
      // "Take no blocks at all" is one coherent intent and by far the most common answer on a
      // board that cannot block profitably, so it gets a shortcut (see `declareAttackers`).
      // There is deliberately no `blockRest` counterpart: throwing every creature in front of
      // one attacker is not a plan a defender usually means, so batching it would invite bad
      // blocks rather than save a call on a common one.
      if (remaining > 0) {
        options.push({
          type: 'noBlockRest',
          description: `No blocks at all: ${blocker.name} and the ${remaining} other potential blocker(s) all stay back`,
          data: { count: remaining + 1 },
          interaction: {
            kind: 'block',
            blockerId: blocker.id,
            appliesToRemaining: true,
          },
        });
      }

      const outcome = yield {
        decisionType: 'declareBlockers',
        player: defenderId,
        prompt:
          `Declare blockers: does ${blocker.name} (${pt.power}/${pt.toughness}) block?` +
          (remaining > 0 ? ` (${remaining} more potential blocker(s) to declare)` : ''),
        options,
      };
      if (outcome.index === 0) continue;
      if (outcome.index > blockable.length) break; // noBlockRest
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

  // Menace (CR 702.111) constrains the block SET, not any individual block, so it is checked
  // once the whole set exists. An illegal single block is undone rather than refused up front:
  // refusing it would have meant never offering the first of the two blocks menace requires.
  for (const attacker of menaceViolations(ctx)) {
    const [onlyBlockerId] = attacker.blockedByOrdered;
    const blocker = onlyBlockerId === undefined ? undefined : findPermanent(ctx, onlyBlockerId);
    attacker.blockedByOrdered = [];
    if (blocker !== undefined) {
      blocker.blocking = null;
      blocker.statuses = blocker.statuses.filter((s) => s !== 'blocking');
      emit(
        ctx,
        'blockIllegal',
        { blocker: blocker.name, attacker: attacker.name, reason: 'menace' },
        blocker.controllerId,
      );
      debug(ctx, 'combat', `${blocker.name}'s block on ${attacker.name} undone — menace`);
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

  // "Whenever ~ deals combat damage to a player" watches this step as one event, so the totals
  // are accumulated across assignments and the triggers queued once, after the damage is dealt.
  // A trampling attacker that hits a blocker and the player deals ONE player-damage amount, not
  // two, and a double-striker fires in each step it deals damage in (CR 702.4b).
  const damageToPlayers = new Map<EnginePermanent, number>();

  for (const a of assignments) {
    const traits = combatDamageTraits(ctx, a.source);
    if (a.targetCreature !== null) {
      dealDamageToCreature(ctx, permanentSource(a.source), a.targetCreature, a.amount, {
        combat: true,
        sourceHasDeathtouch: traits.deathtouch,
        sourceHasLifelink: traits.lifelink,
        sourceColors: traits.colors,
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
      damageToPlayers.set(a.source, (damageToPlayers.get(a.source) ?? 0) + a.amount);
    }
    if (step === 'first') a.source.dealtFirstStrikeDamage = true;
  }

  queueTriggersForEvent(
    ctx,
    'dealsCombatDamageToPlayer',
    [...damageToPlayers].map(([permanent, amount]) => ({ permanent, amount })),
  );
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
