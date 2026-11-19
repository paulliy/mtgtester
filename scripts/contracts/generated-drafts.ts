/**
 * Generated promotion drafts as manifest evidence (Paul, 2026-11-16). A draft `card:scaffold`
 * wrote may satisfy a manifest clause once someone has read its expectations against the Oracle
 * line it names. Until then its title carries the "review against the Oracle line" mark, and a
 * manifest reference to it is refused. `card:scaffold --approve` is the one step that flips the
 * mark and names the draft in the manifest.
 */

export interface DraftScenario {
  id: string;
  title: string;
  /** 1-based Oracle lines the draft exercises. */
  clauses: number[];
}

export interface DraftFile {
  card: string;
  scenarios: DraftScenario[];
}

interface ManifestClause {
  oracleText: string;
  engineTestIds?: Array<string | { id: string }>;
  viewerScenarioIds?: string[];
  /** Files the clause's test IDs are narrowed to; the scenario runner must join them. */
  engineTestSource?: string | string[];
}

interface ManifestCard {
  name: string;
  engineTestIds?: Array<string | { id: string }>;
  clauses: ManifestClause[];
}

interface Manifest {
  cards: Record<string, ManifestCard>;
}

/** The scenario test file every scenario JSON runs in, so a draft's manifest ID is `this::<id>`. */
export const SCENARIO_TEST_FILE = 'scenario/scenarios.test.ts';

const scenarioIdOf = (reference: string): string => reference.split('::').at(-1)!;

/**
 * Every manifest reference (engine test ID or viewer scenario ID) to a draft of the same card
 * that still carries the unreviewed mark, as `card: "id" ...` problems.
 */
export function unreviewedDraftReferences(
  manifestJson: string,
  files: readonly DraftFile[],
  isUnreviewed: (title: string) => boolean,
): string[] {
  const manifest = JSON.parse(manifestJson) as Manifest;
  const pending = new Map<string, Set<string>>();
  for (const file of files)
    for (const scenario of file.scenarios)
      if (isUnreviewed(scenario.title)) {
        const ids = pending.get(file.card) ?? new Set<string>();
        ids.add(scenario.id);
        pending.set(file.card, ids);
      }
  const problems: string[] = [];
  for (const card of Object.values(manifest.cards)) {
    const ids = pending.get(card.name);
    if (ids === undefined) continue;
    const references = [
      ...(card.engineTestIds ?? []),
      ...card.clauses.flatMap((clause) => [
        ...(clause.engineTestIds ?? []),
        ...(clause.viewerScenarioIds ?? []),
      ]),
    ].map((entry) => (typeof entry === 'string' ? entry : entry.id));
    for (const reference of references)
      if (ids.has(scenarioIdOf(reference)))
        problems.push(
          `${card.name}: "${reference}" names a generated draft nobody has reviewed; read it against its Oracle line, then run bun run card:scaffold "${card.name}" --approve ${scenarioIdOf(reference)}`,
        );
  }
  return problems;
}

export interface DraftMapping {
  manifestJson: string;
  /** Draft IDs added to a clause. */
  mapped: string[];
  /** Draft IDs whose Oracle line matched no manifest clause. */
  unmapped: string[];
}

/**
 * The manifest with each draft named in the clause whose Oracle text is the draft's line: as
 * `scenario/scenarios.test.ts::<id>` in `engineTestIds`. Viewer scenario IDs are left to the
 * author, since the Card Test Lab registers scenario files separately (`card:finish`). A card absent from the manifest maps nothing. IDs already
 * present are not added twice. The text is re-serialized with two-space indentation.
 */
export function mapDraftsIntoManifest(
  manifestJson: string,
  cardName: string,
  oracleText: string,
  drafts: readonly DraftScenario[],
): DraftMapping {
  const manifest = JSON.parse(manifestJson) as Manifest;
  const entry = Object.values(manifest.cards).find((card) => card.name === cardName);
  if (entry === undefined)
    return { manifestJson, mapped: [], unmapped: drafts.map((draft) => draft.id) };
  const lines = oracleText.split('\n');
  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const draft of drafts) {
    const targets = draft.clauses
      .map((line) => lines[line - 1]?.trim())
      .flatMap((text) =>
        text === undefined
          ? []
          : entry.clauses.filter((clause) => clause.oracleText.trim() === text),
      );
    if (targets.length === 0) {
      unmapped.push(draft.id);
      continue;
    }
    for (const clause of targets) {
      const testId = `${SCENARIO_TEST_FILE}::${draft.id}`;
      const ids = clause.engineTestIds ?? [];
      if (!ids.some((id) => (typeof id === 'string' ? id : id.id) === testId))
        clause.engineTestIds = [...ids, testId];
      // A clause whose IDs are narrowed to named files would filter the scenario runner's test
      // out, so the runner joins the list (check:manifest-tests rejects the ID otherwise).
      if (clause.engineTestSource !== undefined) {
        const sources = Array.isArray(clause.engineTestSource)
          ? clause.engineTestSource
          : [clause.engineTestSource];
        if (!sources.includes(SCENARIO_TEST_FILE))
          clause.engineTestSource = [...sources, SCENARIO_TEST_FILE];
      }
    }
    mapped.push(draft.id);
  }
  return { manifestJson: `${JSON.stringify(manifest, null, 2)}\n`, mapped, unmapped };
}
