import { readFileSync } from 'node:fs';
import { sha256 } from '../benchmark/hash';
import { Engine } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig } from '@mtg/engine';
import type { DecisionRequest, GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
for (const entry of pinned.cards)
  if (sha256(entry.card) !== entry.sha256)
    throw new Error(`Boseiju Oracle pin drift: ${entry.card.name}`);
const selectedBoseiju = pinned.cards.find((entry) => entry.card.name === 'Boseiju, Who Endures');
if (selectedBoseiju === undefined) throw new Error('Missing Boseiju Oracle pin');
const boseiju = selectedBoseiju;

const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
function basic(name: string): OracleCard {
  const card = coverage.find((entry) => entry.name === name);
  if (card === undefined) throw new Error(`Missing Boseiju scenario basic ${name}`);
  return card;
}

function synthetic(
  name: string,
  kind: 'artifact' | 'legendaryCreature' | 'greenSpell',
): OracleCard {
  const base = basic(kind === 'artifact' ? 'Plains' : 'Forest');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const creature = kind === 'legendaryCreature';
  const spell = kind === 'greenSpell';
  return {
    ...base,
    oracleId: `lab-boseiju-${slug}`,
    scryfallId: `lab-boseiju-${slug}`,
    name,
    manaCost: creature || spell ? '{G}' : null,
    cmc: creature || spell ? 1 : 0,
    colors: creature || spell ? ['G'] : [],
    colorIdentity: creature || spell ? ['G'] : [],
    typeLine: creature ? 'Legendary Creature — Bear' : spell ? 'Sorcery' : 'Artifact',
    supertypes: creature ? ['Legendary'] : [],
    types: creature ? ['Creature'] : spell ? ['Sorcery'] : ['Artifact'],
    subtypes: creature ? ['Bear'] : [],
    oracleText: spell ? 'You gain 1 life.' : '',
    power: creature ? '2' : null,
    toughness: creature ? '2' : null,
    keywords: [],
    isBasicLand: false,
  };
}

export const BOSEIJU_SCENARIO_IDS = [
  'boseiju-viewer-channel-decline-search',
  'boseiju-viewer-channel-legendary-discount-search-forest',
  'boseiju-viewer-land-mana',
] as const;
type ScenarioId = (typeof BOSEIJU_SCENARIO_IDS)[number];

const details: Record<ScenarioId, { title: string; instructions: string[]; expected: string }> = {
  'boseiju-viewer-channel-decline-search': {
    title: 'Boseiju, Who Endures: channel and decline the search',
    instructions: [
      'Channel Boseiju from your hand, paying {1}{G}, and target Lab P2 Artifact.',
      'Confirm the opponent artifact is destroyed and Boseiju is discarded.',
      'P2 declines the optional search, so their library is not shuffled.',
    ],
    expected:
      'Boseiju is discarded as a channel cost, the opposing artifact is destroyed, and its controller declines to search without shuffling.',
  },
  'boseiju-viewer-channel-legendary-discount-search-forest': {
    title: 'Boseiju, Who Endures: legendary discount and search for Forest',
    instructions: [
      'With Lab Legendary Bear in play, channel Boseiju and target Lab P2 Artifact.',
      'The legendary creature reduces only the generic cost, so pay {G} with your Forest.',
      'P2 searches for a basic Forest; it enters the battlefield untapped.',
    ],
    expected:
      'The legendary creature reduces Boseiju’s channel cost by {1}; Boseiju is discarded, the artifact is destroyed, and P2’s searched Forest enters untapped.',
  },
  'boseiju-viewer-land-mana': {
    title: 'Boseiju, Who Endures: play as a land and make green mana',
    instructions: [
      'Play Boseiju, Who Endures from your hand as your land for the turn.',
      'Cast Lab Green Salve for {G}, using Boseiju’s {T}: Add {G} ability.',
      'Confirm Boseiju is tapped and you gain 1 life.',
    ],
    expected:
      'Boseiju enters as a land, taps for green mana to pay for Lab Green Salve, and the spell resolves for 1 life.',
  },
};

function opponentChoices(search: boolean): DecisionProvider {
  return {
    decide(request: DecisionRequest) {
      const prompt = request.prompt.toLowerCase();
      let action;
      if (prompt.includes('search your library')) {
        action = request.legalActions.find((candidate) =>
          search
            ? /yes|search/i.test(candidate.description)
            : /no|decline/i.test(candidate.description),
        );
      } else if (prompt.includes('choose a land with a basic land type')) {
        action = request.legalActions.find((candidate) => /forest/i.test(candidate.description));
      }
      action ??=
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function pr08BoseijuScenario(id: string, gameId: GameId): CardTestScenario {
  const detail = details[id as ScenarioId];
  if (detail === undefined) throw new Error(`Unknown Boseiju scenario ${id}`);
  const discounted = id === BOSEIJU_SCENARIO_IDS[1];
  const forest = basic('Forest');
  const island = basic('Island');
  const landMana = id === BOSEIJU_SCENARIO_IDS[2];
  const greenSpell = synthetic('Lab Green Salve', 'greenSpell');
  const artifact = synthetic('Lab P2 Artifact', 'artifact');
  const legendary = synthetic('Lab Legendary Bear', 'legendaryCreature');
  const p1Battlefield = landMana ? [] : discounted ? [forest, legendary] : [forest, island];
  const p2Library = discounted ? [forest, island] : [island, forest];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `card-lab-${seat}-boseiju`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [boseiju.card, forest, island, legendary, greenSpell]
        : seat === 'P2'
          ? [artifact, ...p2Library]
          : [forest, island],
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
        hand: [
          {
            playerId: 'P1',
            cardNames: landMana
              ? ['Boseiju, Who Endures', greenSpell.name]
              : ['Boseiju, Who Endures'],
          },
        ],
        battlefield: [
          { playerId: 'P1', cardNames: p1Battlefield.map((card) => card.name) },
          { playerId: 'P2', cardNames: [artifact.name] },
        ],
        libraryTop: [{ playerId: 'P2', cardNames: p2Library.map((card) => card.name) }],
      },
    },
  );
  const seats = players.map((config) => ({
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
  }));
  return {
    metadata: {
      id,
      version: 1,
      title: detail.title,
      instructions: detail.instructions,
      expectedOutcome: detail.expected,
      oracleSha256: boseiju.sha256,
      clauseIds: landMana
        ? ['boseiju-land-mana']
        : ['boseiju-channel-target-search', 'boseiju-legendary-cost-reduction'],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: {
      P2: opponentChoices(discounted),
    },
  };
}
