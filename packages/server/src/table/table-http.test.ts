import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeResolvedDeck } from '../test-factory';
import type { TableConfig } from './config';
import type { DeckChecker } from './deck-check';
import { TableRegistry } from './registry';
import {
  createStaticFiles,
  handleTableRequest,
  isLoopbackRequest,
  manifestFiles,
  routeSocketFrame,
  type TableHttpContext,
} from './table-http';

const PORT = 3002;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-host-secret';

const deckChecker: DeckChecker = () => ({
  ok: true,
  deck: makeResolvedDeck({ commanders: [], cards: [] }),
});

let workDir = '';
let webDir = '';

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'table-http-'));
  webDir = join(workDir, 'web');
  mkdirSync(join(webDir, '.vite'), { recursive: true });
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>built</title>');
  writeFileSync(join(webDir, 'assets', 'app-abc.js'), 'console.log("app")');
  writeFileSync(join(webDir, 'assets', 'app-abc.css'), 'body{}');
  writeFileSync(join(webDir, 'assets', 'unlisted.js'), 'console.log("not in manifest")');
  writeFileSync(
    join(webDir, '.vite', 'manifest.json'),
    JSON.stringify({
      'src/main.ts': {
        file: 'assets/app-abc.js',
        isEntry: true,
        css: ['assets/app-abc.css'],
        assets: ['../../escape.txt', '/etc/passwd'],
      },
    }),
  );
  // Outside the served directory.
  writeFileSync(join(workDir, 'secret.txt'), 'TOP SECRET');
  writeFileSync(join(workDir, 'tables.sqlite'), 'database bytes');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function config(overrides: Partial<TableConfig> = {}): TableConfig {
  return {
    dev: true,
    insecureLan: false,
    allowedOrigins: [],
    allowedHosts: [],
    tls: null,
    trustedProxy: null,
    port: PORT,
    host: '127.0.0.1',
    publicOrigin: null,
    dbPath: join(workDir, 'tables.sqlite'),
    webDir,
    testRngKey: null,
    clock: 'off',
    maxTables: 8,
    oracleFixture: null,
    turnCap: null,
    paceMs: null,
    clockScale: null,
    hostSecret: null,
    maxStepWork: null,
    ...overrides,
  };
}

function context(overrides: Partial<TableConfig> = {}, dir = webDir) {
  const cfg = config(overrides);
  const registry = new TableRegistry({
    deckChecker,
    hostSecret: SECRET,
    maxTables: cfg.maxTables,
  });
  const ctx: TableHttpContext = {
    config: cfg,
    registry,
    files: createStaticFiles(dir),
    boundPort: () => PORT,
  };
  return ctx;
}

