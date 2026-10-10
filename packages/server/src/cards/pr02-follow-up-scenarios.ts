import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { choose, Engine, interpretCard, ScriptedDecisionProvider } from '@mtg/engine';
import type { CardDefinition, EnginePlayerConfig, PreparedScenarioSpec } from '@mtg/engine';
import type { CardTestScenarioMetadata, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { SeatSetup } from '../match/setup';
import type { CardTestScenario } from './card-test-scenarios';

interface PinnedFile {
  cards: Array<{ card: OracleCard; sha256: string }>;
}

const ORACLE = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFile;

function pinned(name: string): { card: OracleCard; sha256: string } {
  const entry = ORACLE.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  return entry;
}

const LAB_OX: OracleCard = {
  oracleId: 'lab-pr02-stateful-ox',
  scryfallId: 'lab-pr02-stateful-ox',
  name: 'Lab Ox',
  manaCost: '{2}',
  cmc: 2,
  colors: [],
  colorIdentity: [],
  typeLine: 'Creature — Ox',
  supertypes: [],
  types: ['Creature'],
  subtypes: ['Ox'],
  oracleText: '',
  power: '2',
  toughness: '2',
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
};
const LAB_BEAR: OracleCard = {
  oracleId: 'lab-pr02-convoke-bear',
  scryfallId: 'lab-pr02-convoke-bear',
  name: 'Lab Convoke Bear',
  manaCost: null,
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
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
};
const PLAINS: OracleCard = {
  oracleId: 'lab-pr02-plains',
  scryfallId: 'lab-pr02-plains',
  name: 'Plains',
  manaCost: null,
  cmc: 0,
  colors: [],
  colorIdentity: [],
  typeLine: 'Basic Land — Plains',
  supertypes: ['Basic'],
  types: ['Land'],
  subtypes: ['Plains'],
  oracleText: '{T}: Add {W}.',
  power: null,
  toughness: null,
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: true,
};
const LAND: OracleCard = {
  ...PLAINS,
  oracleId: 'lab-pr02-forest',
  scryfallId: 'lab-pr02-forest',
  name: 'Forest',
  typeLine: 'Basic Land — Forest',
  subtypes: ['Forest'],
  oracleText: '{T}: Add {G}.',
};
const MOUNTAIN: OracleCard = {
  ...PLAINS,
  oracleId: 'lab-pr02-mountain',
  scryfallId: 'lab-pr02-mountain',
  name: 'Mountain',
  typeLine: 'Basic Land — Mountain',
  subtypes: ['Mountain'],
  oracleText: '{T}: Add {R}.',
};

function seat(id: PlayerId, cards: OracleCard[]): { config: EnginePlayerConfig; setup: SeatSetup } {
  const config: EnginePlayerConfig = { id, deckId: `card-lab-${id}`, commanders: [], cards };
  return {
    config,
    setup: {
      seat: id,
      config,
      summary: {
        seat: id,
        deckId: config.deckId,
        label: id === 'P1' ? 'Card Test Lab' : `Deterministic opponent ${id}`,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
      deckSnapshotId: null,
    },
  };
}

const LAB_COUNTED_PROBE: OracleCard = {
  oracleId: 'lab-killian-counted-target-contract',
  scryfallId: 'lab-killian-counted-target-contract',
  name: 'Lab Counted Target Contract',
  manaCost: '{4}{R}',
  cmc: 5,
  colors: ['R'],
  colorIdentity: ['R'],
  typeLine: 'Instant',
  supertypes: [],
  types: ['Instant'],
  subtypes: [],
  oracleText: 'Destroy up to two target creatures.',
  power: null,
  toughness: null,
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
};
const LAB_DEER: OracleCard = {
  ...LAB_BEAR,
  oracleId: 'lab-pr02-deer',
  scryfallId: 'lab-pr02-deer',
  name: 'Lab Deer',
};
const LAB_WOLF: OracleCard = {
  ...LAB_BEAR,
  oracleId: 'lab-pr02-wolf',
  scryfallId: 'lab-pr02-wolf',
  name: 'Lab Wolf',
};
const LAB_REPLICATE_PROBE: OracleCard = {
  oracleId: 'lab-replicate-counted-target-contract',
  scryfallId: 'lab-replicate-counted-target-contract',
  name: 'Lab Replicate Count Contract',
  manaCost: '{2}{R}',
  cmc: 3,
  colors: ['R'],
  colorIdentity: ['R'],
  typeLine: 'Instant',
  supertypes: [],
  types: ['Instant'],
  subtypes: [],
  oracleText:
    'Replicate {1} (When you cast this spell, copy it for each time you paid its replicate cost. You may choose new targets for the copies. Copies become tokens.)\nDestroy up to two target creatures.',
  power: null,
  toughness: null,
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
};

export const PR02_FOLLOW_UP_SCENARIO_IDS = [
  'conclave-tribunal-viewer-convoke-szeras',
  'lab-killian-counted-target-zero-contract',
  'lab-killian-counted-target-creatures-contract',
  'changing-loyalty-viewer-replicate-two-original-countered',
  'lab-replicate-counted-targets-original-countered-contract',
] as const;

export function pr02FollowUpScenario(id: string, gameId: GameId): CardTestScenario | null {
  if (
    id === 'lab-killian-counted-target-zero-contract' ||
    id === 'lab-killian-counted-target-creatures-contract'
  ) {
    return countedTargetScenario(id, gameId);
  }
  if (id === 'changing-loyalty-viewer-replicate-two-original-countered') {
    return replicateAfterCounterScenario(id, gameId);
  }
  if (id === 'lab-replicate-counted-targets-original-countered-contract') {
    return countedReplicateScenario(id, gameId);
  }
  if (id !== 'conclave-tribunal-viewer-convoke-szeras') return null;
  const tribunal = pinned('Conclave Tribunal');
  const szeras = pinned('Illuminor Szeras');
  const metadata: CardTestScenarioMetadata = {
    id,
    version: 1,
    title: 'Conclave Tribunal: convoke beside Illuminor Szeras mana',
    instructions: [
      'Cast Conclave Tribunal. Auto-pay taps Illuminor Szeras and sacrifices Lab Ox (mana value 2) for two black mana, then taps Lab Convoke Bear (mana value 0) for one generic mana.',
      'Use Plains for the white mana.',
    ],
    expectedOutcome:
      'Illuminor Szeras is tapped, Lab Ox is sacrificed, Lab Convoke Bear and Plains are tapped for Tribunal, and P2’s Lab Ox is exiled.',
    oracleSha256: tribunal.sha256,
    clauseIds: ['conclave-tribunal-convoke', 'illuminor-szeras-sacrifice-for-black'],
  };
  const p1Cards = [tribunal.card, szeras.card, LAB_OX, LAB_BEAR, PLAINS];
  const p2Cards = [LAB_OX, LAND];
  const seats = [
    seat('P1', p1Cards),
    seat('P2', p2Cards),
    seat('P3', [LAND]),
    seat('P4', [LAND]),
  ] as const;
  const prepared: PreparedScenarioSpec = {
    currentTurnPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    turnNumber: 1,
    hand: [{ playerId: 'P1', cardNames: ['Conclave Tribunal'] }],
    battlefield: [
      { playerId: 'P1', cardNames: ['Illuminor Szeras', 'Lab Ox', 'Lab Convoke Bear', 'Plains'] },
      { playerId: 'P2', cardNames: ['Lab Ox'] },
    ],
  };
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: seats.map(({ config }) => config), turnCap: 2 },
    { preparedScenario: prepared },
  );
  return { metadata, seed, seats: seats.map(({ setup }) => setup), engine };
}

