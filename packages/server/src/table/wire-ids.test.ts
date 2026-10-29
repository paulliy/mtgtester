import { describe, it, expect } from 'vitest';
import { WireIds, stableSerialize } from './wire-ids';

describe('request ids', () => {
  it('numbers each seat from its own counter, not the engine ids', () => {
    const ids = new WireIds();
    // Engine ids are global; P1 and P2 interleave.
    expect(ids.surfaceDecision('P1', 'req-7').requestId).toBe('q1');
    expect(ids.surfaceDecision('P2', 'req-8').requestId).toBe('q1');
    expect(ids.surfaceDecision('P1', 'req-31').requestId).toBe('q2');
    expect(ids.surfaceDecision('P2', 'req-90').requestId).toBe('q2');
  });

  it('shows no gap when other seats decide in between', () => {
    const ids = new WireIds();
    ids.surfaceDecision('P1', 'req-1');
    for (let i = 2; i < 40; i++) ids.surfaceDecision('P2', `req-${i}`);
    expect(ids.surfaceDecision('P1', 'req-40').requestId).toBe('q2');
  });

  it('memoizes: a re-sent request keeps its id and does not advance anything', () => {
    const ids = new WireIds();
    const first = ids.surfaceDecision('P1', 'req-1');
    ids.surfaceDecision('P1', 'req-2');
    const revisionBefore = ids.revision('P1');
    const again = ids.surfaceDecision('P1', 'req-1');
    expect(again).toEqual({ requestId: first.requestId, revision: revisionBefore, fresh: false });
    expect(first.fresh).toBe(true);
    expect(ids.surfacedCount('P1')).toBe(2);
    expect(ids.revision('P1')).toBe(revisionBefore);
  });

  it('translates a wire id back to the engine id', () => {
    const ids = new WireIds();
    const { requestId } = ids.surfaceDecision('P1', 'req-7');
    expect(ids.toEngineId('P1', requestId)).toBe('req-7');
  });

  it('keeps a wire id private to its seat', () => {
    const ids = new WireIds();
    ids.surfaceDecision('P1', 'req-7');
    // P2 has surfaced nothing, so P1's `q1` means nothing to it.
    expect(ids.toEngineId('P2', 'q1')).toBeUndefined();
    ids.surfaceDecision('P2', 'req-9');
    expect(ids.toEngineId('P2', 'q1')).toBe('req-9');
    expect(ids.toEngineId('P1', 'q1')).toBe('req-7');
  });

  it('refuses an id that was never issued, and an engine id presented as a wire id', () => {
    const ids = new WireIds();
    ids.surfaceDecision('P1', 'req-7');
    expect(ids.toEngineId('P1', 'q2')).toBeUndefined();
    expect(ids.toEngineId('P1', 'req-7')).toBeUndefined();
  });

  it('does not advance the counter for an auto-passed decision', () => {
    const ids = new WireIds();
    expect(ids.surfaceDecision('P1', 'req-1').requestId).toBe('q1');
    ids.autoPassed('P1');
    ids.autoPassed('P1');
    expect(ids.surfacedCount('P1')).toBe(1);
    expect(ids.autoPassedCount('P1')).toBe(2);
    expect(ids.revision('P1')).toBe(1);
    expect(ids.surfaceDecision('P1', 'req-4').requestId).toBe('q2');
    // Nothing maps for the passed ones.
    expect(ids.mapPendingRequestId('P1', 'req-2')).toBeNull();
  });

  it('maps the report pending request id the same way, and never leaks the engine id', () => {
    const ids = new WireIds();
    const { requestId } = ids.surfaceDecision('P1', 'req-7');
    expect(ids.mapPendingRequestId('P1', 'req-7')).toBe(requestId);
    expect(ids.mapPendingRequestId('P2', 'req-7')).toBeNull(); // not shown to P2
    expect(ids.mapPendingRequestId('P1', 'req-99')).toBeNull(); // never surfaced
    expect(ids.mapPendingRequestId('P1', null)).toBeNull();
    expect(ids.mapPendingRequestId('P1', undefined)).toBeNull();
  });

  it('bounds what it remembers', () => {
    const ids = new WireIds({ rememberedRequests: 2 });
    ids.surfaceDecision('P1', 'a');
    ids.surfaceDecision('P1', 'b');
    ids.surfaceDecision('P1', 'c');
    expect(ids.toEngineId('P1', 'q1')).toBeUndefined();
    expect(ids.toEngineId('P1', 'q3')).toBe('c');
    expect(ids.surfaceDecision('P1', 'c').requestId).toBe('q3');
  });
});

