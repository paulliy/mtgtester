/**
 * The Card Test Lab's view model (redesign plan, phase 4d): the catalog `/api/card-test-scenarios`
 * serves, grouped by card. The catalog carries no card name, so the name is the part of a scenario
 * title before its first ": " (the lab's own convention), taken from the most common one among the
 * card's scenarios. Nothing here is invented: a scenario's clauses are its `clauseIds`, and a clause
 * lists the scenarios that name it.
 */
import type { CardTestLabCard, CardTestScenarioMetadata } from '@mtg/shared';

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
export function groupScenariosByCard(
  scenarios: readonly CardTestScenarioMetadata[],
  /** Real card names by Oracle hash (the lab card report); a hash without one keeps the title's. */
  names: ReadonlyMap<string, string> = new Map(),
): LabCard[] {
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
      name: names.get(oracleSha256) ?? cardNameFromTitles(group.map((scenario) => scenario.title)),
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

/** What the evidence column says about one item: whether it is recorded, and the words for it. */
export interface EvidenceRow {
  label: string;
  recorded: boolean;
  state: string;
  detail?: string;
  /** Context, not a completion item: drawn without a check box and never ticked. */
  info?: boolean;
}

const LEDGER_WORDS: Record<string, string> = {
  'engine-tests': 'engine tests',
  contained: 'contained as unsupported',
  playwright: 'Playwright in the real viewer',
  'not-run': 'not run',
  'not-applicable': 'not applicable',
  'not-evaluated': 'not evaluated',
};
const ledgerWord = (value: string): string => LEDGER_WORDS[value] ?? value;

/**
 * The evidence list for one card. An item is recorded only when the manifest or the ledger says
 * it is; everything else reads "Not recorded" with the reason, and nothing defaults to complete.
 */
export function evidenceRows(
  sha256: string,
  scenarioCount: number,
  info: CardTestLabCard | undefined,
): EvidenceRow[] {
  const notRecorded = (state: string, detail?: string): Omit<EvidenceRow, 'label'> => ({
    recorded: false,
    state: `Not recorded. ${state}`,
    ...(detail !== undefined && { detail }),
  });
  const rows: EvidenceRow[] = [
    {
      label: 'Pinned Oracle text',
      recorded: true,
      state: `Recorded: sha256 ${sha256.slice(0, 12)}…`,
    },
  ];

  if (info === undefined || !info.manifestPinned || info.clauses.length === 0) {
    rows.push({
      label: 'Every clause mapped to scenarios',
      ...notRecorded(
        info === undefined
          ? 'The lab card report is not available.'
          : 'The verification manifest does not pin this Oracle text, so its clauses are not known.',
      ),
    });
  } else {
    const gaps = info.clauses.filter((clause) => clause.scenarioIds.length === 0).length;
    const total = info.clauses.length;
    rows.push(
      gaps === 0 && info.unmappedScenarioIds.length === 0
        ? {
            label: 'Every clause mapped to scenarios',
            recorded: true,
            state: `Recorded: all ${total} ${total === 1 ? 'clause has' : 'clauses have'} a scenario.`,
          }
        : {
            label: 'Every clause mapped to scenarios',
            ...notRecorded(
              [
                gaps > 0 ? `${gaps} of ${total} clauses have no scenario.` : '',
                info.unmappedScenarioIds.length > 0
                  ? `${info.unmappedScenarioIds.length} scenarios name no manifest clause.`
                  : '',
              ]
                .filter((part) => part !== '')
                .join(' '),
            ),
          },
    );
  }

  const engineTests = new Set(info?.clauses.flatMap((clause) => clause.engineTestIds) ?? []);
  rows.push({
    label: 'Positive and negative engine scenarios',
    ...notRecorded(
      `${scenarioCount} lab ${scenarioCount === 1 ? 'scenario' : 'scenarios'}, not marked positive or negative by the manifest.`,
      engineTests.size > 0
        ? `The manifest names ${engineTests.size} engine ${engineTests.size === 1 ? 'test' : 'tests'}.`
        : undefined,
    ),
  });
  rows.push({
    label: 'Normal cast and activation path',
    ...notRecorded('The manifest holds no separate record of it.'),
  });

  const ledger = info?.ledger;
  const auditNote =
    info === undefined
      ? 'The lab card report is not available.'
      : info.audit === 'stale'
        ? 'The ledger entry pins a different Oracle text and is not used.'
        : info.audit === 'unpinned'
          ? 'The ledger entry has no Oracle pin and is not used.'
          : 'The ledger has no entry for this card.';
  const tests = ledger?.engineTestIds;
  rows.push(
    ledger?.engine === undefined
      ? { label: 'Engine evidence', ...notRecorded(auditNote) }
      : {
          label: 'Engine evidence',
          recorded: ledger.engine === 'engine-tests',
          state: `Ledger: ${ledgerWord(ledger.engine)}`,
          ...(tests !== undefined && tests.length > 0 && { detail: `Tests: ${tests.join(', ')}` }),
        },
  );
  rows.push(
    ledger?.viewer === undefined
      ? { label: 'Seen working in the real viewer', ...notRecorded(auditNote) }
      : {
          label: 'Seen working in the real viewer',
          recorded: ledger.viewer === 'playwright',
          state: `Ledger: ${ledgerWord(ledger.viewer)}`,
          ...(ledger.viewerScenarioId !== undefined && {
            detail: `Viewer scenario: ${ledger.viewerScenarioId}`,
          }),
        },
  );
  rows.push(
    ledger?.gameplayAi === undefined
      ? { label: 'Gameplay AI uses it sensibly', ...notRecorded(auditNote) }
      : {
          label: 'Gameplay AI uses it sensibly',
          recorded: ledger.gameplayAi !== 'not-evaluated',
          state: `Ledger: ${ledgerWord(ledger.gameplayAi)}`,
        },
  );
  if (ledger?.note !== undefined)
    rows.push({ label: 'Ledger note', recorded: false, info: true, state: ledger.note });
  return rows;
}
