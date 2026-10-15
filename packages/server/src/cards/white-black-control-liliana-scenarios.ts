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

const veil = fromPin('Liliana of the Veil');
const waker = fromPin('Liliana, Waker of the Dead');
const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;

const entries = [
  {
    id: 'liliana-of-the-veil-viewer-each-player-discards',
    source: veil,
    title: 'Liliana of the Veil: normally cast, then +1 makes each player discard',
    clauseIds: ['liliana-of-the-veil-c01'],
    mode: 'veil-discard' as const,
  },
  {
    id: 'liliana-of-the-veil-viewer-targeted-sacrifice',
    source: veil,
    title:
      'Liliana of the Veil: normally cast, then −2 makes the targeted player sacrifice a creature',
    clauseIds: ['liliana-of-the-veil-c02'],
    mode: 'veil-sacrifice' as const,
  },
  {
    id: 'liliana-of-the-veil-viewer-ultimate-piles',
    source: veil,
    title: 'Liliana of the Veil: activate −6 and let P2 choose a pile to sacrifice',
    clauseIds: ['liliana-of-the-veil-c03'],
    mode: 'veil-ultimate' as const,
  },
  {
    id: 'liliana-waker-of-the-dead-viewer-discard-life-loss',
    source: waker,
    title: 'Liliana, Waker of the Dead: +1 discards and opponents unable to discard lose life',
    clauseIds: ['liliana-waker-of-the-dead-c01'],
    mode: 'waker-discard' as const,
  },
  {
    id: 'liliana-waker-of-the-dead-viewer-graveyard-scaled-removal',
    source: waker,
    title: 'Liliana, Waker of the Dead: −3 gives a creature −X/−X for your graveyard size',
    clauseIds: ['liliana-waker-of-the-dead-c02'],
    mode: 'waker-minus-three' as const,
  },
  {
    id: 'liliana-waker-of-the-dead-viewer-ultimate-emblem-reanimation',
    source: waker,
    title: 'Liliana, Waker of the Dead: −7 emblem returns a creature at combat with haste',
    clauseIds: ['liliana-waker-of-the-dead-c03'],
    mode: 'waker-ultimate' as const,
  },
] as const;

export const WHITE_BLACK_CONTROL_LILIANA_SCENARIO_IDS = entries.map((entry) => entry.id);

function witness(
  name: string,
  options: {
    typeLine: string;
    types: string[];
    power?: string | null;
    toughness?: string | null;
  },
): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const creature = options.types.includes('Creature');
  return {
    ...plains,
    oracleId: `lab-white-black-liliana-${slug}`,
    scryfallId: `lab-white-black-liliana-${slug}`,
    name,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    typeLine: options.typeLine,
    supertypes: [],
    types: options.types,
    subtypes: creature ? ['Bear'] : [],
    oracleText: '',
    power: options.power === undefined ? (creature ? '2' : null) : options.power,
    toughness: options.toughness === undefined ? (creature ? '2' : null) : options.toughness,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
  };
}

function creature(name: string, power = '2', toughness = '2'): OracleCard {
  return witness(name, { typeLine: 'Creature — Bear', types: ['Creature'], power, toughness });
}

