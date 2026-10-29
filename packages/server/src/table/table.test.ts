import { describe, it, expect } from 'vitest';
import type {
  PlayerId,
  ResolvedDeck,
  TableServerToClientMessage,
  TableStatePayload,
} from '@mtg/shared';
import { PROTOCOL_VERSION } from '@mtg/shared';
import { makeResolvedDeck } from '../test-factory';
import type { DeckChecker } from './deck-check';
import {
  Table,
  type Connection,
  type StartAttempt,
  type TableEffect,
  type TableOptions,
  type TableResult,
} from './table';
import { AttemptThrottle } from './tokens';

// ── Harness ─────────────────────────────────────────────────────────────────────────────────

const DECK: ResolvedDeck = makeResolvedDeck({ commanders: [], cards: [] });

/** Decklists starting with `bad` fail; everything else is accepted. */
const deckChecker: DeckChecker = (decklist) =>
  decklist.startsWith('bad')
    ? { ok: false, problems: [{ code: 'cardCount', message: 'Deck has 3 cards.' }] }
    : { ok: true, deck: DECK };

const caps = {};

interface Harness {
  table: Table;
  clock: { t: number };
  /** Effects returned through `record`, in order. */
  log: TableEffect[];
}

function setup(options: Partial<TableOptions> = {}): Harness {
  const clock = { t: 1_000_000 };
  const log: TableEffect[] = [];
  const throttle = new AttemptThrottle({ now: () => clock.t });
  const table = new Table({ deckChecker, now: () => clock.t, throttle, ...options });
  return { table, clock, log };
}

let nextId = 0;
const conn = (address = `10.0.0.${++nextId}`): Connection => ({
  socketId: `s${++nextId}`,
  address,
});

const record = <T extends TableResult<object>>(h: Harness, result: T): T => {
  h.log.push(...result.effects);
  return result;
};

function join(h: Harness, c: Connection, name: string, invite = h.table.currentInviteCode) {
  return record(
    h,
    h.table.join(c, {
      inviteCode: invite,
      displayName: name,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: caps,
    }),
  );
}

function hostConn(h: Harness, c: Connection = conn()): Connection {
  const result = record(h, h.table.hostAuth(c, { hostToken: h.table.issuedHostToken }));
  expect(result.ok).toBe(true);
  return c;
}

/** Join, claim and approve a seat; returns the seat token. */
function seatPlayer(h: Harness, host: Connection, c: Connection, name: string, seat: PlayerId) {
  expect(join(h, c, name).ok).toBe(true);
  const claim = record(h, h.table.requestSeat(c, { seat, decklist: 'good deck' }));
  if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
  const approved = record(h, h.table.hostApprove(host, { claimId: claim.claimId }));
  if (!approved.ok) throw new Error(`approve refused: ${approved.reason}`);
  const granted = messagesTo(approved.effects, c.socketId).find((m) => m.type === 'seatGranted');
  if (granted?.type !== 'seatGranted') throw new Error('no grant');
  return { seatToken: granted.payload.seatToken, claimId: claim.claimId };
}

const messagesTo = (effects: TableEffect[], socketId: string): TableServerToClientMessage[] =>
  effects.flatMap((e) => (e.type === 'send' && e.socketId === socketId ? [e.message] : []));

const stateFor = (h: Harness, c: Connection): TableStatePayload => {
  const message = h.table.stateFor(c.socketId);
  if (message?.type !== 'tableState') throw new Error('no state');
  return message.payload;
};

const resume = (h: Harness, c: Connection, seatToken: string) =>
  record(
    h,
    h.table.resumeSeat(c, { seatToken, protocolVersion: PROTOCOL_VERSION, capabilities: caps }),
  );

/** A ready table: host connected, P1 and P2 humans, P3 and P4 bots. */
function readyTable() {
  const h = setup();
  const host = hostConn(h);
  const alice = conn();
  const bob = conn();
  const a = seatPlayer(h, host, alice, 'Alice', 'P1');
  const b = seatPlayer(h, host, bob, 'Bob', 'P2');
  record(h, h.table.hostSetSeat(host, { seat: 'P3', controller: 'bot' }));
  record(h, h.table.hostSetSeat(host, { seat: 'P4', controller: 'bot' }));
  return { h, host, alice, bob, aliceToken: a.seatToken, bobToken: b.seatToken };
}

const startEffects = (effects: TableEffect[]): StartAttempt[] =>
  effects.flatMap((e) => (e.type === 'startGame' ? [e.attempt] : []));

// ── Joining ─────────────────────────────────────────────────────────────────────────────────

