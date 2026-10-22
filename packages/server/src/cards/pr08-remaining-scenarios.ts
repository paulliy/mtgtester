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
    throw new Error(`Tragic Arrogance Oracle pin drift: ${entry.card.name}`);
const selectedSource = pinned.cards.find((entry) => entry.card.name === 'Tragic Arrogance');
if (selectedSource === undefined) throw new Error('Missing Tragic Arrogance Oracle pin');
const source = selectedSource;
const selectedAetherspouts = pinned.cards.find((entry) => entry.card.name === 'Aetherspouts');
if (selectedAetherspouts === undefined) throw new Error('Missing Aetherspouts Oracle pin');
const aetherspouts = selectedAetherspouts;

const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
function basic(name: string): OracleCard {
  const card = coverage.find((entry) => entry.name === name);
  if (card === undefined) throw new Error(`Missing Tragic Arrogance basic ${name}`);
  return card;
}

function witness(name: string, kind: 'artifactCreature' | 'creature' | 'artifact'): OracleCard {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const base = basic('Plains');
  const artifactCreature = kind === 'artifactCreature';
  const creature = artifactCreature || kind === 'creature';
  const types = artifactCreature
    ? ['Artifact', 'Creature']
    : creature
      ? ['Creature']
      : ['Artifact'];
  const typeLine = artifactCreature
    ? 'Artifact Creature — Construct'
    : creature
      ? 'Creature — Bear'
      : 'Artifact';
  return {
    ...base,
    oracleId: `lab-tragic-arrogance-${slug}`,
    scryfallId: `lab-tragic-arrogance-${slug}`,
    name,
    manaCost: creature ? '{0}' : null,
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine,
    supertypes: [],
    types,
    subtypes: creature ? [artifactCreature ? 'Construct' : 'Bear'] : [],
    oracleText: '',
    power: creature ? '2' : null,
    toughness: creature ? '2' : null,
    keywords: [],
    isBasicLand: false,
  };
}

export const PR08_REMAINING_SCENARIO_IDS = [
  'tragic-arrogance-viewer-keeps-artifact-creature-twice',
  'tragic-arrogance-viewer-skips-missing-types',
] as const;
type ScenarioId = (typeof PR08_REMAINING_SCENARIO_IDS)[number];
const details: Record<ScenarioId, { title: string; instructions: string[]; expected: string }> = {
  'tragic-arrogance-viewer-keeps-artifact-creature-twice': {
    title: 'Tragic Arrogance: keep one artifact creature for both choices',
    instructions: [
      'Cast Tragic Arrogance with two Plains and three Forests; let it resolve.',
      'For P2, choose Lab Keeper as both the artifact and creature to keep.',
      'Confirm Lab Victim and Lab Spare leave while all lands survive.',
    ],
    expected:
      'Lab Keeper survives as both the chosen artifact and creature; Lab Victim and Lab Spare are sacrificed, and lands survive.',
  },
  'tragic-arrogance-viewer-skips-missing-types': {
    title: 'Tragic Arrogance: skip unavailable permanent types',
    instructions: [
      'Cast Tragic Arrogance with two Plains and three Forests; let it resolve.',
      'P2 controls only Lab Lone Creature and a land, so no artifact, enchantment, or planeswalker choice is available.',
      'Confirm the creature and all lands survive.',
    ],
    expected:
      'Lab Lone Creature survives as P2’s only creature; missing permanent types are skipped and all lands survive.',
  },
};

export function pr08TragicArroganceScenarioSubject(id: string): string {
  if (!(PR08_REMAINING_SCENARIO_IDS as readonly string[]).includes(id))
    throw new Error(`Unknown Tragic Arrogance scenario ${id}`);
  return 'Tragic Arrogance';
}

