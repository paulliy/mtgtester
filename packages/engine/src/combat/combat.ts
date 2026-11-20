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
import { ATTACKS_TARGET, NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import type { DecisionOutcome, EngineActionOption, GameGen } from '../decisions';
import {
  combatDamageTraits,
  dealCombatDamageToPlaneswalker,
  dealDamageToCreature,
  dealDamageToPlayer,
  gainLife,
  flushDamageReflections,
  permanentSource,
} from '../effects/resolve';
import { computeCharacteristics, matchesSelector } from '../effects/continuous';
import { payLife, payManaCost } from '../effects/resolve';
import { canPay, emptyCost, totalPips } from '../mana/cost';
import type { ManaSource, ParsedManaCost } from '../mana/cost';
import { emit, debug } from '../log/log';
import { counterCount } from '../state/counters';
import { playerLifeLocked } from '../state/phasing';
import {
  playerById,
  queueAttackDeclarationTriggers,
  queueTriggersForEvent,
  queueTriggersForObject,
  retainAttackDefender,
} from '../state/objects';
import {
  attackedPlaneswalker,
  controlledPermanents,
  effectivePT,
  findPermanent,
  hasKeyword,
  hasProtectionFrom,
  isAttackingPlayer,
  isCreaturePermanent,
  playersInApnapOrder,
  opponentsOf,
  allowanceFor,
  gatherRuleStatics,
  manaSourcesFor,
  nearestOpponentInDirection,
  triggersOf,
} from '../state/queries';
import type { RuleStaticEntry } from '../state/queries';
import type { KeywordAbility } from '../cards/ability';
import { evaluateCondition } from '../cards/condition';
import type {
  AttackRequirementEntry,
  AttackRequirementRule,
  CombatChoiceEntry,
  EnginePermanent,
  EnginePlayerState,
  GameContext,
} from '../state/types';
import { emptyManaPools, runPrioritySequence } from '../turn/priority';
import { queueStepTriggers } from '../turn/turn';

function setStep(ctx: GameContext, step: NonNullable<GameContext['state']['step']>): void {
  ctx.state.step = step;
  emit(ctx, 'stepBegin', { step });
  debug(ctx, 'turn', `step: ${step}`);
}

function creaturesOf(ctx: GameContext, playerId: PlayerId): EnginePermanent[] {
  return controlledPermanents(ctx, playerId).filter((p) => isCreaturePermanent(ctx, p));
}

/**
 * The players whose goad applies to this creature. A goad outlasts a goader who left the game
 * until their next turn would have begun (CR 800.4m); the stored entry carries that expiry.
 */
function goaderIdsFor(ctx: GameContext, creature: EnginePermanent): Set<PlayerId> {
  const chars = computeCharacteristics(ctx, creature);
  return new Set([
    ...(creature.goadedBy ?? []).map((requirement) => requirement.goaderId),
    ...(chars.staticGoadedBy ?? []),
  ]);
}

/** Does attacking this target obey one attack requirement (CR 508.1d)? */
type AttackRequirement = (target: AttackTarget) => boolean;

/** "Attacks each combat if able": any attack at all, a planeswalker included. */
const attacksAnything: AttackRequirement = () => true;
/** "Attacks a player other than P if able": a player, never a planeswalker. */
const attacksPlayerOtherThan =
  (playerId: PlayerId): AttackRequirement =>
  (target) =>
    target.planeswalker === null && target.player.id !== playerId;
/** "Attacks P if able": that player, never one of their planeswalkers. */
const attacksPlayer =
  (playerId: PlayerId): AttackRequirement =>
  (target) =>
    target.planeswalker === null && target.player.id === playerId;

/** "Attacks one of these players if able": a player, never a planeswalker. */
const attacksOneOf =
  (playerIds: readonly PlayerId[]): AttackRequirement =>
  (target) =>
    target.planeswalker === null && playerIds.includes(target.player.id);

function requirementOf(rule: AttackRequirementRule): AttackRequirement {
  switch (rule.kind) {
    case 'anyAttack':
      return attacksAnything;
    case 'notPlayer':
      return attacksPlayerOtherThan(rule.playerId);
    case 'player':
      return attacksPlayer(rule.playerId);
  }
}

/**
 * The stored requirement entries that apply to `creature` right now: naming it (or matching their
 * live selector, CR 611.2c), and, for one that lasts "that combat", only while that combat is the
 * one being run. An entry outlasts a controller who left the game for as long as its expiry says
 * (CR 800.4m).
 */
function activeRequirementEntries(
  ctx: GameContext,
  creature: EnginePermanent,
): AttackRequirementEntry[] {
  return (ctx.state.attackRequirements ?? []).filter((entry) => {
    if (entry.expires.kind === 'combat' && ctx.state.currentCombatId !== entry.expires.combatId)
      return false;
    // "During their next turn": only while that player is the active player in that turn.
    if (
      entry.expires.kind === 'theirNextTurn' &&
      (ctx.state.currentTurnPlayer !== entry.expires.playerId ||
        ctx.state.turnNumber <= entry.expires.setTurn)
    )
      return false;
    return entry.affects.kind === 'objects'
      ? entry.affects.objectIds.includes(creature.id)
      : matchesSelector(ctx, creature, entry.affects.selector, {
          cardId: entry.sourceCardId ?? '',
          controllerId: entry.affects.viewpointId ?? entry.controllerId,
        });
  });
}

/**
 * Every attack requirement on this creature: goads (each also an "attacks each combat"), the
 * plain "attacks each combat if able" flags and statics, and the requirements stored by resolved
 * spells and abilities whose affected set includes it (CR 611.2c). An effect whose controller has
 * left the game no longer applies (CR 800.4a).
 */
function attackRequirementsFor(ctx: GameContext, creature: EnginePermanent): AttackRequirement[] {
  const chars = computeCharacteristics(ctx, creature);
  const goaders = goaderIdsFor(ctx, creature);
  const requirements: AttackRequirement[] = [];
  if (
    goaders.size > 0 ||
    creature.mustAttackThisTurn === true ||
    chars.mustAttackEachCombat === true
  )
    requirements.push(attacksAnything);
  for (const goaderId of goaders) requirements.push(attacksPlayerOtherThan(goaderId));
  for (const entry of activeRequirementEntries(ctx, creature))
    for (const rule of entry.requirements) requirements.push(requirementOf(rule));
  // "Attacks an opponent with the most life among your opponents each combat if able" (Galactus).
  for (const entry of gatherRuleStatics(ctx)) {
    if (entry.static.kind !== 'attackRequirement' || entry.sourceCardId !== creature.cardId)
      continue;
    const source = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
    if (entry.static.unless !== undefined && evaluateCondition(ctx, entry.static.unless, source))
      continue;
    const opponents = opponentsOf(ctx, entry.controllerId);
    const most = Math.max(...opponents.map((opponent) => opponent.life));
    requirements.push(
      attacksOneOf(opponents.filter((opponent) => opponent.life === most).map((p) => p.id)),
    );
  }
  return requirements;
}

const requirementsObeyed = (requirements: readonly AttackRequirement[], target: AttackTarget) =>
  requirements.filter((requirement) => requirement(target)).length;

/**
 * "Can't attack alone" / "can't block alone" (Toby's Beast token, CR 506.5): a creature with the
 * rule static, read off the creature itself (the static's source).
 */
function cantActAlone(
  ctx: GameContext,
  creature: EnginePermanent,
  kind: 'cantAttackAlone' | 'cantBlockAlone',
): boolean {
  return gatherRuleStatics(ctx).some(
    (entry) => entry.static.kind === kind && entry.sourceCardId === creature.cardId,
  );
}

/**
 * Does a rule static require this player, as an opponent of its controller, to attack with every
 * creature that can attack for free once any creature attacks (War's Toll)?
 */
function attacksWithAll(ctx: GameContext, attackingPlayerId: PlayerId): boolean {
  return gatherRuleStatics(ctx).some(
    (entry) =>
      entry.static.kind === 'opponentsAttackWithAll' &&
      entry.controllerId !== attackingPlayerId &&
      !playerById(ctx, entry.controllerId).hasLost,
  );
}

/** How many creatures must block this attacker together if any do, beyond menace's two. */
function minBlockersOf(ctx: GameContext, attacker: EnginePermanent): number {
  return gatherRuleStatics(ctx).reduce(
    (most, entry) =>
      entry.static.kind === 'minBlockers' && entry.sourceCardId === attacker.cardId
        ? Math.max(most, entry.static.minimum)
        : most,
    0,
  );
}

function canAttack(ctx: GameContext, perm: EnginePermanent): boolean {
  if (perm.tapped) return false;
  if (hasKeyword(ctx, perm, 'defender')) return false;
  if (perm.summoningSick && !hasKeyword(ctx, perm, 'haste')) return false;
  return true;
}

/**
 * What a creature attacks (CR 508.1b): a player, or a planeswalker that player controls. Tax
 * statics are scoped to one or both — Ghostly Prison and Propaganda tax only attacks on their
 * controller, Norn's Annex also taxes attacks on that player's planeswalkers.
 */
interface AttackTarget {
  player: EnginePlayerState;
  planeswalker: EnginePermanent | null;
}

/** The chosen attack, resolved to its defending player and planeswalker. */
interface AttackChoice {
  defenderId: PlayerId;
  planeswalkerId: ObjectId | null;
}

function attackTaxApplies(
  entry: { controllerId: PlayerId; static: { kind: string; includePlaneswalkers?: boolean } },
  defendingPlayerId: PlayerId,
  atPlaneswalker: boolean,
): boolean {
  return (
    entry.controllerId === defendingPlayerId &&
    entry.static.kind === 'attackTax' &&
    (!atPlaneswalker || entry.static.includePlaneswalkers === true)
  );
}

/**
 * Does `creature` match this "can't attack you or planeswalkers you control" static, read from the
 * static controller's point of view (Combat Calligrapher, Eriette, Rite of the Raging Storm,
 * Nils)? The static is about attacks on its controller, and on their planeswalkers.
 */
function attackRestrictionApplies(
  ctx: GameContext,
  entry: RuleStaticEntry,
  creature: EnginePermanent,
  defendingPlayerId: PlayerId,
): boolean {
  return (
    entry.static.kind === 'attackRestriction' &&
    entry.controllerId === defendingPlayerId &&
    matchesSelector(ctx, creature, entry.static.filter, {
      cardId: entry.sourceCardId,
      controllerId: entry.controllerId,
    })
  );
}

/**
 * What `creature` pays to attack this defender (CR 508.1g): the flat tax, and, for a conditional
 * restriction (Nils), one generic mana for each counter of any kind on that creature.
 */
function attackTax(
  ctx: GameContext,
  defendingPlayerId: PlayerId,
  atPlaneswalker: boolean,
  creature: EnginePermanent,
): number {
  return gatherRuleStatics(ctx).reduce((total, entry) => {
    if (entry.static.kind === 'attackRestriction') {
      if (
        entry.static.cost === undefined ||
        !attackRestrictionApplies(ctx, entry, creature, defendingPlayerId)
      )
        return total;
      return (
        total + Object.values(creature.counters).reduce((sum, count) => sum + Math.max(0, count), 0)
      );
    }
    if (!attackTaxApplies(entry, defendingPlayerId, atPlaneswalker)) return total;
    return entry.static.kind === 'attackTax' ? total + entry.static.amount : total;
  }, 0);
}

/** The joint cost of these creatures all attacking the same defender (CR 508.1g-h). */
function attackCost(
  ctx: GameContext,
  defendingPlayerId: PlayerId,
  atPlaneswalker: boolean,
  creatures: readonly EnginePermanent[],
): ParsedManaCost {
  const cost = {
    ...emptyCost(),
    generic: creatures.reduce(
      (total, creature) => total + attackTax(ctx, defendingPlayerId, atPlaneswalker, creature),
      0,
    ),
  };
  const phyrexian = gatherRuleStatics(ctx).flatMap((entry) => {
    if (
      !attackTaxApplies(entry, defendingPlayerId, atPlaneswalker) ||
      entry.static.kind !== 'attackTax' ||
      entry.static.phyrexianColor === undefined
    ) {
      return [];
    }
    const color = entry.static.phyrexianColor;
    return creatures.map(() => color);
  });
  return phyrexian.length > 0 ? { ...cost, phyrexian } : cost;
}

/**
 * Life each creature attacking this defender, or a planeswalker they control, pays (Sivitri,
 * Dragon Master's +1). A resolved effect rather than a static, so it outlasts its source.
 */
function attackLifeTax(ctx: GameContext, defendingPlayerId: PlayerId): number {
  return (ctx.state.attackLifeTaxes ?? []).reduce(
    (total, entry) => (entry.controllerId === defendingPlayerId ? total + entry.amount : total),
    0,
  );
}

/** No mana and no life to attack this defender: the only attacks a requirement can force (CR 508.1d). */
function attackIsFree(
  ctx: GameContext,
  defendingPlayerId: PlayerId,
  atPlaneswalker: boolean,
  creature: EnginePermanent,
): boolean {
  return (
    totalPips(attackCost(ctx, defendingPlayerId, atPlaneswalker, [creature])) === 0 &&
    attackLifeTax(ctx, defendingPlayerId) === 0
  );
}

/**
 * Can the attacking player pay `life` in attack taxes and still pay `cost`? CR 119.4: a positive
 * life payment needs that much life, and none at all when the life total can't change. Phyrexian
 * pips may only spend the life left over.
 */
function canPayAttackCosts(
  ctx: GameContext,
  attackingPlayerId: PlayerId,
  cost: ParsedManaCost,
  life: number,
  attackers: readonly EnginePermanent[],
): boolean {
  const player = playerById(ctx, attackingPlayerId);
  if (life > 0 && (player.life < life || playerLifeLocked(ctx, attackingPlayerId))) return false;
  if (totalPips(cost) === 0) return true;
  return canPay(
    cost,
    player.manaEntries,
    withoutAttackTappedSources(manaSourcesFor(ctx, attackingPlayerId), ctx, attackers),
    allowanceFor(ctx, attackingPlayerId, { kind: 'other' }),
    player.life - life,
  );
}

/** Does declaring this creature as an attacker tap it (CR 508.1f)? The one predicate `commitAttacker` uses. */
function attackerTaps(ctx: GameContext, creature: EnginePermanent): boolean {
  return !hasKeyword(ctx, creature, 'vigilance');
}

/**
 * Card ids of the attackers that the attack itself taps and that have a `{T}` mana ability among
 * `sources`. CR 508.1f taps the declared attackers before 508.1g/h pay the attack costs, so such a
 * creature cannot pay with that ability. The check (`canPayAttackCosts`) and the payment
 * (`payAttackTax`, through `excludedSourceCardIds`) both use this set, so they cannot disagree.
 * Whole cards are excluded, not single abilities: `payManaCost` filters by card.
 */
function attackTappedSourceIds(
  ctx: GameContext,
  sources: readonly ManaSource[],
  attackers: readonly EnginePermanent[],
): string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.costs.some((cost) => cost.kind === 'tap')) continue;
    if (attackers.some((a) => a.cardId === source.cardId && attackerTaps(ctx, a)))
      ids.add(source.cardId);
  }
  return [...ids];
}

