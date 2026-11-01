/**
 * Warn the player before an action that would break one of their deals (ADR 0035). The table on
 * the server is what judges compliance; this mirrors its rules from what the player's own board
 * shows (chosen target ids and their public owners), so the warning can only ever be advice. It
 * errs towards warning: a promise the table would excuse (self-defense against a seat that now
 * leads or threatens lethal) still gets a warning, worded as "may break".
 */
import type {
  AttackDeclarationPresentation,
  Deal,
  DealObligation,
  ObjectId,
  PlayerBoardState,
  PlayerId,
  TargetChoice,
} from '@mtg/shared';
import type { LegalAction } from './protocol';
import { ATTACKS_TARGET, NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';

const SENTINELS = new Set<string>([NO_ATTACK_TARGET, NO_BLOCK_TARGET, ATTACKS_TARGET]);

/** Who each visible id belongs to: a seat is its own, a permanent or spell its controller's. */
function ownerLookup(board: PlayerBoardState): {
  ownerOf: (id: ObjectId) => PlayerId | undefined;
  isStack: (id: ObjectId) => boolean;
} {
  const owners = new Map<ObjectId, PlayerId>();
  for (const seat of board.seats) {
    owners.set(seat.seat, seat.seat);
    for (const card of seat.graveyard) owners.set(card.id, seat.seat);
  }
  for (const p of board.battlefield) owners.set(p.id, p.controller);
  const stack = new Set<ObjectId>();
  for (const s of board.stack) {
    owners.set(s.id, s.controller);
    stack.add(s.id);
  }
  return { ownerOf: (id) => owners.get(id), isStack: (id) => stack.has(id) };
}

/**
 * Each attack slot's attacker power, from the decision's attack-declaration presentation. Its
 * subjects are in slot order, one per target slot of the declaration action.
 */
function slotPowers(
  action: LegalAction,
  attackDeclaration: AttackDeclarationPresentation | undefined,
): number[] {
  return (action.targets ?? []).map((_, i) =>
    Math.max(0, attackDeclaration?.subjects[i]?.power ?? 0),
  );
}

/**
 * Power a promised attack must send at `target`, as the table requires it: `share` of the power
 * that could attack at all, never more than could reach the target. Zero when it is out of reach.
 */
function requiredPower(
  action: LegalAction,
  powers: readonly number[],
  target: PlayerId,
  ownerOf: (id: ObjectId) => PlayerId | undefined,
  share: number,
): number {
  let available = 0;
  let reachable = 0;
  (action.targets ?? []).forEach((slot, i) => {
    const real = slot.options.filter((id) => !SENTINELS.has(id));
    if (real.length > 0) available += powers[i] ?? 0;
    if (real.some((id) => ownerOf(id) === target)) reachable += powers[i] ?? 0;
  });
  if (reachable <= 0) return 0;
  return Math.min(reachable, Math.max(1, Math.ceil(share * available)));
}

function promise(o: DealObligation): string {
  switch (o.kind) {
    case 'noAttack':
      return `not to attack ${o.against}`;
    case 'noTarget':
      return `not to target ${o.against} or their things`;
    case 'noCounter':
      return `not to target ${o.against}'s spells`;
    case 'attackPlayer':
      return `to attack ${o.target}`;
  }
}

/**
 * Sentences naming each deal this action may break, or none. `me` is the player's seat; `deals`
 * are the deals in force at the table, of which only the player's own promises are read.
 */
export function dealWarnings(
  me: PlayerId,
  deals: readonly Deal[],
  action: LegalAction | undefined,
  /** The pending decision's `presentation.attackDeclaration`, when it has one. */
  attackDeclaration: AttackDeclarationPresentation | undefined,
  targets: readonly TargetChoice[] | undefined,
  board: PlayerBoardState,
  /** `DiplomacySeatState.attackPlayerShare`: how much of a seat's attack a promise needs. */
  attackPlayerShare = 0.5,
): string[] {
  if (action === undefined || action.type === 'blockDeclaration') return [];
  const mine = deals.flatMap((deal) =>
    deal.obligations.filter((o) => o.by === me).map((o) => ({ deal, o })),
  );
  if (mine.length === 0) return [];
  // Choosing which creatures attack (Master Warcraft) names no defender yet, so nothing to warn.
  const attack =
    action.type === 'attackDeclaration' && attackDeclaration?.mode !== 'chooseAttackers';
  const { ownerOf, isStack } = ownerLookup(board);
  const chosen = (targets ?? []).map((t) => t.choice).filter((id) => !SENTINELS.has(id));
  const other = (deal: Deal) => (deal.parties[0] === me ? deal.parties[1] : deal.parties[0]);

  const warnings: string[] = [];
  for (const { deal, o } of mine) {
    const yours = `Deal ${deal.id} with ${other(deal)}: you promised ${promise(o)}`;
    if (o.kind === 'attackPlayer') {
      if (!attack) continue;
      // As on the server: a token attack does not keep the promise, and one the declaration
      // could not have made is excused.
      const powers = slotPowers(action, attackDeclaration);
      const required = requiredPower(action, powers, o.target, ownerOf, attackPlayerShare);
      if (required <= 0) continue;
      const chosenBySlot = new Map((targets ?? []).map((t) => [t.slot, t.choice]));
      let sent = 0;
      (action.targets ?? []).forEach((slot, i) => {
        const choice = chosenBySlot.get(slot.slot);
        if (choice !== undefined && ownerOf(choice) === o.target) sent += powers[i] ?? 0;
      });
      if (sent < required) {
        warnings.push(
          sent === 0
            ? `${yours}, and this attack sends nothing at ${o.target}.`
            : `${yours}, and this attack sends ${sent} of the ${required} power it needs at ${o.target}.`,
        );
      }
      continue;
    }
    if (attack !== (o.kind === 'noAttack')) continue;
    const breaks = chosen.some(
      (id) => ownerOf(id) === o.against && (o.kind !== 'noCounter' || isStack(id)),
    );
    if (breaks) warnings.push(`${yours}. This may break it.`);
  }
  return warnings;
}
