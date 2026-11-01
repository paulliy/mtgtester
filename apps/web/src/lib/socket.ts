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

export class GameSocket {
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
