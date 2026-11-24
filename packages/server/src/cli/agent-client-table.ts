/**
 * Table mode of the JSON agent client (ADR 0031, plan M3 task 13): play one seat at a table
 * server instead of starting a single-player game.
 *
 * The lobby is handled here: join with the invite, ask for the seat with a decklist, wait for the
 * host to approve, then resume the seat on the same socket with the seat token. From then on the
 * in-game frames are the ones a browser seat gets, and `AgentClientSession` handles them exactly
 * as it does for single-player, with the same allow-list and the same reply checks.
 *
 * The seat token stays in this process: it is a takeover credential, so it is never written to
 * stdout. The capability declaration is sent on `joinTable` and again on `resumeSeat`, because a
 * resumed seat starts from the capabilities its resume declared.
 *
 * `--policy first-legal` answers every decision with the first action on the menu, each target
 * slot with its first option. It makes the client a scripted player for tests; the default policy
 * reads replies from stdin like single-player.
 */

import {
  PROTOCOL_VERSION,
  TABLE_SERVER_TO_CLIENT_TYPES,
  type PlayerId,
  type ServerToClientMessage,
  type TableServerToClientMessage,
} from '@mtg/shared';
import {
  AGENT_CAPABILITIES,
  AgentClientSession,
  type AgentClientIo,
  type AgentClientTransport,
  type AgentEvent,
} from './agent-client-core';

export type TableAgentPolicy = 'stdin' | 'first-legal';

export interface TableJoinOptions {
  inviteCode: string;
  displayName: string;
  seat: PlayerId;
  decklist: string;
}

export interface TableAgentSessionOptions {
  io: AgentClientIo;
  transport: AgentClientTransport;
  join: TableJoinOptions;
  policy: TableAgentPolicy;
  onDone?: (code: number) => void;
}

type TableFrame = TableServerToClientMessage;

const isTableFrame = (message: { type: string }): message is TableFrame =>
  (TABLE_SERVER_TO_CLIENT_TYPES as readonly string[]).includes(message.type);

export class TableAgentSession {
  private readonly game: AgentClientSession;
  private requested = false;
  private resumed = false;
  /** The host's pending-claim notice was seen, so a state with no claim later means denial. */
  private claimSeen = false;
  /** A game frame arrived since the last join or resume, so an `error` is no longer a refusal. */
  private settled = false;
  private done = false;
  /** The socket in use; `reconnect` swaps it. */
  private transport: AgentClientTransport;
  /** Held only in memory, for a reconnect; never written anywhere. */
  private seatToken: string | null = null;

  constructor(private readonly opts: TableAgentSessionOptions) {
    this.transport = opts.transport;
    const io: AgentClientIo = {
      event: (event) => {
        opts.io.event(event);
        if (opts.policy === 'first-legal') this.autoAnswer(event);
      },
      diagnostic: (message) => {
        opts.io.diagnostic(message);
      },
    };
    this.game = new AgentClientSession({
      io,
      transport: {
        send: (message) => {
          this.transport.send(message);
        },
        close: () => {
          this.transport.close();
        },
      },
      game: { seats: [], providerKind: 'random', humanSeat: opts.join.seat },
      table: { seat: opts.join.seat },
      onDone: (code) => {
        this.end(code);
      },
    });
  }

  /**
   * Resume the seat on a new socket after the old one dropped (the game keeps the seat for its
   * player, and its fallback bot plays it once the grace runs out). Call once the new socket is
   * open. False when no seat was granted yet.
   */
  reconnect(transport: AgentClientTransport): boolean {
    if (this.seatToken === null || this.done) return false;
    this.transport = transport;
    this.game.reconnected();
    this.sendResume(this.seatToken);
    return true;
  }

  /** Join the table. Called once the socket is open. */
  begin(): void {
    this.transport.send({
      type: 'joinTable',
      payload: {
        inviteCode: this.opts.join.inviteCode,
        displayName: this.opts.join.displayName,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { ...AGENT_CAPABILITIES },
      },
    });
  }

  receive(message: ServerToClientMessage | TableFrame): void {
    if (this.done) return;
    if (isTableFrame(message)) {
      this.onTableFrame(message);
      return;
    }
    if (message.type === 'error' && !this.settled) {
      // The join, the seat request or the resume was refused; nothing here will fix it.
      this.fail(`the table refused the request: ${message.payload.message}`);
      return;
    }
    this.settled = true;
    this.game.receive(message);
  }

  reply(line: string): void {
    if (this.opts.policy === 'stdin') this.game.reply(line);
  }

