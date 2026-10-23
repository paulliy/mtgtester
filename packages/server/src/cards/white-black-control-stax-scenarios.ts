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
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    return input;
  };
  return JSON.stringify(ordered(value));
}

function fromPin(name: string): { sha256: string; card: OracleCard } {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return entry;
}

const plains = fromPin('Plains').card;
const mother = fromPin('Mother of Runes').card;

const entries = [
  {
    id: 'rule-of-law-viewer-single-spell-limit',
    source: fromPin('Rule of Law'),
    title: 'Rule of Law: cast one spell, play a land, and activate Mother of Runes',
    clauseIds: ['rule-of-law-c01'],
  },
  {
    id: 'deafening-silence-viewer-creature-exemption',
    source: fromPin('Deafening Silence'),
    title: 'Deafening Silence: block a second noncreature spell and allow a creature',
    clauseIds: ['deafening-silence-c01'],
  },
  {
    id: 'archon-of-emeria-viewer-single-spell-limit',
    source: fromPin('Archon of Emeria'),
    title: 'Archon of Emeria: each player may cast only one spell each turn',
    clauseIds: ['archon-of-emeria-c02'],
  },
] as const;

export const WHITE_BLACK_CONTROL_STAX_SCENARIO_IDS = entries.map((entry) => entry.id);

function witness(name: string, type: 'creature' | 'instant' | 'sorcery'): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const creature = type === 'creature';
  return {
    ...plains,
    oracleId: `lab-white-black-stax-${slug}`,
    scryfallId: `lab-white-black-stax-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: creature ? 'Creature — Bear' : type === 'instant' ? 'Instant' : 'Sorcery',
    supertypes: [],
    types: creature ? ['Creature'] : [type === 'instant' ? 'Instant' : 'Sorcery'],
    subtypes: creature ? ['Bear'] : [],
    oracleText: creature ? '' : 'You gain 1 life.',
    power: creature ? '2' : null,
    toughness: creature ? '2' : null,
    keywords: [],
    isBasicLand: false,
  };
}

function ruleOpponentProvider(firstSpell: string, secondSpell: string): DecisionProvider {
  let castFirst = false;
  return {
    decide(request) {
      const onP2Main =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.turn === 2 &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const targetName = castFirst ? secondSpell : firstSpell;
      const action = onP2Main
        ? request.legalActions.find(
            (candidate) =>
              candidate.type === 'castSpell' &&
              candidate.description.startsWith(`Cast ${targetName}`) &&
              candidate.data?.['sourceName'] === targetName &&
              candidate.data?.['sourceZone'] === 'hand',
          )
        : undefined;
      if (action !== undefined) {
        if (!castFirst) castFirst = true;
        return { requestId: request.requestId, actionId: action.id };
      }
      const pass =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (pass === undefined) throw new Error(`No legal P2 action for ${request.decisionType}`);
      return { requestId: request.requestId, actionId: pass.id };
    },
  };
}

export function whiteBlackControlStaxScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control stax scenario ${id}`);

  const isRule = entry.source.card.name !== 'Deafening Silence';
  const ownCreature = witness('Lab P1 Free Creature', 'creature');
  const ownInstant = witness('Lab P1 Free Instant', 'instant');
  const p2FirstSpell = witness('Lab P2 First Spell', 'sorcery');
  const p2SecondSpell = witness('Lab P2 Second Spell', 'sorcery');
  const p1Lands = Array.from({ length: isRule ? 4 : 1 }, () => plains);
  const p1Cards = [
    entry.source.card,
    ...p1Lands,
    ...(isRule ? [mother] : []),
    ownCreature,
    ownInstant,
  ];
  const p2Cards = isRule
    ? [p2FirstSpell, p2SecondSpell, ...Array.from({ length: 10 }, () => plains)]
    : Array.from({ length: 10 }, () => plains);
  const otherCards = Array.from({ length: 10 }, () => plains);
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-stax-${seat}`,
    commanders: [],
    cards: seat === 'P1' ? p1Cards : seat === 'P2' ? p2Cards : otherCards,
  }));
  const battlefield = [
    { playerId: 'P1', cardNames: p1Lands.slice(0, isRule ? 3 : 1).map((land) => land.name) },
    ...(isRule ? [{ playerId: 'P1', cardNames: [mother.name] }] : []),
  ];
  const hand = [
    {
      playerId: 'P1',
      cardNames: [
        entry.source.card.name,
        ...(isRule ? [plains.name] : []),
        ownCreature.name,
        ownInstant.name,
      ],
    },
    ...(isRule ? [{ playerId: 'P2', cardNames: [p2FirstSpell.name, p2SecondSpell.name] }] : []),
  ];
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: configs, turnCap: 5 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand,
        battlefield,
        ...(isRule ? { continueThroughPrecombatMains: 2 } : {}),
      },
    },
  );

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isRule
        ? [
            `Cast ${entry.source.card.name} normally from your hand; it is your first spell this turn.`,
            'Verify both Lab P1 Free Creature and Lab P1 Free Instant are not actionable. Play the available Plains and activate Mother of Runes.',
            `Pass through to P2's turn. P2 casts Lab P2 First Spell; ${entry.source.card.name} prevents P2 from casting Lab P2 Second Spell that turn.`,
          ]
        : [
            'Cast Deafening Silence normally from your hand; it is your first noncreature spell this turn.',
            'Verify Lab P1 Free Instant is not actionable while Lab P1 Free Creature remains available.',
            'Cast Lab P1 Free Creature normally and observe it resolve onto the battlefield.',
          ],
      expectedOutcome: isRule
        ? `${entry.source.card.name} resolves from a normal cast. P1 cannot cast either second witness spell that turn but can play a land and activate Mother of Runes. On P2's turn, P2 casts one sorcery and cannot cast the second.`
        : 'Deafening Silence resolves from a normal cast. The second noncreature spell is unavailable, while a creature spell remains legal and resolves normally.',
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
    engine,
    decisionProviderOverrides: isRule
      ? { P2: ruleOpponentProvider(p2FirstSpell.name, p2SecondSpell.name) }
      : {},
  };
}
