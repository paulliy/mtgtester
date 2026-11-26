/**
 * `TABLE_*` settings and the command line of `serve:table` (ADR 0031 decision 9; plan M3 tasks 7
 * to 9, M5 task 1). Pure: `loadTableConfig(env, argv)` reads nothing from the process and returns
 * either the settings or a typed error, so the refusals are testable without starting a server.
 *
 * Two modes:
 *
 * - **Development (`--dev`).** Loopback only. The clock may be off, and a fixed test RNG key and
 *   the scripted-run settings are accepted. The server refuses to start with any proxy, TLS or
 *   allowlist setting, because a proxy or tunnel makes a loopback bind reachable from elsewhere.
 * - **Production.** Whatever address it binds (a tunnel can expose a loopback bind), the server
 *   refuses to start without `TABLE_PUBLIC_ORIGIN`, `TABLE_ALLOWED_ORIGINS` and
 *   `TABLE_ALLOWED_HOSTS`, and without TLS: its own certificate (`TABLE_TLS_CERT` and
 *   `TABLE_TLS_KEY`), or a TLS proxy in front (`TABLE_BEHIND_TLS_PROXY=1` with the proxy's address
 *   in `TABLE_TRUSTED_PROXY`). `--insecure-lan` waives TLS for a LAN game and then accepts only
 *   peers in private address ranges. Development-only settings are refused.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { TableClockMode } from '@mtg/shared';

export const DEFAULT_TABLE_PORT = 3002;
export const DEFAULT_TABLE_HOST = '127.0.0.1';
export const DEFAULT_TABLE_DB_PATH = 'data/tables/tables.sqlite';
export const DEFAULT_TABLE_WEB_DIR = 'apps/web/dist-table';
export const DEFAULT_MAX_TABLES = 8;

/** Settings that put the server behind something other than the loopback interface. */
export const PROXY_OR_ALLOWLIST_SETTINGS = [
  'TABLE_ALLOWED_ORIGINS',
  'TABLE_ALLOWED_HOSTS',
  'TABLE_BEHIND_TLS_PROXY',
  'TABLE_TLS_CERT',
  'TABLE_TLS_KEY',
  'TABLE_TRUSTED_PROXY',
] as const;

export interface TableConfig {
  /** Development mode (`--dev`): loopback only, test settings allowed. */
  dev: boolean;
  /** Production over plain HTTP on a LAN (`--insecure-lan`): private-range peers only. */
  insecureLan: boolean;
  /** Origins a page or socket may come from (production). Empty in development mode. */
  allowedOrigins: string[];
  /** `Host` values a request may name, lowercased `host[:port]` (production). */
  allowedHosts: string[];
  /** The server's own certificate, read from these files. */
  tls: { certPath: string; keyPath: string } | null;
  /** A TLS proxy in front: the peer at `trustedProxy` names the client in `X-Forwarded-For`. */
  trustedProxy: string | null;
  port: number;
  host: string;
  /** Where invite links point; `null` means the loopback URL of the bound port. */
  publicOrigin: string | null;
  /** Absolute path, outside `webDir`. */
  dbPath: string;
  /** Absolute path of the table web build that `table-http` serves from its manifest. */
  webDir: string;
  /** 64 hex digits (lowercase), or `null`. Accepted in development mode only. */
  testRngKey: string | null;
  clock: TableClockMode;
  maxTables: number;
  /** A JSON array of `OracleCard`s to load instead of the Scryfall bulk file. */
  oracleFixture: string | null;
  /** Development mode only: end each game at this turn (`TABLE_TURN_CAP`), for scripted runs. */
  turnCap: number | null;
  /** Development mode only: the live presentation pace in ms (`TABLE_PACE_MS`); 0 is no delay. */
  paceMs: number | null;
  /** Development mode only: every clock duration divided by this (`TABLE_CLOCK_SCALE`). */
  clockScale: number | null;
  /** A fixed host secret (`TABLE_HOST_SECRET`); null makes a random one at each start. */
  hostSecret: string | null;
  /** Development mode only: the engine's events per step (`TABLE_MAX_STEP_WORK`), to force a halt. */
  maxStepWork: number | null;
  /**
   * Model-driven seats (ADR 0055), on with `TABLE_AI_SEATS=1`; null when off. The Anthropic key
   * is read from the environment where it is used (each game worker inherits it), never stored
   * here, so it cannot reach a log line or a frame with the rest of the settings. `baseUrl` is
   * development mode's `TABLE_AI_BASE_URL`: a stand-in for the Anthropic API in a scripted run.
   */
  aiSeats: { maxUsdPerGame: number; baseUrl?: string } | null;
}

