/**
 * The client→server runtime guard. The union in `protocol.ts` is erased at runtime, and the
 * server must never trust a socket frame (brief §11), so the discriminant is checked here.
 */

import { describe, expect, it } from 'vitest';
import { CLIENT_TO_SERVER_TYPES, SERVER_TO_CLIENT_TYPES, isClientToServerMessage } from './protocol';

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
  it('accepts every declared client message', () => {
    const messages = [
      { type: 'startGame', payload: { seats: [{ kind: 'pool' }], providerKind: 'random' } },
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
    expect(messages.map(isClientToServerMessage)).toEqual(
      CLIENT_TO_SERVER_TYPES.map(() => true),
    );
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
