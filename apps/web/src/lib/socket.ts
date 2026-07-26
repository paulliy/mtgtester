/**
 * The typed WebSocket client (brief §11). The frontend is a view: it sends the five client
 * messages and reacts to the eight server ones, and needs no engine code to interpret either.
 */

import type { ClientToServerMessage, ServerToClientMessage } from '@mtg/shared';

export type ServerMessageHandler = (message: ServerToClientMessage) => void;

/** Default to the page's own host so the Vite dev proxy and a built bundle both work. */
function defaultUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export type ConnectionState = 'connecting' | 'open' | 'closed';

export class GameSocket {
  private socket: WebSocket | null = null;
  private readonly queued: ClientToServerMessage[] = [];

  constructor(
    private readonly onMessage: ServerMessageHandler,
    private readonly onStateChange: (state: ConnectionState) => void,
    private readonly url: string = defaultUrl(),
  ) {}

  connect(): void {
    if (this.socket !== null) return;
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

    const closed = (): void => {
      this.socket = null;
      this.onStateChange('closed');
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
    this.socket?.close();
    this.socket = null;
  }
}