export type TableConfigErrorCode =
  /** Production mode without the allowlists or the public origin. */
  | 'allowlistRequired'
  /** Production mode without TLS and without `--insecure-lan`. */
  | 'tlsRequired'
  /** A development-only setting in production mode. */
  | 'devOnlySetting'
  /** `--dev` with a proxy, TLS or allowlist setting. */
  | 'devWithProxySetting'
  | 'badArgument'
  | 'badValue'
  /** A host or origin that is not loopback, in development mode. */
  | 'notLoopback'
  /** The database path lies inside the served web directory. */
  | 'dbInsideWebDir';

export interface TableConfigError {
  code: TableConfigErrorCode;
  message: string;
  /** The env var or flag at fault, when there is one. */
  setting?: string;
}

export type TableConfigResult =
  { ok: true; config: TableConfig } | { ok: false; error: TableConfigError };

const fail = (
  code: TableConfigErrorCode,
  message: string,
  setting?: string,
): TableConfigResult => ({
  ok: false,
  error: { code, message, ...(setting === undefined ? {} : { setting }) },
});

const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** Whether a bare host name or address is a loopback one. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname.toLowerCase());
}

interface ParsedArgs {
  dev: boolean;
  insecureLan: boolean;
  port: number | null;
  oracleFixture: string | null;
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65_535 ? port : null;
}

function parseArgs(argv: readonly string[]): ParsedArgs | TableConfigError {
  const args: ParsedArgs = { dev: false, insecureLan: false, port: null, oracleFixture: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev') {
      args.dev = true;
    } else if (arg === '--insecure-lan') {
      args.insecureLan = true;
    } else if (arg === '--oracle-fixture') {
      const value = argv[++i];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return {
          code: 'badArgument',
          message: '--oracle-fixture needs a file path.',
          setting: arg,
        };
      }
      args.oracleFixture = value;
    } else if (arg === '--port') {
      const port = parsePort(argv[++i]);
      if (port === null) {
        return {
          code: 'badArgument',
          message: '--port needs a number from 0 to 65535.',
          setting: arg,
        };
      }
      args.port = port;
    } else {
      return {
        code: 'badArgument',
        message: `Unknown argument "${String(arg)}". Supported: --dev, --insecure-lan, --oracle-fixture <file>, --port <n>.`,
        setting: String(arg),
      };
    }
  }
  return args;
}

const setting = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Read the settings. `cwd` resolves relative paths and defaults to the process's. Nothing else
 * of the process is read.
 */
