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

function fromPin(name: string): { sha256: string; card: OracleCard } {
  const found = pinned.cards.find((candidate) => candidate.card.name === name);
  if (found === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(found.card)).digest('hex') !== found.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return found;
}

const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;
const hymn = fromPin('Hymn to Tourach').card;
const duress = fromPin('Duress').card;

const cards = [
  {
    id: 'archfiend-of-ifnir-viewer-cycle-counter',
    source: fromPin('Archfiend of Ifnir'),
    title: 'Archfiend of Ifnir: your discard puts -1/-1 counters on opposing creatures',
    clauseIds: ['archfiend-of-ifnir-c02'],
  },
  {
    id: 'waste-not-viewer-opponent-discard-payoffs',
    source: fromPin('Waste Not'),
    title: 'Waste Not: an opponent discards a creature and a land',
    clauseIds: ['waste-not-c01', 'waste-not-c02'],
  },
  {
    id: 'whispers-of-emrakul-viewer-delirium-random-discard',
    source: fromPin('Whispers of Emrakul'),
    title: 'Whispers of Emrakul: delirium makes the opponent discard two at random',
    clauseIds: ['whispers-of-emrakul-c01', 'whispers-of-emrakul-c02'],
  },
  {
    id: 'painful-quandary-viewer-opponent-cast-choice',
    source: fromPin('Painful Quandary'),
    title: 'Painful Quandary: an opponent cast triggers a discard-or-life choice',
    clauseIds: ['painful-quandary-c01'],
  },
  {
    id: 'vicious-rumors-viewer-cast-results',
    source: fromPin('Vicious Rumors'),
    title: 'Vicious Rumors: opponents lose life and discard before milling',
    clauseIds: ['vicious-rumors-c01'],
  },
  {
    id: 'rankle-master-of-pranks-viewer-combat-modes',
    source: fromPin('Rankle, Master of Pranks'),
    title: 'Rankle: combat damage lets you choose discard and draw modes',
    clauseIds: [
      'rankle-master-of-pranks-c02',
      'rankle-master-of-pranks-c03',
      'rankle-master-of-pranks-c04',
    ],
  },
  {
    id: 'tinybones-joins-up-viewer-multi-player-etb-discard',
    source: fromPin('Tinybones Joins Up'),
    title: 'Tinybones Joins Up: choose multiple players to discard',
    clauseIds: ['tinybones-joins-up-c01'],
  },
  {
    id: 'tinybones-trinket-thief-viewer-opponent-discard-end-step',
    source: fromPin('Tinybones, Trinket Thief'),
    title: 'Tinybones, Trinket Thief: an opponent discard draws a card at end step',
    clauseIds: ['tinybones-trinket-thief-c01'],
  },
  {
    id: 'archfiend-of-ifnir-viewer-normal-cycling',
    source: fromPin('Archfiend of Ifnir'),
    title: 'Archfiend of Ifnir: cast one copy and cycle another for two mana',
    clauseIds: ['archfiend-of-ifnir-c02', 'archfiend-of-ifnir-c03'],
  },
  {
    id: 'waste-not-viewer-noncreature-nonland-draw',
    source: fromPin('Waste Not'),
    title: 'Waste Not: Duress discards Sol Ring and draws one card',
    clauseIds: ['waste-not-c03'],
  },
  {
    id: 'tinybones-joins-up-viewer-legendary-entry-mill-life',
    source: fromPin('Tinybones Joins Up'),
    title: 'Tinybones Joins Up: a legendary creature mills P2 and costs one life',
    clauseIds: ['tinybones-joins-up-c02'],
  },
  {
    id: 'hushbringer-viewer-suppresses-creature-death-trigger',
    source: fromPin('Hushbringer'),
    title: 'Hushbringer: a real death trigger works before it enters and is suppressed afterward',
    clauseIds: ['hushbringer-c02'],
  },
  {
    id: 'rankle-master-of-pranks-viewer-all-three-modes',
    source: fromPin('Rankle, Master of Pranks'),
    title: 'Rankle: all four players discard, lose life, draw and sacrifice',
    clauseIds: [
      'rankle-master-of-pranks-c01',
      'rankle-master-of-pranks-c02',
      'rankle-master-of-pranks-c03',
      'rankle-master-of-pranks-c04',
      'rankle-master-of-pranks-c05',
    ],
  },
] as const;

