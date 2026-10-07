import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

type Pin = { sha256: string; card: OracleCard };
function pins(fixture: { cards: Pin[] }): Pin[] {
  for (const entry of fixture.cards) {
    if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
      throw new Error(`Counter/overload Oracle fixture drift: ${entry.card.name}`);
  }
  return fixture.cards;
}
const counters = pins(
  JSON.parse(
    readFileSync('packages/engine/tests/fixtures/counter-targets-oracle.json', 'utf8'),
  ) as { cards: Pin[] },
);
const overloads = pins(
  JSON.parse(
    readFileSync('packages/engine/tests/fixtures/overload-derivation-oracle.json', 'utf8'),
  ) as { cards: Pin[] },
).filter(({ card }) => ['Cyclonic Rift', 'Vandalblast', 'Damn'].includes(card.name));
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const lands = ['Forest', 'Island', 'Plains', 'Mountain', 'Swamp'].map((name) => {
  const card = coverage.find((candidate) => candidate.name === name);
  if (!card) throw new Error(`Missing lab basic land ${name}`);
  return card;
});
const slug = (name: string) => name.toLowerCase().replaceAll(' ', '-');
const cases = [
  ...counters.flatMap((pin) =>
    (['own-counter', 'opponent-counter'] as const).map((mode) => ({
      ...pin,
      mode,
      id: `${slug(pin.card.name)}-viewer-${mode}`,
      title: `${pin.card.name}: counter ${mode === 'own-counter' ? 'your own' : "an opponent's"} spell`,
    })),
  ),
  ...overloads.flatMap((pin) =>
    (['normal', 'overload'] as const).map((mode) => ({
      ...pin,
      mode,
      id: `${slug(pin.card.name)}-viewer-${mode}`,
      title: `${pin.card.name}: ${mode === 'normal' ? 'one normal target' : 'overload without targets'}`,
    })),
  ),
];
export const COUNTER_OVERLOAD_SCENARIO_IDS = cases.map(({ id }) => id);

function witness(name: string, type: 'Creature' | 'Artifact' | 'Instant', text = ''): OracleCard {
  return {
    ...lands[0]!,
    oracleId: `lab-${slug(name)}`,
    scryfallId: `lab-${slug(name)}`,
    name,
    typeLine: type,
    types: [type],
    supertypes: [],
    subtypes: [],
    isBasicLand: false,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    keywords: [],
    oracleText: text,
    power: type === 'Creature' ? '2' : null,
    toughness: type === 'Creature' ? '2' : null,
  };
}

export function counterOverloadScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cases.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown counter/overload scenario ${id}`);
  const isCounter = entry.mode === 'own-counter' || entry.mode === 'opponent-counter';
  const pendingOwner = entry.mode === 'own-counter' ? 'P1' : 'P2';
  const pending = witness('Independent Pending Spell', 'Instant', 'You gain 3 life.');
  const type = entry.card.name === 'Vandalblast' ? 'Artifact' : 'Creature';
  const own = witness('Own Overload Witness', type);
  const chosen = witness('Chosen Overload Witness', type);
  const bystander = witness('Other Overload Witness', type);
  const protectedCard = witness(
    'Protected Overload Witness',
    type,
    `Shroud\nProtection from ${entry.card.name === 'Cyclonic Rift' ? 'blue' : entry.card.name === 'Damn' ? 'white' : 'red'}`,
  );
  const indestructible = witness('Indestructible Overload Witness', type, 'Indestructible');
  const mana = [...lands, ...lands];
  const opposing = [chosen, bystander, protectedCard, indestructible, lands[0]!];
  const seed = `card-lab-${id}-v1`;
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `counter-overload-lab-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [entry.card, ...mana, ...(isCounter ? (pendingOwner === seat ? [pending] : []) : [own])]
        : seat === 'P2'
          ? isCounter
            ? [...lands, ...(pendingOwner === seat ? [pending] : [])]
            : opposing
          : [...lands],
  }));
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isCounter
        ? [
            `Cast ${entry.card.name} targeting Independent Pending Spell.`,
            'Decline any optional counter payment, then pass to finish.',
          ]
        : [
            `Cast ${entry.card.name} using ${entry.mode === 'normal' ? 'its normal cost and target Chosen Overload Witness' : 'overload, with no targets'}.`,
            'Pass with the stack empty to finish.',
          ],
      expectedOutcome: isCounter
        ? 'The pending spell is countered without gaining life, regardless of its controller.'
        : entry.mode === 'normal'
          ? 'Only the chosen witness leaves; other witnesses and lands remain.'
          : 'Overload affects protected witnesses without targeting, preserves lands, and follows the printed controller and indestructible rules.',
      oracleSha256: entry.sha256,
      clauseIds: [`${slug(entry.card.name)}-${isCounter ? 'counter-target' : entry.mode}`],
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
          hand: [{ playerId: 'P1', cardNames: [entry.card.name] }],
          battlefield: [
            {
              playerId: 'P1',
              cardNames: [...mana.map((card) => card.name), ...(isCounter ? [] : [own.name])],
            },
            ...(!isCounter
              ? [{ playerId: 'P2', cardNames: opposing.map((card) => card.name) }]
              : []),
          ],
          ...(isCounter ? { stack: [{ playerId: pendingOwner, cardNames: [pending.name] }] } : {}),
        },
      },
    ),
  };
}
