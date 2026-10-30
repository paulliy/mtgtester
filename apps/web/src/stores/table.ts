/**
 * The table app's connection and lobby (ADR 0031, plan M6 task 2).
 *
 * One socket per table, `/tables/<id>/ws` on the page's own origin. Table frames (lobby, clocks,
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
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/tables/${encodeURIComponent(tableId)}/ws`;
}

const seatKey = (tableId: string): string => `mtg-table-seat:${tableId}`;
const hostKey = (tableId: string): string => `mtg-table-host:${tableId}`;

function readStored(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the seat lasts as long as the tab.
  }
}

const isTableFrame = (message: { type: string }): message is TableServerToClientMessage =>
  (TABLE_SERVER_TO_CLIENT_TYPES as readonly string[]).includes(message.type);

/** A seat's clock as last reported, with when it arrived, so a view can count down from it. */
export interface SeatClock extends ClockStatePayload {
  receivedAt: number;
}

const MAX_BACKOFF_MS = 30_000;

export const useTableStore = defineStore('table', () => {
  const game = useGameStore();

  const tableId = ref<string | null>(null);
  const connection = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle');
  const state = ref<TableStatePayload | null>(null);
  const deckProblems = ref<TableDeckProblem[]>([]);
  const seatToken = ref<string | null>(null);
  const hostToken = ref<string | null>(null);
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
      seatToken.value = readStored(seatKey(id));
      hostToken.value = readStored(hostKey(id));
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
    next.onOpen(() => {
      if (socket !== next) return;
      setConnection('open');
      backoffMs = 1_000;
      if (hostToken.value !== null) {
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
    sendFrame({
      type: 'resumeSeat',
      payload: { seatToken: seatToken.value, protocolVersion: PROTOCOL_VERSION, capabilities: {} },
    });
  }

  function forgetTokens(): void {
    if (tableId.value === null) return;
    seatToken.value = null;
    hostToken.value = null;
    writeStored(seatKey(tableId.value), null);
    writeStored(hostKey(tableId.value), null);
  }

  function receive(message: TableServerToClientMessage | ServerToClientMessage): void {
    if (!isTableFrame(message)) {
      if (message.type === 'replayUnlocked') {
        replayUnlock.value = message.payload;
        return;
      }
      if (message.type === 'error') errors.value = [message.payload.message];
      game.receive(message);
      return;
    }
    switch (message.type) {
      case 'tableState':
        // Leaving a seat, a host reassignment and setup rejection all revoke the old token.
        // A host-auth frame before resume has no prior seat, so retain stored tokens then.
        if (seatOnSocket !== null && message.payload.you.seat === null) {
          seatToken.value = null;
          if (tableId.value !== null) writeStored(seatKey(tableId.value), null);
        }
        seatOnSocket = message.payload.you.seat;
        state.value = message.payload;
        return;
      case 'claimPending':
        deckProblems.value = [];
        return;
      case 'seatGranted':
        seatToken.value = message.payload.seatToken;
        if (tableId.value !== null) writeStored(seatKey(tableId.value), message.payload.seatToken);
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
  function becomeHost(token: string): void {
    hostToken.value = token;
    if (tableId.value !== null) writeStored(hostKey(tableId.value), token);
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
    kick,
    rotateInvite,
    start,
    abandon,
    resumeControl,
    requestReplayTurn,
  };
});
