import type {
  Deal,
  DealObligation,
  DecisionRequest,
  LegalAction,
  OpponentView,
  PermanentView,
  PlayerId,
  PlayerView,
} from '@mtg/shared';

/** Shared builders for the diplomacy tests. Not a test file itself. */

let nextId = 1;

export function creature(
  controller: PlayerId,
  power: number,
  toughness = power,
  extra: Partial<PermanentView> = {},
): PermanentView {
  return {
    id: `c${nextId++}`,
    controller,
    name: `Creature ${power}/${toughness}`,
    typeLine: 'Creature — Test',
    power,
    toughness,
    keywords: [],
    tapped: false,
    status: [],
    ...extra,
  };
}

export function planeswalker(controller: PlayerId): PermanentView {
  return {
    id: `pw${nextId++}`,
    controller,
    name: 'Test Walker',
    typeLine: 'Legendary Planeswalker — Test',
    tapped: false,
    status: [],
  };
}

export function opponent(
  seat: PlayerId,
  life: number,
  extra: Partial<OpponentView> = {},
): OpponentView {
  return {
    seat,
    life,
    handSize: 3,
    librarySize: 60,
    graveyard: [],
    commanders: [],
    poisonCounters: 0,
    commanderDamageDealtToYou: 0,
    ...extra,
  };
}

export function view(
  seat: PlayerId,
  life: number,
  opponents: OpponentView[],
  battlefield: PermanentView[] = [],
  extra: Partial<PlayerView> = {},
): PlayerView {
  return {
    seat,
    life,
    hand: [
      { id: `${seat}-h1`, name: 'Card' },
      { id: `${seat}-h2`, name: 'Card' },
      { id: `${seat}-h3`, name: 'Card' },
    ],
    deck: [],
    graveyard: [],
    exile: [],
    availableMana: {},
    manaSources: [],
    commanders: [],
    battlefield,
    stack: [],
    recentLog: [],
    opponents,
    ...extra,
  };
}

export function request(
  decidingPlayer: PlayerId,
  legalActions: LegalAction[],
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 5,
    activePlayer: decidingPlayer,
    decidingPlayer,
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose',
    legalActions,
    ...overrides,
  };
}

/** A batched attack declaration: one slot per attacker, each with these options. */
export function attackAction(
  attackers: readonly PermanentView[],
  options: (attacker: PermanentView) => string[],
): LegalAction {
  return {
    id: 7,
    type: 'attackDeclaration',
    description: 'Declare attackers',
    data: {
      subjects: attackers.map((a) => ({
        subjectId: a.id,
        power: a.power,
        toughness: a.toughness,
        hasTriggers: false,
        mustAttack: false,
      })),
    },
    targets: attackers.map((a, i) => ({ slot: i, options: options(a) })),
  };
}

export function deal(
  parties: [PlayerId, PlayerId],
  obligations: DealObligation[],
  rounds = 1,
  id = 'd1',
): Deal {
  return {
    id,
    proposer: parties[0],
    parties,
    obligations,
    proposedTurn: 5,
    rounds,
    status: 'proposed',
  };
}
