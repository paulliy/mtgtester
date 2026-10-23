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
const swamp = fromPin('Swamp').card;

const entries = [
  {
    id: 'aven-interrupter-viewer-plots-opponent-spell',
    source: fromPin('Aven Interrupter'),
    title: 'Aven Interrupter: flash in to exile the opposing spell',
    clauseIds: ['aven-interrupter-c01', 'aven-interrupter-c03'],
  },
  {
    id: 'aven-interrupter-viewer-later-plot-cast-pays-tax',
    source: fromPin('Aven Interrupter'),
    title: 'Aven Interrupter: cast the plotted spell later and pay the exile tax',
    clauseIds: ['aven-interrupter-c03', 'aven-interrupter-c04'],
  },
  {
    id: 'tergrid-lantern-viewer-target-loses-life',
    source: fromPin("Tergrid, God of Fright // Tergrid's Lantern"),
    title: "Tergrid's Lantern: activate against a player with no discard or sacrifice choice",
    clauseIds: ['tergrid-god-of-fright-tergrid-s-lantern-c03'],
  },
  {
    id: 'bilbo-s-gambit-viewer-gift-returns-spell',
    source: fromPin("Bilbo's Gambit"),
    title: "Bilbo's Gambit: gift a Treasure and return a spell to its owner's hand",
    clauseIds: ['bilbo-s-gambit-c01', 'bilbo-s-gambit-c02'],
  },
  {
    id: 'dawn-s-truce-viewer-gift-protects-permanents',
    source: fromPin("Dawn's Truce"),
    title: "Dawn's Truce: gift a card for hexproof and indestructible",
    clauseIds: ['dawn-s-truce-c01', 'dawn-s-truce-c02'],
  },
] as const;

export const WHITE_BLACK_FINAL_SCENARIO_IDS = entries.map((entry) => entry.id);

function witness(name: string, kind: 'creature' | 'instant'): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const creature = kind === 'creature';
  return {
    ...plains,
    oracleId: `lab-white-black-final-${slug}`,
    scryfallId: `lab-white-black-final-${slug}`,
    name,
    manaCost: creature ? '{0}' : '{B}',
    cmc: creature ? 0 : 1,
    colors: creature ? [] : ['B'],
    colorIdentity: creature ? [] : ['B'],
    typeLine: creature ? 'Creature — Bear' : 'Instant',
    supertypes: [],
    types: creature ? ['Creature'] : ['Instant'],
    subtypes: creature ? ['Bear'] : [],
    oracleText: creature ? '' : 'Draw a card.',
    power: creature ? '2' : null,
    toughness: creature ? '2' : null,
    keywords: [],
    isBasicLand: false,
  };
}

