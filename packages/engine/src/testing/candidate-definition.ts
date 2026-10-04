import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from '../cards/definition';
import { interpretCard } from '../cards/interpret';

/**
 * Build an executable definition for closed fixture tests without changing the global support
 * registry. The exact interpreter reasons still have to match the candidate's handled lines,
 * and the real card must remain explicitly unsupported before this hook returns a definition.
 */
export function buildGuardedCandidateDefinition(
  card: OracleCard,
  handledLines: readonly string[],
  patch: Partial<CardDefinition>,
): CardDefinition {
  const guarded = interpretCard(card);
  if (guarded.modeled) {
    throw new Error(`${card.name}: candidate definition requires a fail-closed product card`);
  }
  if (!guarded.unmodeledReasons.some((reason) => reason.startsWith('explicitly unsupported:'))) {
    throw new Error(`${card.name}: candidate definition requires an explicit unsupported guard`);
  }

  const remaining = guarded.unmodeledReasons.filter(
    (reason) => !reason.startsWith('explicitly unsupported:'),
  );
  const expectedCounts = new Map<string, number>();
  for (const line of handledLines) expectedCounts.set(line, (expectedCounts.get(line) ?? 0) + 1);
  for (const reason of remaining) {
    const count = expectedCounts.get(reason) ?? 0;
    if (count === 0) {
      throw new Error(`${card.name}: candidate does not handle interpreter reason: ${reason}`);
    }
    expectedCounts.set(reason, count - 1);
  }
  if ([...expectedCounts.values()].some((count) => count !== 0)) {
    throw new Error(`${card.name}: candidate handledLines do not match interpreter reasons`);
  }

  return { ...guarded, ...patch, modeled: true, unmodeledReasons: [] };
}
