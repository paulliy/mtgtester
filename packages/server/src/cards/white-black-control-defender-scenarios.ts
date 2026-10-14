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
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(canonical(item))));
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, JSON.parse(canonical(item))]),
      ),
    );
  }
  return JSON.stringify(value);
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
const definitions = [
  {
    id: 'archon-of-absolution-viewer-taxes-planeswalker-attack',
    source: fromPin('Archon of Absolution'),
    title: 'Archon of Absolution: P2 pays the attack tax to attack your planeswalker',
    clauseIds: ['archon-of-absolution-c02'],
  },
  {
    id: 'soul-snare-viewer-exiles-planeswalker-attacker',
    source: fromPin('Soul Snare'),
    title: 'Soul Snare: pay {W} and sacrifice it to exile a planeswalker attacker',
    clauseIds: ['soul-snare-c01'],
  },
  {
    id: 'the-haunt-of-hightower-viewer-defender-discard-planeswalker-combat',
    source: fromPin('The Haunt of Hightower'),
    title: 'The Haunt of Hightower: its attack makes the planeswalker defender discard',
    clauseIds: ['the-haunt-of-hightower-c02', 'the-haunt-of-hightower-c03'],
  },
] as const;

export const WHITE_BLACK_DEFENDER_SCENARIO_IDS = definitions.map((entry) => entry.id);

function witness(name: string, kind: 'creature' | 'planeswalker' | 'hasteEnchantment'): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (kind === 'hasteEnchantment')
    return {
      ...plains,
      oracleId: `lab-white-black-${slug}`,
      scryfallId: `lab-white-black-${slug}`,
      name,
      manaCost: null,
      cmc: 0,
      colors: [],
      colorIdentity: [],
      typeLine: 'Enchantment',
      supertypes: [],
      types: ['Enchantment'],
      subtypes: [],
      oracleText: 'Creatures you control have haste.',
      power: null,
      toughness: null,
      keywords: [],
      isBasicLand: false,
    };
  if (kind === 'planeswalker')
    return {
      ...plains,
      oracleId: `lab-white-black-${slug}`,
      scryfallId: `lab-white-black-${slug}`,
      name,
      manaCost: null,
      cmc: 0,
      colors: [],
      colorIdentity: [],
      typeLine: 'Planeswalker — Jace',
      supertypes: [],
      types: ['Planeswalker'],
      subtypes: ['Jace'],
      oracleText: '',
      power: null,
      toughness: null,
      loyalty: '4',
      keywords: [],
      isBasicLand: false,
    };
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
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
    power: '3',
    toughness: '3',
    keywords: [],
    isBasicLand: false,
  };
}

