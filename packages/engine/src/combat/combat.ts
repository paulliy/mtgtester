/**
 * The combat phase (CR 506–511, brief §5.3/§5.4). Multiplayer: each attacker chooses
 * which opponent it attacks (CR 802).
 *
 * Both declarations are ONE batched propose-and-validate decision each (ADR 0023 items 13/14,
 * Phase 4): `declareAttackers` surfaces every eligible creature and its legal defenders together,
 * `declareBlockers` does the same per defending player with legal attackers, and in both cases
 * the caller proposes a full assignment that the engine validates as a whole instead of building
 * it up one legal-by-construction creature at a time. See `declareAttackers`/`declareBlockers`.
 *
 * Damage among 2+ blockers is a genuine arbitrary division the attacking player chooses (CR
 * 510.1c-d), not an order — the pre-2018 "damage assignment order" mechanic is obsolete (see the
 * ADR's Context section). `assignDamageDivisions` asks for that division directly, right before
 * each combat-damage-dealing step, after that step's priority window (ADR 0023 item 18). A single
 * blocker (or no blocker) has nothing to choose — CR 510.1c already forces the whole amount to it
 * — and trample's own lethal-first/excess-to-player split (CR 702.19b) still applies there without
 * a decision. First/double strike create the extra combat damage step when present (CR 510.5).
 */

import type {
  AttackDeclarationSubject,
  BlockDeclarationSubject,
  CombatRejection,
  CombatViolation,
  ObjectId,
  PlayerId,
} from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import type { DecisionOutcome, EngineActionOption, GameGen } from '../decisions';
import {
  combatDamageTraits,
  dealDamageToCreature,
  dealDamageToPlayer,
  permanentSource,
} from '../effects/resolve';
import { computeCharacteristics } from '../effects/continuous';
import { payManaCost } from '../effects/resolve';
import { canPay, emptyCost, totalPips } from '../mana/cost';
import type { ParsedManaCost } from '../mana/cost';
import { emit, debug } from '../log/log';
import { playerById, queueTriggersForEvent, queueTriggersForObject } from '../state/objects';
import {
  colorsOf,
  controlledPermanents,
  effectivePT,
  findPermanent,
  hasKeyword,
  hasProtectionFrom,
  isCreaturePermanent,
  playersInApnapOrder,
  allowanceFor,
  gatherRuleStatics,
  manaSourcesFor,
  triggersOf,
} from '../state/queries';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../state/types';
import { emptyManaPools, runPrioritySequence } from '../turn/priority';

function setStep(ctx: GameContext, step: NonNullable<GameContext['state']['step']>): void {
  ctx.state.step = step;
  emit(ctx, 'stepBegin', { step });
  debug(ctx, 'turn', `step: ${step}`);
}

function creaturesOf(ctx: GameContext, playerId: PlayerId): EnginePermanent[] {
  return controlledPermanents(ctx, playerId).filter((p) => isCreaturePermanent(ctx, p));
}

function goaderIdsFor(ctx: GameContext, creature: EnginePermanent): Set<PlayerId> {
  const chars = computeCharacteristics(ctx, creature);
  return new Set([
    ...(creature.goadedBy ?? []).map((requirement) => requirement.goaderId),
    ...(chars.staticGoadedBy ?? []),
  ]);
}

function hasAttackRequirement(ctx: GameContext, creature: EnginePermanent): boolean {
  const chars = computeCharacteristics(ctx, creature);
  return (
    (creature.goadedBy?.length ?? 0) > 0 ||
    (chars.staticGoadedBy?.length ?? 0) > 0 ||
    creature.mustAttackThisTurn === true ||
    chars.mustAttackEachCombat === true
  );
}

function canAttack(ctx: GameContext, perm: EnginePermanent): boolean {
  if (perm.tapped) return false;
  if (hasKeyword(ctx, perm, 'defender')) return false;
  if (perm.summoningSick && !hasKeyword(ctx, perm, 'haste')) return false;
  return true;
}

function attackTax(ctx: GameContext, defendingPlayerId: PlayerId): number {
  return gatherRuleStatics(ctx).reduce((total, entry) => {
    if (entry.controllerId !== defendingPlayerId || entry.static.kind !== 'attackTax') return total;
    return total + entry.static.amount;
  }, 0);
}

function attackCost(ctx: GameContext, defendingPlayerId: PlayerId, count = 1): ParsedManaCost {
  const cost = { ...emptyCost(), generic: attackTax(ctx, defendingPlayerId) * count };
  const phyrexian = gatherRuleStatics(ctx).flatMap((entry) => {
    if (
      entry.controllerId !== defendingPlayerId ||
      entry.static.kind !== 'attackTax' ||
      entry.static.phyrexianColor === undefined
    ) {
      return [];
    }
    const color = entry.static.phyrexianColor;
    return Array.from({ length: count }, () => color);
  });
  return phyrexian.length > 0 ? { ...cost, phyrexian } : cost;
}

/**
 * Can this ONE creature alone afford to attack this defender? Per-creature restriction/cost
 * legality (item 15) — never the whole proposed set's joint cost, which several creatures
 * sharing one taxed defender can still fail even when each individually passes this check
 * (`validateAttackDeclaration`, run once the whole declaration is known — item 14).
 */
function canPayAttackTax(
  ctx: GameContext,
  attackingPlayerId: PlayerId,
  defendingPlayerId: PlayerId,
): boolean {
  const cost = attackCost(ctx, defendingPlayerId);
  if (totalPips(cost) === 0) return true;
  const player = playerById(ctx, attackingPlayerId);
  return canPay(
    cost,
    player.manaEntries,
    manaSourcesFor(ctx, attackingPlayerId),
    allowanceFor(ctx, attackingPlayerId, { kind: 'other' }),
    player.life,
  );
}

function attackTargetsFor(
  ctx: GameContext,
  creature: EnginePermanent,
  opponents: readonly EnginePlayerState[],
): EnginePlayerState[] {
  const payable = opponents.filter((opp) => canPayAttackTax(ctx, creature.controllerId, opp.id));
  const goaderIds = goaderIdsFor(ctx, creature);
  const preferred = payable.filter((opp) => !goaderIds.has(opp.id));
  return preferred.length > 0 ? preferred : payable;
}

