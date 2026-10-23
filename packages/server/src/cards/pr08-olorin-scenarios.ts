import { readFileSync } from 'node:fs';
import { Engine, type DecisionProvider, type EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import { sha256 } from '../benchmark/hash';
import type { CardTestScenario } from './card-test-scenarios';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const pin = pins.cards.find((entry) => entry.card.name === "Olórin's Searing Light");
if (pin === undefined || sha256(pin.card) !== pin.sha256)
  throw new Error('Olórin Oracle pin missing or changed');
const source = pin;
const bank = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
function basic(name: string): OracleCard {
  const found = bank.find((card) => card.name === name);
  if (found === undefined) throw new Error(`Missing lab basic ${name}`);
  return found;
}
function witness(name: string, power: number): OracleCard {
  return {
    ...basic('Forest'),
    oracleId: `lab-olorin-${power}`,
    scryfallId: `lab-olorin-${power}`,
    name,
    typeLine: 'Creature — Bear',
    types: ['Creature'],
    supertypes: [],
    subtypes: ['Bear'],
    manaCost: '{G}',
    cmc: 1,
    isBasicLand: false,
    oracleText: '',
    keywords: [],
    power: String(power),
    toughness: '8',
  };
}
function priorSpell(index: number): OracleCard {
  return {
    ...basic('Plains'),
    oracleId: `lab-olorin-prior-${index}`,
    scryfallId: `lab-olorin-prior-${index}`,
    name: `Lab Earlier Spell ${index}`,
    typeLine: 'Sorcery',
    types: ['Sorcery'],
    supertypes: [],
    subtypes: [],
    manaCost: '{W}',
    cmc: 1,
    isBasicLand: false,
    oracleText: 'You gain 1 life.',
    keywords: [],
  };
}
export const OLORIN_SCENARIO_IDS = [
  'olorin-viewer-spell-mastery-damage',
  'olorin-viewer-without-spell-mastery',
] as const;
export function pr08OlorinScenario(id: string, gameId: GameId): CardTestScenario {
  if (!(OLORIN_SCENARIO_IDS as readonly string[]).includes(id))
    throw new Error(`Unknown Olórin scenario ${id}`);
  const mastery = id === OLORIN_SCENARIO_IDS[0];
  const title = mastery
    ? 'Olórin’s Searing Light: greatest creatures and spell mastery'
    : 'Olórin’s Searing Light: exile without spell mastery';
  const lands = [basic('Plains'), basic('Mountain'), basic('Forest'), basic('Forest')];
  const victims = [witness('Lab Greatest Bear', 4), witness('Lab Lesser Bear', 2)];
  const spells = [priorSpell(1), ...(mastery ? [priorSpell(2)] : [])];
  const players: EnginePlayerConfig[] = ['P1', 'P2', 'P3', 'P4'].map((seat) => ({
    id: seat,
    deckId: `lab-${id}-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [source.card, ...lands, ...spells]
        : seat === 'P2'
          ? [...victims, basic('Forest')]
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
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: [source.card.name] }],
        battlefield: [
          { playerId: 'P1', cardNames: lands.map((card) => card.name) },
          { playerId: 'P2', cardNames: victims.map((card) => card.name) },
        ],
        graveyard: [{ playerId: 'P1', cardNames: spells.map((card) => card.name) }],
      },
    },
  );
  const passing: DecisionProvider = {
    decide(request) {
      const action =
        request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
  return {
    metadata: {
      id,
      version: 1,
      title,
      instructions: [
        'Cast Olórin’s Searing Light for {2}{R}{W}.',
        'P2 must exile its greatest-power creature; its lesser creature survives.',
        mastery
          ? 'Two earlier spells enable four damage to P2.'
          : 'One earlier spell leaves P2 at 40 life.',
      ],
      expectedOutcome: mastery
        ? 'The greatest Bear is exiled and P2 has 36 life.'
        : 'The greatest Bear is exiled and P2 remains at 40 life.',
      oracleSha256: source.sha256,
      clauseIds: ['olorin-greatest-power-exile', 'olorin-spell-mastery-damage'],
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
    decisionProviderOverrides: { P2: passing },
  };
}
