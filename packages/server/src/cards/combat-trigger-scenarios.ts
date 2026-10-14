import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/combat-trigger-oracle.json', 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
for (const entry of fixture.cards) {
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`Combat trigger Oracle pin drift: ${entry.card.name}`);
}
const pin = (name: string) => {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (!entry) throw new Error(`Missing combat trigger Oracle pin ${name}`);
  return entry;
};
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const basic = (name: string) => {
  const found = coverage.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing combat trigger basic ${name}`);
  return found;
};
const bear: OracleCard = {
  ...basic('Forest'),
  oracleId: 'lab-combat-vanilla-bear',
  scryfallId: 'lab-combat-vanilla-bear',
  name: 'Lab Bear',
  manaCost: '{1}{G}',
  cmc: 2,
  typeLine: 'Creature — Bear',
  types: ['Creature'],
  subtypes: ['Bear'],
  supertypes: [],
  oracleText: '',
  power: '2',
  toughness: '2',
  isBasicLand: false,
};

export const COMBAT_TRIGGER_SCENARIO_IDS = [
  'marchesa-viewer-dethrone-response',
  'marchesa-viewer-dethrone-negative',
  'namor-viewer-defender-bonus',
  'namor-viewer-source-removed',
  'scriv-viewer-departed-attacker',
  'scriv-viewer-attacks-controller',
  'marchesa-viewer-granted-dethrone',
  'dragon-mage-viewer-normal-cast-wheel',
  'hunted-phantasm-viewer-opponent-tokens',
] as const;
type ScenarioId = (typeof COMBAT_TRIGGER_SCENARIO_IDS)[number];
const details: Record<
  ScenarioId,
  { title: string; card: string; clause: string; instructions: string[]; expected: string }
> = {
  'marchesa-viewer-dethrone-response': {
    title: 'Marchesa: keep dethrone after a life-total response',
    card: 'Marchesa, the Black Rose',
    clause: 'marchesa-dethrone',
    instructions: [
      'Attack P2 with Marchesa while P2 has the most life.',
      'P3 casts Lightning Bolt at P2 in response. Pass priority to resolve both.',
    ],
    expected: 'P2 falls to 38 life and Marchesa receives one +1/+1 counter.',
  },
  'marchesa-viewer-dethrone-negative': {
    title: 'Marchesa: ignore a non-leading defender',
    card: 'Marchesa, the Black Rose',
    clause: 'marchesa-dethrone',
    instructions: [
      'Attack P2 with Marchesa. P3 has more life than P2.',
      'Pass priority through combat.',
    ],
    expected: 'Marchesa receives no +1/+1 counter.',
  },
  'namor-viewer-defender-bonus': {
    title: 'Namor: boost allies attacking the defender',
    card: 'Namor, Atlantean King',
    clause: 'namor-higher-life-attack',
    instructions: [
      'Attack P2 with Namor and Lab Bear while P2 has more life than you.',
      'Pass priority through combat.',
    ],
    expected: 'Lab Bear deals 4 combat damage to P2.',
  },
  'namor-viewer-source-removed': {
    title: 'Namor: keep the bonus after source removal',
    card: 'Namor, Atlantean King',
    clause: 'namor-higher-life-attack',
    instructions: [
      'Attack P2 with Namor and Lab Bear while P2 has more life than you.',
      'P3 casts Lightning Bolt at Namor in response. Pass priority.',
    ],
    expected: 'Namor leaves the battlefield and Lab Bear still deals 4 combat damage to P2.',
  },
  'scriv-viewer-departed-attacker': {
    title: 'Scriv: no life loss after the attacker dies',
    card: 'Scriv, the Obligator',
    clause: 'scriv-contract',
    instructions: [
      'Cast Scriv and target P2’s Lab Bear with its entry trigger.',
      'After P2’s turn begins, P2 attacks P3 with Lab Bear. Cast Lightning Bolt at it in response.',
    ],
    expected: 'The departed attacker’s controller loses no life.',
  },
  'scriv-viewer-attacks-controller': {
    title: 'Scriv: lose life when attacking the Contract controller',
    card: 'Scriv, the Obligator',
    clause: 'scriv-contract',
    instructions: [
      'Cast Scriv and target P2’s Lab Bear with its entry trigger.',
      'After P2’s turn begins, P2 attacks you with Lab Bear. Do not block.',
    ],
    expected: 'P2 loses 2 life when the Contract trigger resolves.',
  },
  'marchesa-viewer-granted-dethrone': {
    title: 'Marchesa: grant dethrone to an attacking creature',
    card: 'Marchesa, the Black Rose',
    clause: 'marchesa-granted-dethrone',
    instructions: [
      'Cast Marchesa normally. Temur Ascendancy gives her haste.',
      'Attack P2 with only Lab Bear while P2 has the most life. P3 casts Lightning Bolt at P2 in response.',
    ],
    expected:
      'Lab Bear gains a +1/+1 counter, deals 3 damage, and P2 ends at 35 life. Marchesa gets no counter.',
  },
  'dragon-mage-viewer-normal-cast-wheel': {
    title: 'Dragon Mage: normal cast and seven-card wheel',
    card: 'Dragon Mage',
    clause: 'dragon-mage-wheel',
    instructions: [
      'Cast Dragon Mage normally. Decline Temur Ascendancy’s optional draw.',
      'Attack P2 at 40 life. Dragon Mage deals combat damage and each player discards, then draws seven cards.',
    ],
    expected: 'All four players have exactly seven cards in hand and P2 ends at 35 life.',
  },
  'hunted-phantasm-viewer-opponent-tokens': {
    title: 'Hunted Phantasm: give P2 five Goblins',
    card: 'Hunted Phantasm',
    clause: 'hunted-phantasm-opponent-tokens',
    instructions: [
      'Cast Hunted Phantasm normally and target P2 with its entry trigger.',
      'Attack P2 at 40 life. Hunted Phantasm cannot be blocked.',
    ],
    expected: 'P2 controls five 1/1 red Goblins and ends at 36 life.',
  },
};

export function combatTriggerScenarioSubject(id: string): string {
  const detail = details[id as ScenarioId];
  if (!detail) throw new Error(`Unknown combat trigger scenario ${id}`);
  return detail.card;
}

function passing(): DecisionProvider {
  return {
    decide(request) {
      const a = request.legalActions.find((x) => x.type === 'pass') ?? request.legalActions[0]!;
      return { requestId: request.requestId, actionId: a.id };
    },
  };
}
function attacker(defender: PlayerId): DecisionProvider {
  return {
    decide(request) {
      const action = request.legalActions.find((candidate) =>
        candidate.description.startsWith('Declare attackers'),
      );
      if (action)
        return {
          requestId: request.requestId,
          actionId: action.id,
          targets: (action.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice: slot.options.includes(defender) ? defender : slot.options[0]!,
          })),
        };
      const pass =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0]!;
      return { requestId: request.requestId, actionId: pass.id };
    },
  };
}
function responder(
  target: 'P2' | 'P1' | 'Namor, Atlantean King' | 'Lab Bear',
  getObjectId: () => string | undefined,
): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      if (
        !cast &&
        request.step === 'declareAttackers' &&
        request.legalActions.some((a) => a.description.includes('Lightning Bolt'))
      ) {
        const action = request.legalActions.find((a) => a.description.includes('Lightning Bolt'))!;
        const wanted = target === 'P2' || target === 'P1' ? target : getObjectId();
        const choices = (action.targets ?? []).map((slot) => {
          const option = wanted && slot.options.includes(wanted) ? wanted : undefined;
          return { slot: slot.slot, choice: option ?? slot.options[0]! };
        });
        cast = true;
        return { requestId: request.requestId, actionId: action.id, targets: choices };
      }
      const pass = request.legalActions.find((a) => a.type === 'pass') ?? request.legalActions[0]!;
      return { requestId: request.requestId, actionId: pass.id };
    },
  };
}

export function combatTriggerScenario(id: string, gameId: GameId): CardTestScenario {
  const detail = details[id as ScenarioId];
  if (!detail) throw new Error(`Unknown combat trigger scenario ${id}`);
  const marchesa = id.startsWith('marchesa');
  const namor = id.startsWith('namor');
  const scriv = id.startsWith('scriv');
  const response =
    id === 'marchesa-viewer-dethrone-response' ||
    id === 'namor-viewer-source-removed' ||
    id === 'marchesa-viewer-granted-dethrone';
  const boltResponse = response || id === 'scriv-viewer-departed-attacker';
  const namedCard = pin(detail.card).card;
  const viewerScenario = !scriv;
  const cards: OracleCard[] = [
    namedCard,
    pin('Marchesa, the Black Rose').card,
    pin('Namor, Atlantean King').card,
    pin('Scriv, the Obligator').card,
    pin('Lightning Bolt').card,
    ...(viewerScenario
      ? [pin('Temur Ascendancy').card, pin('Dragon Mage').card, pin('Hunted Phantasm').card]
      : []),
    bear,
    ...Array.from({ length: 12 }, () => basic('Forest')),
    ...Array.from({ length: 12 }, () => basic('Mountain')),
    ...Array.from({ length: 8 }, () => basic('Plains')),
    ...Array.from({ length: 8 }, () => basic('Swamp')),
    ...Array.from({ length: 8 }, () => basic('Island')),
  ];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `combat-trigger-${seat}`,
    commanders: [],
    cards,
  }));
  const seed = `card-lab-${id}-v3`;
  const viewerBasics = [
    'Plains',
    'Island',
    'Island',
    'Swamp',
    'Mountain',
    'Mountain',
    'Forest',
    'Forest',
  ];
  const battlefield = scriv
    ? [
        {
          playerId: 'P1' as const,
          cardNames: ['Plains', 'Swamp', 'Forest', 'Forest', 'Mountain', 'Mountain'],
        },
        { playerId: 'P2' as const, cardNames: ['Lab Bear'] },
      ]
    : [
        {
          playerId: 'P1' as const,
          cardNames: [
            ...viewerBasics,
            'Temur Ascendancy',
            ...(namor || id === 'marchesa-viewer-granted-dethrone' ? ['Lab Bear'] : []),
          ],
        },
        { playerId: 'P2' as const, cardNames: ['Forest'] },
        ...(boltResponse ? [{ playerId: 'P3' as const, cardNames: ['Mountain'] }] : []),
      ];
  const humanHand = scriv
    ? ['Scriv, the Obligator', 'Lightning Bolt']
    : id === 'dragon-mage-viewer-normal-cast-wheel'
      ? [detail.card, 'Forest']
      : [detail.card];
  const engine = new Engine(
    { gameId, seed, players, turnCap: 3 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        lifeTotals: [
          { playerId: 'P1', life: 20 },
          {
            playerId: 'P2',
            life: marchesa ? (id.endsWith('negative') ? 39 : 41) : namor ? 41 : 40,
          },
          { playerId: 'P3', life: 40 },
          { playerId: 'P4', life: 40 },
        ],
        hand: [
          ...(humanHand.length ? [{ playerId: 'P1' as const, cardNames: humanHand }] : []),
          ...(boltResponse && !scriv
            ? [{ playerId: 'P3' as const, cardNames: ['Lightning Bolt'] }]
            : []),
          ...(id === 'dragon-mage-viewer-normal-cast-wheel'
            ? (['P2', 'P3', 'P4'] as const).map((playerId) => ({
                playerId,
                cardNames: ['Forest'],
              }))
            : []),
        ],
        battlefield,
        ...(scriv
          ? {
              continueThroughNextTurn: true,
              continueThroughCombat: true,
              continueToPostcombatMain: true,
              continueToEndStep: true,
            }
          : { continueThroughCombat: true }),
      },
    },
  );
  const seats = players.map((config) => ({
    seat: config.id,
    config,
    deckSnapshotId: null,
    summary: {
      seat: config.id,
      deckId: config.deckId,
      label: config.id === 'P1' ? 'Card Test Lab' : `Deterministic opponent ${config.id}`,
      commanderNames: [],
      colorIdentity: [],
      archetypeTag: 'card-test-lab',
    },
  }));
  const p3Provider = response
    ? responder(
        marchesa ? 'P2' : 'Namor, Atlantean King',
        () =>
          engine
            .getState()
            .battlefield.find((permanent) => permanent.name === 'Namor, Atlantean King')?.id,
      )
    : passing();
  return {
    metadata: {
      id,
      version: 3,
      title: detail.title,
      instructions: detail.instructions,
      expectedOutcome: detail.expected,
      oracleSha256: pin(detail.card).sha256,
      clauseIds: [detail.clause],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: scriv
      ? { P2: attacker(id.endsWith('departed-attacker') ? 'P3' : 'P1') }
      : { P2: passing(), P3: p3Provider, P4: passing() },
  };
}
