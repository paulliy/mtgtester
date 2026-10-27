/**
 * The client→server runtime guard. The union in `protocol.ts` is erased at runtime, and the
 * server must never trust a socket frame (brief §11), so the discriminant is checked here.
 */

import { describe, expect, it } from 'vitest';
import {
  CLIENT_TO_SERVER_TYPES,
  SERVER_TO_CLIENT_TYPES,
  isClientToServerMessage,
} from './protocol';

describe('protocol message names', () => {
  it('includes the Phase 5 debug-stream extension alongside the brief §11 messages', () => {
    // `gameReflections` is the one addition ADR 0012's "ride on an existing payload" rule does not
    // cover: commentary arrives *after* `gameOver` by design, so it cannot be a field on it.
    expect([...SERVER_TO_CLIENT_TYPES]).toEqual([
      'gameStarted',
      'stateSnapshot',
      'eventBatch',
      'decisionPending',
      'computeHalted',
      'apiWaiting',
      'debugEvents',
      'playerStateSnapshot',
      'playerActionRequired',
      'sessionPaused',
      'replayUnlocked',
      'gameOver',
      'gameReflections',
      'error',
    ]);
    expect([...CLIENT_TO_SERVER_TYPES]).toEqual([
      'startGame',
      'startCardTestScenario',
      'jumpToTurn',
      'setPlaybackMode',
      'resolveHeldDecision',
      'abandonGame',
      'setDebugFlags',
      'submitPlayerAction',
      'yieldPlayerAbility',
      'resumePlayerAbility',
      'cancelYield',
      'resumeGame',
    ]);
  });
});