export const WHITE_BLACK_DISCARD_EXTENSION_SCENARIO_IDS = cards.map((entry) => entry.id);

function witness(
  name: string,
  options: {
    typeLine: string;
    types: string[];
    cost?: string | null;
    cmc?: number;
    power?: string | null;
    toughness?: string | null;
    oracleText?: string;
    basic?: boolean;
  },
): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const typeLine = options.typeLine;
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
    name,
    manaCost: options.cost === undefined ? '{0}' : options.cost,
    cmc: options.cmc ?? 0,
    colors: [],
    colorIdentity: [],
    typeLine,
    supertypes: typeLine.startsWith('Basic') ? ['Basic'] : [],
    types: options.types,
    subtypes: [],
    oracleText: options.oracleText ?? '',
    power:
      options.power === undefined
        ? options.types.includes('Creature')
          ? '3'
          : null
        : options.power,
    toughness:
      options.toughness === undefined
        ? options.types.includes('Creature')
          ? '3'
          : null
        : options.toughness,
    keywords: [],
    isBasicLand: options.basic ?? typeLine.startsWith('Basic Land'),
  };
}

function castProvider(spellName: string, targetPlayer?: string): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      const allowedWindow =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const action =
        allowedWindow && !cast
          ? request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.startsWith(`Cast ${spellName}`),
            )
          : undefined;
      if (action !== undefined) {
        cast = true;
        const response: {
          requestId: string;
          actionId: number;
          targets?: { slot: number; choice: string }[];
        } = {
          requestId: request.requestId,
          actionId: action.id,
        };
        const targets = (action.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice:
            targetPlayer !== undefined && slot.options.includes(targetPlayer)
              ? targetPlayer
              : (slot.options[0] as string),
        }));
        if (targets.length > 0) response.targets = targets;
        return response;
      }

      const first = request.legalActions[0];
      if (first === undefined) throw new Error(`No legal decision for ${request.decidingPlayer}`);
      const response: {
        requestId: string;
        actionId: number;
        targets?: { slot: number; choice: string }[];
      } = {
        requestId: request.requestId,
        actionId: first.id,
      };
      const targets = (first.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice: slot.options[0] as string,
      }));
      if (targets.length > 0) response.targets = targets;
      return response;
    },
  };
}