function withoutAttackTappedSources(
  sources: ManaSource[],
  ctx: GameContext,
  attackers: readonly EnginePermanent[],
): ManaSource[] {
  const excluded = new Set(attackTappedSourceIds(ctx, sources, attackers));
  return sources.filter((source) => !excluded.has(source.cardId));
}

/**
 * Can this ONE creature alone afford to attack this defender? Per-creature restriction/cost
 * legality (item 15) — never the whole proposed set's joint cost, which several creatures
 * sharing one taxed defender can still fail even when each individually passes this check
 * (`validateAttackDeclaration`, run once the whole declaration is known — item 14).
 */
function canPayAttackTax(
  ctx: GameContext,
  creature: EnginePermanent,
  defendingPlayerId: PlayerId,
  atPlaneswalker: boolean,
): boolean {
  return canPayAttackCosts(
    ctx,
    creature.controllerId,
    attackCost(ctx, defendingPlayerId, atPlaneswalker, [creature]),
    attackLifeTax(ctx, defendingPlayerId),
    [creature],
  );
}

/** Every player this creature's controller could attack, and every planeswalker they control (CR 508.1b). */
function allAttackTargets(
  ctx: GameContext,
  opponents: readonly EnginePlayerState[],
): AttackTarget[] {
  return opponents.flatMap((player) => [
    { player, planeswalker: null },
    ...controlledPermanents(ctx, player.id)
      .filter((p) => computeCharacteristics(ctx, p).types.includes('Planeswalker'))
      .map((planeswalker) => ({ player, planeswalker })),
  ]);
}

/**
 * Hard attack restrictions (CR 508.1c), which always win over a requirement. Promise of Loyalty:
 * "Those creatures can't attack you or planeswalkers you control for as long as they have a vow
 * counter on them." And the statics that say the same of whatever matches a filter (Combat
 * Calligrapher's Inklings, creatures enchanted by an Aura Eriette's controller controls, creatures
 * named Lightning Rager): each covers the player and every planeswalker that player controls.
 * Only the unconditional ones forbid; one with a cost is a tax (`attackTax`), never a ban. Pramikon's
 * seat rule also forbids, for every target but the nearest opponent in its direction.
 */
function attackRestrictionAllows(
  ctx: GameContext,
  creature: EnginePermanent,
  target: AttackTarget,
): boolean {
  if (
    (creature.cantAttackPlayerWhileCounter ?? []).some(
      (restriction) =>
        restriction.playerId === target.player.id &&
        counterCount(creature.counters, restriction.counter) > 0,
    )
  )
    return false;
  // "Can't attack you or planeswalkers you control" from a resolved spell (Illusionist's Gambit).
  // "Only creatures in the chosen pile can attack" (Fight or Flight) bars everything outside it.
  if (
    activeRequirementEntries(ctx, creature).some((entry) =>
      (entry.restrictions ?? []).some((rule) =>
        rule.kind === 'cantAttackExcept'
          ? !rule.objectIds.includes(creature.id)
          : rule.playerId === target.player.id,
      ),
    )
  )
    return false;
  // Teyo's −2: every player's attacks are limited to the nearest opponent in a direction.
  if (
    (ctx.state.attackDirections ?? []).some(
      (entry) => !isNearestOpponent(ctx, creature, target, entry.direction),
    )
  )
    return false;
  return !gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind === 'cantAttackOwner')
      return (
        entry.sourceCardId === creature.cardId &&
        target.planeswalker === null &&
        target.player.id === creature.ownerId
      );
    if (entry.static.kind === 'attackOnlyNearestOpponent') {
      const direction = ctx.state.battlefield.find(
        (perm) => perm.cardId === entry.sourceCardId,
      )?.chosenOption;
      // A source with no direction chosen restricts nothing.
      return (
        (direction === 'left' || direction === 'right') &&
        !isNearestOpponent(ctx, creature, target, direction)
      );
    }
    return (
      entry.static.kind === 'attackRestriction' &&
      entry.static.cost === undefined &&
      attackRestrictionApplies(ctx, entry, creature, target.player.id)
    );
  });
}