/**
 * Opponents this creature could attack **for free** — used only to decide whether a goad
 * requirement is mandatory, never to build the offered menu (that's `attackTargetsFor`,
 * gated on affordability instead). CR 508.1d: "If a creature can't attack unless a player
 * pays a cost, that player is not required to pay that cost, even if attacking with that
 * creature would increase the number of requirements being obeyed" — a cost-gated defender
 * never counts toward "the maximum possible number of requirements that could be obeyed,"
 * regardless of whether the cost happens to be affordable. This is the fix for ADR 0023's
 * goad-versus-attack-tax bug: a goaded creature behind an attack tax (Ghostly Prison and
 * similar) is never forced to attack merely because its controller could afford the tax.
 */
function freeAttackTargetsFor(
  ctx: GameContext,
  creature: EnginePermanent,
  opponents: readonly EnginePlayerState[],
): EnginePlayerState[] {
  const free = opponents.filter((opp) => totalPips(attackCost(ctx, opp.id)) === 0);
  const goaderIds = goaderIdsFor(ctx, creature);
  const preferred = free.filter((opp) => !goaderIds.has(opp.id));
  return preferred.length > 0 ? preferred : free;
}

function* payAttackTax(
  ctx: GameContext,
  attackingPlayerId: PlayerId,
  defendingPlayerId: PlayerId,
  count: number,
): GameGen<void> {
  const cost = attackCost(ctx, defendingPlayerId, count);
  if (totalPips(cost) === 0) return;
  yield* payManaCost(ctx, playerById(ctx, attackingPlayerId), cost, { kind: 'other' });
}