const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}${path}`, init);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const asResponse = (result: Response | { upgrade: { tableId: string } }): Response => {
  if (!(result instanceof Response)) throw new Error('expected a response');
  return result;
};

async function handle(ctx: TableHttpContext, req: Request, address = '10.0.0.1') {
  return handleTableRequest(ctx, req, address);
}

async function createTable(ctx: TableHttpContext, address = '10.0.0.1') {
  const response = asResponse(
    await handle(ctx, post('/tables', {}, { authorization: `Bearer ${SECRET}` }), address),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { tableId: string; hostToken: string; inviteUrl: string };
}

describe('creating a table', () => {
  it('needs the host secret', async () => {
    const ctx = context();
    const none = asResponse(await handle(ctx, post('/tables', {})));
    expect(none.status).toBe(401);
    const wrong = asResponse(
      await handle(ctx, post('/tables', {}, { authorization: 'Bearer nope' }), '10.0.0.2'),
    );
    expect(wrong.status).toBe(401);
    const query = asResponse(await handle(ctx, post(`/tables?secret=${SECRET}`, {}), '10.0.0.3'));
    expect(query.status).toBe(401);
    expect(ctx.registry.size).toBe(0);
    const get = asResponse(await handle(ctx, request('/tables')));
    expect(get.status).toBe(405);
  });

  it('returns the table id, host token and invite URL once', async () => {
    const ctx = context();
    const created = await createTable(ctx);
    const table = ctx.registry.get(created.tableId);
    expect(table).toBeDefined();
    expect(created.hostToken).toBe(table?.issuedHostToken);
    // The invite code is in the fragment, which a browser never sends.
    expect(created.inviteUrl).toBe(
      `${ORIGIN}/t/${created.tableId}#${table?.currentInviteCode ?? ''}`,
    );
    expect(created.hostToken.length).toBeGreaterThanOrEqual(40);
    // Later reads of the table do not repeat the host token.
    const summary = asResponse(
      await handle(
        ctx,
        post(`/tables/${created.tableId}/summary`, { inviteCode: table?.currentInviteCode }),
      ),
    );
    expect(await summary.text()).not.toContain(created.hostToken);
  });

  it('builds invite links from TABLE_PUBLIC_ORIGIN', async () => {
    const ctx = context({ publicOrigin: 'http://localhost:8080' });
    const created = await createTable(ctx);
    expect(created.inviteUrl.startsWith(`http://localhost:8080/t/${created.tableId}#`)).toBe(true);
  });

  it('throttles a client address that guesses the secret, and no other', async () => {
    const ctx = context();
    const bad = post('/tables', {}, { authorization: 'Bearer nope' });
    expect(asResponse(await handle(ctx, bad, '10.9.9.9')).status).toBe(401);
    const right = post('/tables', {}, { authorization: `Bearer ${SECRET}` });
    const blocked = asResponse(await handle(ctx, right, '10.9.9.9'));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const other = asResponse(
      await handle(ctx, post('/tables', {}, { authorization: `Bearer ${SECRET}` }), '10.9.9.8'),
    );
    expect(other.status).toBe(201);
  });

  it('stops at the table cap', async () => {
    const ctx = context({ maxTables: 1 });
    await createTable(ctx);
    const second = asResponse(
      await handle(ctx, post('/tables', {}, { authorization: `Bearer ${SECRET}` })),
    );
    expect(second.status).toBe(503);
  });
});

describe('the summary endpoint', () => {
  it('takes the invite in the POST body, never in the URL', async () => {
    const ctx = context();
    const created = await createTable(ctx);
    const table = ctx.registry.get(created.tableId)!;
    const path = `/tables/${created.tableId}/summary`;

    const viaUrl = asResponse(
      await handle(ctx, post(`${path}?inviteCode=${table.currentInviteCode}`, {})),
    );
    expect(viaUrl.status).toBe(400);

    const ok = asResponse(await handle(ctx, post(path, { inviteCode: table.currentInviteCode })));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      tableId: string;
      phase: string;
      joinable: boolean;
      seats: unknown[];
    };
    expect(body).toMatchObject({ tableId: created.tableId, phase: 'open', joinable: true });
    expect(body.seats).toHaveLength(4);

    const get = asResponse(await handle(ctx, request(path)));
    expect(get.status).toBe(405);
  });

  it('refuses a wrong invite, throttles the guesser, and reads the body strictly', async () => {
    const ctx = context();
    const created = await createTable(ctx);
    const path = `/tables/${created.tableId}/summary`;
    const wrong = asResponse(await handle(ctx, post(path, { inviteCode: 'nope' }), '10.5.5.5'));
    expect(wrong.status).toBe(403);
    const again = asResponse(
      await handle(
        ctx,
        post(path, { inviteCode: ctx.registry.get(created.tableId)?.currentInviteCode }),
        '10.5.5.5',
      ),
    );
    expect(again.status).toBe(429);
    const dup = asResponse(
      await handle(ctx, post(path, '{"inviteCode":"a","inviteCode":"b"}'), '10.5.5.6'),
    );
    expect(dup.status).toBe(400);
    const extra = asResponse(
      await handle(ctx, post(path, { inviteCode: 'a', hostToken: 'x' }), '10.5.5.7'),
    );
    expect(extra.status).toBe(400);
  });

  it('answers 404 for an unknown table', async () => {
    const ctx = context();
    const response = asResponse(
      await handle(ctx, post('/tables/AAAAAAAAAAAAAAAAAAAAAA/summary', { inviteCode: 'x' })),
    );
    expect(response.status).toBe(404);
  });
});