describe('joining', () => {
  it('admits a holder of the invite', () => {
    const h = setup();
    const c = conn();
    expect(join(h, c, 'Alice').ok).toBe(true);
    expect(stateFor(h, c).you.displayName).toBe('Alice');
    expect(stateFor(h, c).phase).toBe('open');
  });

  it('refuses a wrong invite code', () => {
    const h = setup();
    const result = join(h, conn(), 'Alice', 'wrong');
    expect(result).toMatchObject({ ok: false, reason: 'badInvite' });
  });

  it('answers a stale protocol version with protocolMismatch and nothing else', () => {
    const h = setup();
    const c = conn();
    const result = h.table.join(c, {
      inviteCode: h.table.currentInviteCode,
      displayName: 'Alice',
      protocolVersion: PROTOCOL_VERSION + 1,
      capabilities: caps,
    });
    expect(result).toMatchObject({ ok: false, reason: 'protocolMismatch' });
    expect(messagesTo(result.effects, c.socketId)).toEqual([
      {
        type: 'protocolMismatch',
        payload: { serverVersion: PROTOCOL_VERSION, clientVersion: PROTOCOL_VERSION + 1 },
      },
    ]);
    expect(h.table.stateFor(c.socketId)).toBeNull();
  });

  it('delays a client address after failures, then lets the right invite through', () => {
    const h = setup();
    expect(join(h, conn('9.9.9.9'), 'Mallory', 'guess-1')).toMatchObject({
      reason: 'badInvite',
    });
    const blocked = join(h, conn('9.9.9.9'), 'Mallory');
    expect(blocked).toMatchObject({ ok: false, reason: 'throttled' });
    expect((blocked as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    // Another address is unaffected.
    expect(join(h, conn('8.8.8.8'), 'Alice').ok).toBe(true);
    h.clock.t += 60_000;
    expect(join(h, conn('9.9.9.9'), 'Mallory').ok).toBe(true);
  });

  it('refuses a second join on one socket and a bad name', () => {
    const h = setup();
    const c = conn();
    join(h, c, 'Alice');
    expect(join(h, c, 'Alice2')).toMatchObject({ reason: 'alreadyJoined' });
    expect(join(h, conn(), '   ')).toMatchObject({ reason: 'badName' });
    expect(join(h, conn(), 'x'.repeat(25))).toMatchObject({ reason: 'badName' });
  });

  it('caps connected sockets', () => {
    const h = setup({ limits: { maxConnections: 2 } });
    expect(join(h, conn(), 'A').ok).toBe(true);
    expect(join(h, conn(), 'B').ok).toBe(true);
    expect(join(h, conn(), 'C')).toMatchObject({ reason: 'tableFull' });
  });
});

describe('display names', () => {
  it('refuses a repeated name', () => {
    const h = setup();
    join(h, conn(), 'Bob');
    expect(join(h, conn(), 'Bob')).toMatchObject({
      ok: false,
      reason: 'nameTaken',
      lookalike: false,
    });
  });

  it.each([
    ['Cyrillic о', 'Bоb'],
    ['case', 'BOB'],
    ['zero-width space', 'B​ob'],
    ['Greek ο', 'Bοb'],
    ['combining accent', 'Bób'],
    ['fullwidth', 'Ｂｏｂ'],
  ])('flags a lookalike (%s)', (_label, lookalike) => {
    const h = setup();
    join(h, conn(), 'Bob');
    expect(join(h, conn(), lookalike)).toMatchObject({
      ok: false,
      reason: 'nameTaken',
      lookalike: true,
    });
  });

  it('keeps a seated player’s name reserved while they are away', () => {
    const h = setup();
    const host = hostConn(h);
    const alice = conn();
    seatPlayer(h, host, alice, 'Alice', 'P1');
    h.table.disconnect(alice.socketId);
    expect(join(h, conn(), 'Аlice')).toMatchObject({ reason: 'nameTaken', lookalike: true });
  });

  it('frees a name when its socket leaves unseated', () => {
    const h = setup();
    const c = conn();
    join(h, c, 'Alice');
    h.table.disconnect(c.socketId);
    expect(join(h, conn(), 'Alice').ok).toBe(true);
  });
});

// ── Claims ──────────────────────────────────────────────────────────────────────────────────

describe('claims', () => {
  it('needs a joined socket', () => {
    const h = setup();
    expect(h.table.requestSeat(conn(), { seat: 'P1', decklist: 'good' })).toMatchObject({
      reason: 'notJoined',
    });
  });

  it('creates a pending claim with a claim id and a verification code both sides see', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    const claim = record(h, h.table.requestSeat(c, { seat: 'P2', decklist: 'good deck' }));
    if (!claim.ok) throw new Error(claim.reason);
    expect(claim.claimId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(claim.verificationCode).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(stateFor(h, c).you.claim).toEqual({
      claimId: claim.claimId,
      seat: 'P2',
      verificationCode: claim.verificationCode,
    });
    expect(stateFor(h, host).pendingClaims).toEqual([
      {
        claimId: claim.claimId,
        seat: 'P2',
        displayName: 'Alice',
        verificationCode: claim.verificationCode,
      },
    ]);
    expect(messagesTo(claim.effects, c.socketId)[0]).toEqual({
      type: 'claimPending',
      payload: { claimId: claim.claimId, seat: 'P2', verificationCode: claim.verificationCode },
    });
  });

  it('does not show pending claims or the invite code to anyone but the host', () => {
    const h = setup();
    hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    h.table.requestSeat(c, { seat: 'P1', decklist: 'good' });
    const state = stateFor(h, c);
    expect(state.pendingClaims).toBeUndefined();
    expect(state.inviteCode).toBeUndefined();
  });

  it('sends deck problems to the claimant only and creates no claim', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    const result = record(h, h.table.requestSeat(c, { seat: 'P1', decklist: 'bad list' }));
    expect(result).toMatchObject({ ok: false, reason: 'deckInvalid' });
    expect(result.effects).toHaveLength(1);
    expect(messagesTo(result.effects, c.socketId)).toEqual([
      {
        type: 'deckProblems',
        payload: { seat: 'P1', problems: [{ code: 'cardCount', message: 'Deck has 3 cards.' }] },
      },
    ]);
    expect(stateFor(h, host).pendingClaims).toEqual([]);
  });

  it('refuses a taken, bot or unknown seat and a second seat for a seated player', () => {
    const h = setup();
    const host = hostConn(h);
    const alice = conn();
    seatPlayer(h, host, alice, 'Alice', 'P1');
    record(h, h.table.hostSetSeat(host, { seat: 'P3', controller: 'bot' }));
    const bob = conn();
    join(h, bob, 'Bob');
    expect(h.table.requestSeat(bob, { seat: 'P1', decklist: 'good' })).toMatchObject({
      reason: 'seatUnavailable',
    });
    expect(h.table.requestSeat(bob, { seat: 'P3', decklist: 'good' })).toMatchObject({
      reason: 'seatUnavailable',
    });
    expect(h.table.requestSeat(bob, { seat: 'P9', decklist: 'good' })).toMatchObject({
      reason: 'unknownSeat',
    });
    expect(h.table.requestSeat(alice, { seat: 'P2', decklist: 'good' })).toMatchObject({
      reason: 'alreadySeated',
    });
  });

  it('caps pending claims at 1 per socket', () => {
    const h = setup();
    const c = conn();
    join(h, c, 'Alice');
    expect(h.table.requestSeat(c, { seat: 'P1', decklist: 'good' }).ok).toBe(true);
    expect(h.table.requestSeat(c, { seat: 'P2', decklist: 'good' })).toMatchObject({
      reason: 'claimLimitSocket',
    });
  });

  it('caps pending claims at 2 per client address', () => {
    const h = setup();
    const sockets = [conn('7.7.7.7'), conn('7.7.7.7'), conn('7.7.7.7')];
    sockets.forEach((c, i) => join(h, c, `Name${i}`));
    expect(h.table.requestSeat(sockets[0]!, { seat: 'P1', decklist: 'good' }).ok).toBe(true);
    expect(h.table.requestSeat(sockets[1]!, { seat: 'P1', decklist: 'good' }).ok).toBe(true);
    expect(h.table.requestSeat(sockets[2]!, { seat: 'P1', decklist: 'good' })).toMatchObject({
      reason: 'claimLimitAddress',
    });
    // A different address is fine.
    const other = conn('6.6.6.6');
    join(h, other, 'Other');
    expect(h.table.requestSeat(other, { seat: 'P1', decklist: 'good' }).ok).toBe(true);
  });

  it('caps pending claims at 8 per table', () => {
    const h = setup();
    for (let i = 0; i < 8; i++) {
      const c = conn();
      join(h, c, `Player${i}`);
      expect(h.table.requestSeat(c, { seat: 'P1', decklist: 'good' }).ok).toBe(true);
    }
    const ninth = conn();
    join(h, ninth, 'Ninth');
    expect(h.table.requestSeat(ninth, { seat: 'P1', decklist: 'good' })).toMatchObject({
      reason: 'claimLimitTable',
    });
  });

  it('frees cap room when a claim is denied, withdrawn or its socket leaves', () => {
    const h = setup({ limits: { pendingClaimsPerTable: 2 } });
    const host = hostConn(h);
    const [a, b, c] = [conn(), conn(), conn()] as [Connection, Connection, Connection];
    join(h, a, 'A');
    join(h, b, 'B');
    join(h, c, 'C');
    const ca = h.table.requestSeat(a, { seat: 'P1', decklist: 'good' });
    h.table.requestSeat(b, { seat: 'P1', decklist: 'good' });
    expect(h.table.requestSeat(c, { seat: 'P1', decklist: 'good' })).toMatchObject({
      reason: 'claimLimitTable',
    });
    if (!ca.ok) throw new Error('claim');
    h.table.hostDeny(host, { claimId: ca.claimId });
    expect(h.table.requestSeat(c, { seat: 'P1', decklist: 'good' }).ok).toBe(true);
    h.table.leaveSeat(b);
    h.table.disconnect(c.socketId);
    expect(stateFor(h, host).pendingClaims).toEqual([]);
  });
});

describe('approval by claim id', () => {
  it('grants the seat to the claimant of that claim id, with a 256-bit token', () => {
    const h = setup();
    const host = hostConn(h);
    const first = conn();
    const second = conn();
    join(h, first, 'Alice');
    join(h, second, 'Bob');
    const c1 = h.table.requestSeat(first, { seat: 'P1', decklist: 'good' });
    const c2 = h.table.requestSeat(second, { seat: 'P1', decklist: 'good' });
    if (!c1.ok || !c2.ok) throw new Error('claims');
    // Approve the SECOND claim: only that claimant gets the seat.
    const approved = record(h, h.table.hostApprove(host, { claimId: c2.claimId }));
    expect(approved).toMatchObject({ ok: true, seat: 'P1' });
    const grants = approved.effects.filter(
      (e) => e.type === 'send' && e.message.type === 'seatGranted',
    );
    expect(grants).toHaveLength(1);
    const secondMessages = messagesTo(approved.effects, second.socketId);
    expect(secondMessages.map((m) => m.type)).toContain('seatGranted');
    expect(messagesTo(approved.effects, first.socketId).map((m) => m.type)).not.toContain(
      'seatGranted',
    );
    const grant = secondMessages.find((m) => m.type === 'seatGranted');
    expect(grant?.type === 'seatGranted' && grant.payload.seatToken).toHaveLength(43);
    expect(h.table.seatOfSocket(second.socketId)).toBe('P1');
    expect(h.table.seatOfSocket(first.socketId)).toBeNull();
    // The losing claim is gone, not approvable later.
    expect(h.table.hostApprove(host, { claimId: c1.claimId })).toMatchObject({
      reason: 'unknownClaim',
    });
    expect(stateFor(h, first).you.claim).toBeNull();
  });

  it('hands the approved deck to part B for storage', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    const claim = h.table.requestSeat(c, { seat: 'P1', decklist: 'my list' });
    if (!claim.ok) throw new Error('claim');
    const approved = h.table.hostApprove(host, { claimId: claim.claimId });
    expect(approved.effects).toContainEqual({
      type: 'deckApproved',
      seat: 'P1',
      displayName: 'Alice',
      decklist: 'my list',
    });
  });

  it('refuses an unknown claim id and a denied claim', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    const claim = h.table.requestSeat(c, { seat: 'P1', decklist: 'good' });
    if (!claim.ok) throw new Error('claim');
    expect(h.table.hostApprove(host, { claimId: 'nope' })).toMatchObject({
      reason: 'unknownClaim',
    });
    expect(h.table.hostDeny(host, { claimId: claim.claimId }).ok).toBe(true);
    expect(h.table.hostApprove(host, { claimId: claim.claimId })).toMatchObject({
      reason: 'unknownClaim',
    });
    expect(h.table.hostDeny(host, { claimId: claim.claimId })).toMatchObject({
      reason: 'unknownClaim',
    });
    expect(h.table.seatOfSocket(c.socketId)).toBeNull();
  });

  it('drops a claim whose socket disconnected', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    const claim = h.table.requestSeat(c, { seat: 'P1', decklist: 'good' });
    if (!claim.ok) throw new Error('claim');
    h.table.disconnect(c.socketId);
    expect(h.table.hostApprove(host, { claimId: claim.claimId })).toMatchObject({
      reason: 'unknownClaim',
    });
  });

  it('refuses host messages from a connection that has not hostAuthed', () => {
    const h = setup();
    hostConn(h);
    const player = conn();
    join(h, player, 'Alice');
    const claim = h.table.requestSeat(player, { seat: 'P1', decklist: 'good' });
    if (!claim.ok) throw new Error('claim');
    const stranger = conn();
    const calls: TableResult<object>[] = [
      h.table.hostApprove(stranger, { claimId: claim.claimId }),
      h.table.hostApprove(player, { claimId: claim.claimId }),
      h.table.hostDeny(player, { claimId: claim.claimId }),
      h.table.hostSetSeat(player, { seat: 'P2', controller: 'bot' }),
      h.table.hostKick(player, { seat: 'P1' }),
      h.table.hostRotateInvite(player),
      h.table.hostStart(player),
      h.table.hostAbandon(player),
    ];
    for (const call of calls) expect(call).toMatchObject({ ok: false, reason: 'notHost' });
    expect(h.table.seatOfSocket(player.socketId)).toBeNull();
  });

  it('refuses a wrong host token and throttles repeats', () => {
    const h = setup();
    const c = conn('5.5.5.5');
    expect(h.table.hostAuth(c, { hostToken: 'wrong' })).toMatchObject({ reason: 'badToken' });
    expect(h.table.hostAuth(c, { hostToken: h.table.issuedHostToken })).toMatchObject({
      reason: 'throttled',
    });
    expect(h.table.isHost(c.socketId)).toBe(false);
    h.clock.t += 60_000;
    expect(h.table.hostAuth(c, { hostToken: h.table.issuedHostToken }).ok).toBe(true);
    expect(h.table.isHost(c.socketId)).toBe(true);
  });
});

