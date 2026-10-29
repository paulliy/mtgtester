import { describe, it, expect } from 'vitest';
import {
  CLIENT_TO_SERVER_TYPES,
  PROTOCOL_VERSION,
  TABLE_CLIENT_TO_SERVER_TYPES,
  TABLE_MAX_DECKLIST_CHARS,
  TABLE_SERVER_TO_CLIENT_TYPES,
  parseTableClientFrame,
  parseTableClientMessage,
} from './index';

const frame = (type: string, payload: unknown = {}, extra: Record<string, unknown> = {}) => ({
  type,
  payload,
  ...extra,
});

/** One valid example per client message type. */
const VALID: Record<string, unknown> = {
  joinTable: {
    inviteCode: 'abc',
    displayName: 'Alice',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { rawActionData: true },
  },
  requestSeat: { seat: 'P2', decklist: '1 Sol Ring' },
  leaveSeat: {},
  hostAuth: { hostToken: 'tok' },
  hostApprove: { claimId: 'c1' },
  hostDeny: { claimId: 'c1' },
  hostSetSeat: { seat: 'P3', controller: 'bot' },
  hostKick: { seat: 'P2' },
  hostRotateInvite: {},
  hostStart: {},
  hostAbandon: {},
  resumeSeat: { seatToken: 'st', protocolVersion: PROTOCOL_VERSION, capabilities: {} },
  resumeControl: {},
  replayTurn: { turn: 3 },
};

