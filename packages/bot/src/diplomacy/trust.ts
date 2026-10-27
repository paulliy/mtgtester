import type { PlayerId } from '@mtg/shared';
import { WEIGHTS } from '../weights';

export interface TrustRecord {
  kept: number;
  broken: number;
  /** Stake (LEP) of the biggest deal this seat has kept. */
  biggestKept: number;
}

/**
 * The public record of who keeps deals (ADR 0031 decision 12). Every seat sees every breach, so
 * there is one record per seat, not one per pair.
 */
export class TrustLedger {
  private readonly records = new Map<PlayerId, TrustRecord>();

  private recordFor(seat: PlayerId): TrustRecord {
    let record = this.records.get(seat);
    if (record === undefined) {
      record = { kept: 0, broken: 0, biggestKept: 0 };
      this.records.set(seat, record);
    }
    return record;
  }

  recordKept(seat: PlayerId, stake: number): void {
    const record = this.recordFor(seat);
    record.kept++;
    record.biggestKept = Math.max(record.biggestKept, stake);
  }

  recordBroken(seat: PlayerId): void {
    this.recordFor(seat).broken++;
  }

  /** Every seat's record, as plain data for `DiplomacyTable.toState`. */
  toJSON(): Record<PlayerId, TrustRecord> {
    return Object.fromEntries([...this.records].map(([seat, r]) => [seat, { ...r }]));
  }

  static fromJSON(data: Record<PlayerId, TrustRecord>): TrustLedger {
    const ledger = new TrustLedger();
    for (const [seat, r] of Object.entries(data)) ledger.records.set(seat, { ...r });
    return ledger;
  }

  snapshot(seat: PlayerId): Readonly<TrustRecord> {
    return { ...this.recordFor(seat) };
  }

  /**
   * Probability `seat` keeps a deal of size `stake`. Kept deals raise it only up to their own
   * size, so trust built on small deals barely transfers to a large one; each breach multiplies
   * it down.
   */
  pKeep(seat: PlayerId, stake: number): number {
    const D = WEIGHTS.deals;
    const { kept, broken, biggestKept } = this.recordFor(seat);
    const sizeCredit = stake <= 0 ? 1 : Math.min(1, biggestKept / stake);
    const credit = (kept / (kept + 1)) * sizeCredit;
    return (D.basePKeep + (D.maxPKeep - D.basePKeep) * credit) * D.brokenDecay ** broken;
  }
}
