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

/** Owners as seen in one `PlayerView`: seats, permanents and stack objects, all public. */
export function ownerLookup(view: PlayerView): OwnerOf {
  const owners = new Map<ObjectId, PlayerId>();
  owners.set(view.seat, view.seat);
  for (const o of view.opponents) owners.set(o.seat, o.seat);
  for (const p of view.battlefield) owners.set(p.id, p.controller);
  for (const s of view.stack) owners.set(s.id, s.controller);
  return (id) => owners.get(id);
}

/** Whether an id names a stack object, given the same view. */
export function stackLookup(view: PlayerView): (id: ObjectId) => boolean {
  const ids = new Set(view.stack.map((s) => s.id));
  return (id) => ids.has(id);
}

const SENTINELS = new Set<string>([NO_ATTACK_TARGET, NO_BLOCK_TARGET, ATTACKS_TARGET]);

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
    let possible = false;
    for (const slot of slots) {
      const hits = (id: ObjectId) => ownerOf(id) === o.target;
      if (slot.options.some(hits)) possible = true;
      const choice = chosen.get(slot.slot);
      if (choice !== undefined && hits(choice)) return 'kept';
    }
    return possible ? 'violated' : 'excused';
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
