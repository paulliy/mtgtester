/**
 * The table server's HTTP side (ADR 0031 decisions 6 and 9; plan M3 tasks 8, 9 and 11).
 *
 * - `POST /tables` creates a table. It needs the host secret in an `Authorization: Bearer` header
 *   and returns the table id, the host token and the invite URL once.
 * - `POST /tables/<id>/summary` takes the invite code in the body, never in the URL, and returns
 *   the table's public summary.
 * - `GET /tables/<id>/ws` upgrades to the table socket (`table-ws.ts`).
 * - Everything else is the static table web build: only `index.html` and the files its Vite
 *   manifest names are served, never a directory path. Until M6 ships the build, a placeholder
 *   page stands in.
 *
 * In development mode every request must carry a loopback `Host` and, when present, a loopback
 * `Origin`; anything else is refused before it is routed.
 *
 * `handleTableRequest` uses only the standard `Request` and `Response`, so it is tested directly.
 * `startTableServer` is the thin Bun glue around it and the hub.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseStrictJson } from '@mtg/shared';
import { publicOriginFor, type TableConfig } from './config';
import { checkExposure, SocketLimiter } from './exposure';

export { isLoopbackRequest } from './exposure';
import type { TableRegistry } from './registry';
import { TABLE_MAX_FRAME_CHARS, type HubSocket, type TableSocketHub } from './table-ws';
import { constantTimeEqual } from './tokens';

const MAX_BODY_CHARS = 4096;
const MAX_SECRET_CHARS = 256;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// ── Static files ────────────────────────────────────────────────────────────────────────────

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
};

/**
 * The built table app's policy. The page keeps its seat and host tokens in `localStorage`, so a
 * script that ran in it could take a seat: only the bundle's own scripts run, and nothing is
 * framed, embedded or posted elsewhere. Card images come from Scryfall's image host and token
 * art from its search API. `'self'` covers the page's own socket (CSP Level 3). Inline styles
 * stay allowed, because Vue writes hoisted static markup, `style` attributes and all, through
 * `innerHTML`; they cannot run script.
 */
export const TABLE_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cards.scryfall.io",
  "connect-src 'self' https://api.scryfall.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers every page carries: it cannot be framed, sniffed or leaked through a referrer. */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': TABLE_PAGE_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MTG Tester tables</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem}</style>