  inputClosed(): void {
    if (this.opts.policy === 'stdin') this.game.inputClosed();
  }

  socketClosed(): void {
    if (this.done) return;
    this.game.socketClosed();
  }

  private onTableFrame(message: TableFrame): void {
    switch (message.type) {
      case 'tableState': {
        const { you, phase } = message.payload;
        if (!this.requested && phase === 'open' && you.seat === null && you.claim === null) {
          this.requested = true;
          this.transport.send({
            type: 'requestSeat',
            payload: { seat: this.opts.join.seat, decklist: this.opts.join.decklist },
          });
        } else if (
          this.claimSeen &&
          this.seatToken === null &&
          you.seat === null &&
          you.claim === null
        ) {
          // The request was pending and now is not, and no seat was granted: the host said no.
          this.fail('the host denied the seat request.');
        }
        return;
      }
      case 'claimPending':
        this.claimSeen = true;
        this.opts.io.diagnostic(
          `seat request ${message.payload.seat} is waiting on the host; verification code ` +
            `${message.payload.verificationCode}.`,
        );
        return;
      case 'seatGranted':
        if (this.resumed) return;
        this.resumed = true;
        this.seatToken = message.payload.seatToken;
        this.opts.io.diagnostic(`seat ${message.payload.seat} granted; resuming it.`);
        this.sendResume(message.payload.seatToken);
        return;
      case 'deckProblems': {
        const problems = message.payload.problems.map((problem) => problem.message).join(' ');
        this.fail(`the table refused the decklist: ${problems}`);
        return;
      }
      case 'protocolMismatch':
        this.fail(
          `the table speaks protocol ${message.payload.serverVersion}; this client speaks ` +
            `${message.payload.clientVersion}.`,
        );
        return;
      case 'seatTakenOver':
        this.fail('another connection took this seat over.');
        return;
      case 'tableClosed':
        this.fail(`the table closed (${message.payload.reason}).`);
        return;
      case 'seatStatus': {
        // A connected client that finds its own seat with the fallback bot takes it back: it is
        // here to play. Another seat's status is the table's news, not this agent's.
        const { seat, connected, fallback } = message.payload;
        if (seat !== this.opts.join.seat || !fallback) return;
        this.opts.io.diagnostic('the fallback bot holds this seat; taking control back.');
        if (connected) this.transport.send({ type: 'resumeControl', payload: {} });
        return;
      }
      case 'clockState':
        // The clocks are for people; an agent answers as soon as it can.
        return;
      case 'tableResults':
      case 'replayTurnState':
        // Post-game data, after this client's run has ended on `gameOver`.
        return;
      default: {
        const unknown: never = message;
        void unknown;
      }
    }
  }

  private sendResume(seatToken: string): void {
    this.settled = false;
    this.transport.send({
      type: 'resumeSeat',
      payload: {
        seatToken,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { ...AGENT_CAPABILITIES },
      },
    });
  }

  private autoAnswer(event: AgentEvent): void {
    if (event.type !== 'decision-required') return;
    const action = event.request.legalActions[0];
    if (action === undefined) return;
    const targets = (action.targets ?? []).flatMap((slot) => {
      const choice = slot.options[0];
      return choice === undefined ? [] : [{ slot: slot.slot, choice }];
    });
    const line = JSON.stringify({
      requestId: event.requestId,
      revision: event.revision,
      actionId: action.id,
      ...(targets.length > 0 && { targets }),
    });
    // After the event has gone out, never inside the frame that produced it.
    queueMicrotask(() => {
      this.game.reply(line);
    });
  }

  private fail(message: string): void {
    this.opts.io.event({ type: 'error', source: 'server', fatal: true, message });
    this.transport.close();
    this.end(1);
  }

  private end(code: number): void {
    if (this.done) return;
    this.done = true;
    this.opts.onDone?.(code);
  }
}

/**
 * The table socket url from what a host hands out: an invite link
 * (`https://host/multiplayer/<table>#<invite>`, or `/t/<table>` from before) or the socket url
 * itself (`wss://host/tables/<table>/ws`).
 * The invite comes from the link's fragment unless given separately. An https or wss table may
 * be anywhere; a plain http or ws one only on loopback, or on a LAN with `insecureLan` (plan M5
 * task 6), since its traffic, seat token included, crosses the network unencrypted.
 */
