import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/specialized-reference-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
for (const pin of pins.cards)
  if (createHash('sha256').update(JSON.stringify(pin.card)).digest('hex') !== pin.sha256)
    throw new Error(`Specialized-reference Oracle pin drift: ${pin.card.name}`);
const pinned = (name: string) => {
  const entry = pins.cards.find((entry) => entry.card.name === name);
  if (!entry) throw new Error(`Missing specialized-reference Oracle pin ${name}`);
  return entry;
};
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const lands = ['Forest', 'Island', 'Plains', 'Mountain', 'Swamp'].map((name) => {
  const card = coverage.find((card) => card.name === name);
  if (!card) throw new Error(`Missing specialized-reference basic ${name}`);
  return card;
});
const cases = [
  {
    id: 'madame-null-viewer-pay-life',
    title: 'Madame Null: pay life for the entering creature',
    response: null,
  },
  {
    id: 'madame-null-viewer-decline',
    title: 'Madame Null: decline the life payment',
    response: null,
  },
  {
    id: 'madame-null-viewer-unfunded',
    title: 'Madame Null: skip an unaffordable life payment',
    response: null,
  },
  {
    id: 'madame-null-viewer-blink',
    title: 'Madame Null: keep separate blinked incarnations',
    response: 'Ghostly Flicker',
  },
  {
    id: 'madame-null-viewer-destroyed',
    title: "Madame Null: read the departed creature's power",
    response: 'Murder',
  },
] as const;
export const SPECIALIZED_REFERENCE_SCENARIO_IDS = cases.map((entry) => entry.id);

export function specializedReferenceScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cases.find((entry) => entry.id === id);
  if (!entry) throw new Error(`Unknown specialized-reference scenario ${id}`);
  const madame = pinned('Madame Null, Power Broker');
  const response = entry.response === null ? [] : [pinned(entry.response).card];
  const witness: OracleCard = {
    ...lands[0]!,
    oracleId: 'lab-optional-life-witness',
    scryfallId: 'lab-optional-life-witness',
    name: 'Optional-Life Witness',
    manaCost: '{0}',
    cmc: 0,
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
  const seed = `card-lab-${id}-v1`;
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `optional-life-lab-${seat}`,
    commanders: [],
    cards: [...lands, ...(seat === 'P1' ? [madame.card, witness, ...response, ...mana] : [])],
  }));
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        'Cast Optional-Life Witness.',
        ...(entry.response === 'Ghostly Flicker'
          ? [
              'Respond to its entry trigger with Ghostly Flicker targeting the Witness and a basic land.',
            ]
          : []),
        ...(entry.response === 'Murder'
          ? ['Respond to its entry trigger with Murder targeting the Witness.']
          : []),
        id.endsWith('decline')
          ? 'Decline the optional life payment.'
          : 'Pay two life whenever the optional payment is offered.',
      ],
      expectedOutcome: id.endsWith('unfunded')
        ? 'At one life, no two-life payment is offered; the Witness stays 2/2.'
        : id.endsWith('decline')
          ? 'P1 stays at 40 life and the Witness stays 2/2.'
          : id.endsWith('blink')
            ? 'P1 pays two life for each incarnation, ending at 36. Only the new entry trigger adds counters to the returned Witness, which is 4/4.'
            : id.endsWith('destroyed')
              ? 'P1 may still pay two life using last-known power, ending at 38. The departed Witness receives no counters.'
              : 'P1 ends at 38 life with two +1/+1 counters on the 4/4 Witness.',
      oracleSha256: madame.sha256,
      clauseIds: ['madame-null-event-identity-life-payment'],
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
          lifeTotals: [{ playerId: 'P1', life: id.endsWith('unfunded') ? 1 : 40 }],
          hand: [
            { playerId: 'P1', cardNames: [witness.name, ...response.map((card) => card.name)] },
          ],
          battlefield: [
            { playerId: 'P1', cardNames: [madame.card.name, ...mana.map((card) => card.name)] },
          ],
        },
      },
    ),
  };
}
