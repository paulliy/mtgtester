/**
 * The deal panel's builder, as plain data (ADR 0035 phase 3): rows the player edits, turned into
 * the typed obligations the server checks, and back again for a counter or a drafted reading.
 */
import type { DealObligation, DealObligationKind, DealOutcomeNotice, PlayerId } from '@mtg/shared';

export const OBLIGATION_KINDS: readonly { kind: DealObligationKind; label: string }[] = [
  { kind: 'noAttack', label: "won't attack" },
  { kind: 'noTarget', label: "won't target" },
  { kind: 'noCounter', label: "won't counter" },
  { kind: 'attackPlayer', label: 'attacks' },
];

/** One editable obligation: who owes it, what, and the seat it concerns. */
export interface BuilderRow {
  by: PlayerId;
  kind: DealObligationKind;
  /** `against` for the restraints, `target` for `attackPlayer`. */
  other: PlayerId;
}

export function rowToObligation(row: BuilderRow): DealObligation {
  return row.kind === 'attackPlayer'
    ? { kind: 'attackPlayer', by: row.by, target: row.other }
    : { kind: row.kind, by: row.by, against: row.other };
}

export function obligationToRow(o: DealObligation): BuilderRow {
  return o.kind === 'attackPlayer'
    ? { by: o.by, kind: o.kind, other: o.target }
    : { by: o.by, kind: o.kind, other: o.against };
}

/** Rows owed by `seat`. */
export function rowsOwedBy(rows: readonly BuilderRow[], seat: PlayerId): number {
  return rows.filter((row) => row.by === seat).length;
}

/** Whether a row can still be added for `seat` without passing the per-side limit. */
export function canAddRow(rows: readonly BuilderRow[], seat: PlayerId, max: number): boolean {
  return rowsOwedBy(rows, seat) < max;
}

/** A first row for `by`: the first seat that is not `by` and is not excluded. */
export function newRow(by: PlayerId, candidates: readonly PlayerId[]): BuilderRow | null {
  const other = candidates.find((seat) => seat !== by);
  return other === undefined ? null : { by, kind: 'noAttack', other };
}

const REFUSALS: Record<NonNullable<DealOutcomeNotice['reason']>, string> = {
  invalid: 'That is not a valid deal.',
  rateLimited: 'You have already proposed this slot.',
  cooldown: 'That seat just turned you down; try again later.',
  notNegotiating: 'That seat is not negotiating.',
  pending: 'That seat already has an offer from you waiting.',
  noSuchOffer: 'That offer has already lapsed.',
};

/** The outcome of the player's last proposal or answer, as one short sentence. */
export function describeOutcome(outcome: DealOutcomeNotice): string {
  switch (outcome.kind) {
    case 'accepted':
      return 'Deal made.';
    case 'declined':
      if (outcome.reason !== undefined) {
        return `Declined. Your counter was not sent: ${REFUSALS[outcome.reason]}`;
      }
      return outcome.counterPending ? 'Declined. A counter-offer is waiting.' : 'Declined.';
    case 'pending':
      return 'Offer made; waiting for an answer.';
    case 'withdrawn':
      return 'The offer was withdrawn.';
    case 'refused':
      return outcome.reason !== undefined ? REFUSALS[outcome.reason] : 'The offer was refused.';
  }
}
