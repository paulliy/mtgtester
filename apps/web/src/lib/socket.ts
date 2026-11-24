/**
 * The typed WebSocket client (brief §11). The frontend is a view: it sends the five client
 * messages and reacts to the eight server ones, and needs no engine code to interpret either.
 */

import type { ClientToServerMessage } from '@mtg/shared';
import type { ServerToClientMessage } from './protocol';

export type ServerMessageHandler = (message: ServerToClientMessage) => void;

/** Default to the page's own host so the Vite dev proxy and a built bundle both work. */
function defaultUrl(): string {
  const configured = import.meta.env.VITE_GAME_WS_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** How each connection state reads in the UI. */
export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
};

/** What the game store talks through: the server's socket, or the local game worker. */
export interface GameTransport {
  connect(): void;
  send(message: ClientToServerMessage): void;
  close(): void;
}

export class GameSocket implements GameTransport {
  private socket: WebSocket | null = null;
  private readonly queued: ClientToServerMessage[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(
    private readonly onMessage: ServerMessageHandler,
    private readonly onStateChange: (state: ConnectionState) => void,
    private readonly url: string = defaultUrl(),
  ) {}

  connect(): void {
    if (this.socket !== null) return;
    this.shouldReconnect = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.onStateChange('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.onStateChange('open');
      // Anything sent before the handshake finished is replayed in order.
      for (const message of this.queued.splice(0)) this.send(message);
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        this.onMessage(JSON.parse(event.data) as ServerToClientMessage);
      } catch {
        // A frame we cannot parse is a server bug, not something the UI can recover from.
        console.error('Unparseable server frame', event.data);
      }
    });

    let handledClose = false;
    const closed = (): void => {
      if (handledClose) return;
      handledClose = true;
      this.socket = null;
      this.onStateChange('closed');
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 1_000);
      }
    };
    socket.addEventListener('close', closed);
    socket.addEventListener('error', closed);
  }

  send(message: ClientToServerMessage): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.queued.push(message);
      this.connect();
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * Local games (ADR 0053): the same transport over the game worker in this browser
 * (`lib/localEngine.ts`), loaded on first use. The worker answers exactly as the server would.
 * "Open" means the card files are read. A new game replaces the last one inside the worker, as
 * on the server, and leaving a game ends the worker, so its history is freed rather than kept
 * for a resume this build never offers. (A new game cannot get a fresh worker of its own: it
 * redeems the setup preview the current worker drew.)
 */
export class LocalGameSocket implements GameTransport {
  private engine: Promise<typeof import('./localEngine')> | null = null;
  private state: ConnectionState = 'closed';

  constructor(
    private readonly onMessage: ServerMessageHandler,
    private readonly onStateChange: (state: ConnectionState) => void,
  ) {}

  private load(): Promise<typeof import('./localEngine')> {
    this.engine ??= import('./localEngine');
    return this.engine;
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    this.onStateChange(next);
  }

  private listen(engine: typeof import('./localEngine')): void {
    engine.onFrame((text) => {
      try {
        this.onMessage(JSON.parse(text) as ServerToClientMessage);
      } catch {
        console.error('Unparseable worker frame', text);
      }
    });
  }

  connect(): void {
    if (this.state !== 'closed') return;
    this.setState('connecting');
    void this.load().then(async (engine) => {
      this.listen(engine);
      try {
        await engine.engineReady();
        if (this.state === 'connecting') this.setState('open');
      } catch (reason) {
        if (this.state === 'closed') return;
        this.onMessage({
          type: 'error',
          payload: {
            message: `The game engine could not load: ${reason instanceof Error ? reason.message : String(reason)}`,
          },
        });
        this.setState('closed');
      }
    });
  }

  send(message: ClientToServerMessage): void {
    this.connect();
    // Every send waits on the same import, so frames reach the worker in the order sent.
    void this.load().then((engine) => {
      // Leaving a local game frees it at once: the worker goes, and the next use starts afresh.
      if (message.type === 'abandonGame') {
        engine.stopEngine();
        return;
      }
      engine.sendFrame(JSON.stringify(message));
    });
  }

  /** Leave: the worker and the game in it are freed. */
  close(): void {
    if (this.state !== 'closed') this.setState('closed');
    void this.load().then((engine) => {
      engine.onFrame(null);
      engine.stopEngine();
    });
  }
}
