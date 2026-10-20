import { readFileSync } from 'node:fs';
import { Engine, type DecisionProvider, type EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import type { CardTestScenario } from './card-test-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const bank = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
function basic(name: string) {
  const card = bank.find((card) => card.name === name);
  if (!card) throw new Error(`Missing ${name}`);
  return card;
}
function synthetic(
  name: string,
  typeLine: string,
  text: string,
  power: string | null = null,
): OracleCard {
  const creature = typeLine.includes('Creature');
  return {
    ...basic('Forest'),
    oracleId: `lab-rotating-${name}`,
    scryfallId: `lab-rotating-${name}`,
    name,
    typeLine,
    types: [creature ? 'Creature' : 'Instant'],
    supertypes: [],
    subtypes: creature ? ['Survivor'] : [],
    manaCost: creature ? '{R}' : '{1}{B}',
    cmc: creature ? 1 : 2,
    colors: creature ? ['R'] : ['B'],
    colorIdentity: creature ? ['R'] : ['B'],
    isBasicLand: false,
    oracleText: text,
    keywords: [],
    power,
    toughness: power,
  };
}
export const ROTATING_SURVIVOR_SCENARIO_IDS = [
  'alexios-viewer-cast-and-upkeep-rotation',
  'varchild-viewer-cast-death-gains-survivors',
  'varchild-viewer-combat-creates-survivors',
] as const;
export function pr08RotatingSurvivorScenario(id: string, gameId: GameId): CardTestScenario {
  if (!(ROTATING_SURVIVOR_SCENARIO_IDS as readonly string[]).includes(id))
    throw new Error(`Unknown rotating Survivor scenario ${id}`);
  const alexios = id === ROTATING_SURVIVOR_SCENARIO_IDS[0],
    combat = id === ROTATING_SURVIVOR_SCENARIO_IDS[2];
  const pin = pins.cards.find(
    (entry) =>
      entry.card.name === (alexios ? 'Alexios, Deimos of Kosmos' : 'Varchild, Betrayer of Kjeldor'),
  );
  if (!pin || sha256(pin.card) !== pin.sha256)
    throw new Error('Rotating Survivor Oracle pin drift');
  const source = pin;
  const survivor = synthetic('Lab Survivor', 'Creature — Survivor', '', '1');
  const removal = synthetic('Lab Varchild Removal', 'Instant', 'Destroy target creature.');
  const lands = [
    basic('Mountain'),
    basic('Forest'),
    basic('Forest'),
    ...(alexios ? [basic('Forest')] : []),
  ];
  const title = alexios
    ? 'Alexios: cast and rotate control at the next upkeep'
    : combat
      ? 'Varchild: combat damage creates opposing Survivors'
      : 'Varchild: cast, die, and gain control of Survivors';
  const players: EnginePlayerConfig[] = ['P1', 'P2', 'P3', 'P4'].map((seat) => ({
    id: seat,
    deckId: `lab-${id}-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [source.card, ...lands]
        : seat === 'P2'
          ? [survivor, survivor, removal, basic('Swamp'), basic('Forest')]
          : [basic('Forest')],
  }));
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players, turnCap: 2 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 3,
        hand: [
          { playerId: 'P1', cardNames: combat ? [] : [source.card.name] },
          ...(!alexios && !combat ? [{ playerId: 'P2', cardNames: [removal.name] }] : []),
        ],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: [...lands.map((card) => card.name), ...(combat ? [source.card.name] : [])],
          },
          ...(!alexios
            ? [
                {
                  playerId: 'P2',
                  cardNames: combat
                    ? [survivor.name]
                    : [survivor.name, survivor.name, 'Swamp', 'Forest'],
                },
              ]
            : []),
        ],
        ...(alexios
          ? { continueToNextUpkeep: true }
          : combat
            ? { continueThroughCombat: true }
            : {}),
      },
    },
  );
  let removed = false;
  const opponent: DecisionProvider = {
    decide(request) {
      if (!alexios && !combat && !removed) {
        const target = engine.getState().battlefield.find((card) => card.name === source.card.name);
        const action = request.legalActions.find(
          (action) =>
            action.type === 'castSpell' &&
            action.description.includes(removal.name) &&
            action.targets?.some(
              (slot) => target !== undefined && slot.options.includes(target.id),
            ),
        );
        if (action && target) {
          removed = true;
          return {
            requestId: request.requestId,
            actionId: action.id,
            targets: [{ slot: 0, choice: target.id }],
          };
        }
      }
      const action =
        request.legalActions.find((action) => action.type === 'pass') ??
        request.legalActions.find((action) => action.type === 'declareNoBlockers') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
  return {
    metadata: {
      id,
      version: 1,
      title,
      instructions: alexios
        ? [
            'Cast Alexios for {3}{R}.',
            'Pass priority to the next upkeep. P2 gains control, untaps Alexios, and puts a +1/+1 counter on it.',
          ]
        : combat
          ? [
              'Varchild has been in play since the prior turn.',
              'Attack P2 with Varchild. The opposing Survivor cannot block.',
              'P2 takes 3 combat damage and creates three more Survivors.',
            ]
          : [
              'Cast Varchild for {2}{R}.',
              'P2 casts an ordinary removal spell on Varchild.',
              'Resolve the death and leave trigger; you gain control of both Survivors.',
            ],
      expectedOutcome: alexios
        ? 'P2 controls an untapped 5/5 Alexios with haste.'
        : combat
          ? 'P2 has 37 life and four Survivors.'
          : 'Varchild is in your graveyard and you control two Survivors.',
      oracleSha256: source.sha256,
      clauseIds: alexios
        ? ['alexios-trample-combat-restrictions', 'alexios-each-upkeep-rotation']
        : [
            'varchild-combat-survivors',
            'varchild-opposing-survivor-restrictions',
            'varchild-leaves-gains-survivors',
          ],
    },
    seed,
    engine,
    seats: players.map((config) => ({
      seat: config.id,
      config,
      deckSnapshotId: null,
      summary: {
        seat: config.id,
        deckId: config.deckId,
        label: config.id === 'P1' ? 'Card Test Lab' : `Deterministic opponent ${config.id}`,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    })),
    decisionProviderOverrides: { P2: opponent },
  };
}
