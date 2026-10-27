import type {
  DealObligation,
  DecisionRequest,
  DecisionResponse,
  LegalAction,
  ObjectId,
  PlayerId,
  PlayerView,
} from '@mtg/shared';
import { ATTACKS_TARGET, NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import { WEIGHTS } from '../weights';

/**
 * Judging obligations from submitted decisions (ADR 0031 decision 6). Only chosen target ids are
 * read, so compliance needs no hidden information.
 */
export type ComplianceVerdict =
  /** The decision has nothing to do with this obligation. */
  | 'irrelevant'
  /** The decision honored it; for `attackPlayer`, the obligation is now met. */
  | 'kept'
  /** The decision broke it. */
  | 'violated'
  /** The decision would have broken it, but no complying option existed. */
  | 'excused';

/** Who an id belongs to: a seat is its own owner, a permanent or stack object its controller. */
export type OwnerOf = (id: ObjectId) => PlayerId | undefined;

const SENTINELS = new Set<string>([NO_ATTACK_TARGET, NO_BLOCK_TARGET, ATTACKS_TARGET]);

/**
 * Owners as seen in one `PlayerView`, all public: seats, permanents, stack objects, and cards in
 * graveyards. Exiled cards are left out because the view does not say whose they are.
 */
export function ownerLookup(view: PlayerView): OwnerOf {
  const owners = new Map<ObjectId, PlayerId>();
  owners.set(view.seat, view.seat);
  for (const card of view.graveyard) owners.set(card.id, view.seat);
  for (const o of view.opponents) {
    owners.set(o.seat, o.seat);
    for (const card of o.graveyard) owners.set(card.id, o.seat);
  }
  for (const p of view.battlefield) owners.set(p.id, p.controller);
  for (const s of view.stack) owners.set(s.id, s.controller);
  return (id) => owners.get(id);
}

/** Each slot's attacker power in a batched attack declaration, from its subject data. */
export function attackSlotPowers(action: LegalAction, view?: PlayerView): number[] {
  const subjects = action.data?.['subjects'];
  const powerById = new Map((view?.battlefield ?? []).map((p) => [p.id, p.power ?? 0]));
  return (action.targets ?? []).map((_, i) => {
    if (!Array.isArray(subjects)) return 0;
    const subject = subjects[i] as { power?: unknown; subjectId?: unknown } | undefined;
    if (typeof subject?.power === 'number') return Math.max(0, subject.power);
    if (typeof subject?.subjectId === 'string')
      return Math.max(0, powerById.get(subject.subjectId) ?? 0);
    return 0;
  });
}

/**
 * Power `attackPlayer` requires at its target in this declaration: `attackPlayerShare` of the
 * power that could attack at all, but never more than could reach the target. Zero means the
 * target was out of reach.
 */
export function requiredAttackPower(
  action: LegalAction,
  powers: readonly number[],
  target: PlayerId,
  ownerOf: OwnerOf,
): number {
  let available = 0;
  let reachable = 0;
  (action.targets ?? []).forEach((slot, i) => {
    const power = powers[i] ?? 0;
    const real = slot.options.filter((o) => !SENTINELS.has(o));
    if (real.length > 0) available += power;
    if (real.some((o) => ownerOf(o) === target)) reachable += power;
  });
  if (reachable <= 0) return 0;
  return Math.min(reachable, Math.max(1, Math.ceil(WEIGHTS.deals.attackPlayerShare * available)));
}

/** Whether an id names a stack object, given the same view. */
export function stackLookup(view: PlayerView): (id: ObjectId) => boolean {
  const ids = new Set(view.stack.map((s) => s.id));
  return (id) => ids.has(id);
}

export function isAttackDeclaration(action: LegalAction): boolean {
  return action.type === 'attackDeclaration' && action.data?.['chooseAttackers'] !== true;
}

/** Whether an option is off limits to `o` (it names, or belongs to, the protected seat). */
export function forbidsOption(
  o: DealObligation,
  option: ObjectId,
  ownerOf: OwnerOf,
  isStack: (id: ObjectId) => boolean,
): boolean {
  if (o.kind === 'attackPlayer' || SENTINELS.has(option)) return false;
  if (ownerOf(option) !== o.against) return false;
  if (o.kind === 'noCounter') return isStack(option);
  return true;
}

/**
 * Judge one decision against one obligation. Only decisions by the obligated seat matter. Attack
 * slots are judged by `noAttack` and `attackPlayer`; every other target slot by `noTarget` and
 * `noCounter`. Block slots never are: deals cover offense only.
 */
export function judgeDecision(
  o: DealObligation,
  request: DecisionRequest,
  response: DecisionResponse,
  ownerOf: OwnerOf,
  isStack: (id: ObjectId) => boolean,
): ComplianceVerdict {
  if (request.decidingPlayer !== o.by) return 'irrelevant';
  const action = request.legalActions.find((a) => a.id === response.actionId);
  if (action === undefined || action.type === 'blockDeclaration') return 'irrelevant';
  const slots = action.targets ?? [];
  const chosen = new Map((response.targets ?? []).map((t) => [t.slot, t.choice]));
  const attack = isAttackDeclaration(action);

  if (o.kind === 'attackPlayer') {
    if (!attack) return 'irrelevant';
    const powers = attackSlotPowers(action);
    const required = requiredAttackPower(action, powers, o.target, ownerOf);
    if (required <= 0) return 'excused';
    let sent = 0;
    slots.forEach((slot, i) => {
      const choice = chosen.get(slot.slot);
      if (choice !== undefined && ownerOf(choice) === o.target) sent += powers[i] ?? 0;
    });
    return sent >= required ? 'kept' : 'violated';
  }

  if (attack !== (o.kind === 'noAttack')) return 'irrelevant';
  let verdict: ComplianceVerdict = 'irrelevant';
  for (const slot of slots) {
    const choice = chosen.get(slot.slot);
    if (choice === undefined) continue;
    if (!forbidsOption(o, choice, ownerOf, isStack)) {
      if (verdict === 'irrelevant') verdict = 'kept';
      continue;
    }
    // A priority action is voluntary (passing always complies), so only a forced decision with
    // no complying option in the slot is excused.
    const hadAlternative =
      request.decisionType === 'priority' ||
      slot.options.some((opt) => !forbidsOption(o, opt, ownerOf, isStack));
    if (hadAlternative) return 'violated';
    verdict = 'excused';
  }
  return verdict;
}

/**
 * Whether this decision offered `o`'s obligor a way to break it: the test of whether keeping a
 * deal cost anything. Trust is only credited for deals a party was tempted to break (ADR 0031
 * decision 12); keeping a truce with no attackers proves nothing.
 */
export function offeredBreach(
  o: DealObligation,
  request: DecisionRequest,
  ownerOf: OwnerOf,
  isStack: (id: ObjectId) => boolean,
): boolean {
  if (request.decidingPlayer !== o.by || o.kind === 'attackPlayer') return false;
  return request.legalActions.some((action) => {
    if (action.type === 'blockDeclaration') return false;
    if (isAttackDeclaration(action) !== (o.kind === 'noAttack')) return false;
    if (action.type === 'attackDeclaration' && !isAttackDeclaration(action)) return false;
    return (action.targets ?? []).some((slot) =>
      slot.options.some((opt) => forbidsOption(o, opt, ownerOf, isStack)),
    );
  });
}