// ── Seat changes and token revocation ───────────────────────────────────────────────────────

describe('token revocation', () => {
  it('kick revokes the seat token, frees the seat and closes the socket', () => {
    const h = setup();
    const host = hostConn(h);
    const alice = conn();
    const { seatToken } = seatPlayer(h, host, alice, 'Alice', 'P1');
    expect(h.table.seatForToken(seatToken)).toBe('P1');

    const kicked = record(h, h.table.hostKick(host, { seat: 'P1' }));
    expect(kicked.ok).toBe(true);
    expect(messagesTo(kicked.effects, alice.socketId)).toContainEqual({
      type: 'tableClosed',
      payload: { reason: 'kicked' },
    });
    expect(kicked.effects).toContainEqual({
      type: 'close',
      socketId: alice.socketId,
      reason: 'kicked',
    });
    expect(h.table.seatForToken(seatToken)).toBeNull();
    expect(stateFor(h, host).seats[0]).toMatchObject({ seat: 'P1', controller: 'open' });

    const retry = resume(h, conn(), seatToken);
    expect(retry).toMatchObject({ ok: false, reason: 'badToken' });
  });

  it('a kicked player’s name is freed', () => {
    const h = setup();
    const host = hostConn(h);
    seatPlayer(h, host, conn(), 'Alice', 'P1');
    h.table.hostKick(host, { seat: 'P1' });
    expect(join(h, conn(), 'Alice').ok).toBe(true);
  });

  it('refuses to kick an empty or bot seat', () => {
    const h = setup();
    const host = hostConn(h);
    h.table.hostSetSeat(host, { seat: 'P2', controller: 'bot' });
    expect(h.table.hostKick(host, { seat: 'P1' })).toMatchObject({ reason: 'noPlayer' });
    expect(h.table.hostKick(host, { seat: 'P2' })).toMatchObject({ reason: 'noPlayer' });
  });

  it('leaveSeat revokes the token and keeps the player in the lobby', () => {
    const h = setup();
    const host = hostConn(h);
    const alice = conn();
    const { seatToken } = seatPlayer(h, host, alice, 'Alice', 'P1');
    expect(h.table.leaveSeat(alice).ok).toBe(true);
    expect(h.table.seatForToken(seatToken)).toBeNull();
    expect(h.table.seatOfSocket(alice.socketId)).toBeNull();
    expect(stateFor(h, alice).you.displayName).toBe('Alice');
    expect(h.table.leaveSeat(alice)).toMatchObject({ reason: 'noSeat' });
  });

  it('leaveSeat withdraws a pending claim', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    h.table.requestSeat(c, { seat: 'P1', decklist: 'good' });
    expect(h.table.leaveSeat(c).ok).toBe(true);
    expect(stateFor(h, host).pendingClaims).toEqual([]);
  });

  it('a seat change to bot or open revokes the token', () => {
    const h = setup();
    const host = hostConn(h);
    const { seatToken: t1 } = seatPlayer(h, host, conn(), 'Alice', 'P1');
    const { seatToken: t2 } = seatPlayer(h, host, conn(), 'Bob', 'P2');
    expect(h.table.hostSetSeat(host, { seat: 'P1', controller: 'bot' }).ok).toBe(true);
    expect(h.table.hostSetSeat(host, { seat: 'P2', controller: 'open' }).ok).toBe(true);
    expect(h.table.seatForToken(t1)).toBeNull();
    expect(h.table.seatForToken(t2)).toBeNull();
    const seats = stateFor(h, host).seats;
    expect(seats[0]?.controller).toBe('bot');
    expect(seats[1]?.controller).toBe('open');
  });

  it('setting a seat to bot drops claims on it', () => {
    const h = setup();
    const host = hostConn(h);
    const c = conn();
    join(h, c, 'Alice');
    const claim = h.table.requestSeat(c, { seat: 'P1', decklist: 'good' });
    if (!claim.ok) throw new Error('claim');
    h.table.hostSetSeat(host, { seat: 'P1', controller: 'bot' });
    expect(h.table.hostApprove(host, { claimId: claim.claimId })).toMatchObject({
      reason: 'unknownClaim',
    });
  });

  it('a seated player who disconnects keeps the seat and token', () => {
    const h = setup();
    const host = hostConn(h);
    const alice = conn();
    const { seatToken } = seatPlayer(h, host, alice, 'Alice', 'P1');
    h.table.disconnect(alice.socketId);
    expect(stateFor(h, host).seats[0]).toMatchObject({ controller: 'human', connected: false });
    const back = conn();
    expect(resume(h, back, seatToken)).toMatchObject({ ok: true, seat: 'P1' });
    expect(h.table.seatOfSocket(back.socketId)).toBe('P1');
    expect(stateFor(h, host).seats[0]).toMatchObject({ connected: true });
  });

  it('a second socket with the same token takes the seat; the first is told and closed', () => {
    const h = setup();
    const host = hostConn(h);
    const first = conn();
    const { seatToken } = seatPlayer(h, host, first, 'Alice', 'P1');
    const second = conn();
    const taken = resume(h, second, seatToken);
    expect(taken).toMatchObject({ ok: true, seat: 'P1' });
    expect(messagesTo(taken.effects, first.socketId)).toContainEqual({
      type: 'seatTakenOver',
      payload: { seat: 'P1' },
    });
    expect(taken.effects).toContainEqual({
      type: 'close',
      socketId: first.socketId,
      reason: 'takenOver',
    });
    expect(h.table.seatOfSocket(first.socketId)).toBeNull();
    expect(h.table.seatOfSocket(second.socketId)).toBe('P1');
  });

  it('resumeSeat refuses a stale protocol version and throttles bad tokens', () => {
    const h = setup();
    const c = conn('4.4.4.4');
    expect(
      h.table.resumeSeat(c, { seatToken: 'x', protocolVersion: 0, capabilities: caps }),
    ).toMatchObject({ reason: 'protocolMismatch' });
    expect(resume(h, c, 'guess')).toMatchObject({ reason: 'badToken' });
    expect(resume(h, c, 'guess')).toMatchObject({ reason: 'throttled' });
  });

  it('records the capabilities a socket declared', () => {
    const h = setup();
    const c = conn();
    const joined = h.table.join(c, {
      inviteCode: h.table.currentInviteCode,
      displayName: 'Alice',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { rawActionData: true },
    });
    expect(joined.ok).toBe(true);
    expect(h.table.capabilitiesOf(c.socketId)).toEqual({ rawActionData: true });
  });
});