export function tableSocketTarget(
  table: string,
  invite: string | undefined,
  insecureLan = false,
): { ok: true; url: string; inviteCode: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(table);
  } catch {
    return { ok: false, message: `${table} is not a valid url.` };
  }
  const fragment = parsed.hash.startsWith('#') ? decodeURIComponent(parsed.hash.slice(1)) : '';
  const inviteCode = invite ?? fragment;
  if (inviteCode === '') {
    return { ok: false, message: 'Pass --invite, or a table link that ends in #<invite>.' };
  }
  let tableId: string | undefined;
  const link = /^\/(?:multiplayer|t)\/([^/]+)\/?$/.exec(parsed.pathname);
  const socket = /^\/tables\/([^/]+)\/ws$/.exec(parsed.pathname);
  if (link !== null) tableId = link[1];
  else if (socket !== null) tableId = socket[1];
  if (tableId === undefined) {
    return { ok: false, message: `${table} is neither a table link nor a table socket url.` };
  }
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return { ok: false, message: `${table} must be an http(s) or ws(s) url.` };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (scheme === 'ws:' && !loopback && !insecureLan) {
    return {
      ok: false,
      message:
        `${table} is not encrypted. Use the https link, or pass --insecure-lan for a table on ` +
        'your own network.',
    };
  }
  return { ok: true, url: `${scheme}//${parsed.host}/tables/${tableId}/ws`, inviteCode };
}

// ── Argument parsing ───────────────────────────────────────────────────────────────────────

export type TableAgentArgs =
  | {
      kind: 'run';
      url: string;
      inviteCode: string;
      displayName: string;
      seat: PlayerId;
      deckPath: string;
      policy: TableAgentPolicy;
      insecureLan: boolean;
    }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const TABLE_AGENT_USAGE = `Play one seat at a local table server as a JSON agent.

  bun run agent-client --table <link> --name <name> --deck <file> [options]

Options
  --table <url>         The invite link (https://host/t/<id>#<invite>) or the table's socket
                        url (wss://host/tables/<id>/ws); plain http/ws only on loopback or with
                        --insecure-lan
  --invite <code>       The invite code, when the link does not end in #<invite>
  --name <name>         Display name at the table
  --deck <file>         Plaintext decklist to ask for the seat with
  --seat <P1..P4>       Seat to ask for (default P1)
  --policy <policy>     stdin (default): replies on stdin; first-legal: answer every decision
                        with the first legal action
  --insecure-lan        Allow a plain http/ws table on your own network (no TLS)
  --help                Show this message

The host approves the seat request; the client then plays like a single-player client.`;

const TABLE_SEATS: readonly PlayerId[] = ['P1', 'P2', 'P3', 'P4'];

export function parseTableAgentArgs(argv: readonly string[]): TableAgentArgs {
  let table: string | undefined;
  let invite: string | undefined;
  let name: string | undefined;
  let deckPath: string | undefined;
  let seat: PlayerId = 'P1';
  let policy: TableAgentPolicy = 'stdin';
  let insecureLan = false;
  const value = (index: number): string | null => {
    const next = argv[index];
    return next === undefined || next.startsWith('--') ? null : next;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--insecure-lan':
        insecureLan = true;
        break;
      case '--table':
      case '--invite':
      case '--name':
      case '--deck':
      case '--seat':
      case '--policy': {
        const next = value(++i);
        if (next === null) return { kind: 'error', message: `${flag} needs a value.` };
        if (flag === '--table') table = next;
        else if (flag === '--invite') invite = next;
        else if (flag === '--name') name = next;
        else if (flag === '--deck') deckPath = next;
        else if (flag === '--seat') {
          if (!TABLE_SEATS.includes(next)) {
            return { kind: 'error', message: `--seat needs one of ${TABLE_SEATS.join(', ')}.` };
          }
          seat = next;
        } else {
          if (next !== 'stdin' && next !== 'first-legal') {
            return { kind: 'error', message: '--policy needs stdin or first-legal.' };
          }
          policy = next;
        }
        break;
      }
      default:
        return { kind: 'error', message: `Unknown option ${flag}. Try --help.` };
    }
  }
  if (table === undefined) return { kind: 'error', message: '--table is required.' };
  if (name === undefined) return { kind: 'error', message: '--name is required.' };
  if (deckPath === undefined) return { kind: 'error', message: '--deck is required.' };
  const target = tableSocketTarget(table, invite, insecureLan);
  if (!target.ok) return { kind: 'error', message: target.message };
  return {
    kind: 'run',
    url: target.url,
    inviteCode: target.inviteCode,
    displayName: name,
    seat,
    deckPath,
    policy,
    insecureLan,
  };
}
