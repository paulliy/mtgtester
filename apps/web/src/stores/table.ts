/**
 * The table app's connection and lobby (ADR 0031, plan M6 task 2).
 *
 * One socket per table, `/tables/<id>/ws` on the table server (`lib/tableOrigin.ts`). Table frames (lobby, clocks,
 * seat status, post-game) are kept here; every game frame goes to the game store's own handler,
 * so the player board works exactly as it does in single-player. The game store's in-game
 * answers come back out through this socket.
 *
 * - The seat token and the host token live in `localStorage` under the table id, so reopening
 *   the invite link in the same browser resumes the seat. Both are cleared when the table closes.
 * - The socket reconnects with backoff, and resumes the seat on every reconnect. It never
 *   reconnects after `seatTakenOver` (another tab or device holds the seat now), after
 *   `protocolMismatch` (this page is out of date) or after `tableClosed`.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  PROTOCOL_VERSION,
  TABLE_SERVER_TO_CLIENT_TYPES,
  type ClientToServerMessage,
  type ClockStatePayload,
  type HostSeatController,
  type TableBotPlay,
  type PlayerId,
  type ReplayTurnStatePayload,
  type ReplayUnlockedPayload,
  type SeatStatusPayload,
  type TableClientToServerMessage,
  type TableClosedReason,
  type TableDeckProblem,
  type TableResultsPayload,
  type TableServerToClientMessage,
  type TableStatePayload,
} from '@mtg/shared';
import type { ServerToClientMessage } from '../lib/protocol';
import { tableSocketUrl } from '../lib/tableOrigin';
import { useGameStore } from './game';

/** The part of a WebSocket the store uses; tests supply a fake. */
export interface TableSocketLike {
  send(text: string): void;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

export type TableSocketFactory = (url: string) => TableSocketLike;

function browserSocket(url: string): TableSocketLike {
  const socket = new WebSocket(url);
  return {
    send: (text) => {
      socket.send(text);
    },
    close: () => {
      socket.close();
    },
    onOpen: (listener) => {
      socket.addEventListener('open', listener);
    },
    onMessage: (listener) => {
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') listener(event.data);
      });
    },
    onClose: (listener) => {
      socket.addEventListener('close', listener);
    },
  };
}

function socketUrl(tableId: string): string {
  return tableSocketUrl(`/tables/${encodeURIComponent(tableId)}/ws`);
}

const seatKey = (tableId: string): string => `mtg-table-seat:${tableId}`;
const hostKey = (tableId: string): string => `mtg-table-host:${tableId}`;

/**
 * Read a stored token: storage first, then `tab`, this tab's own copy. Storage can be blocked or
 * throw (a private window, a full quota); the tokens then last as long as the tab instead of being
 * lost on the way to the table's page.
 */
function readStored(key: string, tab: Map<string, string>): string | null {
  try {
    const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (stored !== null) return stored;
  } catch {
    // Storage blocked: fall back to this tab's copy.
  }
  return tab.get(key) ?? null;
}

function writeStored(key: string, value: string | null, tab: Map<string, string>): void {
  if (value === null) tab.delete(key);
  else tab.set(key, value);
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the token lasts as long as the tab.
  }
}

const isTableFrame = (message: { type: string }): message is TableServerToClientMessage =>
  (TABLE_SERVER_TO_CLIENT_TYPES as readonly string[]).includes(message.type);

/** A seat's clock as last reported, with when it arrived, so a view can count down from it. */
export interface SeatClock extends ClockStatePayload {
  receivedAt: number;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * The server's refusal text for a host or seat token it does not accept (`badToken` in
 * `REFUSAL_TEXT`). The error frame carries no code, so this text is all there is to match; a
 * typed refusal code on the frame would make this exact.
 */
const BAD_TOKEN_TEXT = 'That token is not valid.';

