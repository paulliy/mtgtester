import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { adaptJevActionAnswer, buildJevActionRequest } from './jev-context';
import { classifyTacticalDecision, JEV_MAX_CHOICE_OPTIONS } from './tactical-decision-shape';

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: 'request-1',
    gameId: 'game-1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose an action.',
    legalActions: [
      { id: 3, type: 'pass', description: 'Pass priority' },
      { id: 9, type: 'castSpell', description: 'Cast removal' },
    ],
    ...overrides,
  };
}

function view(): PlayerView {
  return {
    seat: 'P1',
    life: 20,
    hand: [],
    deck: [],
    graveyard: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    opponents: [],
    revealedLibraryTops: [],
    battlefield: [],
    exile: [],
    stack: [],
    recentLog: [],
  };
}

describe('Jev tactician decision contract', () => {
  it('round-trips non-contiguous action ids without a chat primer', () => {
    const built = buildJevActionRequest('typesafe/jev-1.13', request(), view());
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') return;

    expect(built.optionToActionId).toEqual({ action_3: 3, action_9: 9 });
    expect(built.request.state).not.toHaveProperty('legalActions');
    expect(JSON.stringify(built.request)).not.toContain('REQUIRED JSON OUTPUT FORMAT');
    expect(
      adaptJevActionAnswer(built, request(), {
        type: 'choice',
        choice: 'action_9',
        confidence: 0.8,
        probabilities: { action_3: 0.1, action_9: 0.9 },
      }),
    ).toMatchObject({
      kind: 'accepted',
      response: { requestId: 'request-1', actionId: 9 },
      topTwoMargin: 0.8,
    });
  });

  it('fills only mechanically forced targets', () => {
    const targeted = request({
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        {
          id: 4,
          type: 'castSpell',
          description: 'Cast removal',
          targets: [{ slot: 0, options: ['only-target'] }],
        },
      ],
    });
    const built = buildJevActionRequest('typesafe/jev-1.13', targeted, view());
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') return;

    expect(
      adaptJevActionAnswer(built, targeted, {
        type: 'choice',
        choice: 'action_4',
        confidence: 1,
        probabilities: { action_0: 0, action_4: 1 },
      }),
    ).toMatchObject({
      kind: 'accepted',
      response: {
        requestId: 'request-1',
        actionId: 4,
        targets: [{ slot: 0, choice: 'only-target' }],
      },
    });
  });

  it('bypasses Jev for ambiguous and coupled response shapes', () => {
    expect(
      classifyTacticalDecision(
        request({
          legalActions: [
            {
              id: 1,
              type: 'castSpell',
              description: 'Cast removal',
              targets: [{ slot: 0, options: ['a', 'b'] }],
            },
          ],
        }),
      ),
    ).toMatchObject({ shape: 'ambiguous_targets', jevSupported: false });
    expect(classifyTacticalDecision(request({ decisionType: 'declareAttackers' }))).toMatchObject({
      shape: 'coupled_assignment',
      jevSupported: false,
    });
    expect(
      classifyTacticalDecision(request({ manaSplit: { amount: 3, colors: ['R', 'G'] } })),
    ).toMatchObject({ shape: 'distribution', jevSupported: false });
  });

  it('rejects menus beyond the Choice option limit', () => {
    const legalActions = Array.from({ length: JEV_MAX_CHOICE_OPTIONS + 1 }, (_, id) => ({
      id,
      type: 'choice',
      description: `Choice ${id}`,
    }));
    expect(classifyTacticalDecision(request({ legalActions }))).toMatchObject({
      shape: 'too_many_actions',
      jevSupported: false,
    });
  });

  it('honors a stricter configured action limit', () => {
    const original = request();
    original.legalActions.push({ id: 10, type: 'pass', description: 'Another pass' });
    expect(
      buildJevActionRequest('typesafe/jev-1.13', original, view(), undefined, {}, 2),
    ).toMatchObject({
      kind: 'unsupported',
      classification: { shape: 'too_many_actions' },
    });
  });

  it('rejects stale choices and malformed probability distributions', () => {
    const original = request();
    const built = buildJevActionRequest('typesafe/jev-1.13', original, view());
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') return;

    expect(
      adaptJevActionAnswer(built, original, {
        type: 'choice',
        choice: 'action_99',
        confidence: 0.9,
        probabilities: { action_3: 0.1, action_9: 0.9 },
      }),
    ).toEqual({ kind: 'invalid', reason: 'choice is not a legal action key' });
    expect(
      adaptJevActionAnswer(built, original, {
        type: 'choice',
        choice: 'action_9',
        confidence: 0.9,
        probabilities: { action_3: 0.1, action_9: 0.7 },
      }),
    ).toEqual({ kind: 'invalid', reason: 'probabilities must sum to 1' });
  });

  describe('target expansion', () => {
    const removal = (targets: Array<{ slot: number; options: string[] }>): DecisionRequest =>
      request({
        legalActions: [
          { id: 3, type: 'pass', description: 'Pass priority' },
          { id: 9, type: 'castSpell', description: 'Cast removal', targets },
        ],
      });

    it('offers one option per legal target and submits the chosen target', () => {
      const original = removal([{ slot: 0, options: ['c1', 'c2'] }]);
      const withNames: PlayerView = {
        ...view(),
        battlefield: [
          {
            id: 'c1',
            name: 'Grizzly Bears',
            controller: 'P2',
            status: [],
          } as unknown as PlayerView['battlefield'][0],
        ],
      };
      const built = buildJevActionRequest(
        'typesafe/jev-1.13',
        original,
        withNames,
        undefined,
        {},
        undefined,
        { expandTargets: true },
      );
      expect(built.kind).toBe('ready');
      if (built.kind !== 'ready') return;
      expect(built.classification).toMatchObject({ shape: 'expanded_targets', optionCount: 3 });
      expect(Object.keys(built.request.questions.action.criteria)).toEqual([
        'action_3',
        'action_9_t0',
        'action_9_t1',
      ]);
      expect(built.request.questions.action.criteria['action_9_t0']?.target).toMatchObject({
        id: 'c1',
        name: 'Grizzly Bears',
        controller: 'P2',
      });
      expect(
        adaptJevActionAnswer(built, original, {
          type: 'choice',
          choice: 'action_9_t1',
          probabilities: { action_9_t1: 0.7, action_9_t0: 0.2, action_3: 0.1 },
        }),
      ).toMatchObject({
        kind: 'accepted',
        response: { actionId: 9, targets: [{ slot: 0, choice: 'c2' }] },
        confidence: 0.7,
      });
    });

    it('keeps forced slots and refuses two undecided slots or a possible repeat', () => {
      const forcedPlusOpen = removal([
        { slot: 0, options: ['me'] },
        { slot: 1, options: ['c1', 'c2'] },
      ]);
      expect(
        classifyTacticalDecision(forcedPlusOpen, undefined, { expandTargets: true }),
      ).toMatchObject({ shape: 'expanded_targets', optionCount: 3 });
      expect(
        classifyTacticalDecision(
          removal([
            { slot: 0, options: ['c1', 'c2'] },
            { slot: 1, options: ['c3', 'c4'] },
          ]),
          undefined,
          { expandTargets: true },
        ),
      ).toMatchObject({ shape: 'ambiguous_targets', jevSupported: false });
      expect(
        classifyTacticalDecision(
          removal([
            { slot: 0, options: ['c1'] },
            { slot: 1, options: ['c1', 'c2'] },
          ]),
          undefined,
          { expandTargets: true },
        ),
      ).toMatchObject({ shape: 'ambiguous_targets', jevSupported: false });
    });

    it('stays within the option limit after expansion', () => {
      expect(
        classifyTacticalDecision(removal([{ slot: 0, options: ['a', 'b', 'c'] }]), 3, {
          expandTargets: true,
        }),
      ).toMatchObject({ shape: 'ambiguous_targets', jevSupported: false });
    });
  });

  it('accepts unscored answers and partial probabilities', () => {
    const original = request();
    const built = buildJevActionRequest('typesafe/jev-1.13', original, view());
    if (built.kind !== 'ready') throw new Error('expected ready');
    expect(adaptJevActionAnswer(built, original, { type: 'choice', choice: 'action_9' })).toEqual({
      kind: 'accepted',
      response: { requestId: 'request-1', actionId: 9 },
      confidence: null,
      probabilities: {},
      topTwoMargin: null,
    });
    expect(
      adaptJevActionAnswer(built, original, {
        type: 'choice',
        choice: 'action_9',
        probabilities: { action_9: 0.6 },
      }),
    ).toMatchObject({ kind: 'accepted', confidence: 0.6, topTwoMargin: 0.6 });
    expect(
      adaptJevActionAnswer(built, original, {
        type: 'choice',
        choice: 'action_9',
        probabilities: { action_9: 0.6, action_77: 0.1 },
      }),
    ).toEqual({ kind: 'invalid', reason: 'probability options do not match the legal action map' });
  });
});