function targetWalkerProvider(walkerName: string): DecisionProvider {
  return {
    decide(request) {
      if (request.decisionType === 'declareAttackers') {
        const action = request.legalActions.find(
          (candidate) => candidate.type === 'attackDeclaration',
        );
        const subjects = request.presentation?.attackDeclaration?.subjects ?? [];
        if (action !== undefined) {
          const targets = (action.targets ?? []).map((slot, index) => {
            const walker = subjects[index]?.defenders.find(
              (defender) => defender.name === walkerName,
            );
            const choice = walker?.defenderId ?? walker?.playerId;
            return {
              slot: slot.slot,
              choice:
                choice !== undefined && slot.options.includes(choice) ? choice : slot.options[0]!,
            };
          });
          return { requestId: request.requestId, actionId: action.id, targets };
        }
      }
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (action === undefined) throw new Error(`No legal action for ${request.decidingPlayer}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function whiteBlackControlDefenderScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = definitions.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control defender scenario ${id}`);

  const name = entry.source.card.name;
  const isArchon = name === 'Archon of Absolution';
  const isSnare = name === 'Soul Snare';
  const isHaunt = !isArchon && !isSnare;
  const ownWalker = witness('Lab P1 Planeswalker Defender', 'planeswalker');
  const opponentWalker = witness('Lab P2 Planeswalker Defender', 'planeswalker');
  const attacker = witness(isHaunt ? name : 'Lab P2 Attacking Creature', 'creature');
  const hasteWitness = witness('Lab Haste Witness', 'hasteEnchantment');
  const lands = isHaunt
    ? [plains, plains, plains, plains, swamp, swamp]
    : isArchon
      ? [plains, plains, plains, plains, swamp]
      : [plains, plains, swamp, swamp];
  const p1Cards = [
    entry.source.card,
    ...lands,
    ownWalker,
    opponentWalker,
    ...(isHaunt ? [hasteWitness] : []),
  ];
  const p2Cards = [attacker, swamp, swamp, plains, ...(isHaunt ? [opponentWalker] : [])];
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-defenders-${seat}`,
    commanders: [],
    cards: seat === 'P1' ? p1Cards : seat === 'P2' ? p2Cards : [plains, swamp, swamp],
  }));
  const seed = `card-lab-${id}-v1`;
  const battlefield = [
    { playerId: 'P1', cardNames: lands.map((land) => land.name) },
    { playerId: 'P1', cardNames: [ownWalker.name], counters: { loyalty: 4 } },
    ...(isHaunt ? [] : [{ playerId: 'P2', cardNames: [attacker.name] }]),
    ...(isArchon ? [{ playerId: 'P2', cardNames: [swamp.name, swamp.name] }] : []),
    ...(isHaunt ? [{ playerId: 'P1', cardNames: [hasteWitness.name] }] : []),
    ...(isHaunt
      ? [{ playerId: 'P2', cardNames: [opponentWalker.name], counters: { loyalty: 4 } }]
      : []),
  ];
  const preparedHand = [
    { playerId: 'P1', cardNames: [name] },
    ...(isHaunt ? [{ playerId: 'P2', cardNames: [plains.name] }] : []),
  ];

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isHaunt
        ? [
            'Cast The Haunt of Hightower normally; Lab Haste Witness supplies haste without changing Haunt’s pinned rules text.',
            'Attack P2’s planeswalker and observe the defending player discard before combat damage.',
          ]
        : [
            `Cast ${name} from your hand and let it resolve.`,
            isArchon
              ? 'Pass to P2’s combat. P2 attacks your planeswalker and pays {1} for the attack.'
              : 'Pass to P2’s combat. After the creature attacks your planeswalker, activate Soul Snare for {W} and exile it.',
          ],
      expectedOutcome: isHaunt
        ? 'After a normal cast, The Haunt attacks with the prepared haste effect; the defending player discards before combat damage.'
        : isArchon
          ? 'P2 pays the ordinary {1} attack tax and deals combat damage to your planeswalker.'
          : 'Soul Snare is sacrificed as its activated ability resolves; the attacking creature is exiled and the planeswalker takes no combat damage.',
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
      { gameId, seed, players: configs, turnCap: 5 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: isHaunt ? 'precombatMain' : 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: preparedHand,
          battlefield,
          ...(isHaunt ? { continueThroughCombat: true } : { continueThroughNextCombat: true }),
        },
      },
    ),
    decisionProviderOverrides: {
      ...(isHaunt
        ? {
            P2: {
              decide(request) {
                const discard = request.legalActions.find((candidate) =>
                  /discard/i.test(candidate.description),
                );
                const action =
                  discard ??
                  request.legalActions.find((candidate) => candidate.type === 'pass') ??
                  request.legalActions[0];
                if (action === undefined)
                  throw new Error(`No legal action for ${request.decidingPlayer}`);
                const targets = (action.targets ?? []).map((slot) => ({
                  slot: slot.slot,
                  choice: slot.options[0]!,
                }));
                return {
                  requestId: request.requestId,
                  actionId: action.id,
                  ...(targets.length > 0 ? { targets } : {}),
                };
              },
            },
          }
        : { P2: targetWalkerProvider(ownWalker.name) }),
    },
  };
}