export const useTableStore = defineStore('table', () => {
  const game = useGameStore();

  const tableId = ref<string | null>(null);
  const connection = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle');
  const state = ref<TableStatePayload | null>(null);
  const deckProblems = ref<TableDeckProblem[]>([]);
  const seatToken = ref<string | null>(null);
  const hostToken = ref<string | null>(null);
  /** This tab's copy of the tokens it stored (see `readStored`). */
  const tabTokens = new Map<string, string>();
  const read = (key: string): string | null => readStored(key, tabTokens);
  const write = (key: string, value: string | null): void => writeStored(key, value, tabTokens);
  const clocks = ref<Record<string, SeatClock>>({});
  const seatStatus = ref<Record<string, SeatStatusPayload>>({});
  const results = ref<TableResultsPayload | null>(null);
  const replayUnlock = ref<ReplayUnlockedPayload | null>(null);
  const replayTurn = ref<ReplayTurnStatePayload | null>(null);
  const errors = ref<string[]>([]);
  /** Set when the client must not reconnect, with why. */
  const stopped = ref<'takenOver' | 'protocolMismatch' | TableClosedReason | null>(null);

  let socket: TableSocketLike | null = null;
  let factory: TableSocketFactory = browserSocket;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let now: () => number = () => Date.now();
  let seatOnSocket: PlayerId | null = null;
  let lobbyJoin: { inviteCode: string; displayName: string } | null = null;
  // Which token a refusal on this socket could be answering. The server replies to `hostAuth`
  // then `resumeSeat` in order, and a success shows as a `tableState` that holds the role.
  let hostAuthPending = false;
  let resumePending = false;

  const you = computed(() => state.value?.you ?? null);
  const mySeat = computed<PlayerId | null>(() => you.value?.seat ?? null);
  const isHost = computed(() => you.value?.isHost === true);
  const insecureLan = computed(() => state.value?.insecureLan === true);
  const phase = computed(() => state.value?.phase ?? null);
  const displayNames = computed<Record<string, string>>(() =>
    Object.fromEntries(
      (state.value?.seats ?? []).flatMap((seat) =>
        seat.displayName === null ? [] : [[seat.seat, seat.displayName]],
      ),
    ),
  );

  function sendFrame(message: TableClientToServerMessage | ClientToServerMessage): void {
    if (socket === null || connection.value !== 'open') return;
    socket.send(JSON.stringify(message));
  }

  /** Tests: a socket factory and a clock. */
  function configure(options: { factory?: TableSocketFactory; now?: () => number }): void {
    if (options.factory !== undefined) factory = options.factory;
    if (options.now !== undefined) now = options.now;
  }

  /** Open the table's socket. Resumes a stored seat or host role on every (re)connect. */
  function open(id: string): void {
    if (tableId.value !== id) {
      close();
      tableId.value = id;
      seatToken.value = read(seatKey(id));
      hostToken.value = read(hostKey(id));
      state.value = null;
      results.value = null;
      replayUnlock.value = null;
      replayTurn.value = null;
      clocks.value = {};
      seatStatus.value = {};
      deckProblems.value = [];
      errors.value = [];
      lobbyJoin = null;
      stopped.value = null;
    }
    game.useTableTransport({ send: (message) => sendFrame(message) });
    connectNow();
  }

  function connectNow(): void {
    if (tableId.value === null || socket !== null || stopped.value !== null) return;
    setConnection('connecting');
    const next = factory(socketUrl(tableId.value));
    socket = next;
    seatOnSocket = null;
    hostAuthPending = false;
    resumePending = false;
    next.onOpen(() => {
      if (socket !== next) return;
      setConnection('open');
      backoffMs = 1_000;
      if (hostToken.value !== null) {
        hostAuthPending = true;
        sendFrame({ type: 'hostAuth', payload: { hostToken: hostToken.value } });
      }
      if (seatToken.value !== null) resume();
      else if (lobbyJoin !== null) join(lobbyJoin.inviteCode, lobbyJoin.displayName);
    });
    next.onMessage((text) => {
      if (socket !== next) return;
      let message: TableServerToClientMessage | ServerToClientMessage;
      try {
        message = JSON.parse(text) as TableServerToClientMessage | ServerToClientMessage;
      } catch {
        return;
      }
      receive(message);
    });
    next.onClose(() => {
      if (socket !== next) return;
      socket = null;
      setConnection('closed');
      scheduleReconnect();
    });
  }

  /** The board reads the game store's connection, so it is kept in step with the table's. */
  function setConnection(next: 'connecting' | 'open' | 'closed'): void {
    connection.value = next;
    game.connection = next;
  }

  function scheduleReconnect(): void {
    if (stopped.value !== null || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectNow();
    }, backoffMs);
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
  }

  function close(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    // Detach first: a close callback (or late frame) from this socket cannot reconnect it or
    // mutate the next table's state. Leaving the page does not mean the table was reaped.
    const previous = socket;
    socket = null;
    previous?.close();
    setConnection('closed');
    game.useTableTransport(null);
  }

  function resume(): void {
    if (seatToken.value === null) return;
    resumePending = true;
    sendFrame({
      type: 'resumeSeat',
      payload: { seatToken: seatToken.value, protocolVersion: PROTOCOL_VERSION, capabilities: {} },
    });
  }

  function forgetTokens(): void {
    if (tableId.value === null) return;
    seatToken.value = null;
    hostToken.value = null;
    write(seatKey(tableId.value), null);
    write(hostKey(tableId.value), null);
  }

  /**
   * A bad-token refusal while a stored token was awaiting its answer. The host token goes first
   * (its reply comes first); a refused seat token is dropped so the join form can show instead
   * of resuming a dead seat on every reconnect. Returns whether the refusal was consumed.
   */
  function refusedStoredToken(): boolean {
    if (hostAuthPending) {
      hostAuthPending = false;
      return true;
    }
    if (!resumePending) return false;
    resumePending = false;
    seatToken.value = null;
    if (tableId.value !== null) write(seatKey(tableId.value), null);
    return true;
  }

  function receive(message: TableServerToClientMessage | ServerToClientMessage): void {
    if (!isTableFrame(message)) {
      if (message.type === 'replayUnlocked') {
        replayUnlock.value = message.payload;
        return;
      }
      if (message.type === 'error') {
        if (message.payload.message === BAD_TOKEN_TEXT && refusedStoredToken()) return;
        errors.value = [message.payload.message];
      }
      game.receive(message);
      return;
    }
    switch (message.type) {
      case 'tableState':
        // Leaving a seat, a host reassignment and setup rejection all revoke the old token.
        // A host-auth frame before resume has no prior seat, so retain stored tokens then.
        if (seatOnSocket !== null && message.payload.you.seat === null) {
          seatToken.value = null;
          if (tableId.value !== null) write(seatKey(tableId.value), null);
        }
        seatOnSocket = message.payload.you.seat;
        if (message.payload.you.isHost) hostAuthPending = false;
        if (message.payload.you.seat !== null) resumePending = false;
        state.value = message.payload;
        return;
      case 'claimPending':
        deckProblems.value = [];
        return;
      case 'seatGranted':
        seatToken.value = message.payload.seatToken;
        if (tableId.value !== null) write(seatKey(tableId.value), message.payload.seatToken);
        resume();
        return;
      case 'deckProblems':
        deckProblems.value = message.payload.problems;
        return;
      case 'seatTakenOver':
        stopped.value = 'takenOver';
        socket?.close();
        return;
      case 'protocolMismatch':
        stopped.value = 'protocolMismatch';
        socket?.close();
        return;
      case 'tableClosed':
        stopped.value = message.payload.reason;
        forgetTokens();
        socket?.close();
        return;
      case 'tableResults':
        results.value = message.payload;
        return;
      case 'replayTurnState':
        replayTurn.value = message.payload;
        return;
      case 'clockState':
        clocks.value = {
          ...clocks.value,
          [message.payload.seat]: { ...message.payload, receivedAt: now() },
        };
        return;
      case 'seatStatus':
        seatStatus.value = { ...seatStatus.value, [message.payload.seat]: message.payload };
        return;
      default: {
        const unknown: never = message;
        void unknown;
      }
    }
  }

  /** Milliseconds left on a seat's clock as of `at`. */
  function remainingMs(seat: string, at: number = now()): number | null {
    const clock = clocks.value[seat];
    if (clock === undefined) return null;
    const elapsed = clock.running ? Math.max(0, at - clock.receivedAt) : 0;
    return Math.max(0, clock.remainingMs - elapsed);
  }

  // ── Lobby and host actions ────────────────────────────────────────────────────────────────

  function join(inviteCode: string, displayName: string): void {
    errors.value = [];
    lobbyJoin = { inviteCode, displayName };
    sendFrame({
      type: 'joinTable',
      payload: { inviteCode, displayName, protocolVersion: PROTOCOL_VERSION, capabilities: {} },
    });
  }
  function requestSeat(seat: PlayerId, decklist: string): void {
    deckProblems.value = [];
    sendFrame({ type: 'requestSeat', payload: { seat, decklist } });
  }
  function leaveSeat(): void {
    sendFrame({ type: 'leaveSeat', payload: {} });
  }
  /** Keep the host token a new table returned, for the table's page to authenticate with. */
  function storeHostToken(id: string, token: string): void {
    write(hostKey(id), token);
  }
  function becomeHost(token: string): void {
    hostToken.value = token;
    if (tableId.value !== null) write(hostKey(tableId.value), token);
    sendFrame({ type: 'hostAuth', payload: { hostToken: token } });
  }
  function approve(claimId: string): void {
    sendFrame({ type: 'hostApprove', payload: { claimId } });
  }
  function deny(claimId: string): void {
    sendFrame({ type: 'hostDeny', payload: { claimId } });
  }
  function setSeat(seat: PlayerId, controller: HostSeatController): void {
    sendFrame({ type: 'hostSetSeat', payload: { seat, controller } });
  }
  function setBots(bots: TableBotPlay): void {
    sendFrame({ type: 'hostSetBots', payload: { bots } });
  }
  function kick(seat: PlayerId): void {
    sendFrame({ type: 'hostKick', payload: { seat } });
  }
  function rotateInvite(): void {
    sendFrame({ type: 'hostRotateInvite', payload: {} });
  }
  function start(): void {
    sendFrame({ type: 'hostStart', payload: {} });
  }
  function abandon(): void {
    sendFrame({ type: 'hostAbandon', payload: {} });
  }
  function resumeControl(): void {
    sendFrame({ type: 'resumeControl', payload: {} });
  }
  function requestReplayTurn(turn: number): void {
    sendFrame({ type: 'replayTurn', payload: { turn } });
  }

  return {
    tableId,
    storeHostToken,
    connection,
    state,
    deckProblems,
    seatToken,
    hostToken,
    clocks,
    seatStatus,
    results,
    replayUnlock,
    replayTurn,
    errors,
    stopped,
    you,
    mySeat,
    isHost,
    insecureLan,
    phase,
    displayNames,
    configure,
    open,
    close,
    receive,
    remainingMs,
    join,
    requestSeat,
    leaveSeat,
    becomeHost,
    approve,
    deny,
    setSeat,
    setBots,
    kick,
    rotateInvite,
    start,
    abandon,
    resumeControl,
    requestReplayTurn,
  };
});
