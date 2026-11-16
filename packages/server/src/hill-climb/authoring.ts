/**
 * The authoring probe (hill-climb S4): how much of the test work behind a verified card the
 * generated promotion scaffolds already do, so an agent reviews instead of writing.
 *
 * Agent time per card is not measurable offline, so the probe counts the work it stands for. The
 * completion standard asks that tests kill every IR mutant of a card (`bun run mutate-cards`), and
 * each mutant no test kills is a test an agent still has to write, or a reason it must record.
 * The probe generates a card's scaffold, runs its passing drafts against every mutant of the
 * card in process (the same operators and the same "only a failed expectation kills" rule as
 * `mutate-cards`), and reports what is left.
 *
 * Two card sets:
 * - the pool: every modeled EDHREC pinned card, the cards waiting for promotion to reviewed;
 * - the reference: every card with a committed scenario file, whose hand-written scenarios say
 *   what a finished card's tests kill. The scaffold's kills there are compared with theirs.
 *
 * Everything is deterministic (seeded games, fixed card lists), so every metric is exact.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from '../../../engine/src/cards/definition';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { mutantKills } from '../../../engine/tests/mutation/kills';
import { cardMutants, unmutatedParts } from '../../../engine/tests/mutation/operators';
import { pinStore } from '../../../engine/tests/scenario/pin-store';
import { loadScenarioFile, resolveScenarioCard } from '../../../engine/tests/scenario/runner';
import { scaffoldCard, type ScaffoldUnit } from '../../../engine/tests/scenario/scaffold';
import { PINNED_ORACLE_PATH, type PinnedCard } from '../cards/edhrec-pins';
import type { Metric } from './report';

export { mutantKills };

const SCENARIO_DIR = 'packages/engine/tests/scenarios';

export interface CardAuthoring {
  card: string;
  /** Top-level definition parts (abilities, statics, keywords, replacement fields). */
  parts: string[];
  /** Parts whose every unit has a passing draft (each mode of a modal spell, for one). */
  scaffoldedParts: string[];
  mutants: number;
  /** Mutants a passing draft's expectation catches. */
  killed: number;
  /** Mutant indexes killed, for comparing with another scenario set. */
  killedIndexes: number[];
  /** Drafts built but not passing: a generator gap, or on an unreviewed card possibly a bug. */
  failures: ScaffoldUnit[];
  /** Lines of the scaffold file as `JSON.stringify(file, null, 2)` writes it. */
  draftLines: number;
}

function partsOf(definition: CardDefinition): string[] {
  return [
    ...new Set([...cardMutants(definition).map((m) => m.part), ...unmutatedParts(definition)]),
  ].sort();
}

/** One card's scaffold, measured against its own mutants. */
export function measureCard(
  card: OracleCard,
  resolve: (name: string) => OracleCard,
): CardAuthoring {
  const definition = interpretCard(card);
  const result = scaffoldCard(card, resolve);
  const killedIndexes =
    result.file.scenarios.length === 0 ? [] : mutantKills(definition, result.file, resolve);
  // A part counts once every unit of it has a draft: a modal spell with one mode drafted and
  // another not is not done.
  const open = new Set(
    result.units.filter((unit) => unit.status !== 'scaffolded').map((unit) => unit.part),
  );
  const scaffolded = new Set(
    result.units
      .filter((unit) => unit.status === 'scaffolded' && !open.has(unit.part))
      .map((unit) => unit.part),
  );
  return {
    card: card.name,
    parts: partsOf(definition),
    scaffoldedParts: [...scaffolded].sort(),
    mutants: cardMutants(definition).length,
    killed: killedIndexes.length,
    killedIndexes,
    failures: result.units.filter((unit) => unit.status === 'failed'),
    draftLines:
      result.file.scenarios.length === 0
        ? 0
        : JSON.stringify(result.file, null, 2).split('\n').length,
  };
}

/** Pinned EDHREC cards, then the pin store and basics, by name. */
export function poolResolver(pins: readonly PinnedCard[]): (name: string) => OracleCard {
  const byName = new Map(pins.map((pin) => [pin.card.name, pin.card]));
  return (name) => byName.get(name) ?? resolveScenarioCard(name);
}

export interface AuthoringSummary {
  cards: number;
  parts: number;
  scaffoldedParts: number;
  fullyScaffoldedCards: number;
  mutants: number;
  killed: number;
  failures: number;
  draftLines: number;
}