describe('table protocol vocabulary', () => {
  it('names exactly the plan messages', () => {
    expect([...TABLE_CLIENT_TO_SERVER_TYPES].sort()).toEqual(Object.keys(VALID).sort());
    expect([...TABLE_SERVER_TO_CLIENT_TYPES].sort()).toEqual(
      [
        'claimPending',
        'deckProblems',
        'protocolMismatch',
        'seatGranted',
        'seatTakenOver',
        'tableClosed',
        'tableState',
        'tableResults',
        'replayTurnState',
        'clockState',
        'seatStatus',
      ].sort(),
    );
  });

  it('shares no message type with the tester set', () => {
    for (const type of TABLE_CLIENT_TO_SERVER_TYPES) {
      expect((CLIENT_TO_SERVER_TYPES as readonly string[]).includes(type)).toBe(false);
    }
  });

  it('has a positive integer protocol version', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('parseTableClientMessage', () => {
  it.each(Object.entries(VALID))('accepts a valid %s', (type, payload) => {
    const result = parseTableClientMessage(frame(type, payload));
    expect(result).toEqual({ ok: true, message: { type, payload } });
  });

  it('refuses a non-object frame', () => {
    for (const value of [null, 'joinTable', 7, [], [frame('hostStart')]]) {
      expect(parseTableClientMessage(value)).toEqual({ ok: false, reason: 'notAnObject' });
    }
  });

  it('refuses unknown types, including the tester messages', () => {
    for (const type of ['startGame', 'submitPlayerAction', 'abandonGame', 'nope', '']) {
      expect(parseTableClientMessage(frame(type))).toEqual({ ok: false, reason: 'unknownType' });
    }
    expect(parseTableClientMessage({ payload: {} })).toEqual({ ok: false, reason: 'unknownType' });
    expect(parseTableClientMessage(frame('toString'))).toEqual({
      ok: false,
      reason: 'unknownType',
    });
  });

  it('refuses a top-level extra field', () => {
    expect(parseTableClientMessage(frame('hostStart', {}, { seat: 'P1' }))).toEqual({
      ok: false,
      reason: 'unknownField',
    });
  });

  it.each(Object.entries(VALID))('refuses an extra payload field on %s', (type, payload) => {
    const result = parseTableClientMessage(frame(type, { ...(payload as object), extra: 1 }));
    expect(result).toEqual({ ok: false, reason: 'unknownField' });
  });

  it('refuses a missing or non-object payload', () => {
    expect(parseTableClientMessage({ type: 'hostStart' })).toEqual({
      ok: false,
      reason: 'invalidPayload',
    });
    for (const payload of [null, 'x', 3, []]) {
      expect(parseTableClientMessage(frame('hostStart', payload)).ok).toBe(false);
    }
  });

  it('refuses a missing required field', () => {
    expect(parseTableClientMessage(frame('hostApprove', {})).ok).toBe(false);
    expect(parseTableClientMessage(frame('joinTable', { inviteCode: 'a' })).ok).toBe(false);
  });

  it('refuses wrongly typed fields', () => {
    const bad: [string, unknown][] = [
      ['requestSeat', { seat: 'P9', decklist: 'x' }],
      ['requestSeat', { seat: 'P1', decklist: 5 }],
      ['requestSeat', { seat: 'P1', decklist: '' }],
      ['requestSeat', { seat: ['P1'], decklist: 'x' }],
      ['hostSetSeat', { seat: 'P1', controller: 'human' }],
      ['hostSetSeat', { seat: 'P1', controller: 'ai' }],
      ['hostKick', { seat: 1 }],
      ['hostApprove', { claimId: 7 }],
      ['hostAuth', { hostToken: '' }],
      ['replayTurn', { turn: -1 }],
      ['replayTurn', { turn: 1.5 }],
      ['replayTurn', { turn: '3' }],
      ['joinTable', { inviteCode: 'a', displayName: 'A', protocolVersion: '1', capabilities: {} }],
      ['joinTable', { inviteCode: 'a', displayName: 'A', protocolVersion: 1.5, capabilities: {} }],
      ['resumeSeat', { seatToken: 'a', protocolVersion: 1, capabilities: null }],
    ];
    for (const [type, payload] of bad) {
      expect(
        parseTableClientMessage(frame(type, payload)).ok,
        `${type} ${JSON.stringify(payload)}`,
      ).toBe(false);
    }
  });

  it('requires capabilities on join and resume, and checks their keys', () => {
    const base = { inviteCode: 'a', displayName: 'A', protocolVersion: 1 };
    expect(parseTableClientMessage(frame('joinTable', base)).ok).toBe(false);
    expect(
      parseTableClientMessage(
        frame('joinTable', { ...base, capabilities: { rawActionData: 'yes' } }),
      ).ok,
    ).toBe(false);
    expect(
      parseTableClientMessage(frame('joinTable', { ...base, capabilities: { other: true } })),
    ).toEqual({ ok: false, reason: 'invalidPayload' });
    expect(parseTableClientMessage(frame('joinTable', { ...base, capabilities: [] })).ok).toBe(
      false,
    );
    expect(
      parseTableClientMessage(frame('resumeSeat', { seatToken: 'a', protocolVersion: 1 })).ok,
    ).toBe(false);
  });

  it('bounds the decklist', () => {
    const big = 'x'.repeat(TABLE_MAX_DECKLIST_CHARS + 1);
    expect(parseTableClientMessage(frame('requestSeat', { seat: 'P1', decklist: big })).ok).toBe(
      false,
    );
    const edge = 'x'.repeat(TABLE_MAX_DECKLIST_CHARS);
    expect(parseTableClientMessage(frame('requestSeat', { seat: 'P1', decklist: edge })).ok).toBe(
      true,
    );
  });

  it('drops nothing it accepted and carries nothing it did not read', () => {
    const result = parseTableClientMessage(
      frame('joinTable', { ...(VALID['joinTable'] as object) }),
    );
    expect(result.ok && Object.keys(result.message)).toEqual(['type', 'payload']);
  });
});

describe('parseTableClientFrame', () => {
  it('parses valid text', () => {
    const text = JSON.stringify(frame('hostApprove', { claimId: 'c9' }));
    expect(parseTableClientFrame(text)).toEqual({
      ok: true,
      message: { type: 'hostApprove', payload: { claimId: 'c9' } },
    });
  });

  it('refuses repeated keys and malformed text', () => {
    expect(
      parseTableClientFrame('{"type":"hostApprove","payload":{"claimId":"a","claimId":"b"}}'),
    ).toEqual({ ok: false, reason: 'duplicateKey' });
    expect(parseTableClientFrame('{nope')).toEqual({ ok: false, reason: 'malformed' });
  });
});