describe('revisions', () => {
  it('start at 0 and count only that seat’s board and decision frames', () => {
    const ids = new WireIds();
    expect(ids.revision('P1')).toBe(0);
    expect(ids.recordBoard('P1', { life: 40 })).toEqual({ send: true, revision: 1 });
    expect(ids.surfaceDecision('P1', 'req-1').revision).toBe(2);
    expect(ids.revision('P1')).toBe(2);
  });

  it('isolates seats: frames to one seat never move another seat’s revision', () => {
    const ids = new WireIds();
    for (let i = 0; i < 10; i++) ids.recordBoard('P2', { n: i });
    for (let i = 0; i < 5; i++) ids.surfaceDecision('P3', `req-${i}`);
    expect(ids.revision('P2')).toBe(10);
    expect(ids.revision('P3')).toBe(5);
    expect(ids.revision('P1')).toBe(0);
    ids.recordBoard('P1', { life: 40 });
    expect(ids.revision('P1')).toBe(1);
    expect(ids.revision('P2')).toBe(10);
  });

  it('is untouched by reads, auto-passes and request lookups', () => {
    const ids = new WireIds();
    ids.recordBoard('P1', { a: 1 });
    ids.autoPassed('P1');
    ids.toEngineId('P1', 'q1');
    ids.mapPendingRequestId('P1', 'x');
    ids.nextLogSequence('P1');
    expect(ids.revision('P1')).toBe(1);
  });
});

describe('board snapshots', () => {
  it('sends the first projection', () => {
    const ids = new WireIds();
    expect(ids.recordBoard('P1', { hand: ['a'] }).send).toBe(true);
  });

  it('sends only when that seat’s projection changed', () => {
    const ids = new WireIds();
    ids.recordBoard('P1', { hand: ['a'], life: 40 });
    // An engine advance that changed only something P1 cannot see: same projection.
    expect(ids.recordBoard('P1', { hand: ['a'], life: 40 })).toEqual({ send: false, revision: 1 });
    expect(ids.recordBoard('P1', { hand: ['a'], life: 40 })).toEqual({ send: false, revision: 1 });
    expect(ids.recordBoard('P1', { hand: ['a'], life: 39 })).toEqual({ send: true, revision: 2 });
  });

  it('ignores key order', () => {
    const ids = new WireIds();
    ids.recordBoard('P1', { a: 1, b: { x: 1, y: 2 } });
    expect(ids.recordBoard('P1', { b: { y: 2, x: 1 }, a: 1 }).send).toBe(false);
  });

  it('notices a change nested in arrays and objects', () => {
    const ids = new WireIds();
    ids.recordBoard('P1', { zones: [{ id: 'o1', tapped: false }] });
    expect(ids.recordBoard('P1', { zones: [{ id: 'o1', tapped: true }] }).send).toBe(true);
  });

  it('tracks each seat separately', () => {
    const ids = new WireIds();
    ids.recordBoard('P1', { life: 40 });
    expect(ids.recordBoard('P2', { life: 40 }).send).toBe(true);
    expect(ids.recordBoard('P1', { life: 40 }).send).toBe(false);
  });

  it('sends again after the remembered projection is invalidated', () => {
    const ids = new WireIds();
    ids.recordBoard('P1', { life: 40 });
    ids.invalidateBoard('P1');
    expect(ids.recordBoard('P1', { life: 40 }).send).toBe(true);
  });

  it('serializes stably', () => {
    expect(stableSerialize({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      stableSerialize({ a: [{ c: 2, d: 1 }], b: 1 }),
    );
    expect(stableSerialize({ a: 1 })).not.toBe(stableSerialize({ a: 2 }));
  });
});

describe('log sequences', () => {
  it('count per viewer from 0', () => {
    const ids = new WireIds();
    expect(ids.nextLogSequence('P1')).toBe(0);
    expect(ids.nextLogSequence('P1')).toBe(1);
    expect(ids.nextLogSequence('P2')).toBe(0);
    expect(ids.nextLogSequence('P1')).toBe(2);
    expect(ids.peekLogSequence('P1')).toBe(3);
    expect(ids.peekLogSequence('P3')).toBe(0);
  });
});
