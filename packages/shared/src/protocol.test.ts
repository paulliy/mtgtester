/**
 * The client→server runtime guard. The union in `protocol.ts` is erased at runtime, and the
 * server must never trust a socket frame (brief §11), so the discriminant is checked here.
 */

import { describe, expect, it } from 'vitest';
import { CLIENT_TO_SERVER_TYPES, SERVER_TO_CLIENT_TYPES, isClientToServerMessage } from './protocol';

describe('protocol message names', () => {
  it('matches the eight server and five client messages of brief §11', () => {
    expect([...SERVER_TO_CLIENT_TYPES]).toEqual([
      'gameStarted',
      'stateSnapshot',
      'eventBatch',
      'decisionPending',
      'computeHalted',
      'apiWaiting',
      'gameOver',
      'error',
    ]);
    expect([...CLIENT_TO_SERVER_TYPES]).toEqual([
      'startGame',
      'jumpToTurn',
      'setPlaybackMode',
      'resolveHeldDecision',
      'abandonGame',
    ]);
  });
});

describe('isClientToServerMessage', () => {
  it('accepts every declared client message', () => {
    for (const type of CLIENT_TO_SERVER_TYPES) {
      expect(isClientToServerMessage({ type, payload: {} })).toBe(true);
    }
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
