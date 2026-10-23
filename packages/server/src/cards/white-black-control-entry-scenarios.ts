import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { DecisionProvider } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function fromPin(name: string): { card: OracleCard; sha256: string } {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return entry;
}

const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;
const authority = fromPin('Authority of the Consuls');

const entries = [
  {
    id: 'authority-of-the-consuls-viewer-opponent-creature-entry',
    source: fromPin('Authority of the Consuls'),
    title: 'Authority of the Consuls: opponents enter tapped and gain life',
    clauseIds: ['authority-of-the-consuls-c01', 'authority-of-the-consuls-c02'],
  },
  {
    id: 'archon-of-emeria-viewer-opponent-nonbasic-land-entry',
    source: fromPin('Archon of Emeria'),
    title: 'Archon of Emeria: opponents’ nonbasic land enters tapped',
    clauseIds: ['archon-of-emeria-c01', 'archon-of-emeria-c03'],
  },
  {
    id: 'doorkeeper-thrull-viewer-suppresses-creature-entry-trigger',
    source: fromPin('Doorkeeper Thrull'),
    title: 'Doorkeeper Thrull: artifact creature entry trigger is suppressed',
    clauseIds: ['doorkeeper-thrull-c02', 'doorkeeper-thrull-c03'],
  },
  {
    id: 'hushbringer-viewer-suppresses-creature-entry-trigger',
    source: fromPin('Hushbringer'),
    title: 'Hushbringer: creature entry trigger is suppressed',
    clauseIds: ['hushbringer-c01', 'hushbringer-c02'],
  },
  {
    id: 'karn-argent-defender-viewer-suppresses-artifact-creature-trigger',
    source: fromPin('Karn, Argent Defender'),
    title: 'Karn, Argent Defender: artifact creature entry trigger is suppressed',
    clauseIds: ['karn-argent-defender-c01'],
  },
  {
    id: 'doorkeeper-thrull-viewer-flash-suppresses-incoming-entry',
    source: fromPin('Doorkeeper Thrull'),
    title: 'Doorkeeper Thrull: flash in before an opposing creature enters',
    clauseIds: ['doorkeeper-thrull-c01', 'doorkeeper-thrull-c03'],
  },
] as const;

export const WHITE_BLACK_ENTRY_SCENARIO_IDS = entries.map((entry) => entry.id);

function witness(
  name: string,
  kind: 'creature' | 'artifactCreature' | 'nonbasicLand' | 'basicLand',
): OracleCard {
  if (kind === 'nonbasicLand' || kind === 'basicLand') {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      ...plains,
      oracleId: `lab-white-black-${slug}`,
      scryfallId: `lab-white-black-${slug}`,
      name,
      manaCost: null,
      cmc: 0,
      colors: [],
      colorIdentity: [],
      typeLine: kind === 'basicLand' ? 'Basic Land' : 'Land',
      supertypes: kind === 'basicLand' ? ['Basic'] : [],
      types: ['Land'],
      subtypes: [],
      oracleText: '',
      power: null,
      toughness: null,
      keywords: [],
      isBasicLand: kind === 'basicLand',
    };
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: kind === 'artifactCreature' ? 'Artifact Creature — Construct' : 'Creature — Bear',
    supertypes: [],
    types: kind === 'artifactCreature' ? ['Artifact', 'Creature'] : ['Creature'],
    subtypes: [kind === 'artifactCreature' ? 'Construct' : 'Bear'],
    oracleText: '',
    power: '2',
    toughness: '2',
    keywords: [],
    isBasicLand: false,
  };
}

function witnessProvider(
  name: string,
  actionType: 'cast' | 'playLand',
  basicLandFirst = false,
): DecisionProvider {
  let landPlayed = false;
  let witnessPlayed = false;
  return {
    decide(request) {
      const isP2MainPhase =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const action = request.legalActions.find((candidate) => {
        if (!isP2MainPhase) return false;
        if (actionType === 'playLand')
          return (
            !landPlayed &&
            (candidate.type === 'playLand' || candidate.description.startsWith(`Play ${name}`))
          );
        if (basicLandFirst && !landPlayed)
          return (
            candidate.type === 'playLand' ||
            candidate.description.startsWith('Play Lab Opponent Basic Land')
          );
        return (
          !witnessPlayed &&
          candidate.type === 'castSpell' &&
          candidate.description.startsWith(`Cast ${name}`)
        );
      });
      if (action !== undefined) {
        if (action.type === 'playLand') landPlayed = true;
        else witnessPlayed = true;
        return { requestId: request.requestId, actionId: action.id };
      }
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      return { requestId: request.requestId, actionId: (pass ?? request.legalActions[0]!).id };
    },
  };
}