function countedTargetScenario(id: string, gameId: GameId): CardTestScenario {
  const killian = pinned('Killian, Ink Duelist');
  const title =
    id === 'lab-killian-counted-target-zero-contract'
      ? 'Lab contract: Killian receives no discount with zero counted targets'
      : 'Lab contract: Killian discounts once for two counted creature targets';
  const metadata: CardTestScenarioMetadata = {
    id,
    version: 1,
    title,
    instructions:
      id === 'lab-killian-counted-target-zero-contract'
        ? [
            'Cast the synthetic Lab contract spell and choose no creatures. Killian must not reduce its cost.',
          ]
        : [
            'Cast the synthetic Lab contract spell and choose both opposing creatures. Killian reduces the total cost by {2} once, regardless of the two targets.',
          ],
    expectedOutcome:
      id === 'lab-killian-counted-target-zero-contract'
        ? 'The spell costs {4}{R} and both opposing creatures remain.'
        : 'The spell costs {2}{R} after one {2} reduction and destroys both chosen creatures.',
    oracleSha256: createHash('sha256').update(JSON.stringify(LAB_COUNTED_PROBE)).digest('hex'),
    clauseIds: ['lab-killian-counted-target-contract'],
  };
  const definition = interpretCard(LAB_COUNTED_PROBE);
  const probeDefinition: CardDefinition = {
    ...definition,
    modeled: true,
    unmodeledReasons: [],
    spellAbility: {
      kind: 'spell',
      description: 'Lab counted-target contract spell',
      targets: [{ kind: 'creature', count: { min: 0, max: 2 } }],
      effects: [{ op: 'destroyEachChosen', targetSlot: 0 }],
    },
  };
  const p1Cards = [LAB_COUNTED_PROBE, killian.card, MOUNTAIN, LAND, LAND, LAND, LAND];
  const p2Cards = [LAB_OX, LAB_BEAR, LAND];
  const seats = [
    seat('P1', p1Cards),
    seat('P2', p2Cards),
    seat('P3', [LAND]),
    seat('P4', [LAND]),
  ] as const;
  const prepared: PreparedScenarioSpec = {
    currentTurnPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    turnNumber: 1,
    hand: [{ playerId: 'P1', cardNames: [LAB_COUNTED_PROBE.name] }],
    battlefield: [
      {
        playerId: 'P1',
        cardNames: ['Killian, Ink Duelist', 'Mountain', 'Forest', 'Forest', 'Forest', 'Forest'],
      },
      { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Convoke Bear'] },
    ],
  };
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: seats.map(({ config }) => config),
      turnCap: 2,
      customDefinitions: [probeDefinition],
    },
    { preparedScenario: prepared },
  );
  return { metadata, seed, seats: seats.map(({ setup }) => setup), engine };
}

