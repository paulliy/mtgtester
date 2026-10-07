import type { CardDefinition } from './definition';

/** Additional X currently supports the monotone, bounded "pay X life" announcement. */
export function supportsAdditionalXAnnouncement(
  definition: Pick<CardDefinition, 'announcesX' | 'spellAdditionalCosts'>,
): boolean {
  return (
    definition.announcesX !== true ||
    (definition.spellAdditionalCosts?.some(
      (cost) => cost.kind === 'payLifeValue' && cost.amount.kind === 'xValue',
    ) === true &&
      definition.spellAdditionalCosts.every(
        (cost) => cost.kind !== 'payLifeValue' || ['const', 'xValue'].includes(cost.amount.kind),
      ))
  );
}
