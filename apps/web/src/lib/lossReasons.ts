import type { LossReason } from '@mtg/shared';

const LOSS_LABELS: Record<LossReason, string> = {
  lifeZeroOrLess: 'Life total reached 0',
  emptyLibraryDraw: 'Drew from an empty library',
  poisonCounters: '10+ poison counters',
  commanderDamage: '21+ commander damage from one commander',
  other: 'Eliminated',
};

/** A recorded loss reason in player terms; an unknown stored value is shown as recorded. */
export function lossReasonLabel(reason: string): string {
  return Object.hasOwn(LOSS_LABELS, reason) ? LOSS_LABELS[reason as LossReason] : reason;
}