describe('the table socket route', () => {
  it('upgrades only a websocket request for a table that exists', async () => {
    const ctx = context();
    const created = await createTable(ctx);
    const path = `/tables/${created.tableId}/ws`;
    const upgrade = await handle(ctx, request(path, { headers: { upgrade: 'websocket' } }));
    expect(upgrade).toEqual({ upgrade: { tableId: created.tableId, address: '10.0.0.1' } });
    expect(asResponse(await handle(ctx, request(path))).status).toBe(426);
    const missing = asResponse(
      await handle(
        ctx,
        request('/tables/AAAAAAAAAAAAAAAAAAAAAA/ws', { headers: { upgrade: 'websocket' } }),
      ),
    );
    expect(missing.status).toBe(404);
  });
});

describe('inbound socket frames', () => {
  it('passes a text frame to the hub', () => {
    const hub = { message: vi.fn() };
    const ws = { data: { socketId: 's1' }, close: vi.fn() };
    routeSocketFrame(hub, ws, '{"type":"x"}');
    expect(hub.message).toHaveBeenCalledWith('s1', '{"type":"x"}');
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes the socket on a binary frame instead of dropping it past the rate limit', () => {
    const hub = { message: vi.fn() };
    const ws = { data: { socketId: 's1' }, close: vi.fn() };
    routeSocketFrame(hub, ws, new Uint8Array([1, 2, 3]));
    expect(hub.message).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1003, expect.any(String));
  });
});

describe('static files', () => {
  it('serves index.html and the manifest files, with page headers', async () => {
    const ctx = context();
    const root = asResponse(await handle(ctx, request('/')));
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<title>built</title>');
    expect(root.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const invitePage = asResponse(await handle(ctx, request('/t/abcdefghijklmnop')));
    expect(await invitePage.text()).toContain('<title>built</title>');
    const script = asResponse(await handle(ctx, request('/assets/app-abc.js')));
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(await script.text()).toBe('console.log("app")');
    const css = asResponse(await handle(ctx, request('/assets/app-abc.css')));
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(
      (await asResponse(await handle(ctx, request('/index.html'))).text()).length,
    ).toBeGreaterThan(0);
  });

  it('serves nothing outside the manifest', async () => {
    const ctx = context();
    for (const path of [
      '/assets/unlisted.js',
      '/.vite/manifest.json',
      '/assets/',
      '/assets',
      '/secret.txt',
      '/tables.sqlite',
      '/escape.txt',
      '/etc/passwd',
    ]) {
      const response = asResponse(await handle(ctx, request(path)));
      expect(response.status, path).toBe(404);
    }
  });

  it('refuses encoded .. paths and never returns a file outside the directory', async () => {
    const ctx = context();
    for (const path of [
      '/..%2fsecret.txt',
      '/..%2Fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets%2f..%2f..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
      '/assets%5c..%5c..%5csecret.txt',
      '/%252e%252e/secret.txt',
      '/assets/app-abc.js%00.png',
      '/t/..%2f..%2fsecret.txt',
      '/%c0%ae%c0%ae/secret.txt',
      '/%',
    ]) {
      const response = asResponse(await handle(ctx, request(path)));
      expect([400, 404], path).toContain(response.status);
      expect(await response.text(), path).not.toContain('TOP SECRET');
    }
    const traversal = asResponse(await handle(ctx, request('/assets/..%2f..%2fsecret.txt')));
    expect(traversal.status).toBe(400);
  });

  it('serves a placeholder page until the web build exists', async () => {
    const empty = join(workDir, 'empty');
    mkdirSync(empty, { recursive: true });
    const ctx = context({ webDir: empty }, empty);
    const page = asResponse(await handle(ctx, request('/')));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('not built yet');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(asResponse(await handle(ctx, request('/assets/app-abc.js'))).status).toBe(404);
  });

  it('refuses to serve a manifest path that is a symlink out of the directory', async () => {
    const dir = join(workDir, 'linked');
    mkdirSync(join(dir, '.vite'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), 'x');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(workDir, 'secret.txt'), join(dir, 'leak.txt'));
    writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify({ a: { file: 'leak.txt' } }));
    const ctx = context({ webDir: dir }, dir);
    const response = asResponse(await handle(ctx, request('/leak.txt')));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('TOP SECRET');
  });

  it('reads only plain relative paths from a Vite manifest', () => {
    const files = manifestFiles(
      JSON.stringify({
        a: {
          file: 'assets/a.js',
          css: ['assets/a.css', '../x.css'],
          assets: ['img/logo.png', '/abs.png'],
        },
        b: { file: 'a/../b.js' },
        c: 'not an entry',
      }),
    );
    expect([...files].sort()).toEqual(['assets/a.css', 'assets/a.js', 'img/logo.png']);
    expect(manifestFiles('not json').size).toBe(0);
    expect(manifestFiles('[1]').size).toBe(0);
  });
});

