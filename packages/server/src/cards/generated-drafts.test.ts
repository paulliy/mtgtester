/**
 * Generated promotion drafts as manifest evidence (Paul, 2026-11-16): a draft counts only once it
 * has been reviewed, and approving one names it in the clause whose Oracle line it exercises.
 */
import { describe, expect, it } from 'vitest';
import {
  isUnreviewedDraft,
  markReviewed,
  scaffoldCard,
} from '../../../engine/tests/scenario/scaffold';
import { pinStore } from '../../../engine/tests/scenario/pin-store';
import { resolveScenarioCard } from '../../../engine/tests/scenario/runner';
import {
  SCENARIO_TEST_FILE,
  mapDraftsIntoManifest,
  unreviewedDraftReferences,
} from '../../../../scripts/contracts/generated-drafts';

const card = pinStore.get('Thraben Inspector');
const drafts = scaffoldCard(card, resolveScenarioCard).file.scenarios;

const manifestOf = (engineTestIds: string[], viewerScenarioIds?: string[]) =>
  JSON.stringify({
    cards: {
      [card.oracleId]: {
        name: card.name,
        clauses: card.oracleText.split('\n').map((oracleText, index) => ({
          oracleText,
          engineTestIds: index === 0 ? engineTestIds : [],
          ...(viewerScenarioIds !== undefined && { viewerScenarioIds: [] }),
        })),
      },
    },
  });

describe('generated draft review marks', () => {
  it('marks every fresh draft unreviewed, and reviewing rewrites only the mark', () => {
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(isUnreviewedDraft(draft.title), draft.id).toBe(true);
      const reviewed = markReviewed(draft.title);
      expect(isUnreviewedDraft(reviewed)).toBe(false);
      expect(reviewed).toMatch(/\(generated scaffold v\d+, reviewed\)$/);
      expect(reviewed.replace(/\(generated scaffold.*$/, '')).toBe(
        draft.title.replace(/\(generated scaffold.*$/, ''),
      );
    }
    expect(markReviewed('A hand-written scenario')).toBe('A hand-written scenario');
  });
});

describe('unreviewedDraftReferences', () => {
  const draft = drafts[0]!;
  const file = { card: card.name, scenarios: [draft] };

  it('refuses a manifest reference to an unreviewed draft, by test ID or by viewer ID', () => {
    const problems = unreviewedDraftReferences(
      manifestOf([`${SCENARIO_TEST_FILE}::${draft.id}`]),
      [file],
      isUnreviewedDraft,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('--approve');
  });

  it('accepts the same reference once the draft is reviewed', () => {
    const reviewed = {
      card: card.name,
      scenarios: [{ ...draft, title: markReviewed(draft.title) }],
    };
    expect(
      unreviewedDraftReferences(
        manifestOf([`${SCENARIO_TEST_FILE}::${draft.id}`]),
        [reviewed],
        isUnreviewedDraft,
      ),
    ).toEqual([]);
  });

  it('ignores another card that happens to reuse the scenario ID', () => {
    expect(
      unreviewedDraftReferences(
        manifestOf([`${SCENARIO_TEST_FILE}::${draft.id}`]),
        [{ card: 'Doom Blade', scenarios: [draft] }],
        isUnreviewedDraft,
      ),
    ).toEqual([]);
  });
});

describe('mapDraftsIntoManifest', () => {
  it('names each draft in the clause of its Oracle line, once, as engine test IDs', () => {
    const once = mapDraftsIntoManifest(manifestOf([], []), card.name, card.oracleText, drafts);
    expect(once.mapped).toEqual(drafts.map((draft) => draft.id));
    expect(once.unmapped).toEqual([]);
    const twice = mapDraftsIntoManifest(once.manifestJson, card.name, card.oracleText, drafts);
    const entry = (
      JSON.parse(twice.manifestJson) as {
        cards: Record<
          string,
          { clauses: Array<{ engineTestIds: string[]; viewerScenarioIds: string[] }> }
        >;
      }
    ).cards[card.oracleId]!;
    const line = drafts[0]!.clauses[0]! - 1;
    expect(entry.clauses[line]!.engineTestIds).toEqual(
      drafts
        .filter((draft) => draft.clauses.includes(line + 1))
        .map((draft) => `${SCENARIO_TEST_FILE}::${draft.id}`),
    );
    expect(entry.clauses[line]!.viewerScenarioIds).toEqual([]);
  });

  it('adds the scenario runner to a clause whose test IDs are narrowed to named files', () => {
    const narrowed = JSON.parse(manifestOf(['cards/x.test.ts::old'])) as {
      cards: Record<string, { clauses: Array<Record<string, unknown>> }>;
    };
    const line = drafts[0]!.clauses[0]! - 1;
    narrowed.cards[card.oracleId]!.clauses[line]!['engineTestSource'] = 'cards/x.test.ts';
    const result = mapDraftsIntoManifest(
      JSON.stringify(narrowed),
      card.name,
      card.oracleText,
      drafts,
    );
    const clause = (JSON.parse(result.manifestJson) as typeof narrowed).cards[card.oracleId]!
      .clauses[line]!;
    expect(clause['engineTestSource']).toEqual(['cards/x.test.ts', SCENARIO_TEST_FILE]);
  });

  it('maps nothing for a card the manifest does not have', () => {
    const json = JSON.stringify({ cards: {} });
    const result = mapDraftsIntoManifest(json, card.name, card.oracleText, drafts);
    expect(result.manifestJson).toBe(json);
    expect(result.mapped).toEqual([]);
  });
});