/**
 * "Each player may attack only the nearest opponent in the chosen direction and planeswalkers
 * controlled by that opponent" (Pramikon, Teyo): is this target that opponent or one of their
 * planeswalkers, for `creature`'s controller?
 */
function isNearestOpponent(
  ctx: GameContext,
  creature: EnginePermanent,
  target: AttackTarget,
  direction: 'left' | 'right',
): boolean {
  return nearestOpponentInDirection(ctx, creature.controllerId, direction)?.id === target.player.id;
}

/**
 * Restrict `candidates` to targets obeying the maximum number of requirements achievable among
 * the FREE targets (CR 508.1d: a cost never forces the player to obey an additional
 * requirement, so cost-gated targets never raise the maximum). Attacking a PLAYER P obeys each
 * goader's "other than" requirement except P's own; attacking a planeswalker obeys only the plain
 * "attacks each combat" ones.
 */
function applyRequirementScope(
  ctx: GameContext,
  creature: EnginePermanent,
  candidates: AttackTarget[],
  free: readonly AttackTarget[],
): AttackTarget[] {
  const requirements = attackRequirementsFor(ctx, creature);
  if (requirements.length === 0) return candidates;
  const maximum = Math.max(0, ...free.map((t) => requirementsObeyed(requirements, t)));
  return candidates.filter((t) => requirementsObeyed(requirements, t) >= maximum);
}

function attackTargetsFor(
  ctx: GameContext,
  creature: EnginePermanent,
  opponents: readonly EnginePlayerState[],
): AttackTarget[] {
  const allowed = allAttackTargets(ctx, opponents).filter((t) =>
    attackRestrictionAllows(ctx, creature, t),
  );
  const payable = allowed.filter((t) =>
    canPayAttackTax(ctx, creature, t.player.id, t.planeswalker !== null),
  );
  const free = allowed.filter((t) =>
    attackIsFree(ctx, t.player.id, t.planeswalker !== null, creature),
  );
  return applyRequirementScope(ctx, creature, payable, free);
}

/**
 * Targets this creature could attack **for free** — used only to decide whether a goad
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
): AttackTarget[] {
  const free = allAttackTargets(ctx, opponents).filter(
    (t) =>
      attackRestrictionAllows(ctx, creature, t) &&
      attackIsFree(ctx, t.player.id, t.planeswalker !== null, creature),
  );
  return applyRequirementScope(ctx, creature, free, free);
}

/**
 * The free targets this creature must attack one of (CR 508.1d), or none when no requirement can
 * be obeyed at all: attacking has to obey the maximum number of requirements it can, and a
 * creature none of whose requirements any free attack would obey (it must attack a player it
 * can't attack) is not required to attack.
 */
function requiredAttackTargets(
  ctx: GameContext,
  creature: EnginePermanent,
  opponents: readonly EnginePlayerState[],
): AttackTarget[] {
  const requirements = attackRequirementsFor(ctx, creature);
  if (requirements.length === 0) return [];
  const free = allAttackTargets(ctx, opponents).filter(
    (t) =>
      attackRestrictionAllows(ctx, creature, t) &&
      attackIsFree(ctx, t.player.id, t.planeswalker !== null, creature),
  );
  const maximum = Math.max(0, ...free.map((t) => requirementsObeyed(requirements, t)));
  return maximum === 0 ? [] : free.filter((t) => requirementsObeyed(requirements, t) >= maximum);
}

function* payAttackTax(
  ctx: GameContext,
  attackingPlayerId: PlayerId,
  defendingPlayerId: PlayerId,
  atPlaneswalker: boolean,
  creatures: readonly EnginePermanent[],
  /** Every creature in the declaration: the ones tapped by attacking can't pay with `{T}`. */
  declared: readonly EnginePermanent[],
): GameGen<void> {
  const cost = attackCost(ctx, defendingPlayerId, atPlaneswalker, creatures);
  const life = attackLifeTax(ctx, defendingPlayerId) * creatures.length;
  // The life is paid first, so Phyrexian pips can only spend what is left (CR 601.2h).
  if (life > 0) payLife(ctx, playerById(ctx, attackingPlayerId), life);
  if (totalPips(cost) === 0) return;
  yield* payManaCost(
    ctx,
    playerById(ctx, attackingPlayerId),
    cost,
    { kind: 'other' },
    attackTappedSourceIds(ctx, manaSourcesFor(ctx, attackingPlayerId), declared),
  );
}

/** Evasion check: may `blocker` block `attacker`? (flying/reach, protection — CR 509.1b.) */
function canBlock(ctx: GameContext, blocker: EnginePermanent, attacker: EnginePermanent): boolean {
  if (blocker.tapped || blocker.cantBlock === true || attacker.cantBeBlocked === true) return false;
  if (computeCharacteristics(ctx, attacker).cantBeBlocked) return false;
  if (ctx.state.creaturesCantBeBlockedThisTurn) return false;
  // "Those creatures can't block" until a player's next turn (Taunt from the Rampart).
  if ((ctx.state.blockRestrictions ?? []).some((entry) => entry.objectIds.includes(blocker.id)))
    return false;
  // "Creatures with power less than this creature's power can't block creatures you control"
  // (Champion of Lambholt): a rule static of the source, read against its CURRENT power.
  for (const entry of gatherRuleStatics(ctx)) {
    if (
      entry.static.kind === 'cantBlockMatching' &&
      matchesSelector(ctx, blocker, entry.static.filter, {
        cardId: entry.sourceCardId,
        controllerId: entry.controllerId,
      })
    )
      return false;
    if (entry.static.kind !== 'cantBlockCreatures') continue;
    const source = ctx.state.battlefield.find((perm) => perm.cardId === entry.sourceCardId);
    if (source === undefined) continue;
    if (
      matchesSelector(ctx, attacker, entry.static.attackerFilter, {
        cardId: entry.sourceCardId,
        controllerId: entry.controllerId,
      }) &&
      effectivePT(ctx, blocker).power < effectivePT(ctx, source).power
    )
      return false;
  }
  if (
    ctx.state.effects.some(
      (effect) => effect.kind === 'cantBeBlocked' && effect.targetCardIds.includes(attacker.cardId),
    )
  )
    return false;
  // Protection (CR 702.16), the B in DEBT: an attacker with protection from the blocker
  // (its colors, or creatures) cannot be blocked by it.
  if (hasProtectionFrom(ctx, attacker, computeCharacteristics(ctx, blocker))) return false;
  if (hasKeyword(ctx, attacker, 'flying')) {
    if (!hasKeyword(ctx, blocker, 'flying') && !hasKeyword(ctx, blocker, 'reach')) return false;
  }
  if (!evasionAllows(ctx, blocker, attacker)) return false;
  return blockRestrictionsAllow(ctx, blocker, attacker);
}

/** Basic landwalk keywords and the land subtype each one looks for (CR 702.14c). */
const LANDWALK: readonly (readonly [KeywordAbility, string])[] = [
  ['plainswalk', 'Plains'],
  ['islandwalk', 'Island'],
  ['swampwalk', 'Swamp'],
  ['mountainwalk', 'Mountain'],
  ['forestwalk', 'Forest'],
];

/**
 * The evasion keywords other than flying, read as blockers are declared (CR 509.1b): fear
 * (702.36b), intimidate (702.13b), skulk (702.118b), shadow both ways (702.28b) and landwalk
 * against the lands of the player the attacker attacks, or the controller of the planeswalker it
 * attacks (702.14c; a nonbasic Island counts as an Island).
 */
function evasionAllows(
  ctx: GameContext,
  blocker: EnginePermanent,
  attacker: EnginePermanent,
): boolean {
  const a = computeCharacteristics(ctx, attacker);
  const b = computeCharacteristics(ctx, blocker);
  if (a.keywords.includes('shadow') !== b.keywords.includes('shadow')) return false;
  const artifactBlocker = b.types.includes('Artifact');
  if (a.keywords.includes('fear') && !artifactBlocker && !b.colors.includes('B')) return false;
  if (
    a.keywords.includes('intimidate') &&
    !artifactBlocker &&
    !b.colors.some((color) => a.colors.includes(color))
  )
    return false;
  if (a.keywords.includes('skulk') && b.power > a.power) return false;
  const walks = LANDWALK.filter(([keyword]) => a.keywords.includes(keyword));
  const nonbasicWalk = a.keywords.includes('nonbasic landwalk');
  if ((walks.length > 0 || nonbasicWalk) && attacker.attacking !== null) {
    for (const land of controlledPermanents(ctx, attacker.attacking)) {
      const chars = computeCharacteristics(ctx, land);
      if (!chars.types.includes('Land')) continue;
      if (walks.some(([, subtype]) => chars.subtypes.includes(subtype))) return false;
      if (nonbasicWalk && !chars.supertypes.includes('Basic')) return false;
    }
  }
  return true;
}