describe('development mode', () => {
  it('refuses a request whose Host is not loopback', async () => {
    const ctx = context();
    for (const host of [
      'evil.example',
      'evil.example:3002',
      '10.0.0.5:3002',
      'localhost.evil.test',
    ]) {
      const response = asResponse(await handle(ctx, request('/health', { headers: { host } })));
      expect(response.status, host).toBe(403);
    }
    const created = await createTable(ctx);
    const socket = asResponse(
      await handle(
        ctx,
        request(`/tables/${created.tableId}/ws`, {
          headers: { host: 'evil.example', upgrade: 'websocket' },
        }),
      ),
    );
    expect(socket.status).toBe(403);
  });

  it('refuses a creating request with a loopback address but a foreign Host', async () => {
    const ctx = context();
    const response = asResponse(
      await handle(
        ctx,
        post('/tables', {}, { authorization: `Bearer ${SECRET}`, host: 'tables.example.com' }),
      ),
    );
    expect(response.status).toBe(403);
    expect(ctx.registry.size).toBe(0);
  });

  it('refuses a foreign Origin, and a loopback Origin on another port', async () => {
    const ctx = context();
    for (const origin of [
      'http://evil.example',
      'http://127.0.0.1:4000',
      'null',
      'https://127.0.0.1:3002',
    ]) {
      const response = asResponse(await handle(ctx, request('/health', { headers: { origin } })));
      expect(response.status, origin).toBe(403);
    }
  });

  it('accepts loopback Host and Origin, including the Vite dev server', async () => {
    const ctx = context();
    for (const origin of [ORIGIN, 'http://localhost:3002', 'http://127.0.0.1:5173']) {
      const response = asResponse(await handle(ctx, request('/health', { headers: { origin } })));
      expect(response.status, origin).toBe(200);
    }
    for (const host of ['127.0.0.1:3002', 'localhost:3002', '[::1]:3002']) {
      const response = asResponse(await handle(ctx, request('/health', { headers: { host } })));
      expect(response.status, host).toBe(200);
    }
  });

  it('checks the Host port when the server has a fixed one', () => {
    expect(isLoopbackRequest(request('/', { headers: { host: '127.0.0.1:9999' } }), PORT)).toBe(
      false,
    );
    expect(isLoopbackRequest(request('/', { headers: { host: '127.0.0.1:9999' } }), 0)).toBe(true);
  });
});
