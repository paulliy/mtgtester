import type { OracleCard } from '@mtg/shared';
import type { CoverageReport } from './coverage';

export interface CoveragePopulation {
  decks: { name: string; oracleIds: string[] }[];
  /**
   * Cards of the population known not to be modeled yet. A ratchet: a card outside this list that
   * is unmodeled is a regression, and a listed card that became modeled must leave the list.
   */
  knownUnmodeled?: { oracleId: string; name: string }[];
}

/** Never allow a missing fixture or a substituted card to improve measured coverage. */
export function assertCoveragePopulation(
  report: CoverageReport,
  population: CoveragePopulation,
): void {
  const sameSet = (actual: string[], expected: string[], label: string): void => {
    const a = new Set(actual);
    const e = new Set(expected);
    if (
      a.size !== actual.length ||
      e.size !== expected.length ||
      a.size !== e.size ||
      [...e].some((id) => !a.has(id))
    ) {
      throw new Error(`coverage population changed: ${label}`);
    }
  };
  sameSet(
    report.decks.map((d) => d.name),
    population.decks.map((d) => d.name),
    'decks',
  );
  for (const deck of population.decks) {
    sameSet(
      report.cards.filter((c) => c.deckNames.includes(deck.name)).map((c) => c.oracleId),
      deck.oracleIds,
      deck.name,
    );
  }
  sameSet(
    report.cards.map((c) => c.oracleId),
    [...new Set(population.decks.flatMap((d) => d.oracleIds))],
    'unique cards',
  );
}

/** Stable Oracle input identity, independent of object property order. */
export function canonicalOracle(value: OracleCard): string {
  function ordered(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  }
  return JSON.stringify(ordered(value));
}

export function assertCompleteCoverage(report: CoverageReport): void {
  const blocked = report.cards.filter((c) => !c.modeled || c.reasons.length > 0);
  if (
    report.uniqueCards === 0 ||
    report.uniqueCards !== report.cards.length ||
    report.modeledCards !== report.uniqueCards ||
    blocked.length > 0
  ) {
    throw new Error(
      `coverage incomplete: ${report.modeledCards}/${report.uniqueCards}; ` +
        blocked.map((c) => c.name).join(', '),
    );
  }
}

/** Unmodeled cards must be exactly the population's known-unmodeled list; it may only shrink. */
export function assertKnownUnmodeled(report: CoverageReport, population: CoveragePopulation): void {
  const known = new Set((population.knownUnmodeled ?? []).map((card) => card.oracleId));
  const blocked = report.cards.filter((c) => !c.modeled || c.reasons.length > 0);
  const regressed = blocked.filter((c) => !known.has(c.oracleId)).map((c) => c.name);
  const blockedIds = new Set(blocked.map((c) => c.oracleId));
  const fixed = (population.knownUnmodeled ?? [])
    .filter((card) => !blockedIds.has(card.oracleId))
    .map((card) => card.name);
  const problems = [
    ...(regressed.length > 0 ? [`no longer modeled: ${regressed.join(', ')}`] : []),
    ...(fixed.length > 0
      ? [`now modeled, remove from knownUnmodeled in coverage-contract.json: ${fixed.join(', ')}`]
      : []),
  ];
  if (problems.length > 0) throw new Error(`coverage ratchet: ${problems.join('; ')}`);
}
