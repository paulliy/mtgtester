/**
 * A whole table game, scripted, on loopback, in workers (plan M3 exit). Bun runtime only.
 *
 * It starts the table server the way `serve:table` does (`wireTables`, real worker threads, the
 * fixture oracle), creates a table over HTTP with the host secret, and seats two agent clients
 * (`TableAgentSession`, `first-legal`) beside two bots. The host approves both claims and starts.
 * Every frame each player receives is recorded and scanned (`scanTableFrames`). After the game
 * each player asks for a replay turn and reads the post-game record.
 *
 * `table-scripted-run.ts` in `cli/` runs this and prints the report; `scripted-run.test.ts`
 * spawns that and checks it, since Vitest cannot load `bun:sqlite` or start a Bun server.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROTOCOL_VERSION,
  type OracleCard,
  type PlayerId,
  type ServerToClientMessage,
  type TableServerToClientMessage,
} from '@mtg/shared';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { buildSupportedPool } from '../cards/pool';
import type { AgentEvent } from '../cli/agent-client-core';
import { TableAgentSession } from '../cli/agent-client-table';
import { GameStore } from '../db';
import { parseBannedList } from '../decks/banned';
import { generateCommanderDeck } from '../decks/generate';
import { loadTableConfig } from './config';
import { scanTableFrames, type FrameScanReport, type RecordedFrame } from './frame-scan';
import { startTableServer } from './table-http';
import { makeTestCertificate, startTlsProxy } from './tls-proxy';
import { wireTables } from './wiring';

export interface ScriptedRunOptions {
  fixturePath?: string;
  turnCap?: number;
  /** Human seats: 2 (P1, P2, with bots in P3 and P4) or 4. Default 2. */
  humans?: 2 | 4;
  /** The table clock. Default `off`. */
  clock?: 'off' | 'relaxed' | 'standard';
  /** Every clock duration divided by this. */
  clockScale?: number;
  /**
   * One seat drops its socket after this many decisions, stays away `awayMs`, then resumes the
   * seat on a new socket and takes control back from the fallback bot.
   */
  disconnect?: { seat: PlayerId; afterDecisions: number; awayMs: number };
  /**
   * Run the table server in production mode behind a TLS proxy (plan M5 exit): a certificate made
   * at run time, `TABLE_BEHIND_TLS_PROXY`, and every client over https and wss.
   */
  tls?: boolean;
  /** 64 hex digits; the run fails if it ever appears in a live frame. */
  rngKey?: string;
  /** Give up after this long. */
  timeoutMs?: number;
}

export interface ScriptedSeatReport {
  seat: PlayerId;
  exitCode: number | null;
  frames: number;
  decisionsAnswered: number;
  gameOver: boolean;
  resultsEnding: string | null;
  resultsKeyMatches: boolean;
  replayTurns: number[];
  replayTurnServed: boolean;
}

export interface ScriptedDisconnectReport {
  /** The seat was handed to its fallback bot while away. */
  fallbackSeen: boolean;
  reconnected: boolean;
  /** Decisions shown to the player after it took control back. */
  decisionsAfterResume: number;
}

export interface ScriptedRunReport {
  ok: boolean;
  problems: string[];
  seats: ScriptedSeatReport[];
  disconnect: ScriptedDisconnectReport | null;
  scan: FrameScanReport;
  attemptStatus: string | null;
  gameStatus: string | null;
  durationMs: number;
}

const DEFAULT_FIXTURE = 'packages/server/fixtures/coverage-oracle.json';
const DEFAULT_KEY = '5c'.repeat(32);

function decklistFor(cards: OracleCard[], label: string): string {
  const deck = generateCommanderDeck(buildSupportedPool(cards), { seed: `scripted-${label}` });
  const counts = new Map<string, number>();
  for (const card of deck.cards) counts.set(card.name, (counts.get(card.name) ?? 0) + 1);
  return [
    'Commander',
    deck.commander.name,
    '',
    'Deck',
    ...[...counts].map(([name, quantity]) => `${quantity} ${name}`),
  ].join('\n');
}

type AnyFrame = ServerToClientMessage | TableServerToClientMessage;

