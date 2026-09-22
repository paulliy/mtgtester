import type {
  DecisionRequest,
  PermanentView,
  PlayerView,
  PublicPermanentCapabilities,
} from '@mtg/shared';

export const request: DecisionRequest = {
  requestId: 'threat-fixture',
  gameId: 'threat-game',
  turn: 8,
  phase: 'precombatMain',
  step: null,
  activePlayer: 'P2',
  decidingPlayer: 'P1',
  decisionType: 'priority',
  prompt: 'Choose.',
  legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
};
export function capabilities(
  over: Partial<PublicPermanentCapabilities> = {},
): PublicPermanentCapabilities {
  return {
    creature: true,
    attacking: null,
    cantBlock: false,
    cantBeBlocked: false,
    commanderId: null,
    mana: [],
    engines: [],
    unsupported: [],
    ...over,
  };
}
export function permanent(
  id: string,
  controller = 'P2',
  power = 5,
  over: Partial<PermanentView> = {},
): PermanentView {
  return {
    id,
    controller,
    name: id,
    power,
    toughness: 5,
    tapped: false,
    status: [],
    keywords: [],
    capabilities: capabilities(),
    ...over,
  };
}
export function fixtureView(): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [],
    deck: [],
    graveyard: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    exile: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    opponents: ['P2', 'P3', 'P4'].map((seat) => ({
      seat,
      life: 40,
      handSize: 2,
      librarySize: 60,
      graveyard: [],
      commanders: [],
      poisonCounters: 0,
      commanderDamageDealtToYou: 0,
    })),
    threatFacts: {
      sequence: 80,
      turn: 8,
      phase: 'precombatMain',
      step: null,
      activePlayer: 'P2',
      turnOrder: ['P1', 'P2', 'P3', 'P4'],
      pressure: [],
      pressureTruncated: false,
      players: ['P1', 'P2', 'P3', 'P4'].map((seat) => ({ seat, poison: 0, commanderDamage: {} })),
      rules: { poisonLoss: 10, commanderDamageLoss: 21 },
      unsupported: ['combo-search', 'alternative-wins'],
    },
  };
}