// ── Invite rotation ─────────────────────────────────────────────────────────────────────────

describe('invite rotation', () => {
  it('replaces the invite, refusing the old code and accepting the new one', () => {
    const h = setup();
    const host = hostConn(h);
    const oldCode = h.table.currentInviteCode;
    const rotated = record(h, h.table.hostRotateInvite(host));
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(rotated.inviteCode).not.toBe(oldCode);
    expect(rotated.inviteCode).toBe(h.table.currentInviteCode);
    expect(join(h, conn('1.1.1.1'), 'Old', oldCode)).toMatchObject({ reason: 'badInvite' });
    expect(join(h, conn('2.2.2.2'), 'New', rotated.inviteCode).ok).toBe(true);
    expect(stateFor(h, host).inviteCode).toBe(rotated.inviteCode);
  });

  it('is refused once the table has left open', () => {
    const { h, host } = readyTable();
    record(h, h.table.hostStart(host));
    expect(h.table.hostRotateInvite(host)).toMatchObject({ reason: 'wrongPhase' });
  });
});

// ── Start ───────────────────────────────────────────────────────────────────────────────────

describe('hostStart', () => {
  it('needs at least one human', () => {
    const h = setup();
    const host = hostConn(h);
    for (const seat of ['P1', 'P2', 'P3', 'P4'] as const) {
      h.table.hostSetSeat(host, { seat, controller: 'bot' });
    }
    const result = h.table.hostStart(host);
    expect(result).toMatchObject({ ok: false, reason: 'cannotStart' });
    expect((result as { blockers: string[] }).blockers).toContain(
      'At least one human must take a seat.',
    );
    expect(h.table.currentPhase).toBe('open');
    expect(stateFor(h, host).canStart).toBe(false);
  });

  it('needs every seat to be human or bot', () => {
    const h = setup();
    const host = hostConn(h);
    seatPlayer(h, host, conn(), 'Alice', 'P1');
    h.table.hostSetSeat(host, { seat: 'P2', controller: 'bot' });
    const result = h.table.hostStart(host);
    expect(result).toMatchObject({ ok: false, reason: 'cannotStart' });
    expect((result as { blockers: string[] }).blockers).toEqual([
      'Seat P3 is not assigned.',
      'Seat P4 is not assigned.',
    ]);
    expect(startEffects(result.effects)).toHaveLength(0);
    expect(h.table.currentPhase).toBe('open');
  });

  it('moves open to starting and emits one start attempt with every seat and deck', () => {
    const { h, host } = readyTable();
    expect(stateFor(h, host).canStart).toBe(true);
    const result = record(h, h.table.hostStart(host));
    if (!result.ok) throw new Error(result.reason);
    expect(h.table.currentPhase).toBe('starting');
    const attempts = startEffects(result.effects);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptId: result.attemptId, tableId: h.table.id });
    expect(attempts[0]?.seats.map((s) => [s.seat, s.controller])).toEqual([
      ['P1', 'human'],
      ['P2', 'human'],
      ['P3', 'bot'],
      ['P4', 'bot'],
    ]);
    const first = attempts[0]?.seats[0];
    expect(first?.controller === 'human' && first.deck).toBe(DECK);
    expect(first?.controller === 'human' && first.displayName).toBe('Alice');
    // Seat tokens never travel in the attempt.
    expect(JSON.stringify(attempts[0])).not.toMatch(/seatToken/);
  });

  it('creates exactly one attempt when hostStart is sent twice', () => {
    const { h, host } = readyTable();
    const first = record(h, h.table.hostStart(host));
    const second = record(h, h.table.hostStart(host));
    const third = record(h, h.table.hostStart(host));
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: 'wrongPhase' });
    expect(third).toMatchObject({ ok: false, reason: 'wrongPhase' });
    expect(startEffects(h.log)).toHaveLength(1);
  });
});

