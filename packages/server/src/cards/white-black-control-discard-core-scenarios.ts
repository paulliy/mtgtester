import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { DecisionProvider } from '@mtg/engine';
import type { GameId, OracleCard, PlayerId } from '@mtg/shared';
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
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
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
const swamp = fromPin('Swamp').card;
const hymn = fromPin('Hymn to Tourach');
const arcaneSignet = fromPin('Arcane Signet');

const entries = [
  {
    id: 'hymn-to-tourach-viewer-two-random-discards',
    source: fromPin('Hymn to Tourach'),
    title: 'Hymn to Tourach: cast normally and make the target discard two cards at random',
    clauseIds: ['hymn-to-tourach-c01'],
  },
  {
    id: 'bottomless-pit-viewer-next-upkeep-random-discard',
    source: fromPin('Bottomless Pit'),
    title: 'Bottomless Pit: cast normally, then discard at the next player upkeep',
    clauseIds: ['bottomless-pit-c01'],
  },
  {
    id: 'necrogen-mists-viewer-next-upkeep-discard-choice',
    source: fromPin('Necrogen Mists'),
    title: 'Necrogen Mists: cast normally, then choose a card at the next player upkeep',
    clauseIds: ['necrogen-mists-c01'],
  },
  {
    id: 'hypnotic-specter-viewer-unblocked-combat-discard',
    source: fromPin('Hypnotic Specter'),
    title: 'Hypnotic Specter: unblocked combat damage makes the opponent discard at random',
    clauseIds: ['hypnotic-specter-c01', 'hypnotic-specter-c02'],
  },
  {
    id: 'oppression-viewer-opponent-cast-discard',
    source: fromPin('Oppression'),
    title: 'Oppression: cast normally, then an opponent casts and discards',
    clauseIds: ['oppression-c01'],
  },
  {
    id: 'syphon-mind-viewer-opponents-discard-and-draw',
    source: fromPin('Syphon Mind'),
    title: 'Syphon Mind: each other player discards and you draw for each',
    clauseIds: ['syphon-mind-c01'],
  },
  {
    id: 'geth-s-grimoire-viewer-hymn-discard-draw-payoff',
    source: fromPin("Geth's Grimoire"),
    title: "Geth's Grimoire: cast it, then an opponent casts Hymn and you draw for each discard",
    clauseIds: ['geth-s-grimoire-c01'],
  },
] as const;

export const WHITE_BLACK_DISCARD_CORE_SCENARIO_IDS = entries.map((entry) => entry.id);

