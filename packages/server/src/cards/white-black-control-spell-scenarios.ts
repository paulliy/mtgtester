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
    id: 'imp-s-mischief-viewer',
    source: fromPin("Imp's Mischief"),
    title: "Imp's Mischief: redirect a normal single-target spell and lose its mana value",
    clauseIds: ['imp-s-mischief-c01'],
  },
  {
    id: 'restoration-magic-viewer',
    source: fromPin('Restoration Magic'),
    title: 'Restoration Magic: cast Cura to protect a permanent and gain 3 life',
    clauseIds: ['restoration-magic-c01', 'restoration-magic-c03'],
  },
  {
    id: 'restoration-magic-viewer-cure',
    source: fromPin('Restoration Magic'),
    title: 'Restoration Magic: cast Cure for its zero additional cost',
    clauseIds: ['restoration-magic-c01', 'restoration-magic-c02'],
  },
  {
    id: 'restoration-magic-viewer-curaga',
    source: fromPin('Restoration Magic'),
    title: 'Restoration Magic: pay Curaga to protect all your permanents and gain 6 life',
    clauseIds: ['restoration-magic-c01', 'restoration-magic-c04'],
  },
] as const;

export const WHITE_BLACK_SPELL_SCENARIO_IDS = scenarios.map((scenario) => scenario.id);

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

function growthSpell(): OracleCard {
  return witness('Lab Prepared Growth Spell', {
    typeLine: 'Instant',
    types: ['Instant'],
    manaCost: '{2}',
    cmc: 2,
    oracleText: 'Target creature gets +1/+1 until end of turn.',
    colors: [],
  });
}

function opponentGrowthProvider(getState: () => ReturnType<Engine['getState']>): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      const mainPhase =
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority';
      const action =
        mainPhase && !cast
          ? request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.startsWith('Cast Lab Prepared Growth Spell'),
            )
          : undefined;
      if (action !== undefined) {
        cast = true;
        const targetId = getState().battlefield.find(
          (permanent) => permanent.name === 'Lab P2 Growth Target',
        )?.id;
        const targets = (action.targets ?? []).map((slot) => {
          if (targetId === undefined || !slot.options.includes(targetId))
            throw new Error('Prepared Growth Spell did not offer its controller’s creature');
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

export function whiteBlackControlSpellScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = scenarios.find((scenario) => scenario.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control spell scenario ${id}`);
  const isImp = entry.source.card.name === "Imp's Mischief";
  const isCure = id === 'restoration-magic-viewer-cure';
  const isCuraga = id === 'restoration-magic-viewer-curaga';
  const targetSpell = growthSpell();
  const p1Creature = witness('Lab P1 Redirect Target', {
    typeLine: 'Creature — Bear',
    types: ['Creature'],
    power: '2',
    toughness: '2',
  });
  const p2Creature = witness('Lab P2 Growth Target', {
    typeLine: 'Creature — Bear',
    types: ['Creature'],
    power: '2',
    toughness: '2',
  });
  const restorationTarget = witness('Lab P1 Cura Target', {
    typeLine: 'Artifact',
    types: ['Artifact'],
    manaCost: '{0}',
  });
  const p1Mana = isImp ? [swamp, swamp, plains] : Array.from({ length: isCure ? 1 : isCuraga ? 5 : 2 }, () => plains);
  const configs = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-spells-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [entry.source.card, ...p1Mana, p1Creature, restorationTarget]
        : seat === 'P2'
          ? [targetSpell, p2Creature, swamp, swamp]
          : [plains, swamp, swamp],
  }));
  const seed = `card-lab-${id}-v1`;
  const battlefield = [
    { playerId: 'P1', cardNames: p1Mana.map((land) => land.name) },
    ...(isImp ? [{ playerId: 'P2', cardNames: [swamp.name, swamp.name] }] : []),
    ...(isImp
      ? [
          { playerId: 'P1', cardNames: [p1Creature.name] },
          { playerId: 'P2', cardNames: [p2Creature.name] },
        ]
      : [{ playerId: 'P1', cardNames: [restorationTarget.name, p1Creature.name] }]),
  ];
  const preparedHand = isImp
    ? [
        { playerId: 'P1', cardNames: [entry.source.card.name] },
        { playerId: 'P2', cardNames: [targetSpell.name] },
      ]
    : [{ playerId: 'P1', cardNames: [entry.source.card.name] }];
  const engine = new Engine(
    {
      gameId,
      seed,
      players: configs,
      turnCap: 4,
    },
    {
      preparedScenario: {
        currentTurnPlayer: isImp ? 'P2' : 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        lifeTotals: isImp ? [{ playerId: 'P1', life: 40 }] : [{ playerId: 'P1', life: 35 }],
        hand: preparedHand,
        battlefield,
      },
    },
  );

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isImp
        ? [
            'P2 casts Lab Prepared Growth Spell normally, targeting their creature.',
            "Cast Imp's Mischief from your hand, target that spell, then redirect it to Lab P1 Redirect Target.",
            'Observe the original spell resolve on your creature and lose 2 life for its mana value.',
          ]
        : [
            `Cast Restoration Magic choosing ${isCure ? 'Cure ({0})' : isCuraga ? 'Curaga ({3}{W})' : 'Cura ({1})'} as its additional cost.`,
            isCuraga ? 'Observe every permanent you control gain hexproof and indestructible until end of turn, and gain 6 life.'
              : `Choose Lab P1 Cura Target; it should gain hexproof and indestructible until end of turn${isCure ? '.' : ', and you should gain 3 life.'}`,
          ],
      expectedOutcome: isImp
        ? "Imp's Mischief changes the target of the normally cast single-target spell to your creature and its caster loses life equal to mana value 2."
        : isCuraga ? 'Curaga grants hexproof and indestructible to all your permanents until end of turn and gains 6 life.'
          : isCure ? 'Cure grants hexproof and indestructible to its target with zero additional mana paid and no life gain.'
            : 'The Cura mode grants hexproof and indestructible to the chosen permanent until end of turn and gains its caster 3 life.',
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
    decisionProviderOverrides: isImp ? { P2: opponentGrowthProvider(() => engine.getState()) } : {},
  };
}