describe('refusals outside open', () => {
  it.each(['starting', 'playing', 'finished'] as const)(
    'refuses lobby actions while %s',
    (phase) => {
      const { h, host, alice } = readyTable();
      const latecomer = conn();
      join(h, latecomer, 'Late'); // joined while open
      const started = record(h, h.table.hostStart(host));
      if (!started.ok) throw new Error('start');
      if (phase !== 'starting') h.table.startSucceeded(started.attemptId);
      if (phase === 'finished') h.table.gameFinished(started.attemptId);
      expect(h.table.currentPhase).toBe(phase);

      const outcomes = [
        join(h, conn(), 'Newcomer'),
        h.table.requestSeat(latecomer, { seat: 'P1', decklist: 'good' }),
        h.table.leaveSeat(alice),
        h.table.hostApprove(host, { claimId: 'any' }),
        h.table.hostDeny(host, { claimId: 'any' }),
        h.table.hostSetSeat(host, { seat: 'P3', controller: 'open' }),
        h.table.hostKick(host, { seat: 'P1' }),
        h.table.hostRotateInvite(host),
        h.table.hostStart(host),
      ];
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ ok: false, reason: 'wrongPhase' });
      }
      // Nothing changed.
      expect(stateFor(h, host).seats.map((s) => s.controller)).toEqual([
        'human',
        'human',
        'bot',
        'bot',
      ]);
      expect(h.table.seatOfSocket(alice.socketId)).toBe('P1');
    },
  );

  it('still lets the host authenticate and a seat resume after the start', () => {
    const { h, host, aliceToken } = readyTable();
    h.table.hostStart(host);
    const host2 = conn();
    expect(h.table.hostAuth(host2, { hostToken: h.table.issuedHostToken }).ok).toBe(true);
    expect(resume(h, conn(), aliceToken).ok).toBe(true);
  });
});

