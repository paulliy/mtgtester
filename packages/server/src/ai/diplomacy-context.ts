/**
 * Table diplomacy for model-driven seats (ADR 0035 phase 4): what the strategist and tactician are
 * told about deals, as tokens rather than extra calls, and how a strategist's proposal is read.
 *
 * Everything here is public at the table: deals, who keeps and breaks them, and a seat's own
 * promises. Nothing names a card, so no hidden information moves between seats.
 */

import type { Deal, DealTerms, PlayerId } from '@mtg/shared';
import { describeObligation } from '@mtg/bot';
import { readDealDraft } from './deal-draft';

export interface SeatDiplomacyContext {
  /** The seat's own promises in force, as sentences. */
  yourPromises: string[];
  /** Promises other seats made to it. */
  promisesToYou: string[];
  /** Every other deal in force at the table. */
  otherDeals: string[];
  /** Each seat's public record of deals kept and broken. */
  records: Array<{ seat: PlayerId; kept: number; broken: number }>;
  /** How to offer a deal, for the strategist on a turn it may still propose. */
  howToPropose?: string;
}

export interface DiplomacySource {
  deals: readonly Deal[];
  records: ReadonlyArray<{ seat: PlayerId; kept: number; broken: number }>;
  canPropose: boolean;
  maxRounds: number;
  maxObligationsPerSide: number;
}

function roundsText(rounds: number): string {
  return rounds === 1 ? 'one round' : `${rounds} rounds`;
}

/**
 * The context for `seat`. `role` decides how much: a strategist always sees the table and, when it
 * may propose, how; a tactician sees only its own deals, and nothing at all when it has none, so a
 * seat without deals gets the prompt it always had.
 */
export function seatDiplomacyContext(
  seat: PlayerId,
  source: DiplomacySource,
  role: 'strategist' | 'tactician',
): SeatDiplomacyContext | null {
  const name = (s: PlayerId) => (s === seat ? 'you' : s);
  const yourPromises: string[] = [];
  const promisesToYou: string[] = [];
  const otherDeals: string[] = [];
  for (const deal of source.deals) {
    const length = ` (deal ${deal.id}, ${roundsText(deal.rounds)})`;
    if (!deal.parties.includes(seat)) {
      otherDeals.push(deal.obligations.map((o) => describeObligation(o, name)).join('; ') + length);
      continue;
    }
    for (const o of deal.obligations) {
      (o.by === seat ? yourPromises : promisesToYou).push(describeObligation(o, name) + length);
    }
  }
  if (role === 'tactician' && yourPromises.length === 0 && promisesToYou.length === 0) return null;
  const context: SeatDiplomacyContext = {
    yourPromises,
    promisesToYou,
    otherDeals: role === 'strategist' ? otherDeals : [],
    records: role === 'strategist' ? [...source.records] : [],
  };
  if (role === 'strategist' && source.canPropose) {
    context.howToPropose =
      `To offer one two-party deal this turn, add "dealProposal":{"to":"P3","obligations":[...],"rounds":1} inside turnStrategy. ` +
      `Obligations: {"kind":"noAttack"|"noTarget"|"noCounter","by":seat,"against":seat} or {"kind":"attackPlayer","by":seat,"target":seat}; each is owed by you (${seat}) or the other party. ` +
      `rounds is 1 to ${source.maxRounds}; at most ${source.maxObligationsPerSide} obligations per side. ` +
      `Other players accept only deals that help them, and every breach is seen by the whole table. Omit dealProposal when no deal helps you.`;
  }
  return context;
}

/**
 * A strategist's `dealProposal`, read as terms with the same fail-closed reader as a player's
 * free text. The table still validates whatever comes back when it is offered.
 */
export function readStrategistProposal(
  raw: unknown,
  seat: PlayerId,
  opponents: readonly PlayerId[],
  limits: { maxRounds: number; maxObligationsPerSide: number },
): DealTerms | null {
  if (raw === undefined || raw === null) return null;
  return readDealDraft(raw, {
    gameId: '',
    turn: 0,
    seat,
    opponents,
    maxRounds: limits.maxRounds,
    maxObligationsPerSide: limits.maxObligationsPerSide,
  });
}