function scriptedChoiceProvider(options: {
  discard?: string;
  sacrifice?: string;
  piles?: { pileOne: string[]; sacrifice: 1 | 2 };
}): DecisionProvider {
  return {
    decide(request) {
      if (request.prompt.startsWith('Put ') && options.piles !== undefined) {
        const putInOne = options.piles.pileOne.some((name) => request.prompt.includes(name));
        const pileAction = request.legalActions.find(
          (action) => action.description === (putInOne ? 'Put it in pile 1' : 'Put it in pile 2'),
        );
        if (pileAction !== undefined)
          return { requestId: request.requestId, actionId: pileAction.id };
      }
      if (
        request.prompt === 'Choose a pile of permanents to sacrifice.' &&
        options.piles !== undefined
      ) {
        const pileAction = request.legalActions.find((action) =>
          action.description.startsWith(`Sacrifice pile ${options.piles!.sacrifice}:`),
        );
        if (pileAction !== undefined)
          return { requestId: request.requestId, actionId: pileAction.id };
      }
      const preferred = [options.discard, options.sacrifice].find((name) => name !== undefined);
      const choice =
        preferred === undefined
          ? undefined
          : request.legalActions.find((action) => action.description.includes(preferred));
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const action = choice ?? pass ?? request.legalActions[0];
      if (action === undefined) throw new Error(`No legal action for ${request.decidingPlayer}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function playerCards(
  seat: PlayerId,
  source: OracleCard,
  lands: number,
  extras: OracleCard[],
): OracleCard[] {
  const padding = Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? plains : swamp));
  return seat === 'P1'
    ? [source, ...Array.from({ length: lands }, () => swamp), ...extras, ...padding]
    : [...extras, ...padding];
}

export function whiteBlackControlLilianaScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control Liliana scenario ${id}`);
  const isVeil = entry.mode.startsWith('veil-');
  const isWakerDiscard = entry.mode === 'waker-discard';
  const isWakerMinusThree = entry.mode === 'waker-minus-three';
  const isVeilUltimate = entry.mode === 'veil-ultimate';
  const isWakerUltimate = entry.mode === 'waker-ultimate';
  const ownDiscard = creature('Lab P1 Liliana Discard Card');
  const p2Discard = creature('Lab P2 Liliana Discard Card');
  const p3Discard = creature('Lab P3 Liliana Discard Card');
  const p4Discard = creature('Lab P4 Liliana Discard Card');
  const p2Creature = creature('Lab P2 Liliana Sacrifice Creature');
  const p2PileCreatureOne = creature('Lab P2 Liliana Pile Creature One');
  const p2PileCreatureTwo = creature('Lab P2 Liliana Pile Creature Two');
  const p2PileArtifact = witness('Lab P2 Liliana Pile Artifact', {
    typeLine: 'Artifact',
    types: ['Artifact'],
  });
  const p2WakerTarget = creature('Lab P2 Waker Target');
  const p2WakerOther = creature('Lab P2 Waker Untouched Creature', '4', '4');
  const p2ReanimationTarget = creature('Lab P2 Waker Reanimation Target', '3', '3');
  const graveyardA = creature('Lab P1 Liliana Graveyard Card One');
  const graveyardB = creature('Lab P1 Liliana Graveyard Card Two');

  const p1Discard = entry.mode === 'veil-discard' || isWakerDiscard ? [ownDiscard] : [];
  const p1DeckExtras = [...p1Discard, ...(isWakerMinusThree ? [graveyardA, graveyardB] : [])];
  const p2Hand = entry.mode === 'veil-discard' ? [p2Discard] : [];
  const p3Hand = entry.mode === 'veil-discard' || isWakerDiscard ? [p3Discard] : [];
  const p4Hand = entry.mode === 'veil-discard' ? [p4Discard] : [];
  const opponentCreatures =
    entry.mode === 'veil-sacrifice'
      ? [p2Creature]
      : isVeilUltimate
        ? [p2PileCreatureOne, p2PileCreatureTwo, p2PileArtifact]
        : isWakerMinusThree
          ? [p2WakerTarget, p2WakerOther]
          : [];
  const source = entry.source.card;
  const lands = (isVeil ? 3 : 4) * (isVeilUltimate || isWakerUltimate ? 0 : 1);
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-liliana-${entry.mode}-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? playerCards(seat, source, lands, p1DeckExtras)
        : seat === 'P2'
          ? playerCards(seat, source, 0, [
              ...p2Hand,
              ...opponentCreatures,
              ...(isWakerUltimate ? [p2ReanimationTarget] : []),
            ])
          : seat === 'P3'
            ? playerCards(seat, source, 0, p3Hand)
            : playerCards(seat, source, 0, p4Hand),
  }));
  const hand = [
    ...(isVeilUltimate || isWakerUltimate
      ? []
      : [{ playerId: 'P1', cardNames: [source.name, ...p1Discard.map((card) => card.name)] }]),
    ...(p2Hand.length > 0 ? [{ playerId: 'P2', cardNames: p2Hand.map((card) => card.name) }] : []),
    ...(p3Hand.length > 0 ? [{ playerId: 'P3', cardNames: p3Hand.map((card) => card.name) }] : []),
    ...(p4Hand.length > 0 ? [{ playerId: 'P4', cardNames: p4Hand.map((card) => card.name) }] : []),
  ];
  const battlefield = [
    ...(lands > 0
      ? [{ playerId: 'P1', cardNames: Array.from({ length: lands }, () => swamp.name) }]
      : []),
    ...(isVeilUltimate || isWakerUltimate
      ? [
          {
            playerId: 'P1',
            cardNames: [source.name],
            counters: { loyalty: isVeilUltimate ? 6 : 7 },
          },
        ]
      : []),
    ...(opponentCreatures.length > 0
      ? [{ playerId: 'P2', cardNames: opponentCreatures.map((card) => card.name) }]
      : []),
  ];
  const graveyard = isWakerMinusThree
    ? [{ playerId: 'P1', cardNames: [graveyardA.name, graveyardB.name] }]
    : isWakerUltimate
      ? [{ playerId: 'P2', cardNames: [p2ReanimationTarget.name] }]
      : [];
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: configs, turnCap: 5 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 2,
        hand,
        battlefield,
        ...(graveyard.length > 0 ? { graveyard } : {}),
        ...(isWakerDiscard
          ? {
              lifeTotals: [
                { playerId: 'P1', life: 40 },
                { playerId: 'P2', life: 40 },
                { playerId: 'P3', life: 40 },
                { playerId: 'P4', life: 40 },
              ],
            }
          : {}),
        ...(isWakerUltimate ? { continueThroughCombat: true } : {}),
      },
    },
  );
  const choices: Record<PlayerId, DecisionProvider> = {
    P1: scriptedChoiceProvider({
      ...(isVeilUltimate
        ? { piles: { pileOne: [p2PileCreatureOne.name], sacrifice: 2 as const } }
        : {}),
    }),
    P2: scriptedChoiceProvider({
      ...(entry.mode === 'veil-discard' ? { discard: p2Discard.name } : {}),
      ...(entry.mode === 'veil-sacrifice' ? { sacrifice: p2Creature.name } : {}),
      ...(isVeilUltimate
        ? { piles: { pileOne: [p2PileCreatureOne.name], sacrifice: 2 as const } }
        : {}),
    }),
    P3: scriptedChoiceProvider({ ...(p3Hand.length > 0 ? { discard: p3Discard.name } : {}) }),
    P4: scriptedChoiceProvider({ ...(p4Hand.length > 0 ? { discard: p4Discard.name } : {}) }),
  };

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions:
        entry.mode === 'veil-discard'
          ? [
              'Cast Liliana of the Veil normally from your hand for {1}{B}{B}.',
              'Activate its +1 loyalty ability. Choose a card to discard when each player receives the discard decision.',
            ]
          : entry.mode === 'veil-sacrifice'
            ? [
                'Cast Liliana of the Veil normally from your hand for {1}{B}{B}.',
                'Activate its −2 loyalty ability, target P2, and let P2 choose which creature to sacrifice.',
              ]
            : entry.mode === 'waker-discard'
              ? [
                  'Cast Liliana, Waker of the Dead normally from your hand for {2}{B}{B}.',
                  'Activate its +1 loyalty ability. Discard a card for P1; P3 also has a card to discard, while P2 and P4 have empty hands and lose 3 life.',
                ]
              : isWakerMinusThree
                ? [
                    'Cast Liliana, Waker of the Dead normally from your hand for {2}{B}{B}.',
                    'Activate its −3 loyalty ability and target Lab P2 Waker Target. Your graveyard contains two cards, so the creature receives −2/−2 and dies.',
                  ]
                : isVeilUltimate
                  ? [
                      'Liliana of the Veil is prepared on the battlefield with six loyalty, as if it had been cast on an earlier turn.',
                      'Activate its −6 loyalty ability, target P2, put Lab P2 Liliana Pile Creature One in pile 1 and the other creature plus artifact in pile 2, then let P2 choose pile 2.',
                    ]
                  : [
                      'Liliana, Waker of the Dead is prepared on the battlefield with seven loyalty, as if it had been cast on an earlier turn.',
                      'Activate its −7 loyalty ability. After the emblem is created and the source leaves the battlefield, pass to the beginning of combat and return Lab P2 Waker Reanimation Target from P2’s graveyard with haste.',
                    ],
      expectedOutcome:
        entry.mode === 'veil-discard'
          ? 'Liliana of the Veil resolves and its normal +1 activation makes P1, P2, P3, and P4 each choose and discard one card.'
          : entry.mode === 'veil-sacrifice'
            ? 'Liliana of the Veil resolves and its normal −2 activation targets P2; P2 chooses and sacrifices Lab P2 Liliana Sacrifice Creature.'
            : entry.mode === 'waker-discard'
              ? 'Liliana, Waker of the Dead resolves and its normal +1 activation makes P1 and P3 discard; P2 and P4, who cannot discard, each lose 3 life.'
              : isWakerMinusThree
                ? 'Liliana, Waker of the Dead resolves and its normal −3 activation uses the two cards in P1’s graveyard to give the targeted 2/2 creature −2/−2 until end of turn, causing it to die.'
                : isVeilUltimate
                  ? 'P1 divides P2’s three permanents into two piles, then P2 chooses a pile to sacrifice; Liliana has paid −6 loyalty and leaves the battlefield before the ability resolves.'
                  : 'Liliana’s −7 activation creates an emblem. At P1’s beginning of combat, the emblem returns a creature from P2’s graveyard under P1’s control with haste, after Liliana has left the battlefield.',
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
    decisionProviderOverrides: {
      P2: choices['P2'],
      P3: choices['P3'],
      P4: choices['P4'],
    },
  };
}