describe('setup outcomes', () => {
  it('startSucceeded moves starting to playing, once', () => {
    const { h, host } = readyTable();
    const started = h.table.hostStart(host);
    if (!started.ok) throw new Error('start');
    expect(h.table.startSucceeded(started.attemptId).ok).toBe(true);
    expect(h.table.currentPhase).toBe('playing');
    expect(h.table.startSucceeded(started.attemptId)).toMatchObject({ reason: 'staleAttempt' });
    expect(h.table.startSucceeded('other')).toMatchObject({ reason: 'staleAttempt' });
  });

  it('startRejected returns to open, tells only the affected seat, and revokes its token', () => {
    const { h, host, alice, bob, aliceToken, bobToken } = readyTable();
    const started = h.table.hostStart(host);
    if (!started.ok) throw new Error('start');
    const problems = [{ code: 'banned' as const, message: 'Banned.', cardName: 'Sol Ring' }];
    const rejected = record(h, h.table.startRejected(started.attemptId, { P1: problems }));
    expect(rejected.ok).toBe(true);
    expect(h.table.currentPhase).toBe('open');
    expect(messagesTo(rejected.effects, alice.socketId)).toContainEqual({
      type: 'deckProblems',
      payload: { seat: 'P1', problems },
    });
    expect(messagesTo(rejected.effects, bob.socketId).map((m) => m.type)).not.toContain(
      'deckProblems',
    );
    expect(messagesTo(rejected.effects, host.socketId).map((m) => m.type)).not.toContain(
      'deckProblems',
    );
    expect(rejected.effects.some((e) => e.type === 'startGame')).toBe(false);
    expect(h.table.seatForToken(aliceToken)).toBeNull();
    expect(h.table.seatForToken(bobToken)).toBe('P2');
    expect(stateFor(h, host).seats.map((s) => s.controller)).toEqual([
      'open',
      'human',
      'bot',
      'bot',
    ]);
  });

  it('a corrected retry launches exactly one fresh attempt; the retired one is stale', () => {
    const { h, host, alice } = readyTable();
    const first = h.table.hostStart(host);
    if (!first.ok) throw new Error('start');
    h.table.startRejected(first.attemptId, { P1: [{ code: 'banned', message: 'Banned.' }] });
    // Alice claims again with a corrected deck and is approved.
    const claim = h.table.requestSeat(alice, { seat: 'P1', decklist: 'good deck' });
    if (!claim.ok) throw new Error('claim');
    expect(h.table.hostApprove(host, { claimId: claim.claimId }).ok).toBe(true);
    const second = record(h, h.table.hostStart(host));
    if (!second.ok) throw new Error('restart');
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(startEffects(second.effects)).toHaveLength(1);
    // Messages about the retired attempt cannot touch the new one.
    expect(h.table.startSucceeded(first.attemptId)).toMatchObject({ reason: 'staleAttempt' });
    expect(h.table.startRejected(first.attemptId, {})).toMatchObject({ reason: 'staleAttempt' });
    expect(h.table.gameFinished(first.attemptId)).toMatchObject({ reason: 'staleAttempt' });
    expect(h.table.currentPhase).toBe('starting');
  });
});

