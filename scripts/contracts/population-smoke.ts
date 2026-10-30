/**
 * The whole-population smoke (ADR 0034 decision 9): interpret every card of an Oracle population
 * and validate each modeled definition. The nightly bulk job runs it over the pinned Scryfall
 * bank (`bun run bulk-smoke`); a test runs it over the committed coverage fixture.
 */
import type { OracleCard } from '../../packages/shared/src';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { interpretCard } from '../../packages/engine/src/cards/interpret';

export interface PopulationSmoke {
  cards: number;
  modeled: number;
  /** Cards whose interpretation threw. */
  threw: Array<{ name: string; message: string }>;
  /** Modeled cards whose definition fails validation. */
  invalid: Array<{ name: string; issues: string[] }>;
}

export function populationSmoke(cards: Iterable<OracleCard>): PopulationSmoke {
  const smoke: PopulationSmoke = { cards: 0, modeled: 0, threw: [], invalid: [] };
  for (const card of cards) {
    smoke.cards++;
    let definition;
    try {
      definition = interpretCard(card);
    } catch (error) {
      smoke.threw.push({
        name: card.name,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!definition.modeled) continue;
    smoke.modeled++;
    const issues = validateCardDefinition(definition);
    if (issues.length > 0)
      smoke.invalid.push({
        name: card.name,
        issues: issues.map((issue) => `${issue.path}: ${issue.message}`),
      });
  }
  return smoke;
}

/** Why a smoke fails against the baseline recorded for the same bank, or an empty list. */
export function populationProblems(
  smoke: PopulationSmoke,
  baseline: { modeled: number } | undefined,
): string[] {
  return [
    ...smoke.threw.map(({ name, message }) => `${name}: interpretation threw: ${message}`),
    ...smoke.invalid.map(({ name, issues }) => `${name}: invalid modeled IR: ${issues.join('; ')}`),
    ...(baseline !== undefined && smoke.modeled < baseline.modeled
      ? [`modeled cards fell from ${baseline.modeled} to ${smoke.modeled}`]
      : []),
  ];
}