/** Evasion check: may `blocker` block `attacker`? (flying/reach, protection — CR 509.1b.) */
function canBlock(ctx: GameContext, blocker: EnginePermanent, attacker: EnginePermanent): boolean {
  if (blocker.tapped || blocker.cantBlock === true || attacker.cantBeBlocked === true) return false;
  if (computeCharacteristics(ctx, attacker).cantBeBlocked) return false;
  if (ctx.state.creaturesCantBeBlockedThisTurn) return false;
  for (const champion of ctx.state.battlefield) {
    if (champion.controllerId === attacker.controllerId) {
      const def = ctx.defs.get(champion.oracleId);
      if (
        def?.name === 'Champion of Lambholt' ||
        def?.oracleId === 'c549b0fd-1e08-4873-952e-a14dc45a0fd2'
      ) {
        const champPower = effectivePT(ctx, champion).power;
        const blockerPower = effectivePT(ctx, blocker).power;
        if (blockerPower < champPower) return false;
      }
    }
  }
  if (
    ctx.state.effects.some(
      (effect) => effect.kind === 'cantBeBlocked' && effect.targetCardIds.includes(attacker.cardId),
    )
  )
    return false;
  // Protection (CR 702.16), the B in DEBT: an attacker with protection from the blocker's
  // colors cannot be blocked by it.
  if (hasProtectionFrom(ctx, attacker, colorsOf(ctx, blocker))) return false;
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

/** Commit one creature to attacking a defender (CR 508.1a, 508.1f). */
function commitAttacker(
  ctx: GameContext,
  creature: EnginePermanent,
  defenderId: PlayerId,
  apId: PlayerId,
  hadToAttack = false,
): void {
  if (hadToAttack) creature.hadToAttackThisCombat = true;
  creature.attacking = defenderId;
  creature.statuses.push('attacking');
  if (!hasKeyword(ctx, creature, 'vigilance')) {
    creature.tapped = true; // CR 508.1f
    queueTriggersForObject(ctx, 'becomesTapped', creature);
  }
  emit(
    ctx,
    'attack',
    { attacker: creature.name, attackerCardId: creature.cardId, defender: defenderId },
    apId,
  );
  debug(ctx, 'combat', `${creature.name} attacks ${defenderId}`);
}

/**
 * Build the per-creature legal-defender set for every eligible attacker (CR 508.1c/d) — the
 * data both the presentation layer and the offered menu are built from. `defenders` alone
 * already encodes restrictions and costs (item 15); `mustAttack` encodes the one requirement
 * combat currently models (goad, item 19). What this does NOT check is the joint cost of
 * several creatures attacking the same taxed defender at once — that's `validateAttackDeclaration`,
 * run after the whole set is proposed, per item 14.
 */
function buildAttackSubjects(
  ctx: GameContext,
  eligible: readonly EnginePermanent[],
  opponents: readonly EnginePlayerState[],
): AttackDeclarationSubject[] {
  return eligible.map((creature) => {
    const pt = effectivePT(ctx, creature);
    const legal = attackTargetsFor(ctx, creature, opponents);
    const mustAttack =
      hasAttackRequirement(ctx, creature) &&
      freeAttackTargetsFor(ctx, creature, opponents).length > 0;
    return {
      subjectId: creature.id,
      name: creature.name,
      power: pt.power,
      toughness: pt.toughness,
      defenders: legal.map((opp) => ({
        playerId: opp.id,
        life: opp.life,
        attackTax: attackTax(ctx, opp.id),
      })),
      mustAttack,
      hasTriggers: triggersOf(ctx, creature).length > 0,
    };
  });
}

/**
 * The single `EngineActionOption` a batched attack declaration is proposed against: one target
 * slot per subject (ADR 0023 items 13/14), reusing the existing multi-slot `targets` mechanism
 * rather than inventing a parallel wire shape. A slot's `options` are that creature's legal
 * defenders plus `NO_ATTACK_TARGET`, omitted when `mustAttack` — which is what makes declining
 * illegal for that creature structurally, the same way a menu option's absence always has.
 */
function buildAttackOption(subjects: readonly AttackDeclarationSubject[]): EngineActionOption {
  return {
    type: 'attackDeclaration',
    description: `Declare attackers (${subjects.length} eligible creature${subjects.length === 1 ? '' : 's'})`,
    // Sent to the AI/heuristics layer (unlike `presentationAttackDeclaration`, which is UI-only —
    // see `DecisionPresentation`'s doc comment) — per-subject data a decider needs without
    // parsing `description`, e.g. `packages/server/src/ai/heuristics.ts`'s zero-power-attack rule.
    data: {
      subjects: subjects.map((s) => ({
        subjectId: s.subjectId,
        power: s.power,
        toughness: s.toughness,
        hasTriggers: s.hasTriggers,
        mustAttack: s.mustAttack,
      })),
    },
    targets: subjects.map((s, i) => ({
      slot: i,
      options: [...s.defenders.map((d) => d.playerId), ...(s.mustAttack ? [] : [NO_ATTACK_TARGET])],
    })),
  };
}

/** Read a proposed declaration back out of the outcome's per-slot target choices. */
function readAttackAssignment(
  outcome: DecisionOutcome,
  eligible: readonly EnginePermanent[],
): Map<ObjectId, PlayerId | null> {
  const assignment = new Map<ObjectId, PlayerId | null>();
  for (let i = 0; i < eligible.length; i++) {
    const creature = eligible[i] as EnginePermanent;
    const chosen = outcome.targets.get(i);
    assignment.set(
      creature.id,
      chosen === undefined || chosen === NO_ATTACK_TARGET ? null : (chosen as PlayerId),
    );
  }
  return assignment;
}

function groupByDefender(
  eligible: readonly EnginePermanent[],
  assignment: ReadonlyMap<ObjectId, PlayerId | null>,
): Map<PlayerId, EnginePermanent[]> {
  const byDefender = new Map<PlayerId, EnginePermanent[]>();
  for (const creature of eligible) {
    const defenderId = assignment.get(creature.id);
    if (defenderId === null || defenderId === undefined) continue;
    const group = byDefender.get(defenderId);
    if (group === undefined) byDefender.set(defenderId, [creature]);
    else group.push(creature);
  }
  return byDefender;
}

/**
 * The one thing per-slot legality (`buildAttackSubjects`) can't check: whether the attacking
 * player can pay every taxed defender's combined attack tax at once, since several creatures
 * proposed against the same taxed opponent share one mana pool (ADR 0023 items 2, 14). Anything
 * else a caller could get wrong is already impossible to submit — `Engine.submit` rejects a
 * target choice that isn't one of that slot's legal `options` before this code ever runs.
 */
function validateAttackDeclaration(
  ctx: GameContext,
  attackingPlayerId: PlayerId,
  eligible: readonly EnginePermanent[],
  assignment: ReadonlyMap<ObjectId, PlayerId | null>,
): CombatViolation[] {
  const byDefender = groupByDefender(eligible, assignment);
  const totalCost = emptyCost();
  for (const [defenderId, creatures] of byDefender) {
    const cost = attackCost(ctx, defenderId, creatures.length);
    totalCost.generic += cost.generic;
    totalCost.phyrexian = [...(totalCost.phyrexian ?? []), ...(cost.phyrexian ?? [])];
  }
  if (totalPips(totalCost) === 0) return [];
  const player = playerById(ctx, attackingPlayerId);
  const payable = canPay(
    totalCost,
    player.manaEntries,
    manaSourcesFor(ctx, attackingPlayerId),
    allowanceFor(ctx, attackingPlayerId, { kind: 'other' }),
    player.life,
  );
  if (payable) return [];
  const violations: CombatViolation[] = [];
  for (const [defenderId, creatures] of byDefender) {
    if (totalPips(attackCost(ctx, defenderId)) === 0) continue;
    for (const creature of creatures) {
      violations.push({
        subjectId: creature.id,
        kind: 'attackTax',
        message: `Not enough mana to pay the combined attack tax for every creature attacking ${defenderId} at once`,
      });
    }
  }
  return violations;
}

/** Pay every defender's attack tax once (jointly, per group) and commit the whole set (CR 508.1a/f). */
function* applyAttackDeclaration(
  ctx: GameContext,
  ap: EnginePlayerState,
  eligible: readonly EnginePermanent[],
  opponents: readonly EnginePlayerState[],
  assignment: ReadonlyMap<ObjectId, PlayerId | null>,
): GameGen<void> {
  const byDefender = groupByDefender(eligible, assignment);
  for (const [defenderId, creatures] of byDefender) {
    yield* payAttackTax(ctx, ap.id, defenderId, creatures.length);
    for (const creature of creatures) {
      const hadToAttack =
        hasAttackRequirement(ctx, creature) &&
        freeAttackTargetsFor(ctx, creature, opponents).length > 0;
      commitAttacker(ctx, creature, defenderId, ap.id, hadToAttack);
    }
  }
}

/**
 * Engine-owned repair (ADR 0023 item 17) — never the caller's job, so legality can't drift from
 * whatever the caller thinks it re-derived. `'minimum-change'`: repeatedly pick the lowest-power
 * violating creature (ties broken by id, for determinism — brief §5.9) and fix just it — redirect
 * it to a free defender if a requirement makes it mandatory that it attack someone (CR 508.1d
 * never lets a repair manufacture a cost-driven "must decline" either), otherwise stand it down.
 * Bounded by `eligible.length` retries, so a validator that can never be satisfied can't loop.
 */
function repairAttackDeclaration(
  ctx: GameContext,
  attackingPlayerId: PlayerId,
  eligible: readonly EnginePermanent[],
  opponents: readonly EnginePlayerState[],
  assignment: ReadonlyMap<ObjectId, PlayerId | null>,
): Map<ObjectId, PlayerId | null> {
  const repaired = new Map(assignment);
  let violations = validateAttackDeclaration(ctx, attackingPlayerId, eligible, repaired);
  let guard = eligible.length + 1;
  while (violations.length > 0 && guard-- > 0) {
    const violatedIds = new Set(violations.map((v) => v.subjectId));
    const candidates = eligible
      .filter((c) => violatedIds.has(c.id))
      .sort(
        (a, b) => effectivePT(ctx, a).power - effectivePT(ctx, b).power || a.id.localeCompare(b.id),
      );
    const pick = candidates[0];
    if (pick === undefined) break; // unreachable: every violation names an eligible subject
    const mustAttack =
      hasAttackRequirement(ctx, pick) && freeAttackTargetsFor(ctx, pick, opponents).length > 0;
    repaired.set(
      pick.id,
      mustAttack ? (freeAttackTargetsFor(ctx, pick, opponents)[0]?.id ?? null) : null,
    );
    violations = validateAttackDeclaration(ctx, attackingPlayerId, eligible, repaired);
  }
  return repaired;
}

/**
 * Declare attackers (CR 508.1): one batched propose-and-validate decision for the whole set
 * (ADR 0023 items 13/14), replacing the old per-creature loop. Attacking as a joint decision
 * can't be expressed as a flat "pick one option" menu — n creatures against k opponents is
 * (k+1)^n candidate declarations — so the engine surfaces every eligible creature and its legal
 * defenders together (`buildAttackSubjects`) and the caller proposes a full assignment instead
 * of building one up choice by choice. The engine still validates and still rejects anything it
 * didn't sanction; only the shape of asking changed; see the ADR's Context section.
 *
 * A rejected proposal is re-asked once, with the violation attached (item 16) so a caller that
 * reads it can fix what it missed. A second failure is repaired by the engine itself (item 17) —
 * never a guarantee the caller has to uphold — so the game never stalls on an uncooperative or
 * unlucky proposer.
 */
function* declareAttackers(ctx: GameContext): GameGen<void> {
  const ap = playerById(ctx, ctx.state.currentTurnPlayer);
  const opponents = playersInApnapOrder(ctx).filter((p) => p.id !== ap.id);
  for (const perm of ctx.state.battlefield) {
    if (isCreaturePermanent(ctx, perm)) perm.hadToAttackThisCombat = false;
  }
  // Snapshot up front: declaring the set taps attackers but cannot change whether any *other*
  // creature was eligible to be in it.
  const eligible = creaturesOf(ctx, ap.id).filter((c) => canAttack(ctx, c));

  if (eligible.length > 0) {
    const MAX_PROPOSALS = 2;
    let rejection: CombatRejection | undefined;
    let lastAssignment: Map<ObjectId, PlayerId | null> = new Map();
    let applied = false;

    for (let attempt = 1; attempt <= MAX_PROPOSALS; attempt++) {
      const subjects = buildAttackSubjects(ctx, eligible, opponents);
      const outcome = yield {
        decisionType: 'declareAttackers',
        player: ap.id,
        prompt:
          attempt === 1
            ? `Declare attackers: ${eligible.length} eligible creature${eligible.length === 1 ? '' : 's'}`
            : 'Declare attackers — fix the flagged problem(s) and resubmit',
        options: [buildAttackOption(subjects)],
        presentationAttackDeclaration: {
          subjects,
          ...(rejection !== undefined ? { rejection } : {}),
        },
      };
      lastAssignment = readAttackAssignment(outcome, eligible);
      // Defense in depth: `Engine.submit()` already refuses a response missing a value for a
      // slot with more than one legal option (which `mustAttack` guarantees for a goaded
      // creature's slot — CR 508.1d, item 19), but code driving this generator directly (tests,
      // `pump()`) bypasses that layer, so re-assert the invariant here rather than silently
      // treating an unspecified mustAttack subject as "declines".
      for (const subject of subjects) {
        if (subject.mustAttack && lastAssignment.get(subject.subjectId) === null) {
          throw new Error(
            `engine bug: ${subject.subjectId} must attack (goaded) but was left undeclared`,
          );
        }
      }
      const violations = validateAttackDeclaration(ctx, ap.id, eligible, lastAssignment);
      if (violations.length === 0) {
        yield* applyAttackDeclaration(ctx, ap, eligible, opponents, lastAssignment);
        applied = true;
        break;
      }
      rejection = { violations };
    }

    if (!applied) {
      const repaired = repairAttackDeclaration(ctx, ap.id, eligible, opponents, lastAssignment);
      yield* applyAttackDeclaration(ctx, ap, eligible, opponents, repaired);
      emit(
        ctx,
        'attackDeclarationRepaired',
        { violations: rejection?.violations.length ?? 0 },
        ap.id,
      );
      debug(ctx, 'combat', `attack declaration repaired by the engine for ${ap.id}`);
    }
  }

  const declared = attackers(ctx);
  // Boast (CR 702.146a): "activate only if this creature attacked this turn" — tracked
  // separately from `attacking` (which clears at end of combat) so the check still holds
  // in a later main phase.
  for (const perm of declared) perm.attackedThisTurn = true;
  const defendingPlayers = [...new Set(declared.map((a) => a.attacking as PlayerId))];
  for (const defId of defendingPlayers) {
    playerById(ctx, defId).yieldUntilEndOfTurn = false;
    const auras = ctx.state.battlefield.filter((p) => p.attachedTo === defId);
    for (const aura of auras) {
      queueTriggersForEvent(ctx, 'enchantedPlayerAttacked', [{ permanent: aura, playerId: ap.id }]);
    }
  }
  // Tenuous Truce: attackers declared between an Aura's controller and the player it enchants,
  // in either direction. Creatures attack only players here, so these are all such attacks.
  if (defendingPlayers.length > 0) {
    for (const aura of [...ctx.state.battlefield]) {
      const enchanted = aura.attachedTo;
      if (enchanted === null || !ctx.state.players.some((p) => p.id === enchanted)) continue;
      const broken =
        (aura.controllerId === ap.id && defendingPlayers.includes(enchanted as PlayerId)) ||
        (enchanted === ap.id && defendingPlayers.includes(aura.controllerId));
      if (broken)
        queueTriggersForEvent(ctx, 'attackBetweenControllerAndEnchantedPlayer', [
          { permanent: aura, playerId: ap.id },
        ]);
    }
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
    declared.map((permanent) => ({ permanent, playerId: permanent.controllerId })),
  );
  emit(ctx, 'attackersDeclared', { count: declared.length }, ap.id);
}

interface BlockCandidate {
  blocker: EnginePermanent;
  blockable: EnginePermanent[];
}

/** The blockers one defending player could declare right now (evasion/protection, CR 509.1b),
 * snapshotted up front — assigning one block never taps the blocker or removes an attacker, so
 * it can't change whether another candidate is still eligible. */
function blockCandidatesFor(
  ctx: GameContext,
  defenderId: PlayerId,
  incoming: readonly EnginePermanent[],
): BlockCandidate[] {
  return creaturesOf(ctx, defenderId)
    .map((blocker) => ({ blocker, blockable: incoming.filter((a) => canBlock(ctx, blocker, a)) }))
    .filter(({ blocker, blockable }) => !blocker.tapped && blockable.length > 0);
}

/** Build the per-creature legal-attacker set for every blocking candidate — the blocker-side
 * mirror of `buildAttackSubjects`. What this does NOT check is menace (CR 702.111b): whether an
 * attacker ends up with fewer than two blockers is a property of the whole proposed set, so it's
 * `validateBlockDeclaration`'s job, run after the whole set is known. */
function buildBlockSubjects(
  ctx: GameContext,
  candidates: readonly BlockCandidate[],
): BlockDeclarationSubject[] {
  return candidates.map(({ blocker, blockable }) => {
    const pt = effectivePT(ctx, blocker);
    return {
      subjectId: blocker.id,
      name: blocker.name,
      power: pt.power,
      toughness: pt.toughness,
      attackers: blockable.map((a) => {
        const apt = effectivePT(ctx, a);
        return { attackerId: a.id, name: a.name, power: apt.power, toughness: apt.toughness };
      }),
      mustBlock: blocker.mustBlockThisTurn === true,
    };
  });
}

/** The single `EngineActionOption` a batched block declaration is proposed against — the
 * blocker-side mirror of `buildAttackOption`: one target slot per subject, that creature's legal
 * attackers plus `NO_BLOCK_TARGET`, omitted when `mustBlock`. */
function buildBlockOption(subjects: readonly BlockDeclarationSubject[]): EngineActionOption {
  return {
    type: 'blockDeclaration',
    description: `Declare blockers (${subjects.length} eligible creature${subjects.length === 1 ? '' : 's'})`,
    data: {
      subjects: subjects.map((s) => ({
        subjectId: s.subjectId,
        power: s.power,
        toughness: s.toughness,
        mustBlock: s.mustBlock,
      })),
    },
    targets: subjects.map((s, i) => ({
      slot: i,
      options: [...s.attackers.map((a) => a.attackerId), ...(s.mustBlock ? [] : [NO_BLOCK_TARGET])],
    })),
  };
}

/** Read a proposed declaration back out of the outcome's per-slot target choices. */
function readBlockAssignment(
  outcome: DecisionOutcome,
  candidates: readonly BlockCandidate[],
): Map<ObjectId, ObjectId | null> {
  const assignment = new Map<ObjectId, ObjectId | null>();
  for (let i = 0; i < candidates.length; i++) {
    const { blocker } = candidates[i] as BlockCandidate;
    const chosen = outcome.targets.get(i);
    assignment.set(
      blocker.id,
      chosen === undefined || chosen === NO_BLOCK_TARGET ? null : (chosen as ObjectId),
    );
  }
  return assignment;
}

function groupByAttacker(
  candidates: readonly BlockCandidate[],
  assignment: ReadonlyMap<ObjectId, ObjectId | null>,
): Map<ObjectId, EnginePermanent[]> {
  const byAttacker = new Map<ObjectId, EnginePermanent[]>();
  for (const { blocker } of candidates) {
    const attackerId = assignment.get(blocker.id);
    if (attackerId === null || attackerId === undefined) continue;
    const group = byAttacker.get(attackerId);
    if (group === undefined) byAttacker.set(attackerId, [blocker]);
    else group.push(blocker);
  }
  return byAttacker;
}

/**
 * The one thing per-slot legality (`buildBlockSubjects`) can't check: menace (CR 702.111b) — an
 * attacker with menace is illegal to block with fewer than two creatures, which is a property of
 * how many proposed blockers land on it, not of any one blocker's own legal-attacker list.
 */
function validateBlockDeclaration(
  ctx: GameContext,
  candidates: readonly BlockCandidate[],
  assignment: ReadonlyMap<ObjectId, ObjectId | null>,
): CombatViolation[] {
  const byAttacker = groupByAttacker(candidates, assignment);
  const violations: CombatViolation[] = [];
  for (const [attackerId, blockers] of byAttacker) {
    const attacker = findPermanent(ctx, attackerId);
    if (attacker === undefined || !hasKeyword(ctx, attacker, 'menace') || blockers.length >= 2) {
      continue;
    }
    for (const blocker of blockers) {
      violations.push({
        subjectId: blocker.id,
        kind: 'menace',
        message: `${attacker.name} has menace and can't be blocked by only one creature`,
      });
    }
  }
  return violations;
}

/** Commit the whole validated block set (CR 509.1c). */
function applyBlockDeclaration(
  ctx: GameContext,
  defenderId: PlayerId,
  candidates: readonly BlockCandidate[],
  assignment: ReadonlyMap<ObjectId, ObjectId | null>,
): void {
  const byAttacker = groupByAttacker(candidates, assignment);
  for (const [attackerId, blockers] of byAttacker) {
    const attacker = findPermanent(ctx, attackerId);
    if (attacker === undefined) continue; // left the battlefield between propose and apply — can't happen mid-decision, defensive only
    for (const blocker of blockers) {
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
      queueTriggersForObject(ctx, 'blocks', blocker);
    }
    // Bushido and similar abilities trigger once when an attacker becomes blocked, regardless
    // of how many creatures block it (CR 509.1h).
    queueTriggersForObject(ctx, 'becomesBlocked', attacker);
  }
}

/**
 * Engine-owned repair (ADR 0023 item 17, blocker-side) — the `repairAttackDeclaration` pattern
 * applied to menace: repeatedly pick the lowest-power violating blocker (ties broken by id) and
 * fix just it. If it's `mustBlock`, first try redirecting it to a different legal attacker that
 * isn't itself under-blocked (never manufacturing a second menace violation); otherwise, or if no
 * such attacker exists, stand it down. Bounded by the candidate count so it always terminates.
 */
function repairBlockDeclaration(
  ctx: GameContext,
  candidates: readonly BlockCandidate[],
  assignment: ReadonlyMap<ObjectId, ObjectId | null>,
): Map<ObjectId, ObjectId | null> {
  const repaired = new Map(assignment);
  let violations = validateBlockDeclaration(ctx, candidates, repaired);
  let guard = candidates.length + 1;
  while (violations.length > 0 && guard-- > 0) {
    const violatedIds = new Set(violations.map((v) => v.subjectId));
    const pick = candidates
      .filter((c) => violatedIds.has(c.blocker.id))
      .sort(
        (a, b) =>
          effectivePT(ctx, a.blocker).power - effectivePT(ctx, b.blocker).power ||
          a.blocker.id.localeCompare(b.blocker.id),
      )[0];
    if (pick === undefined) break; // unreachable: every violation names a candidate
    const currentAttackerId = repaired.get(pick.blocker.id);
    const alternative =
      pick.blocker.mustBlockThisTurn === true
        ? pick.blockable.find((a) => a.id !== currentAttackerId && !hasKeyword(ctx, a, 'menace'))
        : undefined;
    repaired.set(pick.blocker.id, alternative?.id ?? null);
    violations = validateBlockDeclaration(ctx, candidates, repaired);
  }
  return repaired;
}

/**
 * Declare blockers (CR 509.1): one batched propose-and-validate decision per defending player, in
 * APNAP order (ADR 0023 items 13/14, Phase 4) — the blocker-side mirror of `declareAttackers`.
 * Each defending player sees every one of their candidate blockers and its legal attackers
 * together and proposes a full assignment at once, instead of one creature at a time. A rejected
 * proposal (menace only — everything else is enforced per-slot, same as attacking) is re-asked
 * once with the violation attached (item 16); a second failure is repaired by the engine itself
 * (item 17).
 */
function* declareBlockers(ctx: GameContext): GameGen<void> {
  const defending = ctx.state.combat?.defendingPlayers ?? [];
  for (const defenderId of playersInApnapOrder(ctx).map((p) => p.id)) {
    if (!defending.includes(defenderId)) continue;
    const incoming = attackers(ctx).filter((a) => a.attacking === defenderId);
    if (incoming.length === 0) continue;

    const candidates = blockCandidatesFor(ctx, defenderId, incoming);
    if (candidates.length === 0) continue;

    const MAX_PROPOSALS = 2;
    let rejection: CombatRejection | undefined;
    let lastAssignment: Map<ObjectId, ObjectId | null> = new Map();
    let applied = false;

    for (let attempt = 1; attempt <= MAX_PROPOSALS; attempt++) {
      const subjects = buildBlockSubjects(ctx, candidates);
      const outcome = yield {
        decisionType: 'declareBlockers',
        player: defenderId,
        prompt:
          attempt === 1
            ? `Declare blockers: ${candidates.length} eligible creature${candidates.length === 1 ? '' : 's'}`
            : 'Declare blockers — fix the flagged problem(s) and resubmit',
        options: [buildBlockOption(subjects)],
        presentationBlockDeclaration: {
          subjects,
          ...(rejection !== undefined ? { rejection } : {}),
        },
      };
      lastAssignment = readBlockAssignment(outcome, candidates);
      // Defense in depth, mirroring `declareAttackers`: `Engine.submit()` already refuses a
      // response missing a value for a slot with more than one legal option (guaranteed for a
      // mustBlock creature's slot), but code driving this generator directly bypasses that layer.
      for (const subject of subjects) {
        if (subject.mustBlock && lastAssignment.get(subject.subjectId) === null) {
          throw new Error(`engine bug: ${subject.subjectId} must block but was left undeclared`);
        }
      }
      const violations = validateBlockDeclaration(ctx, candidates, lastAssignment);
      if (violations.length === 0) {
        applyBlockDeclaration(ctx, defenderId, candidates, lastAssignment);
        applied = true;
        break;
      }
      rejection = { violations };
    }

    if (!applied) {
      const repaired = repairBlockDeclaration(ctx, candidates, lastAssignment);
      applyBlockDeclaration(ctx, defenderId, candidates, repaired);
      emit(
        ctx,
        'blockDeclarationRepaired',
        { violations: rejection?.violations.length ?? 0 },
        defenderId,
      );
      debug(ctx, 'combat', `block declaration repaired by the engine for ${defenderId}`);
    }
  }

  // Damage division used to be decided as an order, right after blockers were declared. Moved
  // out (ADR 0023 item 18): CR 509.2/510 place a full priority window between blockers being
  // declared and damage being dealt, and the board can still change in it (removal, a bounce
  // spell, another blocker leaving combat). See `assignDamageDivisions`, called from
  // `runCombatPhase` immediately before each combat damage step instead.
}

/** Per-attacker chosen division of combat damage among its 2+ live blockers, and — for a
 * trampler — the defending player (keyed by id, `attacker.attacking`). Only ever has an entry
 * for an attacker with 2+ live blockers; `dealCombatDamage` falls back to CR 510.1c's forced
 * single-recipient/no-recipient cases for everything else. */
type DamageDivisions = ReadonlyMap<ObjectId, ReadonlyMap<ObjectId, number>>;

/**
 * Validate a proposed division and fall back to a safe default if it isn't well-formed: integers,
 * non-negative, summing to exactly `power`, over exactly the offered `targets` (CR 510.1a) — and,
 * when a trampler's division names the defending player, CR 702.19b's real constraint: nothing
 * may go to the player until every blocker already has lethal (deathtouch counts 1 as lethal, CR
 * 702.2c). An invalid proposal — a malformed AI response, or a provider (the random fuzzer) that
 * doesn't know this field exists — defaults to dumping the whole amount on the first live
 * blocker, which is always legal regardless of trample (the player gets 0 either way).
 */
function resolveDamageDivision(
  ctx: GameContext,
  attacker: EnginePermanent,
  liveBlockers: readonly EnginePermanent[],
  power: number,
  targets: readonly ObjectId[],
  outcome: DecisionOutcome,
): Map<ObjectId, number> {
  const raw = outcome.combatDamageSplit ?? {};
  const deathtouch = hasKeyword(ctx, attacker, 'deathtouch');
  const lethalFor = (b: EnginePermanent): number => {
    const bpt = effectivePT(ctx, b);
    const remaining = Math.max(0, bpt.toughness - b.damageMarked);
    return b.damagedByDeathtouch ? 0 : deathtouch ? Math.min(1, remaining) : remaining;
  };
  const wellFormed =
    Object.keys(raw).every((id) => targets.includes(id)) &&
    targets.every((id) => Number.isInteger(raw[id] ?? 0) && (raw[id] ?? 0) >= 0) &&
    targets.reduce((total, id) => total + (raw[id] ?? 0), 0) === power;
  const playerId = attacker.attacking;
  const playerAmount = playerId !== null ? (raw[playerId] ?? 0) : 0;
  const lethalSatisfied =
    playerAmount === 0 || liveBlockers.every((b) => (raw[b.id] ?? 0) >= lethalFor(b));

  const division = new Map<ObjectId, number>();
  if (wellFormed && lethalSatisfied) {
    for (const id of targets) division.set(id, raw[id] ?? 0);
  } else {
    for (const id of targets) division.set(id, 0);
    division.set((liveBlockers[0] as EnginePermanent).id, power);
  }
  return division;
}

/**
 * Where the attacking player divides an attacker's combat damage among its 2+ live blockers (and,
 * with trample, the defending player) — CR 510.1c-d's actual freedom, an arbitrary split chosen
 * all at once, not the pre-2018 "damage assignment order" mechanic (obsolete — see the ADR's
 * Context section). Retimed from `declareBlockers` (ADR 0023 item 18) to fire here — right before
 * damage is computed for this step, after the priority window that follows blocker declarations —
 * instead of before that window, which could lock in a choice the board no longer matches by the
 * time damage is actually dealt. Recomputed fresh per step (not decided once for the whole
 * combat) because a blocker from the first-strike step can die before the regular step runs,
 * changing what there is to divide among.
 *
 * A single blocker also permits a choice when trample can send excess to the player:
 * the attacker may assign that excess to either recipient (CR 702.19b). No blocker,
 * a nontrampling single blocker, or insufficient power for excess is forced.
 */
function* assignDamageDivisions(
  ctx: GameContext,
  step: 'first' | 'regular',
): GameGen<DamageDivisions> {
  const divisions = new Map<ObjectId, ReadonlyMap<ObjectId, number>>();
  for (const attacker of attackers(ctx)) {
    if (!dealsInStep(ctx, attacker, step)) continue;
    const power = effectivePT(ctx, attacker).power;
    if (power <= 0) continue;
    const liveBlockers = liveBlockersOf(ctx, attacker);
    const trample = hasKeyword(ctx, attacker, 'trample');
    if (liveBlockers.length === 0) continue;
    if (liveBlockers.length === 1) {
      const blocker = liveBlockers[0]!;
      const remaining = Math.max(0, effectivePT(ctx, blocker).toughness - blocker.damageMarked);
      const lethal = blocker.damagedByDeathtouch
        ? 0
        : hasKeyword(ctx, attacker, 'deathtouch')
          ? Math.min(1, remaining)
          : remaining;
      if (!trample || attacker.attacking === null || power <= lethal) continue;
    }
    const targets: ObjectId[] = liveBlockers.map((b) => b.id);
    if (trample && attacker.attacking !== null) targets.push(attacker.attacking);

    const outcome = yield {
      decisionType: 'assignCombatDamage',
      player: attacker.controllerId,
      prompt:
        `${attacker.name} (${power} power) is blocked by ${liveBlockers.length} creatures: ` +
        `divide its combat damage among them${trample ? ', or the defending player once every blocker has lethal (trample)' : ''}.`,
      options: targets.map((id) => ({
        type: 'assignDamage',
        description: `All ${power} damage to ${damageTargetName(ctx, id)}`,
        interaction: { kind: 'choice' as const },
      })),
      combatDamageSplit: { amount: power, targets },
    };
    const division = resolveDamageDivision(ctx, attacker, liveBlockers, power, targets, outcome);
    divisions.set(attacker.id, division);
    emit(
      ctx,
      'damageAssignmentDivision',
      {
        attacker: attacker.name,
        step,
        split: Object.fromEntries(division),
        // The division as applied — after `resolveDamageDivision`'s fallback — with names, so
        // the log narrates what actually happened rather than whichever preset option the
        // response's `actionId` happened to name.
        assignments: [...division]
          .filter(([, amount]) => amount > 0)
          .map(([id, amount]) => ({ target: damageTargetName(ctx, id), amount })),
      },
      attacker.controllerId,
    );
  }
  return divisions;
}

/**
 * The blockers still blocking `attacker`. `blockedByOrdered` is the full history of who blocked
 * it, because an attacker stays blocked even once every blocker has died or been removed from
 * combat (CR 509.1h, 506.4) — only the blockers still on the battlefield and still blocking it
 * can receive its damage.
 */
function liveBlockersOf(ctx: GameContext, attacker: EnginePermanent): EnginePermanent[] {
  return attacker.blockedByOrdered
    .map((id) => findPermanent(ctx, id))
    .filter((b): b is EnginePermanent => b !== undefined && b.blocking === attacker.id);
}

/** A combat-damage division target's display name: a blocker's card name, or a player id. */
export function damageTargetName(ctx: GameContext, id: ObjectId): string {
  return findPermanent(ctx, id)?.name ?? id;
}

/**
 * "2 to Wall of Omens, 1 to Goblin" — a submitted `combatDamageSplit`, for the decision log. The
 * engine may still reject a malformed split (see `resolveDamageDivision`); the
 * `damageAssignmentDivision` event that follows records the division actually applied.
 */
export function describeDamageSplit(
  ctx: GameContext,
  amount: number,
  split: Readonly<Record<ObjectId, number>>,
): string {
  const parts = Object.entries(split)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} to ${damageTargetName(ctx, id)}`);
  return `Divide ${amount} damage: ${parts.length > 0 ? parts.join(', ') : 'none assigned'}`;
}

interface DamageAssignment {
  source: EnginePermanent;
  targetCreature: EnginePermanent | null;
  targetPlayer: PlayerId | null;
  amount: number;
}

/**
 * Does this creature deal damage in the given combat damage step? (CR 510.4/510.5)
 *
 * The second step is for creatures that had neither first strike nor double strike as the first
 * combat damage step began, plus whatever has double strike now — so gaining first strike after
 * the first step doesn't stop a creature dealing damage, and losing it doesn't let a first
 * striker deal damage twice (CR 702.7c). `dealtFirstStrikeDamage` records the former set.
 */
function dealsInStep(ctx: GameContext, perm: EnginePermanent, step: 'first' | 'regular'): boolean {
  const dbl = hasKeyword(ctx, perm, 'double strike');
  if (step === 'first') return dbl || hasKeyword(ctx, perm, 'first strike');
  return dbl || !perm.dealtFirstStrikeDamage;
}

/** Remember who has first/double strike as the first combat damage step begins (CR 510.4). */
function markFirstStrikeCombatants(ctx: GameContext): void {
  for (const perm of [...attackers(ctx), ...blockersInCombat(ctx)]) {
    if (dealsInStep(ctx, perm, 'first')) perm.dealtFirstStrikeDamage = true;
  }
}

/**
 * Compute and deal all combat damage for one damage step simultaneously (CR 510.2). `divisions`
 * is `assignDamageDivisions`'s output — the arbitrary split for every attacker with 2+ live
 * blockers (CR 510.1c-d); everything else (0 or 1 live blocker) is a forced case with nothing to
 * look up, handled inline exactly as CR 510.1c and trample (702.19b) dictate.
 */
function dealCombatDamage(
  ctx: GameContext,
  step: 'first' | 'regular',
  divisions: DamageDivisions,
): void {
  const assignments: DamageAssignment[] = [];

  for (const attacker of attackers(ctx)) {
    if (!dealsInStep(ctx, attacker, step)) continue;
    const power = effectivePT(ctx, attacker).power;
    if (power <= 0) continue;
    const deathtouch = hasKeyword(ctx, attacker, 'deathtouch');
    const trample = hasKeyword(ctx, attacker, 'trample');

    const liveBlockers = liveBlockersOf(ctx, attacker);
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

    const division = divisions.get(attacker.id);
    if (division !== undefined) {
      // 2+ live blockers: use the chosen arbitrary division exactly (CR 510.1c) — including,
      // with trample, however much of it (if any) the controller sent to the defending player.
      for (const blocker of liveBlockers) {
        const amount = division.get(blocker.id) ?? 0;
        if (amount > 0) {
          assignments.push({
            source: attacker,
            targetCreature: blocker,
            targetPlayer: null,
            amount,
          });
        }
      }
      const playerAmount =
        attacker.attacking === null ? 0 : (division.get(attacker.attacking) ?? 0);
      if (playerAmount > 0 && attacker.attacking !== null) {
        assignments.push({
          source: attacker,
          targetCreature: null,
          targetPlayer: attacker.attacking,
          amount: playerAmount,
        });
      }
      continue;
    }

    // Remaining 0/1-blocker cases are forced; any trample excess choice was handled above.
    // With zero live blockers, trample sends all remaining damage to the defending player once the
    // blocker is gone — even if that happened in the first-strike step and this is the regular step.
    const [only] = liveBlockers;
    if (only !== undefined) {
      const bpt = effectivePT(ctx, only);
      const remaining = Math.max(0, bpt.toughness - only.damageMarked);
      const lethal = only.damagedByDeathtouch ? 0 : deathtouch ? Math.min(1, remaining) : remaining;
      const toBlocker = trample ? Math.min(power, lethal) : power;
      assignments.push({
        source: attacker,
        targetCreature: only,
        targetPlayer: null,
        amount: toBlocker,
      });
      const excess = power - toBlocker;
      if (excess > 0 && trample && attacker.attacking !== null) {
        assignments.push({
          source: attacker,
          targetCreature: null,
          targetPlayer: attacker.attacking,
          amount: excess,
        });
      }
    } else if (trample && attacker.attacking !== null) {
      assignments.push({
        source: attacker,
        targetCreature: null,
        targetPlayer: attacker.attacking,
        amount: power,
      });
    }
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
        sourceHasInfect: traits.infect,
        sourceColors: traits.colors,
      });
    } else if (a.targetPlayer !== null) {
      const dealt = dealDamageToPlayer(
        ctx,
        permanentSource(a.source),
        playerById(ctx, a.targetPlayer),
        a.amount,
        {
          combat: true,
          sourceIsCommander: a.source.isCommander,
          sourceHasLifelink: traits.lifelink,
          sourceHasInfect: traits.infect,
        },
      );
      // Prevented damage was never dealt: no "deals combat damage to a player" trigger, and no
      // monarch steal (CR 725.2 — "whenever a creature deals combat damage to the monarch").
      if (dealt <= 0) continue;
      damageToPlayers.set(a.source, (damageToPlayers.get(a.source) ?? 0) + dealt);
      if (
        ctx.state.monarchPlayerId === a.targetPlayer &&
        a.source.controllerId !== a.targetPlayer
      ) {
        ctx.state.monarchPlayerId = a.source.controllerId;
        emit(ctx, 'monarch', { player: a.source.controllerId }, a.source.controllerId);
      }
    }
  }

  queueTriggersForEvent(
    ctx,
    'dealsCombatDamageToPlayer',
    [...damageToPlayers].map(([permanent, amount]) => ({
      permanent,
      amount,
      playerId: permanent.attacking ?? undefined,
    })),
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
      markFirstStrikeCombatants(ctx);
      const firstDivisions = yield* assignDamageDivisions(ctx, 'first');
      dealCombatDamage(ctx, 'first', firstDivisions);
      yield* runPrioritySequence(ctx);
      emptyManaPools(ctx);
    }

    setStep(ctx, 'combatDamage');
    const regularDivisions = yield* assignDamageDivisions(ctx, 'regular');
    dealCombatDamage(ctx, 'regular', regularDivisions);
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx);
  }

  setStep(ctx, 'endCombat');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);
  endCombatCleanup(ctx);
}