describe('lifecycle', () => {
  it('runs open, starting, playing, finished, reaped', () => {
    const { h, host, aliceToken } = readyTable();
    expect(h.table.currentPhase).toBe('open');
    const started = h.table.hostStart(host);
    if (!started.ok) throw new Error('start');
    expect(h.table.currentPhase).toBe('starting');
    h.table.startSucceeded(started.attemptId);
    expect(h.table.currentPhase).toBe('playing');
    const finished = record(h, h.table.gameFinished(started.attemptId));
    expect(finished.ok).toBe(true);
    expect(h.table.currentPhase).toBe('finished');
    expect(stateFor(h, host).phase).toBe('finished');

    expect(h.table.reapIfIdle()).toMatchObject({ ok: true, reaped: false });
    h.clock.t += 14 * 60_000;
    expect(h.table.reapIfIdle()).toMatchObject({ reaped: false });
    h.clock.t += 2 * 60_000;
    const reaped = record(h, h.table.reapIfIdle());
    expect(reaped).toMatchObject({ ok: true, reaped: true });
    expect(h.table.currentPhase).toBe('reaped');
    expect(reaped.effects.filter((e) => e.type === 'close').length).toBeGreaterThanOrEqual(3);
    expect(h.table.seatForToken(aliceToken)).toBeNull();
    expect(join(h, conn(), 'Anyone')).toMatchObject({ reason: 'wrongPhase' });
  });

  it('can finish straight from starting (setup failed)', () => {
    const { h, host } = readyTable();
    const started = h.table.hostStart(host);
    if (!started.ok) throw new Error('start');
    expect(h.table.gameFinished(started.attemptId).ok).toBe(true);
    expect(h.table.currentPhase).toBe('finished');
    expect(h.table.gameFinished(started.attemptId).ok).toBe(true); // idempotent
  });

  it('does not reap a table that has not finished', () => {
    const { h, host } = readyTable();
    h.table.hostStart(host);
    h.clock.t += 24 * 60 * 60_000;
    expect(h.table.reapIfIdle()).toMatchObject({ reaped: false });
    expect(h.table.currentPhase).toBe('starting');
  });
});