/** The selector view of a rule static's source, with the creature it is attached to. */
function ruleStaticView(
  ctx: GameContext,
  entry: RuleStaticEntry,
): { cardId: string; controllerId: PlayerId; attachedToCardId?: string } {
  const source = ctx.state.battlefield.find((perm) => perm.cardId === entry.sourceCardId);
  const attachedToCardId =
    source === undefined || source.attachedTo === null
      ? undefined
      : ctx.state.battlefield.find((perm) => perm.id === source.attachedTo)?.cardId;
  return {
    cardId: entry.sourceCardId,
    controllerId: entry.controllerId,
    ...(attachedToCardId !== undefined ? { attachedToCardId } : {}),
  };
}

/** `blockRestriction` rule statics (Prowler's Helm, Steel Leaf Champion, Ant-Man), per blocker. */
function blockRestrictionsAllow(
  ctx: GameContext,
  blocker: EnginePermanent,
  attacker: EnginePermanent,
): boolean {
  for (const entry of gatherRuleStatics(ctx)) {
    const rule = entry.static;
    if (rule.kind !== 'blockRestriction') continue;
    const view = ruleStaticView(ctx, entry);
    if (!matchesSelector(ctx, attacker, rule.attackers, view)) continue;
    if (rule.onlyBy !== undefined && !matchesSelector(ctx, blocker, rule.onlyBy, view))
      return false;
    if (rule.notBy !== undefined && matchesSelector(ctx, blocker, rule.notBy, view)) return false;
    if (
      rule.notByGreaterPower === true &&
      effectivePT(ctx, blocker).power > effectivePT(ctx, attacker).power
    )
      return false;
  }
  return true;
}

/** "Can't be blocked by more than N creatures" (Alpha Authority): the smallest such N, or null. */
function maxBlockersOf(ctx: GameContext, attacker: EnginePermanent): number | null {
  let most: number | null = null;
  for (const entry of gatherRuleStatics(ctx)) {
    const rule = entry.static;
    if (rule.kind !== 'blockRestriction' || rule.maxBlockers === undefined) continue;
    const view = ruleStaticView(ctx, entry);
    if (!matchesSelector(ctx, attacker, rule.attackers, view)) continue;
    most = most === null ? rule.maxBlockers : Math.min(most, rule.maxBlockers);
  }
  return most;
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
  choice: AttackChoice,
  apId: PlayerId,
  hadToAttack = false,
): void {
  const { defenderId, planeswalkerId } = choice;
  const planeswalker = planeswalkerId === null ? undefined : findPermanent(ctx, planeswalkerId);
  if (hadToAttack) creature.hadToAttackThisCombat = true;
  creature.attacking = defenderId;
  creature.attackingPlaneswalker = planeswalkerId;
  creature.attackedPlaneswalkerRemoved = false;
  creature.statuses.push('attacking');
  if (attackerTaps(ctx, creature)) {
    creature.tapped = true; // CR 508.1f
    queueTriggersForObject(ctx, 'becomesTapped', creature);
  }
  emit(
    ctx,
    'attack',
    {
      attacker: creature.name,
      attackerCardId: creature.cardId,
      defender: defenderId,
      ...(planeswalker !== undefined ? { planeswalker: planeswalker.name } : {}),
    },
    apId,
  );
  debug(ctx, 'combat', `${creature.name} attacks ${planeswalker?.name ?? defenderId}`);
}

/**
 * Must this creature be declared as an attacker (CR 508.1d)? It has a requirement it can obey for
 * free. A creature that can't attack alone obeys it only together with another creature that can
 * be declared for free, so with no such partner it is not required to attack: nobody has to pay an
 * attack cost to obey a requirement (CR 506.5, 508.1c, 508.1d).
 */
function mustAttackNow(
  ctx: GameContext,
  creature: EnginePermanent,
  eligible: readonly EnginePermanent[],
  opponents: readonly EnginePlayerState[],
): boolean {
  if (requiredAttackTargets(ctx, creature, opponents).length === 0) return false;
  return (
    !cantActAlone(ctx, creature, 'cantAttackAlone') ||
    eligible.some(
      (other) => other.id !== creature.id && freeAttackTargetsFor(ctx, other, opponents).length > 0,
    )
  );
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
    const mustAttack = mustAttackNow(ctx, creature, eligible, opponents);
    return {
      subjectId: creature.id,
      name: creature.name,
      power: pt.power,
      toughness: pt.toughness,
      defenders: legal
        .filter((t) => t.planeswalker === null)
        .map((t) => ({
          playerId: t.player.id,
          life: t.player.life,
          attackTax: attackTax(ctx, t.player.id, false, creature),
          ...lifeTaxField(ctx, t.player.id),
        })),
      planeswalkers: legal.flatMap((t) =>
        t.planeswalker === null
          ? []
          : [
              {
                objectId: t.planeswalker.id,
                controllerId: t.player.id,
                name: t.planeswalker.name,
                loyalty: counterCount(t.planeswalker.counters, 'loyalty'),
                attackTax: attackTax(ctx, t.player.id, true, creature),
                ...lifeTaxField(ctx, t.player.id),
              },
            ],
      ),
      mustAttack,
      hasTriggers: triggersOf(ctx, creature).length > 0,
    };
  });
}

function lifeTaxField(ctx: GameContext, defendingPlayerId: PlayerId): { attackLifeTax?: number } {
  const life = attackLifeTax(ctx, defendingPlayerId);
  return life > 0 ? { attackLifeTax: life } : {};
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
      options: [
        ...s.defenders.map((d) => d.playerId),
        ...s.planeswalkers.map((p) => p.objectId),
        ...(s.mustAttack ? [] : [NO_ATTACK_TARGET]),
      ],
    })),
  };
}

/** Read a proposed declaration back out of the outcome's per-slot target choices. A chosen
 * planeswalker id resolves to its controller as the defending player (CR 508.1b). */
function readAttackAssignment(
  ctx: GameContext,
  outcome: DecisionOutcome,
  eligible: readonly EnginePermanent[],
): Map<ObjectId, AttackChoice | null> {
  const assignment = new Map<ObjectId, AttackChoice | null>();
  for (let i = 0; i < eligible.length; i++) {
    const creature = eligible[i] as EnginePermanent;
    const chosen = outcome.targets.get(i);
    if (chosen === undefined || chosen === NO_ATTACK_TARGET) {
      assignment.set(creature.id, null);
      continue;
    }
    const planeswalker = ctx.state.players.some((p) => p.id === chosen)
      ? undefined
      : findPermanent(ctx, chosen as ObjectId);
    assignment.set(
      creature.id,
      planeswalker !== undefined
        ? { defenderId: planeswalker.controllerId, planeswalkerId: planeswalker.id }
        : { defenderId: chosen as PlayerId, planeswalkerId: null },
    );
  }
  return assignment;
}

/** Attackers sharing a defending player and whether it is a planeswalker of theirs: one tax group. */
interface AttackGroup {
  defenderId: PlayerId;
  atPlaneswalker: boolean;
  creatures: EnginePermanent[];
}

