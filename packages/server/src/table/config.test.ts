import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_PORT,
  DEV_ONLY_SETTINGS,
  PROXY_OR_ALLOWLIST_SETTINGS,
  loadTableConfig,
  publicOriginFor,
  type TableConfig,
} from './config';

const CWD = '/work/repo';
/** A complete production configuration with the server's own certificate. */
const PRODUCTION: Record<string, string> = {
  TABLE_PUBLIC_ORIGIN: 'https://tables.example.com',
  TABLE_ALLOWED_ORIGINS: 'https://tables.example.com, https://other.example.com',
  TABLE_ALLOWED_HOSTS: 'tables.example.com,Tables.Example.com:8443',
  TABLE_TLS_CERT: 'cert.pem',
  TABLE_TLS_KEY: 'key.pem',
};
const KEY = 'ab'.repeat(32);

function okConfig(env: Record<string, string> = {}, argv: string[] = ['--dev']): TableConfig {
  const result = loadTableConfig(env, argv, CWD);
  if (!result.ok) throw new Error(`refused: ${result.error.message}`);
  return result.config;
}

function refusal(env: Record<string, string>, argv: string[]) {
  const result = loadTableConfig(env, argv, CWD);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('loadTableConfig', () => {
  it('refuses production without the public origin and both allowlists, on any bind', () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const error = refusal({ TABLE_HOST: host }, []);
      expect(error.code).toBe('allowlistRequired');
      expect(error.setting).toBe('TABLE_PUBLIC_ORIGIN');
    }
    expect(refusal({ ...PRODUCTION, TABLE_ALLOWED_HOSTS: '' }, []).setting).toBe(
      'TABLE_ALLOWED_HOSTS',
    );
    expect(refusal({ ...PRODUCTION, TABLE_ALLOWED_ORIGINS: '' }, []).setting).toBe(
      'TABLE_ALLOWED_ORIGINS',
    );
  });

  it('refuses production without TLS unless --insecure-lan', () => {
    const { TABLE_TLS_CERT: _cert, TABLE_TLS_KEY: _key, ...noTls } = PRODUCTION;
    expect(refusal(noTls, []).code).toBe('tlsRequired');
    // An https public origin still needs TLS; --insecure-lan takes http origins.
    const lan = okConfig(
      {
        TABLE_PUBLIC_ORIGIN: 'http://192.168.1.20:3002',
        TABLE_ALLOWED_ORIGINS: 'http://192.168.1.20:3002',
        TABLE_ALLOWED_HOSTS: '192.168.1.20:3002',
        TABLE_HOST: '0.0.0.0',
      },
      ['--insecure-lan'],
    );
    expect(lan).toMatchObject({ dev: false, insecureLan: true, tls: null, trustedProxy: null });
    expect(
      refusal(
        {
          ...noTls,
          TABLE_PUBLIC_ORIGIN: 'http://t.example.com',
          TABLE_ALLOWED_ORIGINS: 'http://t.example.com',
        },
        [],
      ).setting,
    ).toBe('TABLE_PUBLIC_ORIGIN');
  });

  it('reads production with its own certificate or behind a TLS proxy', () => {
    const own = okConfig(PRODUCTION, []);
    expect(own).toMatchObject({
      dev: false,
      insecureLan: false,
      publicOrigin: 'https://tables.example.com',
      allowedOrigins: ['https://tables.example.com', 'https://other.example.com'],
      allowedHosts: ['tables.example.com', 'tables.example.com:8443'],
      tls: { certPath: '/work/repo/cert.pem', keyPath: '/work/repo/key.pem' },
      trustedProxy: null,
      clock: 'relaxed',
    });
    const { TABLE_TLS_CERT: _cert, TABLE_TLS_KEY: _key, ...noTls } = PRODUCTION;
    const proxied = okConfig(
      { ...noTls, TABLE_BEHIND_TLS_PROXY: '1', TABLE_TRUSTED_PROXY: '10.0.0.5' },
      [],
    );
    expect(proxied).toMatchObject({ tls: null, trustedProxy: '10.0.0.5' });
    expect(refusal({ ...noTls, TABLE_BEHIND_TLS_PROXY: '1' }, []).setting).toBe(
      'TABLE_TRUSTED_PROXY',
    );
    expect(refusal({ ...PRODUCTION, TABLE_TLS_KEY: '' }, []).setting).toBe('TABLE_TLS_KEY');
    expect(
      refusal({ ...PRODUCTION, TABLE_BEHIND_TLS_PROXY: '1', TABLE_TRUSTED_PROXY: '10.0.0.5' }, [])
        .code,
    ).toBe('badValue');
  });

  it('refuses a public origin outside the allowed origins, and malformed entries', () => {
    expect(
      refusal({ ...PRODUCTION, TABLE_ALLOWED_ORIGINS: 'https://other.example.com' }, []).setting,
    ).toBe('TABLE_ALLOWED_ORIGINS');
    expect(refusal({ ...PRODUCTION, TABLE_ALLOWED_HOSTS: 'bad host' }, []).setting).toBe(
      'TABLE_ALLOWED_HOSTS',
    );
    expect(
      refusal({ ...PRODUCTION, TABLE_PUBLIC_ORIGIN: 'https://t.example.com/x' }, []).code,
    ).toBe('badValue');
  });

  it('refuses development-only settings and an untimed table in production', () => {
    for (const name of DEV_ONLY_SETTINGS) {
      const value = name === 'TABLE_TEST_RNG_KEY' ? KEY : '5';
      expect(refusal({ ...PRODUCTION, [name]: value }, []).code, name).toBe('devOnlySetting');
    }
    expect(refusal({ ...PRODUCTION, TABLE_CLOCK: 'off' }, []).code).toBe('devOnlySetting');
    expect(okConfig({ ...PRODUCTION, TABLE_CLOCK: 'standard' }, []).clock).toBe('standard');
    expect(refusal({}, ['--dev', '--insecure-lan']).code).toBe('badArgument');
  });

  it('reads a turn cap and pace for scripted runs, and refuses bad values', () => {
    expect(okConfig({ TABLE_TURN_CAP: '6', TABLE_PACE_MS: '0' })).toMatchObject({
      turnCap: 6,
      paceMs: 0,
    });
    expect(refusal({ TABLE_TURN_CAP: '0' }, ['--dev']).setting).toBe('TABLE_TURN_CAP');
    expect(refusal({ TABLE_PACE_MS: 'fast' }, ['--dev']).setting).toBe('TABLE_PACE_MS');
  });

  it('reads the defaults in dev mode: loopback, clock off, no test key', () => {
    const config = okConfig();
    expect(config).toMatchObject({
      dev: true,
      port: DEFAULT_TABLE_PORT,
      host: '127.0.0.1',
      publicOrigin: null,
      testRngKey: null,
      clock: 'off',
      maxTables: 8,
      oracleFixture: null,
      turnCap: null,
      paceMs: null,
      clockScale: null,
    });
    expect(config.dbPath).toBe('/work/repo/data/tables/tables.sqlite');
    expect(config.webDir).toBe('/work/repo/apps/web/dist-table');
  });

  it.each(PROXY_OR_ALLOWLIST_SETTINGS)('refuses --dev with %s set', (name) => {
    const error = refusal({ [name]: 'something' }, ['--dev']);
    expect(error.code).toBe('devWithProxySetting');
    expect(error.setting).toBe(name);
  });

  it('treats an empty proxy setting as unset', () => {
    expect(okConfig({ TABLE_ALLOWED_ORIGINS: '  ' }).dev).toBe(true);
  });

  it('accepts the dev test key and normalizes it, and rejects a malformed one', () => {
    expect(okConfig({ TABLE_TEST_RNG_KEY: KEY.toUpperCase() }).testRngKey).toBe(KEY);
    expect(refusal({ TABLE_TEST_RNG_KEY: 'abc' }, ['--dev']).code).toBe('badValue');
    expect(refusal({ TABLE_TEST_RNG_KEY: `${KEY}0` }, ['--dev']).code).toBe('badValue');
  });

  it('allows the clock presets and refuses anything else', () => {
    expect(okConfig({ TABLE_CLOCK: 'relaxed' }).clock).toBe('relaxed');
    expect(refusal({ TABLE_CLOCK: 'fast' }, ['--dev']).setting).toBe('TABLE_CLOCK');
  });

  it('reads the port from the flag first, then the environment', () => {
    expect(okConfig({ TABLE_PORT: '4001' }).port).toBe(4001);
    expect(okConfig({ TABLE_PORT: '4001' }, ['--dev', '--port', '0']).port).toBe(0);
    expect(refusal({ TABLE_PORT: '70000' }, ['--dev']).code).toBe('badValue');
    expect(refusal({}, ['--dev', '--port', 'x']).code).toBe('badArgument');
  });

  it('refuses a non-loopback bind or public origin in dev mode', () => {
    expect(refusal({ TABLE_HOST: '0.0.0.0' }, ['--dev']).code).toBe('notLoopback');
    expect(refusal({ TABLE_HOST: 'example.com' }, ['--dev']).code).toBe('notLoopback');
    expect(okConfig({ TABLE_HOST: 'localhost' }).host).toBe('localhost');
    expect(refusal({ TABLE_PUBLIC_ORIGIN: 'https://tables.example.com' }, ['--dev']).code).toBe(
      'notLoopback',
    );
    expect(refusal({ TABLE_PUBLIC_ORIGIN: 'not a url' }, ['--dev']).code).toBe('badValue');
    expect(refusal({ TABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:3002/path' }, ['--dev']).code).toBe(
      'badValue',
    );
  });

  it('builds invite origins from TABLE_PUBLIC_ORIGIN, defaulting to the loopback URL', () => {
    expect(publicOriginFor(okConfig(), 4321)).toBe('http://127.0.0.1:4321');
    const configured = okConfig({ TABLE_PUBLIC_ORIGIN: 'http://localhost:8080/' });
    expect(publicOriginFor(configured, 4321)).toBe('http://localhost:8080');
  });

  it('keeps the database outside the served directory', () => {
    expect(
      refusal({ TABLE_WEB_DIR: 'public', TABLE_DB_PATH: 'public/db/tables.sqlite' }, ['--dev'])
        .code,
    ).toBe('dbInsideWebDir');
    expect(
      refusal({ TABLE_WEB_DIR: 'public', TABLE_DB_PATH: 'public/../public/t.sqlite' }, ['--dev'])
        .code,
    ).toBe('dbInsideWebDir');
    expect(okConfig({ TABLE_WEB_DIR: 'public', TABLE_DB_PATH: 'public-db/t.sqlite' }).dbPath).toBe(
      '/work/repo/public-db/t.sqlite',
    );
    // A sibling whose name merely starts with the web directory's is outside it.
    expect(okConfig({ TABLE_WEB_DIR: 'web', TABLE_DB_PATH: 'web-data/t.sqlite' }).dev).toBe(true);
  });

  it('reads --oracle-fixture and refuses unknown or incomplete arguments', () => {
    expect(okConfig({}, ['--dev', '--oracle-fixture', 'fixture.json']).oracleFixture).toBe(
      'fixture.json',
    );
    expect(refusal({}, ['--dev', '--oracle-fixture']).code).toBe('badArgument');
    expect(refusal({}, ['--dev', 'extra']).code).toBe('badArgument');
  });

  it('caps the number of tables with a positive whole number', () => {
    expect(okConfig({ TABLE_MAX_TABLES: '3' }).maxTables).toBe(3);
    expect(refusal({ TABLE_MAX_TABLES: '0' }, ['--dev']).code).toBe('badValue');
    expect(refusal({ TABLE_MAX_TABLES: 'many' }, ['--dev']).code).toBe('badValue');
  });
});
