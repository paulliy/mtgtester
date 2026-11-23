/**
 * The Card Test Lab's view model (redesign plan, phase 4d): the catalog `/api/card-test-scenarios`
 * serves, grouped by card. The catalog carries no card name, so the name is the part of a scenario
 * title before its first ": " (the lab's own convention), taken from the most common one among the
 * card's scenarios. Nothing here is invented: a scenario's clauses are its `clauseIds`, and a clause
 * lists the scenarios that name it.
 */
import type { CardTestScenarioMetadata } from '@mtg/shared';

export interface LabClause {
  id: string;
  scenarios: CardTestScenarioMetadata[];
}

export interface LabCard {
  /** The Oracle pin every scenario of the card shares. */
  oracleSha256: string;
  name: string;
  scenarios: CardTestScenarioMetadata[];
  /** Clause IDs in first-seen order, each with the scenarios that name it. */
  clauses: LabClause[];
}

/** The card a scenario title names: the text before its first ": ", or the whole title. */
export function titleSubject(title: string): string {
  const colon = title.indexOf(': ');
  return (colon > 0 ? title.slice(0, colon) : title).trim();
}

/** The most common subject among the titles; the first one seen wins a tie. */
export function cardNameFromTitles(titles: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const subject = titleSubject(title);
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [subject, count] of counts)
    if (count > bestCount) {
      best = subject;
      bestCount = count;
    }
  return best;
}

/** Group the catalog by `oracleSha256`, sorted by card name, keeping each card's catalog order. */
export function groupScenariosByCard(scenarios: readonly CardTestScenarioMetadata[]): LabCard[] {
  const byPin = new Map<string, CardTestScenarioMetadata[]>();
  for (const scenario of scenarios) {
    const group = byPin.get(scenario.oracleSha256);
    if (group === undefined) byPin.set(scenario.oracleSha256, [scenario]);
    else group.push(scenario);
  }
  const cards: LabCard[] = [];
  for (const [oracleSha256, group] of byPin) {
    const clauses = new Map<string, CardTestScenarioMetadata[]>();
    for (const scenario of group)
      for (const id of scenario.clauseIds) {
        const list = clauses.get(id);
        if (list === undefined) clauses.set(id, [scenario]);
        else list.push(scenario);
      }
    cards.push({
      oracleSha256,
      name: cardNameFromTitles(group.map((scenario) => scenario.title)),
      scenarios: group,
      clauses: [...clauses].map(([id, list]) => ({ id, scenarios: list })),
    });
  }
  return cards.sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.oracleSha256.localeCompare(b.oracleSha256),
  );
}

/** Cards whose name contains the query, ignoring case and surrounding space. */
export function filterCards(cards: readonly LabCard[], query: string): LabCard[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...cards];
  return cards.filter((card) => card.name.toLowerCase().includes(needle));
}

/**
 * A "Run all scenarios" sequence: the scenarios of one card still to start. Each scenario opens the
 * real board and the lab page is left, so the queue outlives the page (the view keeps it in
 * `sessionStorage`) and the next scenario starts when the player comes back.
 */
export interface RunQueue {
  oracleSha256: string;
  /** Scenario IDs not started yet, in order. */
  remaining: string[];
  total: number;
}

export function startQueue(card: LabCard): RunQueue {
  return {
    oracleSha256: card.oracleSha256,
    remaining: card.scenarios.map((scenario) => scenario.id),
    total: card.scenarios.length,
  };
}

/** Parse what the view stored; anything malformed is no queue. */
export function parseQueue(text: string | null): RunQueue | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<RunQueue> | null;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof value.oracleSha256 === 'string' &&
      typeof value.total === 'number' &&
      Array.isArray(value.remaining) &&
      value.remaining.every((id) => typeof id === 'string')
    )
      return { oracleSha256: value.oracleSha256, remaining: value.remaining, total: value.total };
  } catch {
    /* fall through */
  }
  return null;
}