export function whiteBlackControlEntryScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control entry scenario ${id}`);

  const sourceName = entry.source.card.name;
  const isFlash = id === 'doorkeeper-thrull-viewer-flash-suppresses-incoming-entry';
  const isAuthority = sourceName === 'Authority of the Consuls';
  const isArchon = sourceName === 'Archon of Emeria';
  const isSuppressor = !isAuthority && !isArchon;
  const witnessName = isArchon
    ? 'Lab Opponent Nonbasic Land'
    : isAuthority
      ? 'Lab Opponent Creature'
      : 'Lab Opponent Artifact Creature';
  const witnessKind = isArchon ? 'nonbasicLand' : isSuppressor ? 'artifactCreature' : 'creature';
  const opponentWitness = witness(witnessName, witnessKind);
  const opponentBasicLand = witness('Lab Opponent Basic Land', 'basicLand');
  const ownWitness = witness('Lab Own Creature', 'creature');
  const ownBasicLand = witness('Lab Own Basic Land', 'basicLand');
  const mana = [plains, plains, plains, plains, swamp];

  const p1Cards = [entry.source.card, ...mana, ownWitness, ownBasicLand, authority.card];
  const p2Cards = [opponentWitness, opponentBasicLand, plains];
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-entry-${seat}`,
    commanders: [],
    cards: seat === 'P1' ? p1Cards : seat === 'P2' ? p2Cards : [plains, plains],
  }));
  const seed = `card-lab-${id}-v1`;
  const preparedBattlefield = [
    { playerId: 'P1', cardNames: mana.map((land) => land.name) },
    ...(isSuppressor ? [{ playerId: 'P1', cardNames: [authority.card.name] }] : []),
  ];
  const preparedHand = [
    { playerId: 'P1', cardNames: [sourceName] },
    ...(isArchon ? [{ playerId: 'P1', cardNames: [ownBasicLand.name] }] : []),
    {
      playerId: 'P2',
      cardNames: isAuthority
        ? [opponentWitness.name, opponentBasicLand.name]
        : [opponentWitness.name],
    },
  ];
  const players = configs.map((config) => ({
    ...config,
  }));

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        isFlash
          ? 'On P2’s turn, cast Doorkeeper Thrull from hand in response to the opposing artifact creature spell.'
          : `Cast ${sourceName} from your hand and let it resolve.`,
        ...(isAuthority
          ? [
              'At P2’s main phase, observe the basic land enter untapped, then the creature enter tapped.',
              'Authority should gain one life for the opposing creature only.',
            ]
          : isArchon
            ? [
                `Play ${ownBasicLand.name} from your hand; your own basic land should enter untapped.`,
                'Pass through the turn until P2 plays Lab Opponent Nonbasic Land.',
              ]
            : [
                'Authority of the Consuls is prepared as a real trigger watcher; the opponent witness is an artifact creature.',
                `Pass through the turn until P2 casts ${witnessName}.`,
              ]),
      ],
      expectedOutcome: isAuthority
        ? 'P2’s basic land enters untapped; the opposing creature enters tapped and Authority gains you one life.'
        : isArchon
          ? 'Your basic Plains enters untapped. P2’s nonbasic land enters tapped.'
          : `The opponent artifact creature enters, but Authority of the Consuls does not gain life because ${sourceName} suppresses its creature-entry trigger.`,
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats: configs.map((config) => ({
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
      { gameId, seed, players, turnCap: 3 },
      {
        preparedScenario: {
          currentTurnPlayer: isFlash ? 'P2' : 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: isFlash ? 2 : 1,
          hand: preparedHand,
          battlefield: preparedBattlefield,
          ...(!isFlash ? { continueThroughNextPrecombatMain: true } : {}),
        },
      },
    ),
    decisionProviderOverrides: {
      P2: witnessProvider(witnessName, isArchon ? 'playLand' : 'cast', isAuthority),
    },
  };
}
