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

const scenarios = [
  {
    id: 'mother-of-runes-viewer',
    source: fromPin('Mother of Runes'),
    title: 'Mother of Runes: tap to give your creature protection from a chosen color',
    clauseIds: ['mother-of-runes-c01'],
  },
  {
    id: 'sejiri-shelter-sejiri-glacier-viewer',
    source: fromPin('Sejiri Shelter // Sejiri Glacier'),
    title: 'Sejiri Shelter: cast for {1}{W} and choose a protection color',
    clauseIds: ['sejiri-shelter-sejiri-glacier-c01'],
  },
  {
    id: 'reprieve-viewer',
    source: fromPin('Reprieve'),
    title: "Reprieve: return P2's targeted spell to their hand and draw a card",
    clauseIds: ['reprieve-c01', 'reprieve-c02'],
  },
  {
    id: 'rebuff-the-wicked-viewer',
    source: fromPin('Rebuff the Wicked'),
    title: "Rebuff the Wicked: counter P2's spell targeting your creature",
    clauseIds: ['rebuff-the-wicked-c01'],
  },
] as const;

export const WHITE_BLACK_PROTECTION_SCENARIO_IDS = scenarios.map((scenario) => scenario.id);

function witness(
  name: string,
  options: {
    typeLine: string;
    types: string[];
    manaCost?: string | null;
    cmc?: number;
    oracleText?: string;
    power?: string | null;
    toughness?: string | null;
    colors?: OracleCard['colors'];
  },
): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
    name,
    manaCost: options.manaCost === undefined ? '{0}' : options.manaCost,
    cmc: options.cmc ?? 0,
    colors: options.colors ?? [],
    colorIdentity: options.colors ?? [],
    typeLine: options.typeLine,
    supertypes: [],
    types: options.types,
    subtypes: options.types.includes('Creature') ? ['Bear'] : [],
    oracleText: options.oracleText ?? '',
    power:
      options.power === undefined
        ? options.types.includes('Creature')
          ? '2'
          : null
        : options.power,
    toughness:
      options.toughness === undefined
        ? options.types.includes('Creature')
          ? '2'
          : null
        : options.toughness,
    keywords: [],
    isBasicLand: false,
  };
}

const protectionTarget = witness('Lab P1 Protection Target', {
  typeLine: 'Creature — Bear',
  types: ['Creature'],
  power: '2',
  toughness: '2',
});

const opponentTargetSpell = witness('Lab P2 Targeted Growth Spell', {
  typeLine: 'Instant',
  types: ['Instant'],
  manaCost: '{1}{B}',
  cmc: 2,
  colors: ['B'],
  oracleText: 'Target creature gets +1/+1 until end of turn.',
});

function opponentTargetSpellProvider(
  getState: () => ReturnType<Engine['getState']>,
): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      const activeMain =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const action =
        activeMain && !cast
          ? request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.startsWith('Cast Lab P2 Targeted Growth Spell'),
            )
          : undefined;
      if (action !== undefined) {
        cast = true;
        const targetId = getState().battlefield.find(
          (permanent) => permanent.name === protectionTarget.name,
        )?.id;
        const targets = (action.targets ?? []).map((slot) => {
          if (targetId === undefined || !slot.options.includes(targetId))
            throw new Error('P2 spell did not offer the P1 creature as a target');
          return { slot: slot.slot, choice: targetId };
        });
        return {
          requestId: request.requestId,
          actionId: action.id,
          ...(targets.length > 0 ? { targets } : {}),
        };
      }
      const pass =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (pass === undefined) throw new Error(`No legal P2 action for ${request.decisionType}`);
      return { requestId: request.requestId, actionId: pass.id };
    },
  };
}

export function whiteBlackControlProtectionScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = scenarios.find((scenario) => scenario.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control protection scenario ${id}`);
  const name = entry.source.card.name;
  const isMother = name === 'Mother of Runes';
  const isShelter = name === 'Sejiri Shelter // Sejiri Glacier';
  const isReprieve = name === 'Reprieve';
  const p1Mana = isMother ? [plains] : isShelter || isReprieve ? [plains, plains] : [plains];
  const p2Mana = isReprieve || name === 'Rebuff the Wicked' ? [swamp, swamp] : [];
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-protection-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [entry.source.card, ...Array.from({ length: 8 }, () => plains), protectionTarget]
        : seat === 'P2'
          ? [opponentTargetSpell, ...Array.from({ length: 8 }, () => swamp)]
          : [
              ...Array.from({ length: 10 }, () => plains),
              ...Array.from({ length: 10 }, () => swamp),
            ],
  }));
  const battlefield = [
    { playerId: 'P1', cardNames: p1Mana.map((land) => land.name) },
    ...(p2Mana.length > 0 ? [{ playerId: 'P2', cardNames: p2Mana.map((land) => land.name) }] : []),
    { playerId: 'P1', cardNames: [protectionTarget.name] },
    ...(isMother ? [{ playerId: 'P1', cardNames: [entry.source.card.name] }] : []),
  ];
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: configs,
      turnCap: 4,
    },
    {
      preparedScenario: {
        currentTurnPlayer: isReprieve || name === 'Rebuff the Wicked' ? 'P2' : 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 2,
        hand: [
          ...(!isMother ? [{ playerId: 'P1', cardNames: [entry.source.card.name] }] : []),
          ...(isReprieve || name === 'Rebuff the Wicked'
            ? [{ playerId: 'P2', cardNames: [opponentTargetSpell.name] }]
            : []),
        ],
        battlefield,
      },
    },
  );

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isMother
        ? [
            'Activate Mother of Runes by tapping it and target Lab P1 Protection Target.',
            'Choose blue when the ability resolves; the target should show protection from blue until end of turn.',
          ]
        : isShelter
          ? [
              'Cast Sejiri Shelter from your hand for {1}{W}, targeting Lab P1 Protection Target.',
              'Choose blue when it resolves and confirm the creature gains protection from blue until end of turn.',
            ]
          : isReprieve
            ? [
                'P2 casts Lab P2 Targeted Growth Spell normally for {1}{B}, targeting Lab P1 Protection Target.',
                "Respond with Reprieve for {1}{W}, target P2's spell, then observe it return to P2's hand and draw a card.",
              ]
            : [
                'P2 casts Lab P2 Targeted Growth Spell normally for {1}{B}, targeting Lab P1 Protection Target.',
                "Respond with Rebuff the Wicked for {W} and target P2's spell; it should be countered because it targets your permanent.",
              ],
      expectedOutcome:
        isMother || isShelter
          ? 'The selected creature gains protection from blue until end of turn after the real target and color decisions.'
          : isReprieve
            ? "Reprieve returns P2's spell to its owner's hand and its caster draws one card."
            : 'Rebuff the Wicked counters the normally cast spell that targets your creature.',
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
    decisionProviderOverrides:
      isReprieve || name === 'Rebuff the Wicked'
        ? { P2: opponentTargetSpellProvider(() => engine.getState()) }
        : {},
  };
}