export function loadTableConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  cwd: string = process.cwd(),
): TableConfigResult {
  const args = parseArgs(argv);
  if ('code' in args) return { ok: false, error: args };

  if (args.dev && args.insecureLan) {
    return fail(
      'badArgument',
      '--insecure-lan is a production setting; development mode is loopback only.',
      '--insecure-lan',
    );
  }

  const portSetting = setting(env, 'TABLE_PORT');
  let port = args.port ?? DEFAULT_TABLE_PORT;
  if (args.port === null && portSetting !== undefined) {
    const parsed = parsePort(portSetting);
    if (parsed === null) {
      return fail('badValue', 'TABLE_PORT must be a number from 0 to 65535.', 'TABLE_PORT');
    }
    port = parsed;
  }
  const host = setting(env, 'TABLE_HOST') ?? DEFAULT_TABLE_HOST;

  let exposure: Exposure;
  if (args.dev) {
    const dev = devExposure(env, host);
    if ('code' in dev) return { ok: false, error: dev };
    exposure = dev;
  } else {
    const production = productionExposure(env, args.insecureLan, cwd);
    if ('code' in production) return { ok: false, error: production };
    exposure = production;
  }
  const publicOrigin = exposure.publicOrigin;

  const keySetting = setting(env, 'TABLE_TEST_RNG_KEY');
  let testRngKey: string | null = null;
  if (keySetting !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(keySetting)) {
      return fail(
        'badValue',
        'TABLE_TEST_RNG_KEY must be 64 hex digits (32 bytes).',
        'TABLE_TEST_RNG_KEY',
      );
    }
    testRngKey = keySetting.toLowerCase();
  }

  // Development mode defaults the clock off; production defaults to relaxed and never runs off.
  const clockSetting = setting(env, 'TABLE_CLOCK') ?? (args.dev ? 'off' : 'relaxed');
  if (clockSetting !== 'off' && clockSetting !== 'relaxed' && clockSetting !== 'standard') {
    return fail('badValue', 'TABLE_CLOCK must be off, relaxed or standard.', 'TABLE_CLOCK');
  }
  if (!args.dev) {
    if (clockSetting === 'off') {
      return fail(
        'devOnlySetting',
        'An untimed table is for development mode only.',
        'TABLE_CLOCK',
      );
    }
    for (const name of DEV_ONLY_SETTINGS) {
      if (setting(env, name) !== undefined) {
        return fail('devOnlySetting', `${name} is for development mode only.`, name);
      }
    }
  }

  const maxSetting = setting(env, 'TABLE_MAX_TABLES');
  let maxTables = DEFAULT_MAX_TABLES;
  if (maxSetting !== undefined) {
    if (!/^\d{1,4}$/.test(maxSetting) || Number(maxSetting) < 1) {
      return fail(
        'badValue',
        'TABLE_MAX_TABLES must be a positive whole number.',
        'TABLE_MAX_TABLES',
      );
    }
    maxTables = Number(maxSetting);
  }

  const turnCap = wholeSetting(env, 'TABLE_TURN_CAP', 1, 10_000);
  if (turnCap === 'bad') {
    return fail('badValue', 'TABLE_TURN_CAP must be a whole number from 1.', 'TABLE_TURN_CAP');
  }
  const paceMs = wholeSetting(env, 'TABLE_PACE_MS', 0, 60_000);
  if (paceMs === 'bad') {
    return fail('badValue', 'TABLE_PACE_MS must be a whole number of ms.', 'TABLE_PACE_MS');
  }

  const clockScale = wholeSetting(env, 'TABLE_CLOCK_SCALE', 1, 10_000);
  if (clockScale === 'bad') {
    return fail(
      'badValue',
      'TABLE_CLOCK_SCALE must be a whole number from 1.',
      'TABLE_CLOCK_SCALE',
    );
  }

  // A fixed host secret: in development for end-to-end tests, in production so the operator can
  // create tables without reading the log after every restart. Production asks for a longer one,
  // since it lives for months rather than one test run.
  const hostSecret = setting(env, 'TABLE_HOST_SECRET') ?? null;
  const minSecret = args.dev ? 16 : 24;
  if (hostSecret !== null && !new RegExp(`^[A-Za-z0-9_-]{${minSecret},128}$`).test(hostSecret)) {
    return fail(
      'badValue',
      `TABLE_HOST_SECRET must be ${minSecret} to 128 letters, digits, - or _.`,
      'TABLE_HOST_SECRET',
    );
  }
  const maxStepWork = wholeSetting(env, 'TABLE_MAX_STEP_WORK', 1, 1_000_000);
  if (maxStepWork === 'bad') {
    return fail(
      'badValue',
      'TABLE_MAX_STEP_WORK must be a whole number from 1.',
      'TABLE_MAX_STEP_WORK',
    );
  }

  const aiSetting = setting(env, 'TABLE_AI_SEATS') ?? '0';
  if (aiSetting !== '0' && aiSetting !== '1') {
    return fail('badValue', 'TABLE_AI_SEATS must be 0 or 1.', 'TABLE_AI_SEATS');
  }
  let aiSeats: TableConfig['aiSeats'] = null;
  if (aiSetting === '1') {
    if ((env['ANTHROPIC_API_KEY'] ?? '').trim() === '') {
      return fail(
        'badValue',
        'TABLE_AI_SEATS=1 needs ANTHROPIC_API_KEY: model seats call the Anthropic API.',
        'ANTHROPIC_API_KEY',
      );
    }
    const capSetting = setting(env, 'TABLE_AI_MAX_USD_PER_GAME') ?? '1';
    const maxUsdPerGame = Number(capSetting);
    if (!/^\d+(\.\d+)?$/.test(capSetting) || !(maxUsdPerGame > 0) || maxUsdPerGame > 100) {
      return fail(
        'badValue',
        'TABLE_AI_MAX_USD_PER_GAME must be a dollar amount above 0 and at most 100.',
        'TABLE_AI_MAX_USD_PER_GAME',
      );
    }
    const baseUrl = setting(env, 'TABLE_AI_BASE_URL');
    if (baseUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      return fail('badValue', 'TABLE_AI_BASE_URL must be an http(s) URL.', 'TABLE_AI_BASE_URL');
    }
    aiSeats = { maxUsdPerGame, ...(baseUrl !== undefined && { baseUrl }) };
  } else if (setting(env, 'TABLE_AI_MAX_USD_PER_GAME') !== undefined) {
    return fail(
      'badValue',
      'TABLE_AI_MAX_USD_PER_GAME applies only with TABLE_AI_SEATS=1.',
      'TABLE_AI_MAX_USD_PER_GAME',
    );
  }

  const webDir = resolve(cwd, setting(env, 'TABLE_WEB_DIR') ?? DEFAULT_TABLE_WEB_DIR);
  const dbPath = resolve(cwd, setting(env, 'TABLE_DB_PATH') ?? DEFAULT_TABLE_DB_PATH);
  if (isInside(webDir, dbPath)) {
    return fail(
      'dbInsideWebDir',
      'The table database must live outside the served web directory.',
      'TABLE_DB_PATH',
    );
  }

  return {
    ok: true,
    config: {
      dev: args.dev,
      insecureLan: args.insecureLan,
      allowedOrigins: exposure.allowedOrigins,
      allowedHosts: exposure.allowedHosts,
      tls: exposure.tls,
      trustedProxy: exposure.trustedProxy,
      port,
      host,
      publicOrigin,
      dbPath,
      webDir,
      testRngKey,
      clock: clockSetting,
      maxTables,
      oracleFixture: args.oracleFixture,
      turnCap,
      paceMs,
      clockScale,
      hostSecret,
      maxStepWork,
      aiSeats,
    },
  };
}