describe('hostAbandon', () => {
  it('is refused while open', () => {
    const { h, host } = readyTable();
    expect(h.table.hostAbandon(host)).toMatchObject({ reason: 'wrongPhase' });
  });

  it('asks part B to stop the attempt once, from starting or playing', () => {
    const { h, host } = readyTable();
    const started = h.table.hostStart(host);
    if (!started.ok) throw new Error('start');
    h.table.startSucceeded(started.attemptId);
    const first = h.table.hostAbandon(host);
    expect(first.effects).toEqual([{ type: 'abandonGame', attemptId: started.attemptId }]);
    expect(h.table.hostAbandon(host)).toMatchObject({ reason: 'alreadyAbandoning' });
    // The table stays `playing` until part B reports the terminal commit.
    expect(h.table.currentPhase).toBe('playing');
    h.table.gameFinished(started.attemptId);
    expect(h.table.currentPhase).toBe('finished');
    expect(h.table.hostAbandon(host)).toMatchObject({ reason: 'wrongPhase' });
  });
});

// ── What the wire carries ───────────────────────────────────────────────────────────────────

describe('secrets on the wire', () => {
  it('sends a seat token only in seatGranted, only to the claimant', () => {
    const { h, aliceToken, bobToken } = readyTable();
    const carrying = h.log.filter(
      (e) =>
        e.type === 'send' &&
        (JSON.stringify(e.message).includes(aliceToken) ||
          JSON.stringify(e.message).includes(bobToken)),
    );
    expect(carrying).toHaveLength(2);
    for (const e of carrying) {
      expect(e.type === 'send' && e.message.type).toBe('seatGranted');
    }
  });

  it('never puts the host token in any message', () => {
    const { h } = readyTable();
    expect(JSON.stringify(h.log)).not.toContain(h.table.issuedHostToken);
  });

  it('sends the invite code only to host connections', () => {
    const { h, host, alice } = readyTable();
    expect(stateFor(h, host).inviteCode).toBe(h.table.currentInviteCode);
    expect(stateFor(h, alice).inviteCode).toBeUndefined();
    const aliceMessages = h.log.filter((e) => e.type === 'send' && e.socketId === alice.socketId);
    expect(JSON.stringify(aliceMessages)).not.toContain(h.table.currentInviteCode);
  });
});