/** Hand-authored DEVELOPMENT positions. They are not a held-out/reviewed quality benchmark. */
export interface ThreatCase {
  name: string;
  category: string;
  view: PlayerView;
  acceptable: string[];
  urgent: string[];
}
export function developmentCases(): ThreatCase[] {
  const cases: ThreatCase[] = [];
  const add = (
    name: string,
    category: string,
    change: (v: PlayerView) => void,
    acceptable: string[],
    urgent: string[] = [],
  ) => {
    const view = fixtureView();
    change(view);
    cases.push({ name, category, view, acceptable, urgent });
  };
  add('equal empty boards', 'ties', () => {}, ['P2', 'P3', 'P4']);
  add(
    'large ready board',
    'combat',
    (v) => {
      v.battlefield = [permanent('giant', 'P2', 30)];
    },
    ['P2'],
  );
  add(
    'tapped board',
    'availability',
    (v) => {
      v.battlefield = [
        permanent('tapped', 'P2', 30, { tapped: true }),
        permanent('ready', 'P3', 15),
      ];
    },
    ['P3'],
  );
  add(
    'summoning sickness',
    'availability',
    (v) => {
      v.battlefield = [
        permanent('sick', 'P2', 30, { status: ['summoningSick'] }),
        permanent('ready', 'P3', 15),
      ];
    },
    ['P3'],
  );
  add(
    'periodic engine vs inert tokens',
    'engines',
    (v) => {
      v.battlefield = [
        permanent('engine', 'P2', 0, {
          capabilities: capabilities({
            engines: [{ kind: 'draw', amount: 6, horizon: 'controller-turn' }],
          }),
        }),
        ...Array.from({ length: 10 }, (_, i) => permanent(`inert-${i}`, 'P3', 0)),
      ];
    },
    ['P2'],
  );
  add(
    'large unknown hand',
    'hand',
    (v) => {
      v.opponents[1]!.handSize = 20;
    },
    ['P3'],
  );
  add(
    'high life inactive',
    'life',
    (v) => {
      v.opponents[0]!.life = 1000;
      v.battlefield = [permanent('active', 'P3', 25)];
    },
    ['P3'],
  );
  add(
    'low life lethal source',
    'stack',
    (v) => {
      v.opponents[0]!.life = 1;
      v.stack = [
        {
          id: 'burn',
          controller: 'P2',
          description: 'damage',
          targets: ['P1'],
          impacts: [{ source: 'burn', recipient: 'P1', amount: 40, kind: 'damage' }],
        },
      ];
    },
    ['P2'],
    ['P2'],
  );
  add(
    'historical aggression after wipe',
    'history',
    (v) => {
      v.threatFacts!.pressure = [
        { sequence: 50, turn: 7, actor: 'P2', recipient: 'P1', amount: 20, kind: 'combat' },
      ];
      v.battlefield = [permanent('new-board', 'P3', 25)];
    },
    ['P3'],
  );
  add(
    'eliminated source',
    'elimination',
    (v) => {
      v.threatFacts!.turnOrder = ['P1', 'P3', 'P4'];
      v.battlefield = [permanent('ghost', 'P2', 100), permanent('survivor', 'P3', 10)];
    },
    ['P3'],
  );
  add(
    'declared lethal to us',
    'combat-urgency',
    (v) => {
      v.threatFacts!.phase = 'combat';
      v.threatFacts!.step = 'declareBlockers';
      v.battlefield = [
        permanent('lethal', 'P2', 40, {
          tapped: true,
          capabilities: capabilities({ attacking: 'P1' }),
        }),
      ];
    },
    ['P2'],
    ['P2'],
  );
  add(
    'declared lethal to other seat',
    'direction',
    (v) => {
      v.threatFacts!.phase = 'combat';
      v.threatFacts!.step = 'declareBlockers';
      v.battlefield = [
        permanent('lethal', 'P3', 40, {
          tapped: true,
          capabilities: capabilities({ attacking: 'P4' }),
        }),
      ];
    },
    ['P3'],
    ['P3'],
  );
  add(
    'unknown scary text',
    'unsupported',
    (v) => {
      v.battlefield = [
        permanent('unknown', 'P2', 0, {
          oracleText: 'Win the game.',
          capabilities: capabilities({ unsupported: ['unmodeled-card'] }),
        }),
      ];
    },
    ['P2', 'P3', 'P4'],
  );
  add(
    'earlier stack deadline',
    'deadlines',
    (v) => {
      v.threatFacts!.phase = 'combat';
      v.threatFacts!.step = 'declareBlockers';
      v.battlefield = [
        permanent('combat', 'P3', 40, { capabilities: capabilities({ attacking: 'P1' }) }),
      ];
      v.stack = [
        {
          id: 'burn',
          controller: 'P2',
          description: 'damage',
          targets: ['P1'],
          impacts: [{ source: 'burn', recipient: 'P1', amount: 40, kind: 'damage' }],
        },
      ];
    },
    ['P2'],
    ['P2', 'P3'],
  );
  add(
    'third party counter intervention',
    'intervention',
    (v) => {
      v.stack = [
        {
          id: 'burn',
          controller: 'P2',
          description: 'damage',
          targets: ['P1'],
          impacts: [{ source: 'burn', recipient: 'P1', amount: 40, kind: 'damage' }],
        },
        {
          id: 'counter',
          controller: 'P3',
          description: 'Counter burn',
          targets: ['burn'],
          impacts: [],
        },
      ];
    },
    ['P2'],
    ['P2'],
  );
  add(
    'rainbow source counts once',
    'mana',
    (v) => {
      v.battlefield = [
        permanent('rainbow', 'P2', 0, {
          capabilities: capabilities({
            creature: false,
            mana: [{ units: [['W', 'U', 'B', 'R', 'G']], available: true, restricted: false }],
          }),
        }),
      ];
    },
    ['P2', 'P3', 'P4'],
  );
  return cases;
}
