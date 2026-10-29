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
import { wireTables } from './wiring';

export interface ScriptedRunOptions {
  fixturePath?: string;
  turnCap?: number;
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

export interface ScriptedRunReport {
  ok: boolean;
  problems: string[];
  seats: ScriptedSeatReport[];
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
): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url);
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
  const loaded = loadTableConfig(
    {
      TABLE_DB_PATH: join(dir, 'tables.sqlite'),
      TABLE_WEB_DIR: join(dir, 'web'),
      TABLE_TEST_RNG_KEY: rngKey,
      TABLE_TURN_CAP: String(options.turnCap ?? 6),
      TABLE_PACE_MS: '0',
      TABLE_PORT: '0',
    },
    ['--dev', '--oracle-fixture', fixturePath],
  );
  if (!loaded.ok) throw new Error(loaded.error.message);
  const config = loaded.config;
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

  const frames: RecordedFrame[] = [];
  const record = (who: PlayerId | 'host', text: string): void => {
    frames.push({ to: who, text, order: frames.length });
  };
  const seatReports = new Map<PlayerId, ScriptedSeatReport>();
  const sockets: WebSocket[] = [];

  try {
    const created = await fetch(`${server.origin}/tables`, {
      method: 'POST',
      headers: { authorization: `Bearer ${registry.hostSecret}` },
    });
    const table = (await created.json()) as {
      tableId: string;
      hostToken: string;
      inviteUrl: string;
    };
    const wsUrl = `${server.origin.replace('http', 'ws')}/tables/${table.tableId}/ws`;
    const inviteCode = table.inviteUrl.split('#')[1] ?? '';

    // The host: authenticates, makes P3 and P4 bots, approves each claim, starts at two humans.
    let approved = 0;
    let startSent = false;
    const host = await openSocket(wsUrl, record, 'host', (frame) => {
      if (frame.type !== 'tableState') return;
      for (const claim of frame.payload.pendingClaims ?? []) {
        host.send(JSON.stringify({ type: 'hostApprove', payload: { claimId: claim.claimId } }));
        approved += 1;
      }
      if (!startSent && frame.payload.canStart && approved >= 2) {
        startSent = true;
        host.send(JSON.stringify({ type: 'hostStart', payload: {} }));
      }
    });
    sockets.push(host);
    host.send(JSON.stringify({ type: 'hostAuth', payload: { hostToken: table.hostToken } }));
    for (const seat of ['P3', 'P4'] as const) {
      host.send(JSON.stringify({ type: 'hostSetSeat', payload: { seat, controller: 'bot' } }));
    }

    const players: Array<{ seat: PlayerId; name: string }> = [
      { seat: 'P1', name: 'Ann' },
      { seat: 'P2', name: 'Bo' },
    ];
    const finished = players.map(
      ({ seat, name }) =>
        new Promise<void>((done, fail) => {
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
          const maybeDone = (): void => {
            if (report.gameOver && report.resultsEnding !== null && askedReplay) {
              if (report.replayTurns.length === 0 || report.replayTurnServed) done();
            }
          };
          const session = new TableAgentSession({
            io: {
              event: (event: AgentEvent) => {
                if (event.type === 'decision-required') report.decisionsAnswered += 1;
              },
              diagnostic: () => undefined,
            },
            transport: {
              send: (message) => socket?.send(JSON.stringify(message)),
              // The run keeps the socket open after `gameOver` to read the post-game record.
              close: () => undefined,
            },
            join: { inviteCode, displayName: name, seat, decklist: decklistFor(cards, seat) },
            policy: 'first-legal',
            onDone: (code) => {
              report.exitCode = code;
            },
          });
          openSocket(wsUrl, record, seat, (frame) => {
            report.frames += 1;
            // A turn-capped game ends as a halt, which the agent reports as a failed run; the
            // seat still receives the game's `gameOver`, and that is what this run waits for.
            if (frame.type === 'gameOver') report.gameOver = true;
            if (frame.type === 'tableResults') {
              report.resultsEnding = frame.payload.ending;
              report.resultsKeyMatches = frame.payload.rngKey === rngKey;
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
            session.receive(frame);
          })
            .then((opened) => {
              socket = opened;
              sockets.push(opened);
              session.begin();
            })
            .catch(fail);
        }),
    );

    const timeout = new Promise<'timeout'>((resolveTimeout) => {
      setTimeout(() => resolveTimeout('timeout'), options.timeoutMs ?? 240_000).unref();
    });
    const outcome = await Promise.race([Promise.all(finished).then(() => 'ok' as const), timeout]);
    if (outcome === 'timeout') problems.push('the scripted game did not finish in time');
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop();
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

  const scan = scanTableFrames(frames, { rngKey, protocolVersion: PROTOCOL_VERSION });
  for (const violation of scan.violations) {
    problems.push(
      `frame scan: ${violation.rule} in a frame to ${violation.to}: ${violation.detail}`,
    );
  }
  if (scan.handIdsTracked === 0) problems.push('frame scan: no hand was ever read from a board');
  const seats = [...seatReports.values()];
  for (const seat of seats) {
    if (!seat.gameOver) problems.push(`${seat.seat} never saw gameOver`);
    if (seat.exitCode === null) problems.push(`${seat.seat} agent never finished`);
    if (seat.resultsEnding !== 'gameOver')
      problems.push(`${seat.seat} results: ${seat.resultsEnding}`);
    if (!seat.resultsKeyMatches) problems.push(`${seat.seat} post-game key did not match`);
    if (seat.replayTurns.length === 0) problems.push(`${seat.seat} has no replay turns`);
    if (!seat.replayTurnServed) problems.push(`${seat.seat} replayTurn was not answered`);
    if (seat.decisionsAnswered === 0) problems.push(`${seat.seat} answered no decision`);
  }
  if (attempt?.status !== 'finished') problems.push(`attempt status ${String(attempt?.status)}`);

  return {
    ok: problems.length === 0,
    problems,
    seats,
    scan,
    attemptStatus: attempt?.status ?? null,
    gameStatus: game?.status ?? null,
    durationMs: Date.now() - started,
  };
}
