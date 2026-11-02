/**
 * The Card Test Lab sample a CI run plays (ADR 0037). `scripts/card-test-lab-sample.ts select`
 * writes the selection file and CI points `LAB_SELECTION` at it; `playwright.config.ts` turns its
 * excluded titles into `grepInvert`, and each spec's completeness check reads the selected IDs.
 * With `LAB_SELECTION` unset (every local run, the weekly run and `ci:lab-verbose`) nothing is
 * filtered and every completeness check demands the full catalog, as before.
 */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

export interface LabSelectionFile {
  schemaVersion: 1;
  /** The commit the sample was drawn from. */
  seed: string;
  /** The commit the change was compared with, or null when none was given. */
  base: string | null;
  sample: boolean;
  latest: boolean;
  perFamily: number;
  /** Scenarios in the catalog. */
  total: number;
  selected: { id: string; title: string; reasons: string[] }[];
  /** IDs and titles of the scenarios left out. */
  excludedTitles: string[];
  notes: string[];
}

export function parseLabSelectionFile(text: string): LabSelectionFile {
  const value = JSON.parse(text) as Partial<LabSelectionFile>;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.selected) ||
    !Array.isArray(value.excludedTitles)
  )
    throw new Error('lab sample: the selection file is not a schemaVersion 1 selection');
  return value as LabSelectionFile;
}

let loaded: LabSelectionFile | null | undefined;
/** The selection `LAB_SELECTION` names, or null for a full run. A named file must exist. */
export function labSelection(): LabSelectionFile | null {
  if (loaded !== undefined) return loaded;
  const path = process.env['LAB_SELECTION'];
  loaded =
    path === undefined || path === '' ? null : parseLabSelectionFile(readFileSync(path, 'utf8'));
  return loaded;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The `grepInvert` pattern that leaves out the tests titled with an excluded scenario's ID or
 * title. Playwright matches it against the test's title path joined with spaces (then any tags),
 * so the title must end the string and follow a space or start it. A test whose title names no
 * scenario is never matched, so it always runs.
 */
export function excludedTitlePattern(excludedTitles: readonly string[]): RegExp | undefined {
  if (excludedTitles.length === 0) return undefined;
  const alternatives = [...new Set(excludedTitles)].sort().map(escapeRegExp);
  return new RegExp(`(?:^| )(?:${alternatives.join('|')})$`);
}

/**
 * A spec's completeness check. A full run must exercise exactly `required`. A sampled run must
 * exercise every selected scenario of `required` and nothing outside `required`; it may exercise
 * unselected ones too, through tests whose titles name no scenario and so always run.
 */
export function expectLabCoverage(
  exercised: ReadonlySet<string>,
  required: Iterable<string>,
): void {
  const all = [...new Set(required)].sort();
  const selection = labSelection();
  if (selection === null) {
    expect([...exercised].sort()).toEqual(all);
    return;
  }
  const selected = new Set(selection.selected.map(({ id }) => id));
  expect(all.filter((id) => selected.has(id) && !exercised.has(id))).toEqual([]);
  expect([...exercised].filter((id) => !all.includes(id)).sort()).toEqual([]);
}