function groupByDefender(
  eligible: readonly EnginePermanent[],
  assignment: ReadonlyMap<ObjectId, AttackChoice | null>,
): AttackGroup[] {
  const groups = new Map<string, AttackGroup>();
  for (const creature of eligible) {
    const choice = assignment.get(creature.id);
    if (choice === null || choice === undefined) continue;
    const atPlaneswalker = choice.planeswalkerId !== null;
    const key = `${choice.defenderId}|${atPlaneswalker ? 'planeswalker' : 'player'}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { defenderId: choice.defenderId, atPlaneswalker, creatures: [creature] });
    } else group.creatures.push(creature);
  }
  return [...groups.values()];
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
  assignment: ReadonlyMap<ObjectId, AttackChoice | null>,
  /** False while only WHICH creatures attack is known (Master Warcraft): no defender, so no cost yet. */
  costs = true,
): CombatViolation[] {
  // CR 506.5: a creature that can't attack alone is declared only with another attacker.
  const declared = eligible.filter((creature) => (assignment.get(creature.id) ?? null) !== null);
  const lone = declared.length === 1 ? declared[0] : undefined;
  if (lone !== undefined && cantActAlone(ctx, lone, 'cantAttackAlone'))
    return [
      {
        subjectId: lone.id,
        kind: 'attackAlone',
        message: `${lone.name} can't attack alone`,
      },
    ];
  // War's Toll: once any creature attacks, every creature that can attack for free must.
  if (declared.length > 0 && attacksWithAll(ctx, attackingPlayerId)) {
    const opponents = playersInApnapOrder(ctx).filter((p) => p.id !== attackingPlayerId);
    const missing = eligible.filter(
      (creature) =>
        (assignment.get(creature.id) ?? null) === null &&
        freeAttackTargetsFor(ctx, creature, opponents).length > 0,
    );
    if (missing.length > 0)
      return missing.map((creature) => ({
        subjectId: creature.id,
        kind: 'attackWithAll' as const,
        message: `${creature.name} must attack because another creature of yours attacks`,
      }));
  }
  if (!costs) return [];
  const groups = groupByDefender(eligible, assignment);
  const totalCost = emptyCost();
  let totalLife = 0;
  for (const { defenderId, atPlaneswalker, creatures } of groups) {
    const cost = attackCost(ctx, defenderId, atPlaneswalker, creatures);
    totalCost.generic += cost.generic;
    totalCost.phyrexian = [...(totalCost.phyrexian ?? []), ...(cost.phyrexian ?? [])];
    totalLife += attackLifeTax(ctx, defenderId) * creatures.length;
  }
  if (totalPips(totalCost) === 0 && totalLife === 0) return [];
  if (canPayAttackCosts(ctx, attackingPlayerId, totalCost, totalLife, declared)) return [];
  const violations: CombatViolation[] = [];
  for (const { defenderId, atPlaneswalker, creatures } of groups) {
    for (const creature of creatures) {
      if (attackIsFree(ctx, defenderId, atPlaneswalker, creature)) continue;
      violations.push({
        subjectId: creature.id,
        kind: 'attackTax',
        message: `Not enough mana or life to pay the combined attack tax for every creature attacking ${
          atPlaneswalker ? `${defenderId}'s planeswalkers` : defenderId
        } at once`,
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
  assignment: ReadonlyMap<ObjectId, AttackChoice | null>,
): GameGen<void> {
  const declared = eligible.filter((creature) => (assignment.get(creature.id) ?? null) !== null);
  for (const { defenderId, atPlaneswalker, creatures } of groupByDefender(eligible, assignment)) {
    // The costs are paid as if every attacker were already tapped (CR 508.1f -> 508.1h), while
    // events and triggers keep their order: pay, then commit, group by group.
    yield* payAttackTax(ctx, ap.id, defenderId, atPlaneswalker, creatures, declared);
    // War's Toll: every attacker that could attack for free was required to (Firkraag reads it).
    const allMustAttack = attacksWithAll(ctx, ap.id);
    for (const creature of creatures) {
      const hadToAttack =
        mustAttackNow(ctx, creature, eligible, opponents) ||
        (allMustAttack && freeAttackTargetsFor(ctx, creature, opponents).length > 0);
      commitAttacker(
        ctx,
        creature,
        assignment.get(creature.id) as AttackChoice,
        ap.id,
        hadToAttack,
      );
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
  assignment: ReadonlyMap<ObjectId, AttackChoice | null>,
  costs = true,
): Map<ObjectId, AttackChoice | null> {
  const repaired = new Map(assignment);
  let violations = validateAttackDeclaration(ctx, attackingPlayerId, eligible, repaired, costs);
  let guard = eligible.length + 1;
  while (violations.length > 0 && guard-- > 0) {
    // A creature that can't attack alone, declared alone (CR 506.5): when it has a requirement
    // the declaration has to obey (CR 508.1d), another creature joins it; otherwise it stands down.
    const alone = violations.find((v) => v.kind === 'attackAlone');
    if (alone !== undefined) {
      const lone = eligible.find((c) => c.id === alone.subjectId) as EnginePermanent;
      const partner = mustAttackNow(ctx, lone, eligible, opponents)
        ? eligible
            .filter((c) => c.id !== lone.id && freeAttackTargetsFor(ctx, c, opponents).length > 0)
            .sort(
              (a, b) =>
                effectivePT(ctx, a).power - effectivePT(ctx, b).power || a.id.localeCompare(b.id),
            )[0]
        : undefined;
      const target =
        partner === undefined ? undefined : freeAttackTargetsFor(ctx, partner, opponents)[0];
      if (partner !== undefined && target !== undefined)
        repaired.set(partner.id, {
          defenderId: target.player.id,
          planeswalkerId: target.planeswalker?.id ?? null,
        });
      else repaired.set(lone.id, null);
      violations = validateAttackDeclaration(ctx, attackingPlayerId, eligible, repaired, costs);
      continue;
    }
    const violatedIds = new Set(violations.map((v) => v.subjectId));
    const candidates = eligible
      .filter((c) => violatedIds.has(c.id))
      .sort(
        (a, b) => effectivePT(ctx, a).power - effectivePT(ctx, b).power || a.id.localeCompare(b.id),
      );
    const pick = candidates[0];
    if (pick === undefined) break; // unreachable: every violation names an eligible subject
    // A creature that must join the attack goes at a target it can attack for free.
    const joining = violations.some((v) => v.subjectId === pick.id && v.kind === 'attackWithAll');
    const mustAttack = joining || mustAttackNow(ctx, pick, eligible, opponents);
    const free = joining
      ? freeAttackTargetsFor(ctx, pick, opponents)[0]
      : mustAttack
        ? requiredAttackTargets(ctx, pick, opponents)[0]
        : undefined;
    repaired.set(
      pick.id,
      free === undefined
        ? null
        : { defenderId: free.player.id, planeswalkerId: free.planeswalker?.id ?? null },
    );
    violations = validateAttackDeclaration(ctx, attackingPlayerId, eligible, repaired, costs);
  }
  return repaired;
}

/**
 * Whoever chooses this turn's attackers and every player's blocks (Master Warcraft), or null. A
 * newer effect overrides an older one; one whose controller has left the game no longer applies
 * (CR 800.4a).
 */
function combatChooserId(ctx: GameContext): PlayerId | null {
  const entries = ctx.state.combatChoices ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as CombatChoiceEntry;
    if (entry.turn === ctx.state.turnNumber && !playerById(ctx, entry.casterId).hasLost)
      return entry.casterId;
  }
  return null;
}

/** The set-only counterpart of `buildAttackOption`: each slot is "attacks" or "stays home". */
function buildAttackSetOption(subjects: readonly AttackDeclarationSubject[]): EngineActionOption {
  const base = buildAttackOption(subjects);
  return {
    ...base,
    description: `Choose attackers (${subjects.length} eligible creature${subjects.length === 1 ? '' : 's'})`,
    data: { ...base.data, chooseAttackers: true },
    targets: subjects.map((s, i) => ({
      slot: i,
      options: [ATTACKS_TARGET, ...(s.mustAttack ? [] : [NO_ATTACK_TARGET])],
    })),
  };
}

/**
 * "You choose which creatures attack this turn" (Master Warcraft), first half: the chooser picks
 * the set from the creatures that can attack, held to the same requirements and joint rules as
 * any declaration (CR 508.1c-d, 506.5) but with no defender yet, so no cost is checked here. Asked
 * and repaired like `declareAttackers`.
 */
function* chooseAttackerSet(
  ctx: GameContext,
  ap: EnginePlayerState,
  opponents: readonly EnginePlayerState[],
  pool: readonly EnginePermanent[],
  chooserId: PlayerId,
): GameGen<EnginePermanent[]> {
  const MAX_PROPOSALS = 2;
  // Which creatures are in the set is all that matters; the defender is a placeholder.
  const stand = { defenderId: opponents[0]?.id ?? ap.id, planeswalkerId: null };
  const asAssignment = (set: ReadonlySet<ObjectId>) =>
    new Map<ObjectId, AttackChoice | null>(pool.map((c) => [c.id, set.has(c.id) ? stand : null]));
  let rejection: CombatRejection | undefined;
  let set = new Set<ObjectId>();
  for (let attempt = 1; attempt <= MAX_PROPOSALS; attempt++) {
    const subjects = buildAttackSubjects(ctx, pool, opponents);
    const outcome = yield {
      decisionType: 'declareAttackers',
      player: chooserId,
      prompt:
        attempt === 1
          ? `Choose which of ${ap.id}'s creatures attack: ${pool.length} eligible creature${pool.length === 1 ? '' : 's'}`
          : `Choose which of ${ap.id}'s creatures attack — fix the flagged problem(s) and resubmit`,
      options: [buildAttackSetOption(subjects)],
      presentationAttackDeclaration: {
        subjects,
        mode: 'chooseAttackers',
        attackingPlayer: ap.id,
        ...(rejection !== undefined ? { rejection } : {}),
      },
    };
    set = new Set(
      pool.filter((_, i) => outcome.targets.get(i) === ATTACKS_TARGET).map((c) => c.id),
    );
    for (const subject of subjects) {
      if (subject.mustAttack && !set.has(subject.subjectId)) {
        throw new Error(
          `engine bug: ${subject.subjectId} must attack but was left out of the chosen set`,
        );
      }
    }
    const violations = validateAttackDeclaration(ctx, ap.id, pool, asAssignment(set), false);
    if (violations.length === 0) return pool.filter((c) => set.has(c.id));
    rejection = { violations };
  }
  const repaired = repairAttackDeclaration(ctx, ap.id, pool, opponents, asAssignment(set), false);
  emit(
    ctx,
    'attackDeclarationRepaired',
    { violations: rejection?.violations.length ?? 0 },
    chooserId,
  );
  return pool.filter((c) => repaired.get(c.id) !== null && repaired.get(c.id) !== undefined);
}

