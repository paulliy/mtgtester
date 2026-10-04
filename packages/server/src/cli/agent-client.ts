/**
 * JSON agent client — play one Commander seat from a program instead of a browser.
 *
 *   bun run serve                                    # in one terminal
 *   bun run agent-client --seat P1 --seed demo       # in another, driven over stdin/stdout
 *
 * This is a client, not a second way to run a game: it speaks the existing single-player
 * WebSocket flow (`startGame` → `gameStarted` → `playerActionRequired` → `submitPlayerAction` →
 * `gameOver`) against the local server, exactly as the Vue player view does. No engine, no
 * decision policy, and no browser behavior lives here.
 *
 * The interface is strict NDJSON. stdout carries one JSON event per line and nothing else —
 * including for `--help`, which goes to stderr so that promise holds for every invocation.
 * stdin takes one reply line per outstanding decision. Everything a human would want to read is a
 * stderr diagnostic. `agent-client-core.ts` holds the translation and owns its tests; this file is
 * only the wiring to a real socket and a real process.
 *
 * Exit codes: 0 game over, 1 the run ended without one, 2 bad arguments, 130 interrupted.
 */

import type { ServerToClientMessage } from '@mtg/shared';
import {
  AGENT_CLIENT_USAGE,
  AgentClientSession,
  LineBuffer,
  createAgentIo,
  parseAgentClientArgs,
} from './agent-client-core';

function main(): void {
  const args = parseAgentClientArgs(process.argv.slice(2));
  if (args.kind === 'help') {
    process.stderr.write(`${AGENT_CLIENT_USAGE}\n`);
    return;
  }
  if (args.kind === 'error') {
    process.stderr.write(`agent-client: ${args.message}\n`);
    process.exitCode = 2;
    return;
  }

  const io = createAgentIo({
    writeOut: (chunk) => void process.stdout.write(chunk),
    writeErr: (chunk) => void process.stderr.write(chunk),
  });

  const socket = new WebSocket(args.url);
  const input = new LineBuffer();

  const session = new AgentClientSession({
    io,
    transport: {
      send: (message) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
    },
    game: args.game,
    onDone: (code) => {
      process.exitCode = code;
      // Nothing more will be read. Without this the stdin listener keeps the loop alive and a
      // finished run hangs holding the agent's pipe open.
      process.stdin.pause();
    },
  });

  socket.addEventListener('open', () => {
    io.diagnostic(
      `connected to ${args.url}; starting a single-player game on ${args.game.humanSeat}.`,
    );
    session.begin();
  });
  socket.addEventListener('message', (event: MessageEvent) => {
    const raw = event.data;
    if (typeof raw !== 'string') {
      io.diagnostic('ignored a non-text socket frame.');
      return;
    }
    let parsed: ServerToClientMessage;
    try {
      parsed = JSON.parse(raw) as ServerToClientMessage;
    } catch {
      // A frame the server sent that does not parse is a server bug, not something to answer.
      io.diagnostic('ignored an unparseable socket frame.');
      return;
    }
    session.receive(parsed);
  });
  // Bun reports a failed connection as `error` and may or may not follow it with `close`;
  // `socketClosed` is idempotent, so reacting to both is safe and neither can be missed.
  socket.addEventListener('error', () => session.socketClosed());
  socket.addEventListener('close', () => session.socketClosed());

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of input.take(chunk)) session.reply(line);
  });
  process.stdin.on('end', () => {
    for (const line of input.flush()) session.reply(line);
    session.inputClosed();
  });

  // A single-player session survives its socket closing (the server holds it for a reconnect), so
  // an interrupted agent would otherwise leave a game the next start has to fight for.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      io.diagnostic(`${signal} received; abandoning the game.`);
      try {
        socket.send(JSON.stringify({ type: 'abandonGame', payload: {} }));
      } catch {
        // The socket was already gone; there is nothing left to abandon.
      }
      socket.close();
      process.exit(130);
    });
  }
}

main();
