/**
 * Scarce answers and lethal on the public board (ADR 0044). The `scarce-answer` escalation trigger
 * and the bot's own last-answer discipline read the same definitions here, so the trigger and the
 * bot agree on which card is the last of its kind and when lethal is at stake.
 *
 * Everything reads only the seat's `PlayerView` and the card knowledge: no hidden information.
 */
import type { DecisionRequest, ObjectId, PlayerView } from '@mtg/shared';
import type { CardKnowledge, CardTraits } from './card-knowledge';
import {
  combatBody,
  damageThrough,
  incomingDamage,
  readyAttackers,
  untappedCreatures,
} from './tactics';

/** The answer roles that make a card scarce when it is the last of its kind in hand. */
export type AnswerKind = 'counter' | 'wipe' | 'hardRemoval';

export function answerKinds(traits: CardTraits | undefined): AnswerKind[] {
  if (traits === undefined) return [];
  const kinds: AnswerKind[] = [];
  if (traits.roles.includes('counter')) kinds.push('counter');
  if (traits.roles.includes('wipe')) kinds.push('wipe');
  if (traits.roles.includes('removal') && traits.hardRemoval === true) kinds.push('hardRemoval');
  return kinds;
}

/** Constant damage the seat's hand could send at a player: burn spells whose slots deal it. */
function burnInHand(view: PlayerView, knowledge: CardKnowledge): number {
  let total = 0;
  for (const card of view.hand) {
    const traits = knowledge(card.name);
    if (traits === undefined || !traits.roles.includes('burn')) continue;
    const best = Math.max(0, ...(traits.spellDamage ?? []).map((d) => d ?? 0));
    total += best;
  }
  return total;
}

/** The opponents this seat could kill this turn from its board and the cards it can see. */
export function offensiveLethal(
  view: PlayerView,
  request: DecisionRequest,
  knowledge: CardKnowledge,
) {
  if (request.activePlayer !== view.seat) return [];
  const combatOver = request.phase === 'postcombatMain' || request.phase === 'ending';
  const attackers = combatOver ? [] : readyAttackers(view).map((p) => combatBody(p));
  const burn = burnInHand(view, knowledge);
  return view.opponents.filter((o) => {
    if (o.life <= 0) return false;
    const blockers = untappedCreatures(view, o.seat).map((p) => combatBody(p));
    return damageThrough(attackers, blockers) + burn >= o.life;
  });
}

/**
 * The power each opponent's creatures add from a team pump that opponent has on the stack: the
 * stack is public, so a resolving Overrun is part of the board a seat can read.
 */
export function stackPumps(view: PlayerView, knowledge: CardKnowledge): Map<string, number> {
  const pumps = new Map<string, number>();
  for (const item of view.stack) {
    if (item.controller === view.seat) continue;
    const pump = knowledge(item.description)?.massPump;
    if (pump !== undefined)
      pumps.set(item.controller, (pumps.get(item.controller) ?? 0) + pump.power);
  }
  return pumps;
}

/**
 * Whether the opponents who act before this seat's next turn have lethal on board: their total
 * creature power (plus team pumps they have on the stack) reaches the seat's life, an opponent's
 * commander damage plus its biggest creature reaches 21, or infect and toxic power reaches ten
 * poison counters.
 */
export function defensiveLethal(view: PlayerView, knowledge: CardKnowledge): boolean {
  const live = new Set(view.opponents.filter((o) => o.life > 0).map((o) => o.seat));
  const pumps = stackPumps(view, knowledge);
  const theirs = view.battlefield.filter(
    (p) => live.has(p.controller) && p.power !== undefined && p.power !== null,
  );
  const powerOf = (p: (typeof theirs)[number]): number =>
    Math.max(0, (p.power ?? 0) + (pumps.get(p.controller) ?? 0));
  const power = theirs.reduce((sum, p) => sum + powerOf(p), 0);
  if (power >= view.life) return true;
  for (const opponent of view.opponents) {
    if (!live.has(opponent.seat) || opponent.commanderDamageDealtToYou === 0) continue;
    const biggest = Math.max(
      0,
      ...theirs.filter((p) => p.controller === opponent.seat).map(powerOf),
    );
    if (opponent.commanderDamageDealtToYou + biggest >= 21) return true;
  }
  const poisonous = theirs
    .filter((p) => (p.keywords ?? []).some((k) => /^(infect|toxic)/i.test(k)))
    .reduce((sum, p) => sum + powerOf(p), 0);
  return poisonous > 0 && (view.poisonCounters ?? 0) + poisonous >= 10;
}

/** Lethal at stake on the public board, either way (ADR 0044's `scarce-answer` exemption). */
export function publicLethal(
  view: PlayerView,
  request: DecisionRequest,
  knowledge: CardKnowledge,
): boolean {
  return (
    incomingTotal(view) >= view.life ||
    defensiveLethal(view, knowledge) ||
    offensiveLethal(view, request, knowledge).length > 0
  );
}

/** Combat damage on its way to this seat now: the sum of `incomingDamage`. */
export function incomingTotal(view: PlayerView): number {
  return [...incomingDamage(view).values()].reduce((sum, d) => sum + d, 0);
}

/**
 * The answer kinds `name` would spend that no other card in the seat's hand shares: casting it
 * leaves the seat without that kind of answer. `castId` is the cast card's own object id, so it is
 * not counted as its own backup. Empty when the card is no answer, or when every kind it has is
 * backed up by another card in hand.
 */
export function lastAnswerKinds(
  name: string | undefined,
  castId: ObjectId | undefined,
  view: PlayerView,
  knowledge: CardKnowledge,
): AnswerKind[] {
  const kinds = answerKinds(name === undefined ? undefined : knowledge(name));
  if (kinds.length === 0) return [];
  const others = view.hand.filter((card) => card.id !== castId);
  return kinds.filter(
    (kind) => !others.some((card) => answerKinds(knowledge(card.name)).includes(kind)),
  );
}