/**
 * Second half: the attacking player chooses what each chosen creature attacks and pays for it
 * (CR 508.1b, 508.1g). A creature with a way to attack that costs nothing must attack one; one
 * that could attack only by paying may be declined (CR 508.1d), and is then left out of the
 * assignment for the chooser to choose again. Asked and repaired like `declareAttackers`.
 */
function* assignChosenAttackers(
  ctx: GameContext,
  ap: EnginePlayerState,
  opponents: readonly EnginePlayerState[],
  members: readonly EnginePermanent[],
  chooserId: PlayerId,
): GameGen<Map<ObjectId, AttackChoice | null>> {
  const MAX_PROPOSALS = 2;
  let rejection: CombatRejection | undefined;
  let assignment: Map<ObjectId, AttackChoice | null> = new Map();
  for (let attempt = 1; attempt <= MAX_PROPOSALS; attempt++) {
    const subjects = buildAttackSubjects(ctx, members, opponents).map((subject) => ({
      ...subject,
      mustAttack:
        freeAttackTargetsFor(
          ctx,
          members.find((c) => c.id === subject.subjectId) as EnginePermanent,
          opponents,
        ).length > 0,
    }));
    const outcome = yield {
      decisionType: 'declareAttackers',
      player: ap.id,
      prompt:
        attempt === 1
          ? `Choose what each of the ${members.length} creature${members.length === 1 ? '' : 's'} ${chooserId} chose attacks`
          : 'Choose what each chosen creature attacks — fix the flagged problem(s) and resubmit',
      options: [buildAttackOption(subjects)],
      presentationAttackDeclaration: {
        subjects,
        mode: 'assignChosen',
        attackingPlayer: ap.id,
        chosenBy: chooserId,
        ...(rejection !== undefined ? { rejection } : {}),
      },
    };
    assignment = readAttackAssignment(ctx, outcome, members);
    for (const subject of subjects) {
      if (subject.mustAttack && assignment.get(subject.subjectId) === null) {
        throw new Error(`engine bug: ${subject.subjectId} must attack but was left undeclared`);
      }
    }
    const violations = validateAttackDeclaration(ctx, ap.id, members, assignment);
    if (violations.length === 0) return assignment;
    rejection = { violations };
  }
  const repaired = repairAttackDeclaration(ctx, ap.id, members, opponents, assignment);
  emit(ctx, 'attackDeclarationRepaired', { violations: rejection?.violations.length ?? 0 }, ap.id);
  return repaired;
}

/**
 * Declare attackers when someone else chooses which creatures attack (Master Warcraft): the
 * chooser picks the set, the attacking player picks what each attacks, and a creature whose cost
 * they decline can't attack, so the chooser chooses again among the rest (CR 508.1g-h).
 */