function passing(): DecisionProvider {
  return {
    decide(request) {
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function pr08TragicArroganceScenario(id: string, gameId: GameId): CardTestScenario {
  const detail = details[id as ScenarioId];
  if (detail === undefined) throw new Error(`Unknown Tragic Arrogance scenario ${id}`);
  const expanded = id === PR08_REMAINING_SCENARIO_IDS[0];
  const plains = basic('Plains');
  const forest = basic('Forest');
  const p2Permanents = expanded
    ? [
        witness('Lab Keeper', 'artifactCreature'),
        witness('Lab Victim', 'creature'),
        witness('Lab Spare', 'artifact'),
      ]
    : [witness('Lab Lone Creature', 'creature')];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `card-lab-${seat}-tragic-arrogance`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [source.card, plains, plains, forest, forest, forest]
        : seat === 'P2'
          ? [...p2Permanents, forest]
          : [forest, forest],
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
        hand: [{ playerId: 'P1', cardNames: ['Tragic Arrogance'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Plains', 'Plains', 'Forest', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: p2Permanents.map((card) => card.name) },
          { playerId: 'P2', cardNames: ['Forest'] },
        ],
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
      oracleSha256: source.sha256,
      clauseIds: ['tragic-arrogance-choose-permanent-types-then-sacrifice-other-nonlands'],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: { P2: passing(), P3: passing(), P4: passing() },
  };
}

export const AETHERSPOUTS_SCENARIO_IDS = [
  'aetherspouts-viewer-owner-alpha-top-beta-bottom',
  'aetherspouts-viewer-owner-alpha-bottom-beta-top',
] as const;
type AetherspoutsScenarioId = (typeof AETHERSPOUTS_SCENARIO_IDS)[number];
const aetherspoutsDetails: Record<
  AetherspoutsScenarioId,
  { title: string; instructions: string[]; expected: string }
> = {
  'aetherspouts-viewer-owner-alpha-top-beta-bottom': {
    title: 'Aetherspouts: owner puts one attacker on top and one on bottom',
    instructions: [
      'Let P2 attack you with Lab P1 Attacker Alpha, Lab P1 Attacker Beta, and Lab P2 Attacker.',
      'Cast Aetherspouts with two Islands and three Forests after attackers are declared.',
      'As owner, put Lab P1 Attacker Alpha on top and Lab P1 Attacker Beta on the bottom of your library.',
    ],
    expected:
      'Aetherspouts is cast without targets for {3}{U}{U}; P1’s owned attacker Alpha is on top of P1’s library and Beta is on the bottom, while P2’s own attacker goes to P2’s library.',
  },
  'aetherspouts-viewer-owner-alpha-bottom-beta-top': {
    title: 'Aetherspouts: owner reverses the top and bottom choices',
    instructions: [
      'Let P2 attack you with Lab P1 Attacker Alpha, Lab P1 Attacker Beta, and Lab P2 Attacker.',
      'Cast Aetherspouts with two Islands and three Forests after attackers are declared.',
      'As owner, put Lab P1 Attacker Alpha on the bottom and Lab P1 Attacker Beta on top of your library.',
    ],
    expected:
      'Aetherspouts is cast without targets for {3}{U}{U}; P1’s owned attacker Beta is on top of P1’s library and Alpha is on the bottom, while P2’s own attacker goes to P2’s library.',
  },
};

function aetherspoutsWitness(name: string): OracleCard {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    ...basic('Forest'),
    oracleId: `lab-aetherspouts-${slug}`,
    scryfallId: `lab-aetherspouts-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: 'Creature — Bear',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Bear'],
    oracleText: '',
    power: '2',
    toughness: '2',
    keywords: [],
    isBasicLand: false,
  };
}

function aetherspoutsOpponent(): DecisionProvider {
  return {
    decide(request: DecisionRequest) {
      if (request.decisionType === 'declareAttackers') {
        const action = request.legalActions.find(
          (candidate) => candidate.type === 'attackDeclaration',
        );
        if (action === undefined) throw new Error('P2 has no attacker declaration action');
        const targets = (action.targets ?? []).map((slot) => {
          if (!slot.options.includes('P1'))
            throw new Error(`P2 cannot attack P1 from slot ${slot.slot}`);
          return { slot: slot.slot, choice: 'P1' };
        });
        return { requestId: request.requestId, actionId: action.id, targets };
      }
      if (request.prompt.toLowerCase().includes('top or bottom')) {
        const bottom = request.legalActions.find((candidate) =>
          /bottom/i.test(candidate.description),
        );
        if (bottom !== undefined) return { requestId: request.requestId, actionId: bottom.id };
      }
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function pr08AetherspoutsScenario(id: string, gameId: GameId): CardTestScenario {
  const detail = aetherspoutsDetails[id as AetherspoutsScenarioId];
  if (detail === undefined) throw new Error(`Unknown Aetherspouts scenario ${id}`);
  const island = basic('Island');
  const forest = basic('Forest');
  const ownerAlpha = aetherspoutsWitness('Lab P1 Attacker Alpha');
  const ownerBeta = aetherspoutsWitness('Lab P1 Attacker Beta');
  const opponentAttacker = aetherspoutsWitness('Lab P2 Attacker');
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `card-lab-${seat}-aetherspouts`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [
            aetherspouts.card,
            island,
            island,
            forest,
            forest,
            forest,
            ownerAlpha,
            ownerBeta,
            forest,
            forest,
            forest,
            forest,
          ]
        : seat === 'P2'
          ? [opponentAttacker, forest, forest, forest, forest, forest]
          : [forest, forest],
  }));
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players, turnCap: 2 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P2',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Aetherspouts'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Island', 'Island', 'Forest', 'Forest', 'Forest'] },
          { playerId: 'P1', cardNames: [ownerAlpha.name], controllerId: 'P2' },
          { playerId: 'P1', cardNames: [ownerBeta.name], controllerId: 'P2' },
          { playerId: 'P2', cardNames: [opponentAttacker.name] },
        ],
        continueThroughCombat: true,
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
      oracleSha256: aetherspouts.sha256,
      clauseIds: ['aetherspouts-each-attacker-owner-chooses-top-or-bottom-of-library'],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: { P2: aetherspoutsOpponent() },
  };
}
