import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/zone-change-trigger-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
for (const pin of pins.cards)
  if (createHash('sha256').update(JSON.stringify(pin.card)).digest('hex') !== pin.sha256)
    throw new Error(`First-zone Oracle pin drift: ${pin.card.name}`);
const pinned = (name: string) => {
  const entry = pins.cards.find((entry) => entry.card.name === name);
  if (!entry) throw new Error(`Missing first-zone Oracle pin ${name}`);
  return entry;
};
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const lands = ['Forest', 'Island', 'Plains', 'Mountain', 'Swamp'].map((name) => {
  const card = coverage.find((card) => card.name === name);
  if (!card) throw new Error(`Missing first-zone basic ${name}`);
  return card;
});
const cases = [
  {
    id: 'marchesa-viewer-first-zone-own',
    title: 'Marchesa: return your dead creature',
    owner: 'P1',
    controller: 'P1',
    counters: true,
    bog: false,
  },
  {
    id: 'marchesa-viewer-first-zone-opponent-owned',
    title: 'Marchesa: return an opponent-owned creature',
    owner: 'P2',
    controller: 'P1',
    counters: true,
    bog: false,
  },
  {
    id: 'marchesa-viewer-first-zone-no-counter',
    title: 'Marchesa: ignore a creature without a +1/+1 counter',
    owner: 'P1',
    controller: 'P1',
    counters: false,
    bog: false,
  },
  {
    id: 'marchesa-viewer-first-zone-opponent-controlled',
    title: 'Marchesa: ignore an opponent-controlled creature',
    owner: 'P2',
    controller: 'P2',
    counters: true,
    bog: false,
  },
  {
    id: 'marchesa-viewer-first-zone-exiled',
    title: 'Marchesa: skip the card exiled by Bojuka Bog',
    owner: 'P2',
    controller: 'P1',
    counters: true,
    bog: true,
  },
  {
    id: 'marchesa-viewer-simultaneous-deaths',
    title: 'Marchesa: return creatures after simultaneous deaths',
    owner: 'P2',
    controller: 'P1',
    counters: true,
    bog: false,
  },
] as const;
export const ZONE_CHANGE_TRIGGER_SCENARIO_IDS = cases.map((entry) => entry.id);

export function zoneChangeTriggerScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cases.find((entry) => entry.id === id);
  if (!entry) throw new Error(`Unknown first-zone scenario ${id}`);
  const marchesa = pinned('Marchesa, the Black Rose');
  const murder = pinned('Murder').card;
  const bog = pinned('Bojuka Bog').card;
  const batch = id === 'marchesa-viewer-simultaneous-deaths';
  const wipePin = JSON.parse(
    readFileSync('packages/engine/tests/fixtures/overload-derivation-oracle.json', 'utf8'),
  ).cards.find((pin: { card: OracleCard }) => pin.card.name === 'Damn') as {
    card: OracleCard;
    sha256: string;
  };
  if (createHash('sha256').update(JSON.stringify(wipePin.card)).digest('hex') !== wipePin.sha256)
    throw new Error('Batch-death Damn Oracle pin drift');
  const removal = batch ? wipePin.card : murder;
  const witness: OracleCard = {
    ...lands[0]!,
    oracleId: 'lab-first-zone-witness',
    scryfallId: 'lab-first-zone-witness',
    name: 'First-Zone Witness',
    manaCost: '{2}',
    cmc: 2,
    typeLine: 'Creature — Witness',
    types: ['Creature'],
    subtypes: ['Witness'],
    supertypes: [],
    colors: [],
    colorIdentity: [],
    oracleText: '',
    isBasicLand: false,
    power: '2',
    toughness: '2',
  };
  const mana = [...lands, ...lands];
  const noCounter = {
    ...witness,
    oracleId: 'lab-batch-no-counter',
    scryfallId: 'lab-batch-no-counter',
    name: 'Batch No-Counter Witness',
  };
  const seed = `card-lab-${id}-v1`;
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `first-zone-lab-${seat}`,
    commanders: [],
    cards: [
      ...lands,
      ...(seat === 'P1'
        ? [
            marchesa.card,
            removal,
            ...mana,
            ...(batch ? [noCounter] : []),
            ...(entry.bog ? [bog] : []),
          ]
        : []),
      ...(seat === entry.owner ? [witness] : []),
    ],
  }));
  return {
    metadata: {
      id,
      version: batch ? 2 : 1,
      title: entry.title,
      instructions: [
        batch
          ? 'Cast Damn with overload, destroying all creatures simultaneously.'
          : 'Cast Murder on First-Zone Witness.',
        ...(entry.bog ? ['After it dies, play Bojuka Bog and exile P2’s graveyard.'] : []),
        'Pass to the next end step.',
      ],
      expectedOutcome: entry.bog
        ? 'The exiled card stays exiled and does not return.'
        : entry.counters && entry.controller === 'P1'
          ? 'The same first graveyard incarnation returns under P1’s control, retaining its owner and losing its old counters.'
          : 'The creature remains in its owner’s graveyard.',
      oracleSha256: marchesa.sha256,
      clauseIds: ['marchesa-first-public-destination'],
    },
    seed,
    seats: players.map((config) => ({
      seat: config.id,
      config,
      deckSnapshotId: null,
      summary: {
        seat: config.id,
        deckId: config.deckId,
        label: config.id,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    })),
    engine: new Engine(
      { gameId, seed, players, turnCap: 2 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [{ playerId: 'P1', cardNames: [removal.name, ...(entry.bog ? [bog.name] : [])] }],
          battlefield: [
            {
              playerId: 'P1',
              cardNames: [...mana.map((card) => card.name), ...(batch ? [noCounter.name] : [])],
            },
            {
              playerId: 'P1',
              cardNames: [marchesa.card.name],
              ...(batch ? { counters: { '+1/+1': 1 } } : {}),
            },
            {
              playerId: entry.owner,
              controllerId: entry.controller,
              cardNames: [witness.name],
              counters: entry.counters ? { '+1/+1': 1 } : {},
            },
          ],
          continueToEndStep: true,
        },
      },
    ),
  };
}