function replicateAfterCounterScenario(id: string, gameId: GameId): CardTestScenario {
  const loyalty = pinned('Changing Loyalty');
  const denial = pinned('Arcane Denial');
  const swamps = Array.from({ length: 6 }, () => ({
    ...PLAINS,
    oracleId: 'lab-pr02-swamp',
    scryfallId: 'lab-pr02-swamp',
    name: 'Swamp',
    typeLine: 'Basic Land — Swamp',
    subtypes: ['Swamp'],
    oracleText: '{T}: Add {B}.',
    isBasicLand: true,
  }));
  const p1Cards = [loyalty.card, ...swamps];
  const islands = Array.from({ length: 2 }, (_, index) => ({
    ...PLAINS,
    oracleId: `lab-pr02-island-${index}`,
    scryfallId: `lab-pr02-island-${index}`,
    name: 'Island',
    typeLine: 'Basic Land — Island',
    subtypes: ['Island'],
    oracleText: '{T}: Add {U}.',
    isBasicLand: true,
  }));
  const p2Cards = [denial.card, ...islands, LAB_OX, LAB_BEAR];
  const seats = [
    seat('P1', p1Cards),
    seat('P2', p2Cards),
    seat('P3', [LAND]),
    seat('P4', [LAND]),
  ] as const;
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: seats.map(({ config }) => config), turnCap: 2 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [
          { playerId: 'P1', cardNames: ['Changing Loyalty'] },
          { playerId: 'P2', cardNames: ['Arcane Denial'] },
        ],
        battlefield: [
          { playerId: 'P1', cardNames: p1Cards.slice(1).map((land) => land.name) },
          { playerId: 'P2', cardNames: ['Island', 'Island', 'Lab Ox', 'Lab Convoke Bear'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'Changing Loyalty: replicate twice, counter the original, keep both copies',
      instructions: [
        'Cast Changing Loyalty with replicate 2 for {5}{B}, targeting P2’s Lab Ox.',
        'Arcane Denial counters the original spell. Choose Lab Ox for the first copy and Lab Convoke Bear for the second.',
      ],
      expectedOutcome:
        'The original Changing Loyalty is countered, while both replicate copies resolve as tokens onto their chosen creatures.',
      oracleSha256: loyalty.sha256,
      clauseIds: [
        'changing-loyalty-replicate',
        'changing-loyalty-enchant',
        'arcane-denial-counter-and-affected-player-draw',
      ],
    },
    seed,
    seats: seats.map(({ setup }) => setup),
    engine,
    decisionProviderOverrides: {
      P2: new ScriptedDecisionProvider([
        choose('Cast Arcane Denial'),
        ...Array.from({ length: 16 }, () => choose(/Pass/)),
      ]),
    },
  };
}

function countedReplicateScenario(id: string, gameId: GameId): CardTestScenario {
  const denial = pinned('Arcane Denial');
  const parsed = interpretCard(LAB_REPLICATE_PROBE);
  const replicateDefinition: CardDefinition = {
    ...parsed,
    modeled: true,
    unmodeledReasons: [],
    optionalAdditionalCost: {
      mechanic: 'replicate',
      cost: { generic: 1, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      repeatable: true,
    },
    spellAbility: {
      kind: 'spell',
      description: 'Lab counted-target replicate contract spell',
      targets: [{ kind: 'creature', count: { min: 1, max: 2 } }],
      effects: [{ op: 'destroyEachChosen', targetSlot: 0 }],
    },
  };
  const forests = Array.from({ length: 3 }, (_, index) => ({
    ...LAND,
    oracleId: `lab-repl-forest-${index}`,
    scryfallId: `lab-repl-forest-${index}`,
  }));
  const islands = Array.from({ length: 2 }, (_, index) => ({
    ...PLAINS,
    oracleId: `lab-repl-island-${index}`,
    scryfallId: `lab-repl-island-${index}`,
    name: 'Island',
    typeLine: 'Basic Land — Island',
    subtypes: ['Island'],
    oracleText: '{T}: Add {U}.',
  }));
  const p1Cards = [LAB_REPLICATE_PROBE, MOUNTAIN, ...forests];
  const p2Cards = [denial.card, ...islands, LAB_OX, LAB_BEAR, LAB_DEER, LAB_WOLF];
  const seats = [
    seat('P1', p1Cards),
    seat('P2', p2Cards),
    seat('P3', [LAND]),
    seat('P4', [LAND]),
  ] as const;
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: seats.map(({ config }) => config),
      turnCap: 2,
      customDefinitions: [replicateDefinition],
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [
          { playerId: 'P1', cardNames: [LAB_REPLICATE_PROBE.name] },
          { playerId: 'P2', cardNames: ['Arcane Denial'] },
        ],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Forest', 'Forest', 'Forest'] },
          {
            playerId: 'P2',
            cardNames: ['Island', 'Island', 'Lab Ox', 'Lab Convoke Bear', 'Lab Deer', 'Lab Wolf'],
          },
        ],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title:
        'Lab contract: replicate preserves two counted targets after the original is countered',
      instructions: [
        'Cast the synthetic Lab Replicate Count Contract with replicate 1, choosing Lab Ox and Lab Convoke Bear.',
        'Arcane Denial counters the original. The replicate copy must still offer two target choices; choose Lab Deer and Lab Wolf.',
      ],
      expectedOutcome:
        'The original spell is countered. Its one replicate copy has two counted targets and destroys Lab Deer and Lab Wolf.',
      oracleSha256: createHash('sha256').update(JSON.stringify(LAB_REPLICATE_PROBE)).digest('hex'),
      clauseIds: [
        'lab-replicate-counted-target-contract',
        'arcane-denial-counter-and-affected-player-draw',
      ],
    },
    seed,
    seats: seats.map(({ setup }) => setup),
    engine,
    decisionProviderOverrides: {
      P2: new ScriptedDecisionProvider([
        choose('Cast Arcane Denial'),
        ...Array.from({ length: 16 }, () => choose(/Pass/)),
      ]),
    },
  };
}
