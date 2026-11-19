import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { cardMutants } from '../../../engine/tests/mutation/operators';
import { pinStore } from '../../../engine/tests/scenario/pin-store';
import { resolveScenarioCard } from '../../../engine/tests/scenario/runner';
import { scaffoldCard } from '../../../engine/tests/scenario/scaffold';
import { authoringProbe, measureCard, mutantKills, summarize } from './authoring';
import { PROFILES } from './probes';
import { compareReports, type Baseline, type Report } from './report';

const baseline = JSON.parse(
  readFileSync('packages/server/fixtures/hill-climb-baseline.json', 'utf8'),
) as Baseline;

describe('mutantKills', () => {
  it('counts a mutant only when a draft expectation catches it, as mutate-cards does', () => {
    const card = pinStore.get('Noble Hierarch');
    const definition = interpretCard(card);
    const { file } = scaffoldCard(card, resolveScenarioCard);
    const labels = cardMutants(definition).map((mutant) => mutant.label);
    const killed = mutantKills(definition, file, resolveScenarioCard).map((index) => labels[index]);
    // Dropping the mana ability makes the payment impossible: the run throws, which is a crash
    // and not a kill, so the mana drafts alone leave it for the agent.
    expect(labels).toContain('(card): drop manaAbilities[0]');
    expect(killed).not.toContain('(card): drop manaAbilities[0]');
  });

  it('kills a dropped effect and a nudged constant on a drafted ability', () => {
    const card = pinStore.get('Thraben Inspector');
    const definition = interpretCard(card);
    const { file } = scaffoldCard(card, resolveScenarioCard);
    const labels = cardMutants(definition).map((mutant) => mutant.label);
    const killed = mutantKills(definition, file, resolveScenarioCard).map((index) => labels[index]);
    expect(killed).toEqual(
      expect.arrayContaining([
        'triggers[0]: drop effect 0',
        'triggers[0].effects[0].count: const 1 + 1',
      ]),
    );
  });

  it('kills nothing with no drafts: the starting point every card had before scaffolds', () => {
    const card = pinStore.get('Doom Blade');
    const definition = interpretCard(card);
    expect(
      mutantKills(
        definition,
        { schemaVersion: 1, card: card.name, scenarios: [] },
        resolveScenarioCard,
      ),
    ).toEqual([]);
  });
});

describe('measureCard and summarize', () => {
  it('counts parts, drafts and kills per card', () => {
    const summary = summarize([measureCard(pinStore.get('Doom Blade'), resolveScenarioCard)]);
    expect(summary).toMatchObject({
      cards: 1,
      parts: 1,
      scaffoldedParts: 1,
      fullyScaffoldedCards: 1,
      mutants: 2,
      killed: 1,
      failures: 0,
    });
  });
});

/**
 * The authoring gate: the scaffolds may not leave more work for agents than the committed
 * baseline records. A failure means a generator change lost drafts or kills; if that is
 * intended, rewrite the baseline and say why in the pull request.
 */
describe('hill-climb gate: authoring metrics against the committed baseline', () => {
  it('leaves no more mutants and no fewer scaffolded parts than the baseline', () => {
    const quick = baseline.profiles['quick']!;
    const current: Report = {
      ...quick,
      probes: ['authoring'],
      metrics: authoringProbe(PROFILES['quick']!.authoringStride).metrics,
      fingerprints: {},
    };
    const comparison = compareReports(quick, current);
    expect(comparison.failures).toEqual([]);
    expect(comparison.rows.filter((row) => row.id.startsWith('authoring.'))).toHaveLength(6);
  }, 120_000);
});
