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

/**
 * The engine's elimination log line ends with the raw reason code ("P2 is eliminated —
 * lifeZeroOrLess"). Show the reason in player terms; any other line is returned unchanged.
 */
export function playerFacingLogText(line: { text: string; emphasis?: string }): string {
  if (line.emphasis !== 'elimination') return line.text;
  return line.text.replace(
    / — (\w+)$/,
    (_match, reason: string) => ` — ${lossReasonLabel(reason)}`,
  );
}
