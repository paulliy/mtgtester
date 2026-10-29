/**
 * The table frame scan can fail: each rule is run against a frame that breaks it, and a clean
 * sequence passes. The scan over real worker traffic is in `scripted-run.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { PLAYER_HALT_TEXT } from '@mtg/engine';
import type { PlayerId } from '@mtg/shared';
import { scanTableFrames, type FrameScanRule, type RecordedFrame } from './frame-scan';

const KEY = 'c3'.repeat(32);

function frames(...list: Array<[PlayerId | 'host', object]>): RecordedFrame[] {
  return list.map(([to, message], order) => ({ to, text: JSON.stringify(message), order }));
}

const board = (seat: PlayerId, hand: string[]) => ({
  type: 'playerStateSnapshot',
  payload: {
    revision: 1,
    state: { seed: '', seats: [{ seat, hand: hand.map((id) => ({ id })) }] },
  },
});

const decision = (requestId: string, data = false) => ({
  type: 'playerActionRequired',
  payload: {
    revision: 1,
    request: {
      requestId,
      legalActions: [{ id: 0, type: 'pass', ...(data && { data: { x: 1 } }) }],
    },
    state: { seed: '', seats: [] },
  },
});

function rules(list: RecordedFrame[], rawSeats?: ReadonlySet<PlayerId>): FrameScanRule[] {
  return scanTableFrames(list, {
    rngKey: KEY,
    protocolVersion: 1,
    ...(rawSeats !== undefined && { rawActionDataSeats: rawSeats }),
  }).violations.map((violation) => violation.rule);
}

describe('scanTableFrames', () => {
  it('passes a clean game, results and replay included', () => {
    const report = scanTableFrames(
      frames(
        ['P1', { type: 'gameStarted', payload: { seed: '' } }],
        ['P1', board('P1', ['o1'])],
        ['P2', board('P2', ['o2'])],
        ['P1', decision('q1')],
        ['P1', decision('q1')],
        ['P1', decision('q2')],
        ['P1', { type: 'gameOver', payload: {} }],
        ['P1', { type: 'tableResults', payload: { rngKey: KEY } }],
        ['P1', { type: 'replayTurnState', payload: { turn: 1, state: { seed: 'x' } } }],
      ),
      { rngKey: KEY, protocolVersion: 1 },
    );
    expect(report.violations).toEqual([]);
    expect(report.handIdsTracked).toBe(2);
  });

  it('finds the key in a live frame', () => {
    expect(rules(frames(['P1', { type: 'eventBatch', payload: { lines: [KEY] } }]))).toEqual([
      'key',
    ]);
  });

  it('finds a seed in a start frame or a board', () => {
    expect(rules(frames(['P1', { type: 'gameStarted', payload: { seed: 's' } }]))).toEqual([
      'seed',
    ]);
    expect(
      rules(frames(['P1', { type: 'playerStateSnapshot', payload: { state: { seed: 's' } } }])),
    ).toEqual(['seed']);
  });

  it('finds a full-state frame before the seat saw gameOver', () => {
    expect(rules(frames(['P1', { type: 'replayUnlocked', payload: {} }]))).toEqual(['fullState']);
    // A seat that was away at the end gets the record on return, after the game was over.
    expect(
      rules(
        frames(
          ['P2', { type: 'gameOver', payload: {} }],
          ['P1', { type: 'tableResults', payload: {} }],
        ),
      ),
    ).toEqual([]);
  });

  it('finds tester-only frame types', () => {
    for (const type of ['stateSnapshot', 'debugEvents', 'apiWaiting', 'decisionPending']) {
      expect(rules(frames(['P1', { type, payload: {} }])), type).toEqual(['forbiddenType']);
    }
  });

  it('finds a note key, raw halt text and an engine request id', () => {
    expect(rules(frames(['P1', { type: 'error', payload: { a: [{ note: 'x' }] } }]))).toEqual([
      'noteKey',
    ]);
    expect(
      rules(frames(['P1', { type: 'eventBatch', payload: { t: 'ENGINE HALT — TypeError at x' } }])),
    ).toEqual(['rawHaltText']);
    expect(
      rules(
        frames(['P1', { type: 'eventBatch', payload: { t: `ENGINE HALT — ${PLAYER_HALT_TEXT}` } }]),
      ),
    ).toEqual([]);
    expect(rules(frames(['P1', decision('g1-t3-d17')]))).toEqual([
      'engineRequestId',
      'requestOrder',
    ]);
  });

  it('finds request ids out of order', () => {
    expect(rules(frames(['P1', decision('q1')], ['P1', decision('q3')]))).toEqual(['requestOrder']);
  });

  it("finds another seat's hand id", () => {
    expect(
      rules(
        frames(['P1', board('P1', ['o7'])], ['P2', { type: 'eventBatch', payload: { id: 'o7' } }]),
      ),
    ).toEqual(['otherSeatHand']);
  });

  it('finds raw action data sent to a seat that did not ask', () => {
    expect(rules(frames(['P1', decision('q1', true)]), new Set<PlayerId>(['P2']))).toEqual([
      'rawData',
    ]);
    expect(rules(frames(['P1', decision('q1', true)]), new Set<PlayerId>(['P1']))).toEqual([]);
  });
});