describe('isClientToServerMessage', () => {
  it('accepts saved snapshots and a preview-bound start, rejecting malformed IDs', () => {
    const payload = {
      seats: [
        { kind: 'snapshot', snapshotId: 'stable-id' },
        ...Array.from({ length: 3 }, () => ({ kind: 'pool' })),
      ],
      providerKind: 'random',
      seed: 'fixed',
      previewId: 'preview-id',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
    };
    expect(isClientToServerMessage({ type: 'startGame', payload })).toBe(true);
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: { ...payload, seats: [{ kind: 'snapshot', snapshotId: '' }] },
      }),
    ).toBe(false);
    expect(
      isClientToServerMessage({ type: 'startGame', payload: { ...payload, previewId: 42 } }),
    ).toBe(false);
  });
  it('accepts every declared client message', () => {
    const messages = [
      { type: 'startGame', payload: { seats: [{ kind: 'pool' }], providerKind: 'random' } },
      {
        type: 'startCardTestScenario',
        payload: { scenarioId: 'tribute-viewer-cast-search-select-resolve' },
      },
      { type: 'jumpToTurn', payload: { turn: 2 } },
      { type: 'setPlaybackMode', payload: { mode: 'live' } },
      { type: 'resolveHeldDecision', payload: { requestId: 'r1', actionId: 0 } },
      { type: 'abandonGame', payload: {} },
      {
        type: 'setDebugFlags',
        payload: {
          flags: {
            showAIRequests: false,
            showAIResponses: false,
            showLegalActions: false,
            showSBAChecks: false,
            showPriorityPasses: false,
            showTokenUsage: true,
            verboseEngine: false,
          },
        },
      },
      {
        type: 'submitPlayerAction',
        payload: { requestId: 'r2', actionId: 1, revision: 3 },
      },
      {
        type: 'yieldPlayerAbility',
        payload: { requestId: 'r2', actionId: 1, revision: 3 },
      },
      { type: 'resumePlayerAbility', payload: { key: 'card-1:0' } },
      { type: 'cancelYield', payload: {} },
      { type: 'resumeGame', payload: { sessionToken: 'opaque-token' } },
    ];
    expect(messages.map(isClientToServerMessage)).toEqual(CLIENT_TO_SERVER_TYPES.map(() => true));
  });

  it('rejects malformed player submissions and resume attempts', () => {
    expect(
      isClientToServerMessage({
        type: 'submitPlayerAction',
        payload: { requestId: 'r', actionId: 0 },
      }),
    ).toBe(false);
    expect(isClientToServerMessage({ type: 'resumeGame', payload: { sessionToken: '' } })).toBe(
      false,
    );
    expect(
      isClientToServerMessage({
        type: 'submitPlayerAction',
        payload: {
          requestId: 'r',
          actionId: 0,
          revision: 1,
          targets: [{ slot: 'zero', choice: 'P2' }],
        },
      }),
    ).toBe(false);
  });

  it.each([
    ['submitPlayerAction', { requestId: 'request-1', revision: 3, actionId: 2 }],
    ['yieldPlayerAbility', { requestId: 'request-1', revision: 3, actionId: 2 }],
    ['resolveHeldDecision', { requestId: 'request-1', actionId: 2 }],
  ])('rejects an empty requestId for %s', (type, payload) => {
    expect(isClientToServerMessage({ type, payload })).toBe(true);
    expect(isClientToServerMessage({ type, payload: { ...payload, requestId: '' } })).toBe(false);
    expect(isClientToServerMessage({ type, payload: { ...payload, requestId: ' ' } })).toBe(true);
  });

  it('accepts only declared submitPlayerAction payload and target fields', () => {
    const payload = {
      requestId: 'request-1',
      revision: 3,
      actionId: 2,
      targets: [{ slot: 0, choice: 'P2' }],
    };
    const submission = (value: unknown) =>
      isClientToServerMessage({ type: 'submitPlayerAction', payload: value });

    expect(submission(payload)).toBe(true);
    expect(submission({ requestId: 'request-1', revision: 3, actionId: 2 })).toBe(true);
    expect(submission({ ...payload, unexpected: true })).toBe(false);
    expect(submission({ ...payload, manaSplit: { G: 1 } })).toBe(false);
    expect(submission({ ...payload, combatDamageSplit: { P2: 1 } })).toBe(false);
    expect(submission({ ...payload, targets: [{ slot: 0, choice: 'P2', amount: 1 }] })).toBe(false);
  });

  it('accepts smart yield and rejects unknown yield modes and fields', () => {
    const payload = { requestId: 'r1', revision: 1, actionId: 0 };
    const valid = (extra: Record<string, unknown>) =>
      isClientToServerMessage({ type: 'yieldPlayerAbility', payload: { ...payload, ...extra } });
    expect(valid({ mode: 'smart' })).toBe(true);
    expect(valid({ mode: 'always' })).toBe(true);
    expect(valid({})).toBe(true);
    expect(valid({ mode: 'never' })).toBe(false);
    expect(valid({ unexpected: true })).toBe(false);
  });

  it('validates nested and optional payload fields, not only message discriminants', () => {
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: { seats: [{ kind: 'url' }], providerKind: 'random' },
      }),
    ).toBe(false);
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: {
          seats: [{ kind: 'pool' }],
          providerKind: 'random',
          gameMode: 'singlePlayer',
        },
      }),
    ).toBe(false);
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: {
          seats: [{ kind: 'pool' }],
          providerKind: 'random',
          gameMode: 'spectator',
          humanSeat: 'P1',
        },
      }),
    ).toBe(false);
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: {
          seats: [{ kind: 'plaintext', text: '1 Forest' }],
          providerKind: 'random',
          humanSeat: 'P9',
        },
      }),
    ).toBe(false);
    // `reflectionEnabled` turns on billed calls, so a frame must not smuggle in a truthy string.
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: {
          seats: [{ kind: 'pool' }],
          providerKind: 'ai',
          reflectionEnabled: 'yes',
        },
      }),
    ).toBe(false);
    expect(
      isClientToServerMessage({
        type: 'startGame',
        payload: {
          seats: [{ kind: 'pool' }],
          providerKind: 'ai',
          reflectionEnabled: true,
        },
      }),
    ).toBe(true);
    // The diplomacy switch (ADR 0031) is a boolean or absent, nothing else.
    for (const [diplomacy, valid] of [
      [true, true],
      [false, true],
      ['on', false],
      [1, false],
    ] as const) {
      expect(
        isClientToServerMessage({
          type: 'startGame',
          payload: { seats: [{ kind: 'pool' }], providerKind: 'random', diplomacy },
        }),
      ).toBe(valid);
    }
    expect(
      isClientToServerMessage({
        type: 'setPlaybackMode',
        payload: { mode: 'live', paceMs: Number.NaN },
      }),
    ).toBe(false);
    expect(
      isClientToServerMessage({
        type: 'setDebugFlags',
        payload: { flags: { verboseEngine: true } },
      }),
    ).toBe(false);
  });

  it('rejects a server message sent in the wrong direction', () => {
    expect(isClientToServerMessage({ type: 'gameStarted', payload: {} })).toBe(false);
  });

  it('rejects anything that is not a message at all', () => {
    expect(isClientToServerMessage(null)).toBe(false);
    expect(isClientToServerMessage('startGame')).toBe(false);
    expect(isClientToServerMessage(42)).toBe(false);
    expect(isClientToServerMessage([])).toBe(false);
    expect(isClientToServerMessage({ type: 'startGame' })).toBe(false);
    expect(isClientToServerMessage({ type: 'startGame', payload: null })).toBe(false);
    expect(isClientToServerMessage({ payload: {} })).toBe(false);
  });
});

describe('single-player seat identity', () => {
  function startGame(humanSeat: unknown): unknown {
    return {
      type: 'startGame',
      payload: {
        seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
        providerKind: 'random',
        gameMode: 'singlePlayer',
        humanSeat,
      },
    };
  }

  it.each(['P1', 'P2', 'P3', 'P4'])('accepts %s as the human seat', (seat) => {
    expect(isClientToServerMessage(startGame(seat))).toBe(true);
  });

  // The seat is the single-player authorization identity: everything the server will treat as
  // "the requester's own deck" keys on it. A value that only *stringifies* to a seat is not one.
  it.each([
    ['a single-element array', ['P1']],
    ['a nested array', [['P1']]],
    ['an object with a matching toString', { toString: () => 'P1' }],
    ['the number one', 1],
    ['a padded string', ' P1'],
    ['a lowercase seat', 'p1'],
    ['null', null],
    ['undefined', undefined],
    ['a seat-like object', { seat: 'P1' }],
  ])('rejects %s as the human seat', (_case, seat) => {
    expect(isClientToServerMessage(startGame(seat))).toBe(false);
  });
});