function witness(name: string, kind: 'creature' | 'artifact' | 'sorcery'): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const creature = kind === 'creature';
  const artifact = kind === 'artifact';
  return {
    ...plains,
    oracleId: `lab-white-black-discard-core-${slug}`,
    scryfallId: `lab-white-black-discard-core-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: creature ? 'Creature — Bear' : artifact ? 'Artifact' : 'Sorcery',
    supertypes: [],
    types: creature ? ['Creature'] : artifact ? ['Artifact'] : ['Sorcery'],
    subtypes: creature ? ['Bear'] : [],
    oracleText: '',
    power: creature ? '2' : null,
    toughness: creature ? '2' : null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
  };
}

function scriptedP2(options: {
  cast?: string;
  target?: PlayerId;
  discard?: string;
}): DecisionProvider {
  let hasCast = false;
  return {
    decide(request) {
      const inP2Main =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const cast =
        inP2Main && !hasCast && options.cast !== undefined
          ? request.legalActions.find(
              (action) =>
                action.type === 'castSpell' &&
                action.description.startsWith(`Cast ${options.cast}`),
            )
          : undefined;
      if (cast !== undefined) {
        hasCast = true;
        const targets = (cast.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice:
            options.target !== undefined && slot.options.includes(options.target)
              ? options.target
              : slot.options[0]!,
        }));
        return {
          requestId: request.requestId,
          actionId: cast.id,
          ...(targets.length > 0 ? { targets } : {}),
        };
      }
      const discard =
        options.discard === undefined
          ? undefined
          : request.legalActions.find((action) =>
              action.description.includes(`Discard ${options.discard}`),
            );
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const action = discard ?? pass ?? request.legalActions[0];
      if (action === undefined) throw new Error(`No legal action for ${request.decidingPlayer}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function seatConfigs(id: string, cards: Record<PlayerId, OracleCard[]>) {
  return (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => {
    const config = {
      id: seat,
      deckId: `white-black-discard-core-${id}-${seat}`,
      commanders: [],
      cards: cards[seat]!.length > 0 ? cards[seat]! : [swamp, plains],
    };
    return {
      seat,
      config,
      deckSnapshotId: null,
      summary: {
        seat,
        deckId: config.deckId,
        label: seat,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    };
  });
}

export function whiteBlackControlDiscardCoreScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined)
    throw new Error(`Unknown white-black-control discard-core scenario ${id}`);

  const name = entry.source.card.name;
  const p1Hand = [name];
  const p1Battlefield: string[] = [];
  const p2Hand: string[] = [];
  const p2Battlefield: string[] = [];
  const p3Hand: string[] = [];
  const p4Hand: string[] = [];
  const p1Library: string[] = [];
  const witnesses = new Map<string, OracleCard>();
  let p1Mana = 0;
  let p2Mana = 0;
  let p1BattlefieldCreatures: string[] = [];
  let continueThroughUpkeeps = false;
  let continueThroughCombat = false;
  let continueThroughNextPrecombatMain = false;
  let opponentProvider: DecisionProvider | undefined;
  const register = (label: string, kind: 'creature' | 'artifact' | 'sorcery' = 'creature') => {
    const card = witness(label, kind);
    witnesses.set(label, card);
    return label;
  };

  switch (name) {
    case 'Hymn to Tourach': {
      p1Mana = 2;
      p2Hand.push(register('Lab P2 Hymn Card One'), register('Lab P2 Hymn Card Two', 'artifact'));
      break;
    }
    case 'Bottomless Pit': {
      p1Mana = 3;
      p2Hand.push(register('Lab P2 Pit Card One'), register('Lab P2 Pit Card Two', 'artifact'));
      continueThroughUpkeeps = true;
      break;
    }
    case 'Necrogen Mists': {
      p1Mana = 3;
      const keep = register('Lab P2 Mists Card One');
      const discard = register('Lab P2 Mists Card Two', 'artifact');
      p2Hand.push(keep, discard);
      continueThroughUpkeeps = true;
      opponentProvider = scriptedP2({ discard });
      break;
    }
    case 'Hypnotic Specter': {
      p1Hand.length = 0;
      p1BattlefieldCreatures = [name];
      p2Hand.push(
        register('Lab P2 Specter Card One'),
        register('Lab P2 Specter Card Two', 'artifact'),
      );
      continueThroughCombat = true;
      break;
    }
    case 'Oppression': {
      p1Mana = 3;
      p2Mana = 2;
      const castCard = arcaneSignet.card.name;
      const discard = register('Lab P2 Oppression Discard Card', 'artifact');
      p2Hand.push(castCard, discard);
      continueThroughNextPrecombatMain = true;
      opponentProvider = scriptedP2({ cast: castCard, discard });
      break;
    }
    case 'Syphon Mind': {
      p1Mana = 4;
      p2Hand.push(register('Lab P2 Syphon Discard Card'));
      p3Hand.push(register('Lab P3 Syphon Discard Card', 'artifact'));
      p4Hand.push(register('Lab P4 Syphon Discard Card'));
      p1Library.push(
        register('Lab P1 Syphon Draw One', 'artifact'),
        register('Lab P1 Syphon Draw Two'),
        register('Lab P1 Syphon Draw Three', 'artifact'),
      );
      break;
    }
    case "Geth's Grimoire": {
      p1Mana = 4;
      p2Mana = 2;
      p2Hand.push(hymn.card.name);
      const first = register('Lab P3 Grimoire Discard One');
      const second = register('Lab P3 Grimoire Discard Two', 'artifact');
      p3Hand.push(first, second);
      p1Library.push(
        register('Lab P1 Grimoire Draw One', 'artifact'),
        register('Lab P1 Grimoire Draw Two'),
      );
      continueThroughNextPrecombatMain = true;
      opponentProvider = scriptedP2({ cast: hymn.card.name, target: 'P3' });
      break;
    }
    default:
      throw new Error(`No Card Test Lab setup for ${name}`);
  }

  const p1Lands = Array.from({ length: p1Mana }, () => swamp.name);
  const p2Lands = Array.from({ length: p2Mana }, () => swamp.name);
  p1Battlefield.push(...p1Lands, ...p1BattlefieldCreatures);
  p2Battlefield.push(...p2Lands);
  // These continuations cross normal draw steps. Keep a real library behind any known payoff
  // draws so a player does not lose to an empty library before the intended next-turn action.
  const libraryPadding = Array.from({ length: 12 }, () => swamp);
  const playerCards: Record<PlayerId, OracleCard[]> = {
    P1: [
      entry.source.card,
      ...Array.from({ length: p1Mana }, () => swamp),
      ...p1Library.map((cardName) => witnesses.get(cardName)!),
      ...libraryPadding,
    ],
    P2: [
      ...p2Hand.map((cardName) =>
        cardName === hymn.card.name
          ? hymn.card
          : cardName === arcaneSignet.card.name
            ? arcaneSignet.card
            : witnesses.get(cardName)!,
      ),
      ...Array.from({ length: p2Mana }, () => swamp),
      ...libraryPadding,
    ],
    P3: [...p3Hand.map((cardName) => witnesses.get(cardName)!), ...libraryPadding],
    P4: [...p4Hand.map((cardName) => witnesses.get(cardName)!), ...libraryPadding],
  };
  const seats = seatConfigs(id, playerCards);
  const configs = seats.map((seat) => seat.config);
  const hands = [
    ...(p1Hand.length > 0 ? [{ playerId: 'P1' as const, cardNames: p1Hand }] : []),
    ...(p2Hand.length > 0 ? [{ playerId: 'P2' as const, cardNames: p2Hand }] : []),
    ...(p3Hand.length > 0 ? [{ playerId: 'P3' as const, cardNames: p3Hand }] : []),
    ...(p4Hand.length > 0 ? [{ playerId: 'P4' as const, cardNames: p4Hand }] : []),
  ];
  const battlefield = [
    ...(p1Battlefield.length > 0 ? [{ playerId: 'P1' as const, cardNames: p1Battlefield }] : []),
    ...(p2Battlefield.length > 0 ? [{ playerId: 'P2' as const, cardNames: p2Battlefield }] : []),
  ];
  const libraryTop =
    p1Library.length > 0 ? [{ playerId: 'P1' as const, cardNames: p1Library }] : [];
  const seed = `card-lab-${id}-v1`;
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions:
        name === 'Hymn to Tourach'
          ? [
              'Cast Hymn to Tourach from your hand, target P2, and allow both random discards to resolve.',
            ]
          : name === 'Bottomless Pit'
            ? [
                'Cast Bottomless Pit normally. The prepared production continuation advances to P2’s next upkeep.',
              ]
            : name === 'Necrogen Mists'
              ? [
                  'Cast Necrogen Mists normally. Advance to P2’s upkeep and choose one card to discard.',
                ]
              : name === 'Hypnotic Specter'
                ? [
                    'Attack P2 with the prepared, previously controlled Hypnotic Specter. No creature can block it.',
                  ]
                : name === 'Oppression'
                  ? [
                      'Cast Oppression normally. P2 casts Arcane Signet during P2’s next main phase and discards.',
                    ]
                  : name === 'Syphon Mind'
                    ? [
                        'Cast Syphon Mind normally. P2, P3, and P4 each discard one card; then draw three cards.',
                      ]
                    : [
                        'Cast Geth’s Grimoire normally. P2 casts Hymn to Tourach targeting P3; accept both optional draw triggers.',
                      ],
      expectedOutcome:
        name === 'Hymn to Tourach'
          ? 'P2 discards two cards at random to Hymn to Tourach.'
          : name === 'Bottomless Pit'
            ? 'P2 discards a card at random to Bottomless Pit’s next-upkeep trigger.'
            : name === 'Necrogen Mists'
              ? 'At P2’s next upkeep, P2 chooses and discards one card to Necrogen Mists.'
              : name === 'Hypnotic Specter'
                ? 'Hypnotic Specter deals unblocked combat damage to P2; its trigger makes P2 discard a card at random.'
                : name === 'Oppression'
                  ? 'P2 casts a normal spell; Oppression triggers and P2 discards a card.'
                  : name === 'Syphon Mind'
                    ? 'P2, P3, and P4 each discard one card; P1 draws three cards for those discards.'
                    : 'After P2 casts Hymn to Tourach and P3 discards two cards, Geth’s Grimoire offers two independent optional draws to P1.',
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats,
    engine: new Engine(
      { gameId, seed, players: configs, turnCap: 4 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: hands,
          battlefield,
          ...(libraryTop.length > 0 ? { libraryTop } : {}),
          ...(continueThroughUpkeeps ? { continueThroughUpkeeps: 1 } : {}),
          ...(continueThroughCombat ? { continueThroughCombat: true } : {}),
          ...(continueThroughNextPrecombatMain ? { continueThroughNextPrecombatMain: true } : {}),
        },
      },
    ),
    ...(opponentProvider !== undefined
      ? { decisionProviderOverrides: { P2: opponentProvider } }
      : {}),
  };
}