/** Settings only development mode accepts. */
export const DEV_ONLY_SETTINGS = [
  'TABLE_TEST_RNG_KEY',
  'TABLE_TURN_CAP',
  'TABLE_PACE_MS',
  'TABLE_CLOCK_SCALE',
  'TABLE_MAX_STEP_WORK',
  'TABLE_AI_BASE_URL',
] as const;

/** Who may reach the server, and how. */
interface Exposure {
  publicOrigin: string | null;
  allowedOrigins: string[];
  allowedHosts: string[];
  tls: { certPath: string; keyPath: string } | null;
  trustedProxy: string | null;
}

/** Development mode: loopback only, and no proxy, TLS or allowlist setting at all. */
function devExposure(
  env: Readonly<Record<string, string | undefined>>,
  host: string,
): Exposure | TableConfigError {
  for (const name of PROXY_OR_ALLOWLIST_SETTINGS) {
    if (setting(env, name) !== undefined) {
      return {
        code: 'devWithProxySetting',
        message:
          `${name} is set. Development mode is loopback only and refuses to start with any ` +
          'proxy, TLS or allowlist setting, because a proxy or tunnel can expose a loopback bind.',
        setting: name,
      };
    }
  }
  if (!isLoopbackHostname(host)) {
    return {
      code: 'notLoopback',
      message: `TABLE_HOST "${host}" is not a loopback address. Development mode binds loopback only.`,
      setting: 'TABLE_HOST',
    };
  }
  let publicOrigin: string | null = null;
  const originSetting = setting(env, 'TABLE_PUBLIC_ORIGIN');
  if (originSetting !== undefined) {
    const origin = parseOrigin(originSetting, 'TABLE_PUBLIC_ORIGIN', ['http:', 'https:']);
    if (typeof origin !== 'string') return origin;
    if (!isLoopbackHostname(new URL(origin).hostname)) {
      return {
        code: 'notLoopback',
        message:
          'TABLE_PUBLIC_ORIGIN is not loopback. Development mode refuses non-loopback origins.',
        setting: 'TABLE_PUBLIC_ORIGIN',
      };
    }
    if (!origin.startsWith('http:')) {
      return {
        code: 'badValue',
        message: 'TABLE_PUBLIC_ORIGIN must be a plain http origin in development mode.',
        setting: 'TABLE_PUBLIC_ORIGIN',
      };
    }
    publicOrigin = origin;
  }
  return { publicOrigin, allowedOrigins: [], allowedHosts: [], tls: null, trustedProxy: null };
}