function seats(gameId: GameId, id: string, decks: Record<string, OracleCard[]>) {
  return (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => {
    const config = {
      id: seat,
      deckId: `white-black-discard-extension-${id}-${seat}`,
      commanders: [],
      cards: decks[seat] ?? [swamp, swamp, swamp],
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

export function whiteBlackControlDiscardExtensionScenario(
  id: string,
  gameId: GameId,
): CardTestScenario {
  const entry = cards.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  const name = entry.source.card.name;
  const p1Hand: string[] = [name];
  const p1Battlefield: string[] = [];
  const p1Library: string[] = [];
  const p2Hand: string[] = [];
  const p2Battlefield: string[] = [];
  const p2Library: string[] = [];
  const p3Hand: string[] = [];
  const p3Battlefield: string[] = [];
  const p3Library: string[] = [];
  const p4Hand: string[] = [];
  const p4Battlefield: string[] = [];
  const p4Library: string[] = [];
  let manaCount = 2;
  let whiteManaCount = 0;
  let continuation: Record<string, true> = {};
  let opponentSpell: string | undefined;
  let targetP1 = false;
  const graveyardNames: string[] = [];
  const cardsByName: Record<string, OracleCard> = { [name]: entry.source.card };
  let extraInstructions: string[] | undefined;
  let extraExpected: string | undefined;
  const register = (card: OracleCard) => {
    cardsByName[card.name] = card;
    return card.name;
  };
  const creature = (label: string) =>
    register(witness(label, { typeLine: 'Creature — Bear', types: ['Creature'] }));
  const artifact = (label: string) =>
    register(witness(label, { typeLine: 'Artifact', types: ['Artifact'] }));
  const land = (label: string) =>
    register(
      witness(label, { typeLine: 'Basic Land — Forest', types: ['Land'], cost: null, basic: true }),
    );

  switch (name) {
    case 'Hushbringer': {
      manaCount = 6;
      whiteManaCount = 3;
      const removal = register(
        witness('Lab Hushbringer Destroy Spell', {
          typeLine: 'Instant',
          types: ['Instant'],
          cost: '{B}',
          cmc: 1,
          oracleText: 'Destroy target creature.',
        }),
      );
      p1Hand.push(removal, removal);
      for (const label of [
        'Lab Before Hushbringer Death Witness',
        'Lab After Hushbringer Death Witness',
      ])
        p2Battlefield.push(
          register(
            witness(label, {
              typeLine: 'Creature — Bear',
              types: ['Creature'],
              oracleText: `When ${label} dies, you gain 1 life.`,
            }),
          ),
        );
      extraInstructions = [
        'Cast the destroy spell at the first creature and observe its real death trigger gain P2 one life. Cast Hushbringer normally, then destroy the second creature with the other destroy spell.',
      ];
      extraExpected =
        'Both creatures die to normally cast removal. P2 gains one life before Hushbringer enters, and gains no life after Hushbringer suppresses the second death trigger.';
      break;
    }
    case 'Archfiend of Ifnir': {
      manaCount = 7;
      if (id === 'archfiend-of-ifnir-viewer-normal-cycling') {
        p1Hand.push(name);
        p1Library.push(register(plains));
        p1Battlefield.push(creature('Lab Own Cycling Counter Witness'));
        p2Battlefield.push(creature('Lab P2 Cycling Counter Witness'));
        p3Battlefield.push(creature('Lab P3 Cycling Counter Witness'));
        p4Battlefield.push(creature('Lab P4 Cycling Counter Witness'));
        extraInstructions = [
          'Cast one Archfiend from hand for {3}{B}{B}. Cycle the other copy for {2}.',
        ];
        extraExpected =
          'Cycling pays two mana, discards the copy and draws Plains. The battlefield Archfiend triggers once: each opposing creature gets one -1/-1 counter; your creature gets none.';
        break;
      }
      const discarded = artifact('Lab P1 Duress Choice');
      const p2Threat = creature('Lab P2 Counter Witness');
      const p3Threat = creature('Lab P3 Counter Witness');
      const p4Threat = creature('Lab P4 Counter Witness');
      p1Hand.push(discarded);
      p2Hand.push(duress.name);
      p2Battlefield.push(swamp.name, p2Threat);
      p3Battlefield.push(p3Threat);
      p4Battlefield.push(p4Threat);
      cardsByName[duress.name] = duress;
      continuation = { continueThroughNextPrecombatMain: true };
      opponentSpell = duress.name;
      targetP1 = true;
      break;
    }
    case 'Waste Not': {
      manaCount = 4;
      if (id === 'waste-not-viewer-noncreature-nonland-draw') {
        p1Hand.push(register(duress));
        p2Hand.push(register(fromPin('Sol Ring').card));
        p1Library.push(register(plains));
        extraInstructions = [
          'Cast Waste Not normally, then cast Duress targeting P2. P2 has one eligible card: Sol Ring.',
        ];
        extraExpected =
          'Duress discards Sol Ring. The noncreature, nonland discard triggers Waste Not and P1 draws exactly one Plains, without creating a Zombie or adding black mana.';
        break;
      }
      const p2Creature = creature('Lab P2 Creature Discard');
      const p2Land = land('Lab P2 Land Discard');
      p1Hand.push(hymn.name);
      p2Hand.push(p2Creature, p2Land);
      cardsByName[hymn.name] = hymn;
      break;
    }
    case 'Whispers of Emrakul': {
      const first = creature('Lab Graveyard Creature Type');
      const second = artifact('Lab Graveyard Artifact Type');
      const third = hymn.name;
      cardsByName[hymn.name] = hymn;
      const fourth = register(
        witness('Lab Graveyard Enchantment Type', {
          typeLine: 'Enchantment',
          types: ['Enchantment'],
        }),
      );
      graveyardNames.push(first, second, third, fourth);
      const one = creature('Lab P2 Random Discard One');
      const two = artifact('Lab P2 Random Discard Two');
      p2Hand.push(one, two);
      break;
    }
    case 'Painful Quandary': {
      manaCount = 5;
      const p2TestSpell = register(
        witness('Lab P2 Quandary Test Creature', {
          typeLine: 'Artifact Creature — Golem',
          types: ['Artifact', 'Creature'],
          cost: '{0}',
          cmc: 0,
          power: '1',
          toughness: '1',
        }),
      );
      p2Hand.push(p2TestSpell);
      opponentSpell = p2TestSpell;
      continuation = { continueThroughNextPrecombatMain: true };
      break;
    }
    case 'Vicious Rumors': {
      manaCount = 1;
      const p2Card = creature('Lab P2 Rumors Discard');
      const p3Card = artifact('Lab P3 Rumors Discard');
      const p4Card = creature('Lab P4 Rumors Discard');
      p2Hand.push(p2Card);
      p3Hand.push(p3Card);
      p4Hand.push(p4Card);
      p2Library.push(land('Lab P2 Rumors Mill'));
      p3Library.push(artifact('Lab P3 Rumors Mill'));
      p4Library.push(creature('Lab P4 Rumors Mill'));
      break;
    }
    case 'Rankle, Master of Pranks': {
      manaCount = 4;
      if (id === 'rankle-master-of-pranks-viewer-all-three-modes') {
        p1Battlefield.push(creature('Lab P1 Rankle Sacrifice'));
        p2Battlefield.push(creature('Lab P2 Rankle Sacrifice'));
        p3Battlefield.push(creature('Lab P3 Rankle Sacrifice'));
        p4Battlefield.push(creature('Lab P4 Rankle Sacrifice'));
        extraInstructions = [
          'Cast Rankle normally, then attack P2 that turn despite its nonflying creature. Choose all three modes. Sacrifice your witness creature rather than Rankle.',
        ];
        extraExpected =
          'Rankle attacks the turn it enters using haste and deals combat damage past the nonflying defender. All four players discard once, lose one life, draw once and sacrifice a creature. Rankle remains on the battlefield.';
      }
      p1Hand.push(creature('Lab P1 Rankle Discard'));
      p2Hand.push(creature('Lab P2 Rankle Discard'));
      p3Hand.push(artifact('Lab P3 Rankle Discard'));
      p4Hand.push(creature('Lab P4 Rankle Discard'));
      p1Library.push(artifact('Lab P1 Rankle Draw'));
      p2Library.push(creature('Lab P2 Rankle Draw'));
      p3Library.push(land('Lab P3 Rankle Draw'));
      p4Library.push(land('Lab P4 Rankle Draw'));
      continuation = { continueThroughCombat: true };
      break;
    }
    case 'Tinybones Joins Up': {
      if (id === 'tinybones-joins-up-viewer-legendary-entry-mill-life') {
        manaCount = 3;
        p1Hand.push(register(fromPin('Tinybones, Trinket Thief').card));
        p1Hand.push(creature('Lab Nonlegendary Entry Witness'));
        p2Library.push(register(swamp));
        extraInstructions = [
          'Cast Tinybones Joins Up and select no players for its enters trigger. Cast the nonlegendary witness, then cast Tinybones, Trinket Thief. Target P2 with the legendary-entry trigger.',
        ];
        extraExpected =
          'The nonlegendary creature creates no mill/life trigger. The legendary Tinybones triggers once; P2 mills Swamp and loses one life, while P3 and P4 are unaffected.';
        break;
      }
      p2Hand.push(creature('Lab P2 Tinybones Discard'));
      p3Hand.push(artifact('Lab P3 Tinybones Discard'));
      break;
    }
    case 'Tinybones, Trinket Thief': {
      manaCount = 3;
      const spell = register(duress);
      p1Hand.push(spell);
      p2Hand.push(artifact('Lab P2 Tinybones Discard'));
      p1Library.push(creature('Lab Tinybones End Step Draw'));
      cardsByName[spell] = duress;
      continuation = { continueToEndStep: true };
      break;
    }
    default:
      throw new Error(`No Card Test Lab setup for ${name}`);
  }

  const mana = [
    ...Array.from({ length: whiteManaCount }, () => plains),
    ...Array.from({ length: manaCount - whiteManaCount }, () => swamp),
  ];
  p1Battlefield.push(...mana.map((card) => card.name));
  const deckLists: Record<string, OracleCard[]> = {
    P1: [
      entry.source.card,
      ...(name === 'Hushbringer' ? [cardsByName['Lab Hushbringer Destroy Spell']!] : []),
      ...(id === 'archfiend-of-ifnir-viewer-normal-cycling' ? [entry.source.card] : []),
      ...mana,
      ...Object.values(cardsByName).filter((card) => card.name !== name),
      ...Array.from({ length: 12 }, () => swamp),
    ],
    P2: [
      ...p2Hand.map(
        (cardName) =>
          cardsByName[cardName] ??
          witness(cardName, { typeLine: 'Creature — Bear', types: ['Creature'] }),
      ),
      ...p2Battlefield.map((cardName) => cardsByName[cardName] ?? swamp),
      ...p2Library.map((cardName) => cardsByName[cardName]!),
      ...Array.from({ length: 8 }, () => swamp),
    ],
    P3: [
      ...p3Hand.map((cardName) => cardsByName[cardName]!),
      ...p3Library.map((cardName) => cardsByName[cardName]!),
      ...p3Battlefield.map((cardName) => cardsByName[cardName]!),
      ...Array.from({ length: 8 }, () => swamp),
    ],
    P4: [
      ...p4Hand.map((cardName) => cardsByName[cardName]!),
      ...p4Library.map((cardName) => cardsByName[cardName]!),
      ...p4Battlefield.map((cardName) => cardsByName[cardName]!),
      ...Array.from({ length: 8 }, () => swamp),
    ],
  };
  const seatSetups = seats(gameId, id, deckLists);
  const configs = seatSetups.map((seat) => seat.config);
  const allP1Hand = p1Hand;
  const hands = [
    { playerId: 'P1', cardNames: allP1Hand },
    ...(p2Hand.length > 0 ? [{ playerId: 'P2', cardNames: p2Hand }] : []),
    ...(p3Hand.length > 0 ? [{ playerId: 'P3', cardNames: p3Hand }] : []),
    ...(p4Hand.length > 0 ? [{ playerId: 'P4', cardNames: p4Hand }] : []),
  ];
  const battlefield = [
    { playerId: 'P1', cardNames: p1Battlefield },
    ...(p2Battlefield.length > 0 ? [{ playerId: 'P2', cardNames: p2Battlefield }] : []),
    ...(p3Battlefield.length > 0 ? [{ playerId: 'P3', cardNames: p3Battlefield }] : []),
    ...(p4Battlefield.length > 0 ? [{ playerId: 'P4', cardNames: p4Battlefield }] : []),
  ];
  const graveyard =
    graveyardNames.length > 0 ? [{ playerId: 'P1', cardNames: graveyardNames }] : [];
  const libraryTop = [
    ...(p1Library.length > 0 ? [{ playerId: 'P1', cardNames: p1Library }] : []),
    ...(p2Library.length > 0 ? [{ playerId: 'P2', cardNames: p2Library }] : []),
    ...(p3Library.length > 0 ? [{ playerId: 'P3', cardNames: p3Library }] : []),
    ...(p4Library.length > 0 ? [{ playerId: 'P4', cardNames: p4Library }] : []),
  ];
  const seed = `card-lab-${id}-v1`;

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: extraInstructions ?? [
        `Cast ${name} from your hand and let it resolve.`,
        ...(name === 'Archfiend of Ifnir'
          ? ['Pass to P2; let P2 cast Duress targeting you, then discard Lab P1 Duress Choice.']
          : name === 'Waste Not'
            ? ['Cast Hymn to Tourach targeting P2; both cards in P2’s hand are discarded.']
            : name === 'Whispers of Emrakul'
              ? ['Cast Whispers targeting P2; P1 begins with four card types in the graveyard.']
              : name === 'Painful Quandary'
                ? [
                    'Pass to P2; P2 casts the zero-cost creature and discards a card to avoid losing five life.',
                  ]
                : name === 'Vicious Rumors'
                  ? [
                      'Resolve Vicious Rumors; each opponent has one card in hand and one known library card.',
                    ]
                  : name === 'Rankle, Master of Pranks'
                    ? ['Attack P2 with Rankle. Choose the discard and lose-life/draw modes.']
                    : name === 'Tinybones Joins Up'
                      ? ['Choose P2 and P3 as targets for the enters trigger.']
                      : ['Cast Duress targeting P2, then pass through to your end step.']),
      ],
      expectedOutcome:
        extraExpected ??
        (name === 'Archfiend of Ifnir'
          ? 'P2 casts Duress and discards P1’s sole eligible artifact card. Archfiend triggers once, and each opponent-controlled creature receives one -1/-1 counter.'
          : name === 'Waste Not'
            ? 'P2 discards exactly one creature card and one land card to Hymn to Tourach. Waste Not creates a black 2/2 Zombie and adds {B}{B}.'
            : name === 'Whispers of Emrakul'
              ? 'P1 begins with four card types in the graveyard. Whispers of Emrakul resolves targeting P2, who discards both cards in hand at random.'
              : name === 'Painful Quandary'
                ? 'P2 casts the zero-cost artifact creature and discards a card to avoid losing five life to Painful Quandary.'
                : name === 'Vicious Rumors'
                  ? 'Each opponent loses one life, discards one card, then mills one card. P1 gains one life.'
                  : name === 'Rankle, Master of Pranks'
                    ? 'Rankle deals combat damage to P2. P1 chooses the discard and lose-one-life/draw modes; each player discards, loses one life, and draws.'
                    : name === 'Tinybones Joins Up'
                      ? 'P1 selects P2 and P3 as targets of Tinybones Joins Up’s enters trigger. Both players discard one card.'
                      : 'P2 discards to Duress during P1’s turn. At P1’s end step, Tinybones draws one card and its controller loses one life.'),
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats: seatSetups,
    engine: new Engine(
      { gameId, seed, players: configs, turnCap: 3 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: hands,
          battlefield,
          ...(graveyard.length > 0 ? { graveyard } : {}),
          ...(libraryTop.length > 0 ? { libraryTop } : {}),
          ...(Object.keys(continuation).length > 0 ? continuation : {}),
        },
      },
    ),
    ...(opponentSpell === undefined
      ? {}
      : {
          decisionProviderOverrides: {
            P2: castProvider(opponentSpell, targetP1 ? 'P1' : undefined),
          },
        }),
  };
}