export function summarize(cards: readonly CardAuthoring[]): AuthoringSummary {
  const sum = (pick: (card: CardAuthoring) => number) =>
    cards.reduce((total, card) => total + pick(card), 0);
  return {
    cards: cards.length,
    parts: sum((card) => card.parts.length),
    scaffoldedParts: sum((card) => card.scaffoldedParts.length),
    fullyScaffoldedCards: cards.filter(
      (card) => card.parts.length > 0 && card.scaffoldedParts.length === card.parts.length,
    ).length,
    mutants: sum((card) => card.mutants),
    killed: sum((card) => card.killed),
    failures: sum((card) => card.failures.length),
    draftLines: sum((card) => card.draftLines),
  };
}

/** The modeled EDHREC pinned cards, every `stride`-th one. */
export function poolCards(stride = 1): OracleCard[] {
  const pins = JSON.parse(readFileSync(PINNED_ORACLE_PATH, 'utf8')) as PinnedCard[];
  return pins
    .map((pin) => pin.card)
    .filter((card) => interpretCard(card).modeled)
    .filter((_, index) => index % stride === 0);
}

export interface ReferenceCard {
  authoring: CardAuthoring;
  /** Mutants the committed scenario file kills, and how many of them the scaffold kills too. */
  committedKilled: number;
  reproduced: number;
}

/** Every card with a committed scenario file: the scaffold's kills against the hand-written ones. */
export function measureReference(): ReferenceCard[] {
  return readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const file = loadScenarioFile(
        new URL(`../../../../${SCENARIO_DIR}/${name}`, import.meta.url),
      );
      if (!pinStore.has(file.card)) return [];
      const card = pinStore.get(file.card);
      const definition = interpretCard(card);
      const authoring = measureCard(card, resolveScenarioCard);
      const committed = new Set(mutantKills(definition, file, resolveScenarioCard));
      return [
        {
          authoring,
          committedKilled: committed.size,
          reproduced: authoring.killedIndexes.filter((index) => committed.has(index)).length,
        },
      ];
    });
}

const exact = (value: number, unit: string, better: Metric['better']): Metric => ({
  value,
  unit,
  better,
  kind: 'exact',
});
const pct = (part: number, whole: number) =>
  whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(2));

/**
 * The probe's metrics. `poolStride` samples the pool (1 = every modeled EDHREC card); the quick
 * profile samples, the standard profile measures all of it.
 */
export function authoringProbe(poolStride: number, log: (line: string) => void = () => {}) {
  const pool = poolCards(poolStride);
  const resolve = poolResolver(
    JSON.parse(readFileSync(PINNED_ORACLE_PATH, 'utf8')) as PinnedCard[],
  );
  const poolSummary = summarize(pool.map((card) => measureCard(card, resolve)));
  log(
    `  authoring pool: ${poolSummary.cards} cards, ${poolSummary.killed}/${poolSummary.mutants} mutants killed by scaffolds`,
  );
  const reference = measureReference();
  const committed = reference.reduce((sum, card) => sum + card.committedKilled, 0);
  const reproduced = reference.reduce((sum, card) => sum + card.reproduced, 0);
  const referenceSummary = summarize(reference.map((card) => card.authoring));
  log(
    `  authoring reference: ${reference.length} cards, ${reproduced}/${committed} hand-written kills reproduced`,
  );
  const metrics: Record<string, Metric> = {
    // What an agent still has to kill by hand, as a share of all mutants of the pool's cards.
    'authoring.poolMutantsLeftPct': exact(
      Number((100 - pct(poolSummary.killed, poolSummary.mutants)).toFixed(2)),
      '%',
      'lower',
    ),
    'authoring.poolPartsScaffoldedPct': exact(
      pct(poolSummary.scaffoldedParts, poolSummary.parts),
      '%',
      'higher',
    ),
    'authoring.poolCardsFullyScaffolded': exact(
      poolSummary.fullyScaffoldedCards,
      'cards',
      'higher',
    ),
    'authoring.poolDraftFailures': exact(poolSummary.failures, 'drafts', 'lower'),
    'authoring.referenceKillsReproducedPct': exact(pct(reproduced, committed), '%', 'higher'),
    'authoring.referenceDraftFailures': exact(referenceSummary.failures, 'drafts', 'lower'),
  };
  return { metrics, pool: poolSummary, reference: referenceSummary, committed, reproduced };
}