</head>
<body>
<h1>MTG Tester tables</h1>
<p>The table server is running in development mode. The table web app is not built yet.</p>
</body>
</html>
`;

/** A path from the manifest is served only if it is a plain relative path with no `..`. */
function isPlainRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

interface ViteManifestEntry {
  file?: unknown;
  css?: unknown;
  assets?: unknown;
}

/** The files a Vite `.vite/manifest.json` names: each entry's `file`, `css` and `assets`. */
export function manifestFiles(manifestText: string): Set<string> {
  const files = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return files;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return files;
  const add = (value: unknown): void => {
    if (typeof value === 'string' && isPlainRelativePath(value)) files.add(value);
  };
  for (const entry of Object.values(parsed as Record<string, ViteManifestEntry>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    add(entry.file);
    for (const list of [entry.css, entry.assets]) {
      if (Array.isArray(list)) list.forEach(add);
    }
  }
  return files;
}

export interface StaticFiles {
  /** Whether a built `index.html` is being served (otherwise the placeholder is). */
  readonly hasBuild: boolean;
  /** The page for `/` and the invite path. */
  page(): Response;
  /**
   * A response for a pathname, or `null` for a path that is not served. A malformed or
   * traversing path is a 400.
   */
  serve(pathname: string): Response | null;
}

/**
 * Serve only `index.html` and the manifest's files from `webDir`. The set is read once at
 * creation. Every candidate is decoded once, checked for traversal, looked up by exact name, and
 * then resolved through `realpath` to confirm it still lies inside the directory.
 */
export function createStaticFiles(webDir: string): StaticFiles {
  const root = resolve(webDir);
  const manifestPath = resolve(root, '.vite', 'manifest.json');
  const allowed = new Set<string>();
  if (existsSync(resolve(root, 'index.html'))) allowed.add('index.html');
  if (existsSync(manifestPath)) {
    for (const file of manifestFiles(readFileSync(manifestPath, 'utf8'))) allowed.add(file);
  }
  const hasBuild = allowed.has('index.html');
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = null;
  }

  const readFile = (relative: string): Response | null => {
    if (realRoot === null) return null;
    try {
      const real = realpathSync(resolve(root, relative));
      if (!real.startsWith(realRoot + sep) || !statSync(real).isFile()) return null;
      const extension = relative.slice(relative.lastIndexOf('.') + 1).toLowerCase();
      const isPage = relative === 'index.html';
      return new Response(readFileSync(real), {
        headers: {
          'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
          'cache-control': isPage ? 'no-store' : 'public, max-age=3600',
          ...PAGE_HEADERS,
        },
      });
    } catch {
      return null;
    }
  };

  const page = (): Response =>
    (hasBuild ? readFile('index.html') : null) ??
    new Response(PLACEHOLDER_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...PAGE_HEADERS,
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    });

  return {
    hasBuild,
    page,
    serve(pathname) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return new Response('Bad path', { status: 400 });
      }
      if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
        return new Response('Bad path', { status: 400 });
      }
      const relative = decoded.slice(1);
      if (
        relative === '' ||
        relative === 't' ||
        relative.startsWith('t/') ||
        relative === 'multiplayer' ||
        relative.startsWith('multiplayer/')
      ) {
        // The tables' pages and invite paths (`/multiplayer/<id>`, and `/t/<id>` from before
        // the tables moved there): their segments are data for the page, never a file name.
        if (relative.split('/').includes('..')) return new Response('Bad path', { status: 400 });
        return page();
      }
      const segments = relative.split('/');
      if (segments.some((segment) => segment === '..' || segment === '.')) {
        return new Response('Bad path', { status: 400 });
      }
      if (!allowed.has(relative)) return null;
      return readFile(relative);
    },
  };
}

// ── Request handling ────────────────────────────────────────────────────────────────────────

export interface TableHttpContext {
  config: TableConfig;
  registry: TableRegistry;
  files: StaticFiles;
  /** The port in use (the configured one, or the one the OS gave for port 0). */
  boundPort: () => number;
}

/** The request is a WebSocket upgrade for this table; the caller completes it. */
export interface UpgradeRequest {
  upgrade: { tableId: string; address: string };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

function retryAfter(ms: number): Record<string, string> {
  return { 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) };
}

/** `Authorization: Bearer <secret>`, or `null`. */
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const secret = match?.[1];
  return secret === undefined || secret.length > MAX_SECRET_CHARS ? null : secret;
}

async function readBody(request: Request): Promise<string | null> {
  try {
    const text = await request.text();
    return text.length > MAX_BODY_CHARS ? null : text;
  } catch {
    return null;
  }
}

/**
 * Route one request. Returns a response, or an `UpgradeRequest` for a valid socket path. `address`
 * is the peer's address, which the throttles key on.
 */
export async function handleTableRequest(
  ctx: TableHttpContext,
  request: Request,
  peer: string,
): Promise<Response | UpgradeRequest> {
  const exposure = checkExposure(ctx.config, request, peer, ctx.boundPort());
  if (!exposure.ok) return new Response(exposure.reason, { status: exposure.status });
  // Throttles and per-address caps key on the client, which a trusted proxy names.
  const address = exposure.address;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/health') return json({ ok: true });

  if (path === '/tables') {
    if (method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    return createTable(ctx, request, address);
  }

  const tableRoute = /^\/tables\/([^/]+)\/(summary|ws)$/.exec(path);
  if (tableRoute !== null) {
    const tableId = tableRoute[1] ?? '';
    if (!TABLE_ID_PATTERN.test(tableId) || ctx.registry.get(tableId) === undefined) {
      return json({ error: 'No such table.' }, 404);
    }
    if (tableRoute[2] === 'ws') {
      if (method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'Upgrade required.' }, 426);
      }
      return { upgrade: { tableId, address } };
    }
    if (method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    return tableSummary(ctx, request, address, tableId);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, HEAD' });
  }
  return ctx.files.serve(path) ?? new Response('Not found', { status: 404 });
}

async function createTable(
  ctx: TableHttpContext,
  request: Request,
  address: string,
): Promise<Response> {
  const secret = bearer(request);
  if (secret === null) {
    return json({ error: 'The host secret is required.' }, 401, { 'www-authenticate': 'Bearer' });
  }
  const check = ctx.registry.checkHostSecret(secret, address);
  if (!check.ok) {
    if (check.reason === 'throttled') {
      return json({ error: 'Too many attempts.' }, 429, retryAfter(check.retryAfterMs));
    }
    return json({ error: 'The host secret is not valid.' }, 401, { 'www-authenticate': 'Bearer' });
  }
  const created = ctx.registry.create();
  if (!created.ok)
    return json({ error: 'The server is hosting as many tables as it allows.' }, 503);
  const origin = publicOriginFor(ctx.config, ctx.boundPort());
  // The invite code rides in the fragment, which a browser never sends to any server.
  const inviteUrl = `${origin}/multiplayer/${created.tableId}#${created.inviteCode}`;
  return json({ tableId: created.tableId, hostToken: created.hostToken, inviteUrl }, 201);
}

