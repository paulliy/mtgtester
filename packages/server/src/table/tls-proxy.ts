/**
 * A minimal TLS-terminating reverse proxy for tests (plan M5): what an operator's nginx or Caddy
 * does in front of `serve:table` with `TABLE_BEHIND_TLS_PROXY=1`. It serves HTTPS and WSS with a
 * certificate made at run time, forwards each request and socket to the table server over plain
 * HTTP on loopback, passes `Host` through, and appends the client's address to
 * `X-Forwarded-For`. Bun runtime only. Not for production use.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestCertificate {
  certPath: string;
  keyPath: string;
  /** The certificate, PEM, for a client to trust. */
  ca: string;
}

/** A self-signed certificate for `localhost` and 127.0.0.1, valid for a day, written to `dir`. */
export function makeTestCertificate(dir: string): TestCertificate {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { certPath, keyPath, ca: readFileSync(certPath, 'utf8') };
}

interface ProxySocketData {
  path: string;
  host: string;
  forwardedFor: string;
  upstream: WebSocket | null;
  queue: string[];
}

export interface RunningTlsProxy {
  readonly port: number;
  /** Where to forward to, set once the table server has bound its port. */
  setUpstreamPort(port: number): void;
  stop(): void;
}

export function startTlsProxy(certificate: TestCertificate): RunningTlsProxy {
  let upstreamPort = 0;
  const forwardedFor = (request: Request, peer: string): string => {
    const prior = request.headers.get('x-forwarded-for');
    return prior === null ? peer : `${prior}, ${peer}`;
  };
  const server = Bun.serve<ProxySocketData, never>({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: Bun.file(certificate.certPath), key: Bun.file(certificate.keyPath) },
    fetch: async (request, srv) => {
      const url = new URL(request.url);
      const peer = srv.requestIP(request)?.address ?? '127.0.0.1';
      const host = request.headers.get('host') ?? url.host;
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const upgraded = srv.upgrade(request, {
          data: {
            path: url.pathname + url.search,
            host,
            forwardedFor: forwardedFor(request, peer),
            upstream: null,
            queue: [],
          },
        });
        return upgraded ? undefined : new Response('Upgrade failed', { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.set('host', host);
      headers.set('x-forwarded-for', forwardedFor(request, peer));
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
      return fetch(`http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(body !== null && { body }),
      });
    },
    websocket: {
      open: (ws) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${ws.data.path}`, {
          headers: { host: ws.data.host, 'x-forwarded-for': ws.data.forwardedFor },
        } as unknown as string[]);
        ws.data.upstream = upstream;
        upstream.addEventListener('open', () => {
          for (const text of ws.data.queue.splice(0)) upstream.send(text);
        });
        upstream.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data === 'string') ws.send(event.data);
        });
        upstream.addEventListener('close', () => ws.close());
        upstream.addEventListener('error', () => ws.close());
      },
      message: (ws, message) => {
        if (typeof message !== 'string') return;
        const upstream = ws.data.upstream;
        if (upstream !== null && upstream.readyState === WebSocket.OPEN) upstream.send(message);
        else ws.data.queue.push(message);
      },
      close: (ws) => {
        ws.data.upstream?.close();
      },
    },
  });
  return {
    port: server.port ?? 0,
    setUpstreamPort: (port) => {
      upstreamPort = port;
    },
    stop: () => {
      server.stop(true);
    },
  };
}