/** One WebSocket client that records every frame it receives, in arrival order. */
function openSocket(
  url: string,
  record: (seat: PlayerId | 'host', text: string) => void,
  who: PlayerId | 'host',
  onFrame: (frame: AnyFrame) => void,
  ca: string | null = null,
): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const socket =
      ca === null ? new WebSocket(url) : new WebSocket(url, { tls: { ca } } as unknown as string[]);
    socket.addEventListener('open', () => {
      resolvePromise(socket);
    });
    socket.addEventListener('error', () => {
      reject(new Error(`socket ${who} failed`));
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      record(who, event.data);
      onFrame(JSON.parse(event.data) as AnyFrame);
    });
  });
}

export async function runScriptedTable(
  options: ScriptedRunOptions = {},
): Promise<ScriptedRunReport> {
  const started = Date.now();
  const problems: string[] = [];
  const fixturePath = resolve(options.fixturePath ?? DEFAULT_FIXTURE);
  const rngKey = options.rngKey ?? DEFAULT_KEY;
  const dir = mkdtempSync(join(tmpdir(), 'mtg-table-run-'));
  const certificate = options.tls === true ? makeTestCertificate(dir) : null;
  const proxy = certificate === null ? null : startTlsProxy(certificate);
  const ca = certificate?.ca ?? null;
  const common = {
    TABLE_DB_PATH: join(dir, 'tables.sqlite'),
    TABLE_WEB_DIR: join(dir, 'web'),
    TABLE_PORT: '0',
  };
  const loaded =
    proxy === null
      ? loadTableConfig(
          {
            ...common,
            TABLE_TEST_RNG_KEY: rngKey,
            TABLE_TURN_CAP: String(options.turnCap ?? 6),
            TABLE_PACE_MS: '0',
            TABLE_CLOCK: options.clock ?? 'off',
            ...(options.clockScale !== undefined && {
              TABLE_CLOCK_SCALE: String(options.clockScale),
            }),
          },
          ['--dev', '--oracle-fixture', fixturePath],
        )
      : loadTableConfig(
          {
            ...common,
            TABLE_PUBLIC_ORIGIN: `https://localhost:${proxy.port}`,
            TABLE_ALLOWED_ORIGINS: `https://localhost:${proxy.port}`,
            TABLE_ALLOWED_HOSTS: `localhost:${proxy.port}`,
            TABLE_BEHIND_TLS_PROXY: '1',
            TABLE_TRUSTED_PROXY: '127.0.0.1',
          },
          ['--oracle-fixture', fixturePath],
        );
  if (!loaded.ok) throw new Error(loaded.error.message);
  // Production mode refuses the scripted-run settings from the environment; the harness sets
  // them on the configuration directly so the game stays short. The key stays a fresh one.
  const config =
    proxy === null ? loaded.config : { ...loaded.config, turnCap: options.turnCap ?? 6, paceMs: 0 };
  const cards = JSON.parse(readFileSync(fixturePath, 'utf8')) as OracleCard[];
  const store = new GameStore(config.dbPath);
  const { registry, hub } = wireTables({
    config,
    index: buildOracleIndexFromCards(cards),
    pool: buildSupportedPool(cards),
    banned: parseBannedList(''),
    store,
    replay: { cardDataSha256: 'scripted-run', build: { commit: null, branch: null, dirty: null } },
  });
  const server = startTableServer({ config, registry, hub });
  proxy?.setUpstreamPort(server.port);
  const origin = proxy === null ? server.origin : `https://localhost:${proxy.port}`;

  const frames: RecordedFrame[] = [];
  let gameKey = rngKey;
  const record = (who: PlayerId | 'host', text: string): void => {
    frames.push({ to: who, text, order: frames.length });
  };
  const seatReports = new Map<PlayerId, ScriptedSeatReport>();
  const sockets: WebSocket[] = [];
  const humanCount = options.humans ?? 2;
  const drop = options.disconnect;
  const disconnect: ScriptedDisconnectReport | null =
    drop === undefined
      ? null
      : { fallbackSeen: false, reconnected: false, decisionsAfterResume: 0 };

  try {
    const created = await fetch(`${origin}/tables`, {
      method: 'POST',
      headers: { authorization: `Bearer ${registry.hostSecret}` },
      ...(ca !== null && { tls: { ca } }),
    } as RequestInit);
    const table = (await created.json()) as {
      tableId: string;
      hostToken: string;
      inviteUrl: string;
    };
    const wsUrl = `${origin.replace('http', 'ws')}/tables/${table.tableId}/ws`;
    const inviteCode = table.inviteUrl.split('#')[1] ?? '';

    // The host: authenticates, makes the bot seats, approves each claim, starts once every human
    // seat is approved.
    let approved = 0;
    let startSent = false;
    const host = await openSocket(
      wsUrl,
      record,
      'host',
      (frame) => {
        if (frame.type !== 'tableState') return;
        for (const claim of frame.payload.pendingClaims ?? []) {
          host.send(JSON.stringify({ type: 'hostApprove', payload: { claimId: claim.claimId } }));
          approved += 1;
        }
        if (!startSent && frame.payload.canStart && approved >= humanCount) {
          startSent = true;
          host.send(JSON.stringify({ type: 'hostStart', payload: {} }));
        }
      },
      ca,
    );
    sockets.push(host);
    host.send(JSON.stringify({ type: 'hostAuth', payload: { hostToken: table.hostToken } }));
    if (humanCount === 2) {
      for (const seat of ['P3', 'P4'] as const) {
        host.send(JSON.stringify({ type: 'hostSetSeat', payload: { seat, controller: 'bot' } }));
      }
    }

    const players: Array<{ seat: PlayerId; name: string }> = [
      { seat: 'P1', name: 'Ann' },
      { seat: 'P2', name: 'Bo' },
      { seat: 'P3', name: 'Cy' },
      { seat: 'P4', name: 'Di' },
    ].slice(0, humanCount);
    // One claim at a time: every scripted player connects from the same address, and a table
    // holds at most two pending claims per address (plan M3 task 2).
    let previousGranted: Promise<void> = Promise.resolve();
    const finished = players.map(({ seat, name }) => {
      let markGranted!: () => void;
      const granted = new Promise<void>((resolveGranted) => {
        markGranted = resolveGranted;
      });
      const after = previousGranted;
      previousGranted = granted;
      return new Promise<void>((done, fail) => {
        const report: ScriptedSeatReport = {
          seat,
          exitCode: null,
          frames: 0,
          decisionsAnswered: 0,
          gameOver: false,
          resultsEnding: null,
          resultsKeyMatches: false,
          replayTurns: [],
          replayTurnServed: false,
        };
        seatReports.set(seat, report);
        let socket: WebSocket | null = null;
        let askedReplay = false;
        const dropsHere = drop !== undefined && drop.seat === seat;
        let away = false;
        let resumedAt: number | null = null;
        const maybeDone = (): void => {
          // A seat that was away at the end gets the results on return, without `gameOver`.
          if (report.resultsEnding !== null && askedReplay) {
            if (report.replayTurns.length === 0 || report.replayTurnServed) done();
          }
        };
        const session = new TableAgentSession({
          io: {
            event: (event: AgentEvent) => {
              if (event.type !== 'decision-required') return;
              report.decisionsAnswered += 1;
              if (disconnect !== null && resumedAt !== null) disconnect.decisionsAfterResume += 1;
              if (dropsHere && !away && resumedAt === null) {
                if (report.decisionsAnswered === drop.afterDecisions) leave();
              }
            },
            diagnostic: () => undefined,
          },
          transport: {
            send: (message) => {
              try {
                socket?.send(JSON.stringify(message));
              } catch {
                // Sent on a socket that is going away; the game still has the decision.
              }
            },
            close: () => undefined,
          },
          join: { inviteCode, displayName: name, seat, decklist: decklistFor(cards, seat) },
          policy: 'first-legal',
          onDone: (code) => {
            report.exitCode = code;
          },
        });
        const onFrame = (frame: AnyFrame): void => {
          report.frames += 1;
          if (frame.type === 'seatGranted') markGranted();
          if (
            disconnect !== null &&
            frame.type === 'seatStatus' &&
            frame.payload.seat === seat &&
            frame.payload.fallback
          ) {
            disconnect.fallbackSeen = true;
          }
          // A turn-capped game ends as a halt, which the agent reports as a failed run; the
          // seat still receives the game's `gameOver`, and that is what this run waits for.
          if (frame.type === 'gameOver') report.gameOver = true;
          if (frame.type === 'tableResults') {
            report.resultsEnding = frame.payload.ending;
            // A production table draws a fresh key: check its shape, not its value, and scan the
            // live frames for the key it turned out to be.
            if (frame.payload.rngKey !== null) gameKey = frame.payload.rngKey;
            report.resultsKeyMatches =
              proxy === null
                ? frame.payload.rngKey === rngKey
                : /^[0-9a-f]{64}$/.test(frame.payload.rngKey ?? '');
            report.replayTurns = frame.payload.replayTurns;
            const first = frame.payload.replayTurns[0];
            askedReplay = true;
            if (first !== undefined) {
              socket?.send(JSON.stringify({ type: 'replayTurn', payload: { turn: first } }));
            }
            maybeDone();
            return;
          }
          if (frame.type === 'replayTurnState') {
            report.replayTurnServed = true;
            maybeDone();
            return;
          }
          if (away) return;
          session.receive(frame);
        };
        const transportFor = (target: WebSocket) => ({
          send: (message: unknown) => {
            try {
              target.send(JSON.stringify(message));
            } catch {
              // Sent on a socket that is going away; the game still has the decision.
            }
          },
          // The run keeps the socket open after `gameOver` to read the post-game record.
          close: () => undefined,
        });
        /** Drop the socket mid-game, stay away past the grace, then resume on a new one. */
        const leave = (): void => {
          away = true;
          queueMicrotask(() => {
            socket?.close();
            setTimeout(() => {
              openSocket(wsUrl, record, seat, onFrame, ca)
                .then((opened) => {
                  socket = opened;
                  sockets.push(opened);
                  away = false;
                  resumedAt = Date.now();
                  if (disconnect !== null)
                    disconnect.reconnected = session.reconnect(transportFor(opened));
                })
                .catch(fail);
            }, drop?.awayMs ?? 0);
          });
        };
        after
          .then(() => openSocket(wsUrl, record, seat, onFrame, ca))
          .then((opened) => {
            socket = opened;
            sockets.push(opened);
            session.begin();
          })
          .catch(fail);
      });
    });

    const timeout = new Promise<'timeout'>((resolveTimeout) => {
      setTimeout(() => resolveTimeout('timeout'), options.timeoutMs ?? 240_000).unref();
    });
    const outcome = await Promise.race([Promise.all(finished).then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') problems.push('the scripted game did not finish in time');
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
    proxy?.stop();
  }

  const attempts = store.raw
    .query<{ status: string; game_id: string }, []>(`SELECT status, game_id FROM table_attempts`)
    .all();
  const attempt = attempts[0] ?? null;
  const game =
    attempt === null
      ? null
      : store.raw
          .query<{ status: string }, [string]>(`SELECT status FROM games WHERE id = ?`)
          .get(attempt.game_id);
  store.close();
  rmSync(dir, { recursive: true, force: true });

  const scan = scanTableFrames(frames, { rngKey: gameKey, protocolVersion: PROTOCOL_VERSION });
  for (const violation of scan.violations) {
    problems.push(
      `frame scan: ${violation.rule} in a frame to ${violation.to}: ${violation.detail}`,
    );
  }
  if (scan.handIdsTracked === 0) problems.push('frame scan: no hand was ever read from a board');
  const seats = [...seatReports.values()];
  for (const seat of seats) {
    if (!seat.gameOver && drop?.seat !== seat.seat) {
      problems.push(`${seat.seat} never saw gameOver`);
    }
    if (seat.exitCode === null) problems.push(`${seat.seat} agent never finished`);
    if (seat.resultsEnding !== 'gameOver')
      problems.push(`${seat.seat} results: ${seat.resultsEnding}`);
    if (!seat.resultsKeyMatches) problems.push(`${seat.seat} post-game key did not match`);
    if (seat.replayTurns.length === 0) problems.push(`${seat.seat} has no replay turns`);
    if (!seat.replayTurnServed) problems.push(`${seat.seat} replayTurn was not answered`);
    if (seat.decisionsAnswered === 0) problems.push(`${seat.seat} answered no decision`);
  }
  if (attempt?.status !== 'finished') problems.push(`attempt status ${String(attempt?.status)}`);

  if (disconnect !== null) {
    if (!disconnect.reconnected) problems.push('the dropped seat never reconnected');
    if (!disconnect.fallbackSeen) problems.push('the dropped seat was never handed to its bot');
    if (disconnect.decisionsAfterResume === 0) {
      problems.push('the player got no decision after taking control back');
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    seats,
    disconnect,
    scan,
    attemptStatus: attempt?.status ?? null,
    gameStatus: game?.status ?? null,
    durationMs: Date.now() - started,
  };
}
