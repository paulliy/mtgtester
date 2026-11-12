import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PermanentView, PlayerView } from '@mtg/shared';
import type { CardKnowledge, CardTraits } from '@mtg/bot';
import { isUncertain } from './bot-tactician';
import { attribute, firedTriggers, type TriggerInput } from './escalation';

const creature = (
  id: string,
  controller: string,
  power: number,
  extra: Partial<PermanentView> = {},
): PermanentView => ({
  id,
  controller,
  name: `Bear ${id}`,
  typeLine: 'Creature — Bear',
  power,
  toughness: power,
  tapped: false,
  status: [],
  ...extra,
});

function view(overrides: Partial<PlayerView>): PlayerView {
  return {
    seat: 'P1',
    life: 30,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    opponents: [
      {
        seat: 'P2',
        life: 2,
        handSize: 0,
        librarySize: 50,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
      {
        seat: 'P3',
        life: 30,
        handSize: 3,
        librarySize: 50,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
    battlefield: [],
    stack: [],
    recentLog: [],
    ...overrides,
  };
}

const request = (overrides: Partial<DecisionRequest>): DecisionRequest => ({
  requestId: 'r',
  gameId: 'g',
  turn: 5,
  activePlayer: 'P1',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: '',
  legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
  ...overrides,
});

const knowledge: CardKnowledge = (name) =>
  name === 'Mystery Spell'
    ? ({ manaValue: 2, types: ['Sorcery'], roles: [], unclassified: true } as CardTraits)
    : undefined;

function fire(input: Partial<TriggerInput> & Pick<TriggerInput, 'request' | 'view'>) {
  return firedTriggers({
    response: { requestId: 'r', actionId: 0 },
    ranked: [],
    knowledge,
    margin: 1,
    isUncertain,
    ...input,
  });
}

describe('lethal (shadow)', () => {
  it('fires when the seat passes on its own turn with a kill on the board', () => {
    const v = view({ battlefield: [creature('a', 'P1', 3)] });
    expect(fire({ request: request({}), view: v })).toContain('lethal');
  });

  it('does not fire when no kill is available, or once combat is over', () => {
    const v = view({ battlefield: [creature('a', 'P1', 1)] });
    expect(fire({ request: request({}), view: v })).not.toContain('lethal');
    const late = view({ battlefield: [creature('a', 'P1', 3)] });
    expect(fire({ request: request({ phase: 'postcombatMain' }), view: late })).not.toContain(
      'lethal',
    );
  });

  it('fires when the seat passes while the attack on it is lethal as blocks stand', () => {
    const v = view({
      life: 3,
      battlefield: [creature('x', 'P3', 4, { attacking: 'P1', tapped: true })],
    });
    const r = request({ activePlayer: 'P3', phase: 'combat', step: 'declareBlockers' });
    expect(fire({ request: r, view: v })).toContain('lethal');
  });

  it('fires on blocks that leave lethal unblocked, not on blocks that stop it', () => {
    const v = view({
      life: 3,
      battlefield: [
        creature('x', 'P3', 4, { attacking: 'P1', tapped: true }),
        creature('b', 'P1', 2),
      ],
    });
    const block = {
      id: 0,
      type: 'blockDeclaration',
      description: 'Declare blockers',
      targets: [{ slot: 0, options: ['x', '__no_block__'] }],
    };
    const r = request({
      activePlayer: 'P3',
      phase: 'combat',
      step: 'declareBlockers',
      decisionType: 'declareBlockers',
      legalActions: [block],
    });
    const none = { requestId: 'r', actionId: 0, targets: [{ slot: 0, choice: '__no_block__' }] };
    const blocked = { requestId: 'r', actionId: 0, targets: [{ slot: 0, choice: 'x' }] };
    expect(fire({ request: r, view: v, response: none })).toContain('lethal');
    expect(fire({ request: r, view: v, response: blocked })).not.toContain('lethal');
  });
});

describe('unknown-card on an opposing spell', () => {
  it('fires once per stack object, not at every priority it sits there', () => {
    const seen = new Set<string>();
    const firstSightOf = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    };
    const v = view({
      stack: [{ id: 's1', controller: 'P3', description: 'Mystery Spell', targets: [] }],
    });
    const r = request({ activePlayer: 'P3' });
    expect(fire({ request: r, view: v, firstSightOf })).toEqual(['unknown-card']);
    expect(fire({ request: r, view: v, firstSightOf })).toEqual([]);
  });
});

describe('attribution', () => {
  it('credits the first live trigger, and never a shadow one', () => {
    expect(attribute(['unknown-card', 'uncertain', 'lethal'], ['uncertain'])).toBe('uncertain');
    expect(attribute(['scarce-answer', 'uncertain'], ['uncertain', 'scarce-answer'])).toBe(
      'scarce-answer',
    );
    expect(attribute(['lethal'], ['uncertain'])).toBeNull();
  });
});