/**
 * Production: the allowlists and the public origin always, and TLS unless `--insecure-lan`.
 * The rules hold for any bind address, loopback included.
 */
function productionExposure(
  env: Readonly<Record<string, string | undefined>>,
  insecureLan: boolean,
  cwd: string,
): Exposure | TableConfigError {
  const schemes = insecureLan ? ['http:', 'https:'] : ['https:'];
  const originSetting = setting(env, 'TABLE_PUBLIC_ORIGIN');
  const originsSetting = setting(env, 'TABLE_ALLOWED_ORIGINS');
  const hostsSetting = setting(env, 'TABLE_ALLOWED_HOSTS');
  for (const [name, value] of [
    ['TABLE_PUBLIC_ORIGIN', originSetting],
    ['TABLE_ALLOWED_ORIGINS', originsSetting],
    ['TABLE_ALLOWED_HOSTS', hostsSetting],
  ] as const) {
    if (value === undefined) {
      return {
        code: 'allowlistRequired',
        message:
          `${name} is required outside development mode, whatever address the server binds: ` +
          'a tunnel or proxy can expose a loopback bind.',
        setting: name,
      };
    }
  }
  const publicOrigin = parseOrigin(originSetting!, 'TABLE_PUBLIC_ORIGIN', schemes);
  if (typeof publicOrigin !== 'string') return publicOrigin;
  const allowedOrigins: string[] = [];
  for (const entry of originsSetting!.split(',').map((item) => item.trim())) {
    if (entry === '') continue;
    const origin = parseOrigin(entry, 'TABLE_ALLOWED_ORIGINS', schemes);
    if (typeof origin !== 'string') return origin;
    allowedOrigins.push(origin);
  }
  if (!allowedOrigins.includes(publicOrigin)) {
    return {
      code: 'badValue',
      message: 'TABLE_ALLOWED_ORIGINS must include TABLE_PUBLIC_ORIGIN, where invite links point.',
      setting: 'TABLE_ALLOWED_ORIGINS',
    };
  }
  const allowedHosts: string[] = [];
  for (const entry of hostsSetting!.split(',').map((item) => item.trim().toLowerCase())) {
    if (entry === '') continue;
    if (!/^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/.test(entry)) {
      return {
        code: 'badValue',
        message: `TABLE_ALLOWED_HOSTS entry "${entry}" is not a host or host:port.`,
        setting: 'TABLE_ALLOWED_HOSTS',
      };
    }
    allowedHosts.push(entry);
  }
  if (allowedHosts.length === 0) {
    return {
      code: 'allowlistRequired',
      message: 'TABLE_ALLOWED_HOSTS names no host.',
      setting: 'TABLE_ALLOWED_HOSTS',
    };
  }

  const cert = setting(env, 'TABLE_TLS_CERT');
  const key = setting(env, 'TABLE_TLS_KEY');
  const behindProxy = setting(env, 'TABLE_BEHIND_TLS_PROXY');
  const proxy = setting(env, 'TABLE_TRUSTED_PROXY');
  if ((cert === undefined) !== (key === undefined)) {
    return {
      code: 'badValue',
      message: 'TABLE_TLS_CERT and TABLE_TLS_KEY go together.',
      setting: cert === undefined ? 'TABLE_TLS_CERT' : 'TABLE_TLS_KEY',
    };
  }
  if (behindProxy !== undefined && behindProxy !== '1') {
    return {
      code: 'badValue',
      message: 'TABLE_BEHIND_TLS_PROXY must be 1 when set.',
      setting: 'TABLE_BEHIND_TLS_PROXY',
    };
  }
  if ((behindProxy === '1') !== (proxy !== undefined)) {
    return {
      code: 'badValue',
      message:
        'TABLE_BEHIND_TLS_PROXY=1 and TABLE_TRUSTED_PROXY (the proxy address that may name the ' +
        'client in X-Forwarded-For) go together.',
      setting: proxy === undefined ? 'TABLE_TRUSTED_PROXY' : 'TABLE_BEHIND_TLS_PROXY',
    };
  }
  if (cert !== undefined && behindProxy === '1') {
    return {
      code: 'badValue',
      message: 'Use the server certificate or a TLS proxy, not both.',
      setting: 'TABLE_BEHIND_TLS_PROXY',
    };
  }
  const tls =
    cert === undefined || key === undefined
      ? null
      : { certPath: resolve(cwd, cert), keyPath: resolve(cwd, key) };
  if (tls === null && behindProxy === undefined && !insecureLan) {
    return {
      code: 'tlsRequired',
      message:
        'Outside development mode the server needs TLS: set TABLE_TLS_CERT and TABLE_TLS_KEY, ' +
        'or TABLE_BEHIND_TLS_PROXY=1 with TABLE_TRUSTED_PROXY. For a LAN game without TLS, pass ' +
        '--insecure-lan.',
    };
  }
  return { publicOrigin, allowedOrigins, allowedHosts, tls, trustedProxy: proxy ?? null };
}

/** A plain origin with one of `schemes`, normalized, or the error naming `name`. */
function parseOrigin(
  value: string,
  name: string,
  schemes: readonly string[],
): string | TableConfigError {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      code: 'badValue',
      message: `${name} must be an origin such as https://tables.example.com.`,
      setting: name,
    };
  }
  if (
    !schemes.includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return {
      code: 'badValue',
      message: `${name} must be a plain ${schemes.join(' or ').replaceAll(':', '')} origin with no path.`,
      setting: name,
    };
  }
  return url.origin;
}

/** An optional whole-number setting within bounds: the value, `null` when unset, or `'bad'`. */
function wholeSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  min: number,
  max: number,
): number | null | 'bad' {
  const raw = setting(env, name);
  if (raw === undefined) return null;
  if (!/^\d{1,6}$/.test(raw)) return 'bad';
  const value = Number(raw);
  return value < min || value > max ? 'bad' : value;
}

/** The invite-link origin: the configured one, else the loopback URL of the port in use. */
export function publicOriginFor(config: TableConfig, boundPort: number): string {
  return config.publicOrigin ?? `http://127.0.0.1:${boundPort}`;
}
