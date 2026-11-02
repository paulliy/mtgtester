import { describe, expect, it } from 'vitest';
import {
  assertCompleteCoverage,
  assertCoveragePopulation,
  assertKnownUnmodeled,
} from './coverage-contract';
import type { CoverageReport } from './coverage';
function report(): CoverageReport {
  return {
    uniqueCards: 2,
    modeledCards: 2,
    byFamily: [],
    topReasons: [],
    decks: [
      { name: 'A', uniqueCards: 1, modeled: 1 },
      { name: 'B', uniqueCards: 1, modeled: 1 },
    ],
    cards: ['a', 'b'].map((id, i) => ({
      oracleId: id,
      name: id,
      modeled: true,
      reasons: [],
      families: [],
      deckNames: [i === 0 ? 'A' : 'B'],
    })),
  };
}
const population = {
  decks: [
    { name: 'A', oracleIds: ['a'] },
    { name: 'B', oracleIds: ['b'] },
  ],
};
describe('coverage completion contract', () => {
  it('accepts the exact population', () => {
    expect(() => assertCoveragePopulation(report(), population)).not.toThrow();
    expect(() => assertCompleteCoverage(report())).not.toThrow();
  });
  it('rejects a missing deck even if the remaining deck is fully modeled', () => {
    const actual = report();
    actual.decks.pop();
    actual.cards.pop();
    actual.uniqueCards = actual.modeledCards = 1;
    expect(() => assertCoveragePopulation(actual, population)).toThrow('decks');
  });
  it('rejects same-sized card substitutions and shifted deck membership', () => {
    const actual = report();
    actual.cards[1]!.oracleId = 'substitute';
    expect(() => assertCoveragePopulation(actual, population)).toThrow('B');
    const shifted = report();
    shifted.cards[1]!.deckNames = ['A'];
    expect(() => assertCoveragePopulation(shifted, population)).toThrow();
  });
  it('rejects unresolved blockers despite an optimistic modeled total', () => {
    const actual = report();
    actual.cards[0]!.reasons = ['missing behavior'];
    expect(() => assertCompleteCoverage(actual)).toThrow('incomplete');
  });
});
describe('known-unmodeled ratchet', () => {
  const blocked = (): CoverageReport => {
    const actual = report();
    actual.cards[1]!.modeled = false;
    actual.cards[1]!.reasons = ['unrecognized rules text: "Storm"'];
    return actual;
  };
  const listing = (ids: string[]) => ({
    ...population,
    knownUnmodeled: ids.map((id) => ({ oracleId: id, name: id })),
  });
  it('accepts exactly the listed unmodeled cards', () => {
    expect(() => assertKnownUnmodeled(blocked(), listing(['b']))).not.toThrow();
    expect(() => assertKnownUnmodeled(report(), listing([]))).not.toThrow();
  });
  it('fails a card that stopped being modeled', () => {
    expect(() => assertKnownUnmodeled(blocked(), listing([]))).toThrow('no longer modeled: b');
  });
  it('fails a listed card that is now modeled, so the list only shrinks', () => {
    expect(() => assertKnownUnmodeled(report(), listing(['b']))).toThrow('now modeled');
  });
  it('treats a modeled flag with a leftover reason as unmodeled', () => {
    const actual = report();
    actual.cards[0]!.reasons = ['missing behavior'];
    expect(() => assertKnownUnmodeled(actual, listing([]))).toThrow('no longer modeled: a');
  });
});
