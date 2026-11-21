/**
 * Knob persistence (bot-led mode, ADR 0039 and ADR 0051): the strategist's knobs stay in force
 * across turns, and a new answer changes only the knobs it names. A knob it leaves out keeps its
 * value; an empty list clears `targetOrder`, `prioritize` or `hold`. The strategist is shown the
 * knobs in force (`yourCurrentKnobs`), so leaving one out is a choice to keep it.
 */
import type { BotSteering } from '@mtg/shared';

const LIST_KNOBS = ['targetOrder', 'prioritize', 'hold'] as const;

export function mergeSteering(kept: BotSteering | undefined, next: BotSteering): BotSteering {
  const merged: BotSteering = { ...kept, ...next };
  for (const key of LIST_KNOBS) {
    const list = merged[key];
    if (list !== undefined && list.length === 0) delete merged[key];
  }
  return merged;
}