function* declareChosenAttackers(
  ctx: GameContext,
  ap: EnginePlayerState,
  opponents: readonly EnginePlayerState[],
  eligible: readonly EnginePermanent[],
  chooserId: PlayerId,
): GameGen<void> {
  const declined = new Set<ObjectId>();
  for (let round = 0; round <= eligible.length; round++) {
    const pool = eligible.filter(
      (c) => !declined.has(c.id) && attackTargetsFor(ctx, c, opponents).length > 0,
    );
    if (pool.length === 0) return;
    const members = yield* chooseAttackerSet(ctx, ap, opponents, pool, chooserId);
    if (members.length === 0) return;
    const assignment = yield* assignChosenAttackers(ctx, ap, opponents, members, chooserId);
    const dropped = members.filter((c) => (assignment.get(c.id) ?? null) === null);
    if (dropped.length === 0) {
      yield* applyAttackDeclaration(ctx, ap, members, opponents, assignment);
      return;
    }
    for (const creature of dropped) declined.add(creature.id);
  }
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

  const chooserId = combatChooserId(ctx);
  if (chooserId !== null && chooserId !== ap.id)
    yield* declareChosenAttackers(ctx, ap, opponents, eligible, chooserId);
  else if (eligible.length > 0) {
    const MAX_PROPOSALS = 2;
    let rejection: CombatRejection | undefined;
    let lastAssignment: Map<ObjectId, AttackChoice | null> = new Map();
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
      lastAssignment = readAttackAssignment(ctx, outcome, eligible);
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
  for (const perm of declared) {
    perm.attackedThisTurn = true;
    perm.timesAttackedThisTurn = (perm.timesAttackedThisTurn ?? 0) + 1;
  }
  if (declared.length > 0) (ctx.state.attackedThisTurnPlayers ??= {})[ap.id] = true;
  const defendingPlayers = [...new Set(declared.map((a) => a.attacking as PlayerId))];
  for (const defId of defendingPlayers) {
    // The defending player is woken for an attack on their planeswalker too (CR 509.1).
    playerById(ctx, defId).yieldUntilEndOfTurn = false;
    // "Whenever enchanted player is attacked" (CR 508.3b) needs a creature attacking the player
    // itself; attacking only their planeswalkers doesn't.
    if (!declared.some((a) => isAttackingPlayer(a, defId))) continue;
    const auras = ctx.state.battlefield.filter((p) => p.attachedTo === defId);
    for (const aura of auras) {
      queueTriggersForEvent(ctx, 'enchantedPlayerAttacked', [{ permanent: aura, playerId: ap.id }]);
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
  queueAttackDeclarationTriggers(ctx, declared);
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
function buildBlockOption(
  subjects: readonly BlockDeclarationSubject[],
  /** Set when someone else chooses this defending player's blocks (Master Warcraft). */
  blockingPlayer?: PlayerId,
): EngineActionOption {
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
      ...(blockingPlayer !== undefined ? { blockingPlayer } : {}),
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
    if (attacker === undefined) continue;
    if (hasKeyword(ctx, attacker, 'menace') && blockers.length < 2)
      for (const blocker of blockers) {
        violations.push({
          subjectId: blocker.id,
          kind: 'menace',
          message: `${attacker.name} has menace and can't be blocked by only one creature`,
        });
      }
    // "Can't be blocked by more than one creature": the blockers past the limit are flagged.
    const most = maxBlockersOf(ctx, attacker);
    if (most !== null && blockers.length > most)
      for (const blocker of blockers) {
        violations.push({
          subjectId: blocker.id,
          kind: 'maxBlockers',
          message: `${attacker.name} can't be blocked by more than ${most === 1 ? 'one creature' : `${most} creatures`}`,
        });
      }
    // "Can't be blocked except by N or more creatures": none, or at least N.
    const needed = minBlockersOf(ctx, attacker);
    if (needed > 2 && blockers.length < needed)
      for (const blocker of blockers) {
        violations.push({
          subjectId: blocker.id,
          kind: 'minBlockers',
          message: `${attacker.name} can't be blocked except by ${needed} or more creatures`,
        });
      }
  }
  // CR 506.5: a creature that can't block alone blocks only if another creature of the same
  // defending player is declared as a blocker too (this is that player's whole declaration).
  const blocking = candidates.filter(
    ({ blocker }) => (assignment.get(blocker.id) ?? null) !== null,
  );
  const lone = blocking.length === 1 ? blocking[0]?.blocker : undefined;
  if (lone !== undefined && cantActAlone(ctx, lone, 'cantBlockAlone'))
    violations.push({
      subjectId: lone.id,
      kind: 'blockAlone',
      message: `${lone.name} can't block alone`,
    });
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
      queueTriggersForEvent(ctx, 'blocks', [{ permanent: blocker, blockedObjectId: attacker.id }]);
    }
    // Bushido and similar abilities trigger once when an attacker becomes blocked, regardless
    // of how many creatures block it (CR 509.1h).
    queueTriggersForObject(ctx, 'becomesBlocked', attacker);
  }
}

/**
 * A group too small for menace or "can't be blocked except by N or more creatures" that holds a
 * creature required to block grows to the minimum with its controller's idle creatures able to
 * block that attacker, rather than standing the required creature down (CR 509.1c). Assigns
 * nothing unless the whole gap can be filled, and fills each attacker at most once so the repair
 * still terminates; returns whether it assigned.
 */
function fillRequiredBlockGroup(
  ctx: GameContext,
  candidates: readonly BlockCandidate[],
  repaired: Map<ObjectId, ObjectId | null>,
  violations: readonly CombatViolation[],
  filled: Set<ObjectId>,
): boolean {
  const shortIds = new Set(
    violations
      .filter((v) => v.kind === 'menace' || v.kind === 'minBlockers')
      .map((v) => v.subjectId),
  );
  for (const { blocker } of candidates) {
    if (!shortIds.has(blocker.id) || blocker.mustBlockThisTurn !== true) continue;
    const attackerId = repaired.get(blocker.id);
    if (attackerId == null || filled.has(attackerId)) continue;
    const attacker = findPermanent(ctx, attackerId);
    if (attacker === undefined) continue;
    const needed = Math.max(
      hasKeyword(ctx, attacker, 'menace') ? 2 : 0,
      minBlockersOf(ctx, attacker),
    );
    const current = candidates.filter((c) => repaired.get(c.blocker.id) === attackerId).length;
    const idle = candidates.filter(
      (c) =>
        (repaired.get(c.blocker.id) ?? null) === null &&
        c.blockable.some((a) => a.id === attackerId),
    );
    if (current + idle.length < needed) continue;
    for (const partner of idle.slice(0, needed - current))
      repaired.set(partner.blocker.id, attackerId);
    filled.add(attackerId);
    return true;
  }
  return false;
}

/**
 * Engine-owned repair (ADR 0023 item 17, blocker-side) — the `repairAttackDeclaration` pattern
 * applied to menace: repeatedly pick the lowest-power violating blocker (ties broken by id) and
 * fix just it. If it's `mustBlock`, first try redirecting it to a different legal attacker that
 * isn't itself under-blocked (never manufacturing a second menace violation); otherwise, or if no
 * such attacker exists, stand it down. A too-small group holding a `mustBlock` creature is first
 * grown to its minimum when enough idle creatures can join it. Bounded by the candidate count so
 * it always terminates.
 */
function repairBlockDeclaration(
  ctx: GameContext,
  candidates: readonly BlockCandidate[],
  assignment: ReadonlyMap<ObjectId, ObjectId | null>,
): Map<ObjectId, ObjectId | null> {
  const repaired = new Map(assignment);
  let violations = validateBlockDeclaration(ctx, candidates, repaired);
  // Each candidate is stood down or redirected at most once, and each attacker filled at most once.
  let guard = 2 * candidates.length + 1;
  const filled = new Set<ObjectId>();
  while (violations.length > 0 && guard-- > 0) {
    if (fillRequiredBlockGroup(ctx, candidates, repaired, violations, filled)) {
      violations = validateBlockDeclaration(ctx, candidates, repaired);
      continue;
    }
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
    // A redirect or a recruited partner never lands on an attacker already at its blocker limit.
    const hasRoom = (attacker: EnginePermanent): boolean => {
      const most = maxBlockersOf(ctx, attacker);
      return (
        most === null ||
        candidates.filter((c) => repaired.get(c.blocker.id) === attacker.id).length < most
      );
    };
    // A lone blocker that can't block alone stands down; no other attacker fixes that.
    const alone = violations.some(
      (v) => v.subjectId === pick.blocker.id && v.kind === 'blockAlone',
    );
    // A required blocker that can't block alone keeps its block when another of its controller's
    // idle creatures can block too (CR 506.5 counts every blocker that player declares): beside
    // it on the same attacker, or else on any attacker that one creature may block by itself.
    if (alone && pick.blocker.mustBlockThisTurn === true && currentAttackerId != null) {
      const idle = candidates.filter(
        (c) => c.blocker.id !== pick.blocker.id && (repaired.get(c.blocker.id) ?? null) === null,
      );
      const current = pick.blockable.find((a) => a.id === currentAttackerId);
      const beside =
        current !== undefined && hasRoom(current)
          ? idle.find((c) => c.blockable.some((a) => a.id === currentAttackerId))
          : undefined;
      const elsewhere =
        beside === undefined
          ? idle
              .map((c) => ({
                c,
                attacker: c.blockable.find(
                  (a) => !hasKeyword(ctx, a, 'menace') && minBlockersOf(ctx, a) === 0 && hasRoom(a),
                ),
              }))
              .find((entry) => entry.attacker !== undefined)
          : undefined;
      const partner = beside ?? elsewhere?.c;
      const partnerAttackerId = beside !== undefined ? currentAttackerId : elsewhere?.attacker?.id;
      if (partner !== undefined && partnerAttackerId !== undefined) {
        repaired.set(partner.blocker.id, partnerAttackerId);
        violations = validateBlockDeclaration(ctx, candidates, repaired);
        continue;
      }
    }
    // A required blocker over a "can't be blocked by more than N" limit keeps its block when an
    // optional blocker on the same attacker can stand down instead (CR 509.1c).
    const overMax = violations.some(
      (v) => v.subjectId === pick.blocker.id && v.kind === 'maxBlockers',
    );
    if (overMax && pick.blocker.mustBlockThisTurn === true && currentAttackerId != null) {
      const optional = candidates.find(
        (c) =>
          c.blocker.id !== pick.blocker.id &&
          c.blocker.mustBlockThisTurn !== true &&
          repaired.get(c.blocker.id) === currentAttackerId,
      );
      if (optional !== undefined) {
        repaired.set(optional.blocker.id, null);
        violations = validateBlockDeclaration(ctx, candidates, repaired);
        continue;
      }
    }
    const alternative =
      pick.blocker.mustBlockThisTurn === true && !alone
        ? pick.blockable.find(
            (a) =>
              a.id !== currentAttackerId &&
              !hasKeyword(ctx, a, 'menace') &&
              minBlockersOf(ctx, a) === 0 &&
              hasRoom(a),
          )
        : undefined;
    repaired.set(pick.blocker.id, alternative?.id ?? null);
    violations = validateBlockDeclaration(ctx, candidates, repaired);
  }
  // Out of guard with violations left: stand down every flagged blocker until the declaration is
  // legal. Each pass removes at least one block, so this ends (no blocks is always reachable).
  while (violations.length > 0) {
    const flagged = new Set(violations.map((v) => v.subjectId));
    const standDown = candidates.filter(
      (c) => flagged.has(c.blocker.id) && (repaired.get(c.blocker.id) ?? null) !== null,
    );
    if (standDown.length === 0) break;
    for (const c of standDown) repaired.set(c.blocker.id, null);
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

    // Master Warcraft: someone else chooses this defending player's blocks.
    const chooserId = combatChooserId(ctx);
    const chosenFor = chooserId !== null && chooserId !== defenderId;
    for (let attempt = 1; attempt <= MAX_PROPOSALS; attempt++) {
      const subjects = buildBlockSubjects(ctx, candidates);
      const outcome = yield {
        decisionType: 'declareBlockers',
        player: chosenFor ? chooserId : defenderId,
        prompt:
          attempt === 1
            ? `Declare blockers${chosenFor ? ` for ${defenderId}` : ''}: ${candidates.length} eligible creature${candidates.length === 1 ? '' : 's'}`
            : 'Declare blockers — fix the flagged problem(s) and resubmit',
        options: [buildBlockOption(subjects, chosenFor ? defenderId : undefined)],
        presentationBlockDeclaration: {
          subjects,
          ...(chosenFor ? { blockingPlayer: defenderId } : {}),
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

/**
 * Where an attacker's combat damage goes when it is not (or no longer) assigned to a blocker: the
 * player it attacks, the planeswalker it attacks, or nowhere — an attacker whose planeswalker was
 * removed from combat attacks no player or planeswalker (CR 506.4c) and has no one to assign
 * damage to (CR 510.1b, 702.19c).
 */
type CombatRecipient =
  { kind: 'player'; id: PlayerId } | { kind: 'planeswalker'; permanent: EnginePermanent };

function combatRecipientOf(ctx: GameContext, attacker: EnginePermanent): CombatRecipient | null {
  if (attacker.attacking === null) return null;
  if (attacker.attackingPlaneswalker === null) return { kind: 'player', id: attacker.attacking };
  const permanent = attackedPlaneswalker(ctx, attacker);
  return permanent === null ? null : { kind: 'planeswalker', permanent };
}

/** The key a recipient has in a damage division and a trampler's `combatDamageSplit.targets`. */
function recipientKey(recipient: CombatRecipient): ObjectId {
  return recipient.kind === 'player' ? recipient.id : recipient.permanent.id;
}

/** Per-attacker chosen division of combat damage among its 2+ live blockers, and — for a
 * trampler — the player or planeswalker it attacks (keyed by id, see `recipientKey`). Only ever has an entry
 * for an attacker with 2+ live blockers; `dealCombatDamage` falls back to CR 510.1c's forced
 * single-recipient/no-recipient cases for everything else. */
type DamageDivisions = ReadonlyMap<ObjectId, ReadonlyMap<ObjectId, number>>;

/**
 * The damage from `attacker` that counts as lethal to `blocker` right now (CR 702.19b): its
 * toughness less the damage already marked on it, 1 at most from a deathtouch source (CR 702.2c),
 * and nothing more once a deathtouch source has already damaged it.
 */
function lethalDamageFor(
  ctx: GameContext,
  attacker: EnginePermanent,
  blocker: EnginePermanent,
): number {
  if (blocker.damagedByDeathtouch) return 0;
  const remaining = Math.max(0, effectivePT(ctx, blocker).toughness - blocker.damageMarked);
  return hasKeyword(ctx, attacker, 'deathtouch') ? Math.min(1, remaining) : remaining;
}

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
  recipientId: ObjectId | null,
  outcome: DecisionOutcome,
): Map<ObjectId, number> {
  const raw = outcome.combatDamageSplit ?? {};
  const lethalFor = (b: EnginePermanent): number => lethalDamageFor(ctx, attacker, b);
  const wellFormed =
    Object.keys(raw).every((id) => targets.includes(id)) &&
    targets.every((id) => Number.isInteger(raw[id] ?? 0) && (raw[id] ?? 0) >= 0) &&
    targets.reduce((total, id) => total + (raw[id] ?? 0), 0) === power;
  const playerAmount = recipientId !== null ? (raw[recipientId] ?? 0) : 0;
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
    const recipient = combatRecipientOf(ctx, attacker);
    if (liveBlockers.length === 0) continue;
    if (liveBlockers.length === 1) {
      const lethal = lethalDamageFor(ctx, attacker, liveBlockers[0]!);
      if (!trample || recipient === null || power <= lethal) continue;
    }
    const targets: ObjectId[] = liveBlockers.map((b) => b.id);
    if (trample && recipient !== null) targets.push(recipientKey(recipient));

    const outcome = yield {
      decisionType: 'assignCombatDamage',
      player: attacker.controllerId,
      prompt:
        `${attacker.name} (${power} power) is blocked by ${liveBlockers.length} creatures: ` +
        `divide its combat damage among them${trample && recipient !== null ? `, or ${recipient.kind === 'player' ? 'the defending player' : recipient.permanent.name} once every blocker has lethal (trample)` : ''}.`,
      options: targets.map((id) => ({
        type: 'assignDamage',
        description: `All ${power} damage to ${damageTargetName(ctx, id)}`,
        interaction: { kind: 'choice' as const },
      })),
      combatDamageSplit: {
        amount: power,
        targets,
        lethal: Object.fromEntries(
          liveBlockers.map((b) => [b.id, lethalDamageFor(ctx, attacker, b)]),
        ),
      },
    };
    const division = resolveDamageDivision(
      ctx,
      attacker,
      liveBlockers,
      power,
      targets,
      recipient === null ? null : recipientKey(recipient),
      outcome,
    );
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
  /** The planeswalker an attacker deals combat damage to (CR 120.3c). */
  targetPlaneswalker: EnginePermanent | null;
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
  if (perm.assignsNoCombatDamageTurn === ctx.state.turnNumber) return false;
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
function* dealCombatDamage(
  ctx: GameContext,
  step: 'first' | 'regular',
  divisions: DamageDivisions,
): GameGen<void> {
  const assignments: DamageAssignment[] = [];

  for (const attacker of attackers(ctx)) {
    if (!dealsInStep(ctx, attacker, step)) continue;
    const power = effectivePT(ctx, attacker).power;
    if (power <= 0) continue;
    const deathtouch = hasKeyword(ctx, attacker, 'deathtouch');
    const trample = hasKeyword(ctx, attacker, 'trample');

    const liveBlockers = liveBlockersOf(ctx, attacker);
    const wasBlocked = attacker.blockedByOrdered.length > 0;
    // The player or planeswalker it attacks; null once its planeswalker was removed from combat,
    // so an unblocked attacker deals no damage (CR 510.1b) and a trampler has no excess to assign.
    const recipient = combatRecipientOf(ctx, attacker);
    const toRecipient = (recipientAmount: number): DamageAssignment | null =>
      recipient === null
        ? null
        : {
            source: attacker,
            targetCreature: null,
            targetPlayer: recipient.kind === 'player' ? recipient.id : null,
            targetPlaneswalker: recipient.kind === 'planeswalker' ? recipient.permanent : null,
            amount: recipientAmount,
          };

    if (!wasBlocked) {
      const assignment = toRecipient(power);
      if (assignment !== null) assignments.push(assignment);
      continue;
    }

    const division = divisions.get(attacker.id);
    if (division !== undefined) {
      // 2+ live blockers: use the chosen arbitrary division exactly (CR 510.1c) — including,
      // with trample, however much of it (if any) the controller sent to the defending player
      // or the planeswalker it attacks.
      for (const blocker of liveBlockers) {
        const amount = division.get(blocker.id) ?? 0;
        if (amount > 0) {
          assignments.push({
            source: attacker,
            targetCreature: blocker,
            targetPlayer: null,
            targetPlaneswalker: null,
            amount,
          });
        }
      }
      const recipientAmount = recipient === null ? 0 : (division.get(recipientKey(recipient)) ?? 0);
      if (recipientAmount > 0) {
        const assignment = toRecipient(recipientAmount);
        if (assignment !== null) assignments.push(assignment);
      }
      continue;
    }

    // Remaining 0/1-blocker cases are forced; any trample excess choice was handled above.
    // With zero live blockers, trample sends all remaining damage to the defending player (or the
    // planeswalker) once the blocker is gone — even if that happened in the first-strike step and
    // this is the regular step.
    const [only] = liveBlockers;
    if (only !== undefined) {
      const bpt = effectivePT(ctx, only);
      const remaining = Math.max(0, bpt.toughness - only.damageMarked);
      const lethal = only.damagedByDeathtouch ? 0 : deathtouch ? Math.min(1, remaining) : remaining;
      // Without anyone to send trample excess to, all of the damage is assigned to the blocker.
      const toBlocker = trample && recipient !== null ? Math.min(power, lethal) : power;
      assignments.push({
        source: attacker,
        targetCreature: only,
        targetPlayer: null,
        targetPlaneswalker: null,
        amount: toBlocker,
      });
      const excess = power - toBlocker;
      if (excess > 0) {
        const assignment = toRecipient(excess);
        if (assignment !== null) assignments.push(assignment);
      }
    } else if (trample) {
      const assignment = toRecipient(power);
      if (assignment !== null) assignments.push(assignment);
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
      targetPlaneswalker: null,
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
  // Likewise "is dealt damage" is one event per damaged creature, carrying the step's total.
  const damageToCreatures = new Map<EnginePermanent, number>();
  // A lifelinking source's simultaneous combat damage to several recipients is ONE life-gain
  // event of the total (CR 120.3f, 119.9), so a "plus 1" replacement applies once, not per hit.
  const lifelinkTotals = new Map<EnginePermanent, number>();
  const noteLifelink = (source: EnginePermanent, lifelink: boolean, dealt: number) => {
    if (lifelink && dealt > 0)
      lifelinkTotals.set(source, (lifelinkTotals.get(source) ?? 0) + dealt);
  };

  for (const a of assignments) {
    const traits = combatDamageTraits(ctx, a.source);
    if (a.targetCreature !== null) {
      const before = damageToCreatures.get(a.targetCreature) ?? 0;
      yield* dealDamageToCreature(ctx, permanentSource(a.source), a.targetCreature, a.amount, {
        combat: true,
        sourceHasDeathtouch: traits.deathtouch,
        sourceHasLifelink: false,
        sourceHasInfect: traits.infect,
        sourceTraits: traits,
        dealtTotals: damageToCreatures,
      });
      noteLifelink(
        a.source,
        traits.lifelink,
        (damageToCreatures.get(a.targetCreature) ?? 0) - before,
      );
    } else if (a.targetPlaneswalker !== null) {
      // Damage to a planeswalker is not damage to a player: no commander damage, no "deals combat
      // damage to a player" trigger, no monarch steal — it only removes loyalty (CR 120.3c).
      const dealt = yield* dealCombatDamageToPlaneswalker(
        ctx,
        permanentSource(a.source),
        a.targetPlaneswalker,
        a.amount,
        { sourceHasLifelink: false, sourceTraits: traits },
      );
      noteLifelink(a.source, traits.lifelink, dealt);
    } else if (a.targetPlayer !== null) {
      const dealt = yield* dealDamageToPlayer(
        ctx,
        permanentSource(a.source),
        playerById(ctx, a.targetPlayer),
        a.amount,
        {
          combat: true,
          sourceIsCommander: a.source.isCommander,
          sourceHasLifelink: false,
          sourceHasInfect: traits.infect,
          sourceToxic: traits.toxic,
        },
      );
      noteLifelink(a.source, traits.lifelink, dealt);
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

  for (const [source, amount] of lifelinkTotals)
    yield* gainLife(ctx, playerById(ctx, source.controllerId), amount);

  // Damage a prevention owes (Deflecting Palm) is dealt once every combat damage in the step has.
  yield* flushDamageReflections(ctx);

  queueTriggersForEvent(
    ctx,
    'dealtDamage',
    [...damageToCreatures].map(([permanent, amount]) => ({ permanent, amount })),
  );
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
    retainAttackDefender(perm);
    perm.attacking = null;
    perm.attackingPlaneswalker = null;
    perm.attackedPlaneswalkerRemoved = false;
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
  ctx.state.declareAttackersReachedThisTurn = true;
  yield* declareAttackers(ctx);
  const anyAttackers = attackers(ctx).length > 0;
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // CR 508.8: no attackers ⇒ skip declare blockers and combat damage steps.
  if (anyAttackers) {
    setStep(ctx, 'declareBlockers');
    yield* declareBlockers(ctx);
    queueTriggersForEvent(
      ctx,
      'attacksUnblocked',
      attackers(ctx)
        .filter((permanent) => permanent.blockedByOrdered.length === 0)
        .map((permanent) => ({ permanent, playerId: permanent.attacking! })),
    );
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx);

    if (firstStrikeStepNeeded(ctx)) {
      setStep(ctx, 'firstStrikeCombatDamage');
      markFirstStrikeCombatants(ctx);
      const firstDivisions = yield* assignDamageDivisions(ctx, 'first');
      yield* dealCombatDamage(ctx, 'first', firstDivisions);
      yield* runPrioritySequence(ctx);
      emptyManaPools(ctx);
    }

    setStep(ctx, 'combatDamage');
    const regularDivisions = yield* assignDamageDivisions(ctx, 'regular');
    yield* dealCombatDamage(ctx, 'regular', regularDivisions);
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx);
  }

  setStep(ctx, 'endCombat');
  // "At end of combat" delayed triggers (Wall of Tears) fire as the step begins (CR 511.1).
  queueStepTriggers(ctx, 'endOfCombat');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);
  endCombatCleanup(ctx);
}
