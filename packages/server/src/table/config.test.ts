import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_PORT,
  PROXY_OR_ALLOWLIST_SETTINGS,
  loadTableConfig,
  publicOriginFor,
  type TableConfig,
} from './config';

const CWD = '/work/repo';
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
  it('refuses to start without --dev (the M5 gate)', () => {
    const error = refusal({}, []);
    expect(error.code).toBe('devRequired');
    expect(error.message).toContain('--dev');
    expect(refusal({ TABLE_PORT: '4000' }, ['--oracle-fixture', 'f.json']).code).toBe(
      'devRequired',
    );
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
    expect(refusal({}, ['--dev', '--insecure-lan']).code).toBe('badArgument');
    expect(refusal({}, ['--dev', 'extra']).code).toBe('badArgument');
  });

  it('caps the number of tables with a positive whole number', () => {
    expect(okConfig({ TABLE_MAX_TABLES: '3' }).maxTables).toBe(3);
    expect(refusal({ TABLE_MAX_TABLES: '0' }, ['--dev']).code).toBe('badValue');
    expect(refusal({ TABLE_MAX_TABLES: 'many' }, ['--dev']).code).toBe('badValue');
  });
});
