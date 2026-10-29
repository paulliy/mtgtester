/**
 * `TABLE_*` settings and the command line of `serve:table` (ADR 0031 decision 9, plan M3 tasks 7
 * to 9). Pure: `loadTableConfig(env, argv)` reads nothing from the process and returns either the
 * settings or a typed error, so the refusals are testable without starting a server.
 *
 * Until M5 lands the server runs in development mode only, so `loadTableConfig` refuses any
 * start without `--dev`. In development mode the clock may be off and a fixed test RNG key is
 * accepted, and the server refuses to start with any proxy, TLS or allowlist setting, because a
 * proxy or tunnel makes a loopback bind reachable from the internet (decision 9).
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
  /** Always true in M3: production mode ships with M5. */
  dev: true;
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
}

export type TableConfigErrorCode =
  /** No `--dev`: production mode is not available yet (M5 gate). */
  | 'devRequired'
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
  port: number | null;
  oracleFixture: string | null;
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65_535 ? port : null;
}

function parseArgs(argv: readonly string[]): ParsedArgs | TableConfigError {
  const args: ParsedArgs = { dev: false, port: null, oracleFixture: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev') {
      args.dev = true;
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
        message: `Unknown argument "${String(arg)}". Supported: --dev, --oracle-fixture <file>, --port <n>.`,
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

  if (!args.dev) {
    return fail(
      'devRequired',
      'serve:table runs only in development mode until production exposure lands (ADR 0031, ' +
        'plan M5). Re-run with --dev; it binds and serves loopback only.',
      '--dev',
    );
  }

  for (const name of PROXY_OR_ALLOWLIST_SETTINGS) {
    if (setting(env, name) !== undefined) {
      return fail(
        'devWithProxySetting',
        `${name} is set. Development mode is loopback only and refuses to start with any proxy, ` +
          'TLS or allowlist setting, because a proxy or tunnel can expose a loopback bind.',
        name,
      );
    }
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
  if (!isLoopbackHostname(host)) {
    return fail(
      'notLoopback',
      `TABLE_HOST "${host}" is not a loopback address. Development mode binds loopback only.`,
      'TABLE_HOST',
    );
  }

  let publicOrigin: string | null = null;
  const originSetting = setting(env, 'TABLE_PUBLIC_ORIGIN');
  if (originSetting !== undefined) {
    let url: URL;
    try {
      url = new URL(originSetting);
    } catch {
      return fail(
        'badValue',
        'TABLE_PUBLIC_ORIGIN must be an origin such as http://127.0.0.1:3002.',
        'TABLE_PUBLIC_ORIGIN',
      );
    }
    if (!isLoopbackHostname(url.hostname)) {
      return fail(
        'notLoopback',
        'TABLE_PUBLIC_ORIGIN is not loopback. Development mode refuses non-loopback origins.',
        'TABLE_PUBLIC_ORIGIN',
      );
    }
    if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return fail(
        'badValue',
        'TABLE_PUBLIC_ORIGIN must be a plain http origin with no path.',
        'TABLE_PUBLIC_ORIGIN',
      );
    }
    publicOrigin = url.origin;
  }

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

  // Development mode defaults the clock off; a preset may still be asked for.
  const clockSetting = setting(env, 'TABLE_CLOCK') ?? 'off';
  if (clockSetting !== 'off' && clockSetting !== 'relaxed' && clockSetting !== 'standard') {
    return fail('badValue', 'TABLE_CLOCK must be off, relaxed or standard.', 'TABLE_CLOCK');
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
      dev: true,
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
    },
  };
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
