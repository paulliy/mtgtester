/**
 * Warn the player before an action that would break one of their deals (ADR 0035). The table on
 * the server is what judges compliance; this mirrors its rules from what the player's own board
 * shows (chosen target ids and their public owners), so the warning can only ever be advice. It
 * errs towards warning: a promise the table would excuse (self-defense against a seat that now
 * leads or threatens lethal) still gets a warning, worded as "may break".
 */
import type {
  Deal,
  DealObligation,
  LegalAction,
  ObjectId,
  PlayerBoardState,
  PlayerId,
  TargetChoice,
} from '@mtg/shared';
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
  targets: readonly TargetChoice[] | undefined,
  board: PlayerBoardState,
): string[] {
  if (action === undefined || action.type === 'blockDeclaration') return [];
  const mine = deals.flatMap((deal) =>
    deal.obligations.filter((o) => o.by === me).map((o) => ({ deal, o })),
  );
  if (mine.length === 0) return [];
  const attack = action.type === 'attackDeclaration' && action.data?.['chooseAttackers'] !== true;
  const { ownerOf, isStack } = ownerLookup(board);
  const chosen = (targets ?? []).map((t) => t.choice).filter((id) => !SENTINELS.has(id));
  const other = (deal: Deal) => (deal.parties[0] === me ? deal.parties[1] : deal.parties[0]);

  const warnings: string[] = [];
  for (const { deal, o } of mine) {
    const yours = `Deal ${deal.id} with ${other(deal)}: you promised ${promise(o)}`;
    if (o.kind === 'attackPlayer') {
      // As on the server, a promised attack the declaration could not have made is excused.
      const reachable = (action.targets ?? []).some((slot) =>
        slot.options.some((id) => !SENTINELS.has(id) && ownerOf(id) === o.target),
      );
      if (attack && reachable && !chosen.some((id) => ownerOf(id) === o.target)) {
        warnings.push(`${yours}, and this attack sends nothing at ${o.target}.`);
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