function opponentSpellProvider(spellName: string): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      const onOpponentMain =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const action =
        onOpponentMain && !cast
          ? request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.startsWith(`Cast ${spellName}`),
            )
          : undefined;
      if (action !== undefined) {
        cast = true;
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

function avenPlotTaxProvider(spellName: string): DecisionProvider {
  let castFromHand = false;
  let castFromExile = false;
  return {
    decide(request) {
      const onP2Main =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const handCast =
        onP2Main && request.turn === 1 && !castFromHand
          ? request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.startsWith(`Cast ${spellName}`) &&
                candidate.data?.['sourceZone'] === 'hand',
            )
          : undefined;
      const plottedCast =
        onP2Main && request.turn === 5 && castFromHand && !castFromExile
          ? request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.startsWith(`Cast ${spellName}`) &&
                candidate.data?.['sourceName'] === spellName &&
                candidate.data?.['sourceZone'] === 'exile' &&
                candidate.data?.['manaCost'] === '{2}',
            )
          : undefined;
      const action = handCast ?? plottedCast;
      if (action !== undefined) {
        if (action === handCast) castFromHand = true;
        else castFromExile = true;
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

export function whiteBlackControlFinalScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control final scenario ${id}`);

  const sourceName = entry.source.card.name;
  const isAven = sourceName === 'Aven Interrupter';
  const isAvenPlotTax = id === 'aven-interrupter-viewer-later-plot-cast-pays-tax';
  const isLantern = sourceName.startsWith('Tergrid,');
  const isBilbo = sourceName === "Bilbo's Gambit";
  const isDawn = sourceName === "Dawn's Truce";
  const witnessSpell = witness('Lab Opposing Instant', 'instant');
  const ownCreature = witness('Lab Visible P1 Creature', 'creature');
  const manaP1 = isLantern
    ? [plains, plains, plains, swamp]
    : isAven
      ? [plains, plains, plains]
      : [plains, plains];
  const p1Cards = [entry.source.card, ...manaP1, ownCreature];
  const p2Cards = isAvenPlotTax
    ? [
        witnessSpell,
        ...Array.from({ length: 3 }, () => swamp),
        ...Array.from({ length: 10 }, () => plains),
      ]
    : isAven || isBilbo
      ? [witnessSpell, swamp, plains]
      : [plains, plains, plains];
  const p3Cards = [plains, swamp];
  const p4Cards = [plains, swamp];
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-final-${seat}`,
    commanders: [],
    cards: seat === 'P1' ? p1Cards : seat === 'P2' ? p2Cards : seat === 'P3' ? p3Cards : p4Cards,
  }));
  const battlefield = [
    { playerId: 'P1', cardNames: manaP1.map((land) => land.name) },
    ...(isAvenPlotTax
      ? [{ playerId: 'P2', cardNames: Array.from({ length: 3 }, () => swamp.name) }]
      : isAven || isBilbo
        ? [{ playerId: 'P2', cardNames: [swamp.name] }]
        : []),
    ...(isDawn ? [{ playerId: 'P1', cardNames: [ownCreature.name] }] : []),
  ];
  const hand = [
    { playerId: 'P1', cardNames: [sourceName] },
    ...(isAven || isBilbo ? [{ playerId: 'P2', cardNames: [witnessSpell.name] }] : []),
  ];

  const currentTurnPlayer = isAven || isBilbo ? 'P2' : 'P1';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: configs, turnCap: 5 },
    {
      preparedScenario: {
        currentTurnPlayer,
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand,
        battlefield,
        ...(isAvenPlotTax ? { continueThroughPrecombatMains: 4 } : {}),
      },
    },
  );

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isAvenPlotTax
        ? [
            'P2 casts Lab Opposing Instant normally from hand; cast Aven Interrupter in response and exile it as plotted.',
            "Continue through the intervening turns to P2's later precombat main phase.",
            "P2 casts Lab Opposing Instant from exile using its legal plot-cast action and pays Aven Interrupter's {2} tax with two Swamps.",
            "Observe the spell leave exile, P2 retain the cards drawn on their turns, and two of P2's three Swamps tapped.",
          ]
        : isAven
          ? [
              'P2 casts Lab Opposing Instant normally from hand.',
              'Cast Aven Interrupter from your hand in response; it has flash.',
              'Choose Lab Opposing Instant for the enters trigger and observe it move from the stack to exile.',
            ]
          : isLantern
            ? [
                "Cast Tergrid's Lantern from the back face of Tergrid, God of Fright // Tergrid's Lantern.",
                "Activate Tergrid's Lantern targeting P2. P2 has no cards in hand or nonland permanents, so P2 loses 3 life.",
              ]
            : isBilbo
              ? [
                  'P2 casts Lab Opposing Instant normally from hand.',
                  "Cast Bilbo's Gambit, promise the Treasure gift to P3, and target Lab Opposing Instant.",
                  "Observe P3 create a Treasure and the spell return to P2's hand; players cannot cast spells for the rest of this turn.",
                ]
              : [
                  "Cast Dawn's Truce and promise the card gift to P2.",
                  'P2 draws a card before the protection effect; you and your visible creature gain hexproof and indestructible until end of turn.',
                ],
      expectedOutcome: isAvenPlotTax
        ? "Aven Interrupter exiles and plots P2's spell on turn 1. On P2's later turn, the legal plot cast costs {2}; P2 pays with two Swamps, draws for the turn, and the spell leaves exile."
        : isAven
          ? 'Aven Interrupter resolves normally and its triggered ability moves the opposing spell from the stack to exile.'
          : isLantern
            ? "Tergrid's Lantern taps and P2 loses 3 life because P2 has no nonland permanent or card in hand to choose instead."
            : isBilbo
              ? "P3 receives the promised Treasure, Lab Opposing Instant returns to its owner's hand, and the turn's spell-casting restriction applies."
              : "P2 draws one card before Dawn's Truce gives you and your creature hexproof and indestructible until end of turn.",
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
    decisionProviderOverrides: isAvenPlotTax
      ? { P2: avenPlotTaxProvider(witnessSpell.name) }
      : isAven || isBilbo
        ? { P2: opponentSpellProvider(witnessSpell.name) }
        : {},
  };
}
