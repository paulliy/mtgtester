import { COMMANDER_DAMAGE_LETHAL, type LossReason } from '@mtg/shared';

const LOSS_LABELS: Record<LossReason, string> = {
  lifeZeroOrLess: 'Life total reached 0',
  emptyLibraryDraw: 'Drew from an empty library',
  poisonCounters: '10+ poison counters',
  commanderDamage: `${COMMANDER_DAMAGE_LETHAL}+ commander damage from one commander`,
  other: 'Eliminated',
};

/**
 * A recorded loss reason in player terms; an unknown stored value is shown as recorded. The
 * engine's codes (`lifeZeroOrLess`) never reach a screen: the server writes the words (ADR 0032
 * decision 5).
 */
export function lossReasonLabel(reason: string): string {
  return Object.hasOwn(LOSS_LABELS, reason) ? LOSS_LABELS[reason as LossReason] : reason;
}