async function tableSummary(
  ctx: TableHttpContext,
  request: Request,
  address: string,
  tableId: string,
): Promise<Response> {
  const table = ctx.registry.get(tableId);
  if (table === undefined) return json({ error: 'No such table.' }, 404);
  const text = await readBody(request);
  const strict = text === null ? null : parseStrictJson(text);
  const body: unknown = strict !== null && strict.ok ? strict.value : null;
  const invite =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)['inviteCode']
      : undefined;
  if (
    typeof invite !== 'string' ||
    invite.length === 0 ||
    invite.length > MAX_SECRET_CHARS ||
    Object.keys(body as object).length !== 1
  ) {
    return json({ error: 'An invite code is required in the request body.' }, 400);
  }
  const throttle = ctx.registry.throttle;
  const wait = throttle.check(address);
  if (wait > 0) return json({ error: 'Too many attempts.' }, 429, retryAfter(wait));
  if (!constantTimeEqual(invite, table.currentInviteCode)) {
    throttle.fail(address);
    return json({ error: 'That invite code is not valid.' }, 403);
  }
  throttle.succeed(address);
  return json(table.publicSummary());
}

// ── Bun glue ────────────────────────────────────────────────────────────────────────────────

interface SocketData {
  tableId: string;
  socketId: string;
  address: string;
}

export interface TableServerDeps {
  config: TableConfig;
  registry: TableRegistry;
  hub: TableSocketHub;
  /** How often finished tables are checked for reaping. Default one minute. */
  reapIntervalMs?: number;
  /** Per-address socket caps (plan M5 task 2). */
  sockets?: SocketLimiter;
}

/** The largest inbound socket frame, in bytes (plan M5 task 2). */
export const TABLE_MAX_PAYLOAD_BYTES = 256 * 1024;
/** A socket silent this long (no frame, no pong) is closed. */
export const TABLE_IDLE_TIMEOUT_S = 120;
/** Outbound bytes a socket may have queued before it is closed as too slow to keep up. */
export const TABLE_BACKPRESSURE_BYTES = 1024 * 1024;

/**
 * One inbound WebSocket frame. The protocol is text-only, so a binary frame closes the socket
 * (code 1003) instead of being dropped, where it would dodge the hub's per-socket rate limit.
 */
export function routeSocketFrame(
  hub: Pick<TableSocketHub, 'message'>,
  ws: { data: { socketId: string }; close(code?: number, reason?: string): void },
  raw: unknown,
): void {
  if (typeof raw !== 'string') {
    ws.close(1003, 'Text frames only');
    return;
  }
  hub.message(ws.data.socketId, raw);
}

export interface RunningTableServer {
  readonly port: number;
  readonly origin: string;
  stop(): Promise<void>;
}

/** Listen on the configured loopback address, serve HTTP and sockets, and own the reaper timer. */
export function startTableServer(deps: TableServerDeps): RunningTableServer {
  const { config, registry, hub } = deps;
  const files = createStaticFiles(config.webDir);
  let boundPort = config.port;
  const ctx: TableHttpContext = { config, registry, files, boundPort: () => boundPort };

  const limiter = deps.sockets ?? new SocketLimiter();
  const server = Bun.serve<SocketData, never>({
    port: config.port,
    hostname: config.host,
    // Every request body this server reads is small (a host secret, an invite code); refuse a
    // large one before it is buffered.
    maxRequestBodySize: 16 * 1024,
    ...(config.tls !== null && {
      tls: { cert: Bun.file(config.tls.certPath), key: Bun.file(config.tls.keyPath) },
    }),
    fetch: async (request, srv) => {
      const peer = srv.requestIP(request)?.address ?? 'unknown';
      const result = await handleTableRequest(ctx, request, peer);
      if (result instanceof Response) return result;
      const address = result.upgrade.address;
      if (!limiter.admit(address)) {
        return new Response('Too many connections', {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      }
      const upgraded = srv.upgrade(request, {
        data: { tableId: result.upgrade.tableId, socketId: crypto.randomUUID(), address },
      });
      if (upgraded) return undefined;
      limiter.release(address);
      return new Response('WebSocket upgrade failed', { status: 400 });
    },
    websocket: {
      // Binary frames are not part of the protocol (`routeSocketFrame` closes on one). The hub also caps a frame's text length.
      maxPayloadLength: Math.min(TABLE_MAX_PAYLOAD_BYTES, TABLE_MAX_FRAME_CHARS * 3),
      idleTimeout: TABLE_IDLE_TIMEOUT_S,
      sendPings: true,
      backpressureLimit: TABLE_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true,
      open: (ws) => {
        const socket: HubSocket = {
          id: ws.data.socketId,
          address: ws.data.address,
          send: (text) => void ws.send(text),
          close: () => ws.close(),
        };
        if (!hub.open(ws.data.tableId, socket)) ws.close();
      },
      message: (ws, raw) => {
        routeSocketFrame(hub, ws, raw);
      },
      close: (ws) => {
        limiter.release(ws.data.address);
        hub.close(ws.data.socketId);
      },
    },
  });
  boundPort = server.port ?? config.port;

  const timer = setInterval(() => hub.reapIdle(), deps.reapIntervalMs ?? 60_000);
  timer.unref();

  return {
    port: boundPort,
    origin: publicOriginFor(config, boundPort),
    async stop() {
      clearInterval(timer);
      await hub.shutdown();
      // Bun 1.3.14 never settled this once a server-side WebSocket had closed; 1.4 does, and
      // `package.json` requires it.
      await server.stop(true);
    },
  };
}
