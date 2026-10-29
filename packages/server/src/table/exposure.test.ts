/**
 * Who may reach a production table server (plan M5 tasks 1 and 2): host and origin allowlists,
 * the client a trusted TLS proxy names, the LAN rules of `--insecure-lan`, and per-address
 * socket caps.
 */

import { describe, expect, it } from 'vitest';
import { loadTableConfig, type TableConfig } from './config';
import {
  checkExposure,
  forwardedClient,
  isPrivateAddress,
  SocketLimiter,
  type ExposureCheck,
} from './exposure';

function config(env: Record<string, string>, argv: string[] = []): TableConfig {
  const result = loadTableConfig(env, argv, '/work');
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const TLS = config({
  TABLE_PUBLIC_ORIGIN: 'https://tables.example.com',
  TABLE_ALLOWED_ORIGINS: 'https://tables.example.com',
  TABLE_ALLOWED_HOSTS: 'tables.example.com',
  TABLE_TLS_CERT: 'c.pem',
  TABLE_TLS_KEY: 'k.pem',
});

const PROXIED = config({
  TABLE_PUBLIC_ORIGIN: 'https://tables.example.com',
  TABLE_ALLOWED_ORIGINS: 'https://tables.example.com',
  TABLE_ALLOWED_HOSTS: 'tables.example.com',
  TABLE_BEHIND_TLS_PROXY: '1',
  TABLE_TRUSTED_PROXY: '127.0.0.1',
});

const LAN = config(
  {
    TABLE_PUBLIC_ORIGIN: 'http://192.168.1.20:3002',
    TABLE_ALLOWED_ORIGINS: 'http://192.168.1.20:3002',
    TABLE_ALLOWED_HOSTS: '192.168.1.20:3002,localhost:3002',
    TABLE_HOST: '0.0.0.0',
  },
  ['--insecure-lan'],
);

function req(headers: Record<string, string>): Request {
  return new Request('http://placeholder/', { headers });
}

const check = (c: TableConfig, headers: Record<string, string>, peer: string): ExposureCheck =>
  checkExposure(c, req(headers), peer, 3002);

describe('checkExposure', () => {
  it('accepts an allowed host and origin, and refuses others', () => {
    expect(check(TLS, { host: 'Tables.Example.com' }, '203.0.113.9')).toEqual({
      ok: true,
      address: '203.0.113.9',
    });
    expect(
      check(TLS, { host: 'tables.example.com', origin: 'https://tables.example.com' }, '1.2.3.4')
        .ok,
    ).toBe(true);
    expect(check(TLS, { host: 'evil.example.com' }, '1.2.3.4')).toMatchObject({ status: 403 });
    expect(check(TLS, {}, '1.2.3.4')).toMatchObject({ ok: false });
    expect(
      check(TLS, { host: 'tables.example.com', origin: 'https://evil.example.com' }, '1.2.3.4'),
    ).toMatchObject({ ok: false, reason: 'Forbidden origin' });
  });

  it('behind a TLS proxy, takes the client from the rightmost forwarded-for entry', () => {
    expect(
      check(
        PROXIED,
        { host: 'tables.example.com', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' },
        '127.0.0.1',
      ),
    ).toEqual({ ok: true, address: '198.51.100.7' });
    // A client cannot name itself: only the entry the proxy appended counts.
    expect(forwardedClient(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('10.0.0.1');
    expect(forwardedClient(req({ 'x-forwarded-for': 'not-an-ip' }))).toBeNull();
    // Only the proxy may connect, and it must name the client.
    expect(
      check(PROXIED, { host: 'tables.example.com', 'x-forwarded-for': '1.1.1.1' }, '10.9.9.9'),
    ).toMatchObject({ ok: false, status: 403 });
    expect(check(PROXIED, { host: 'tables.example.com' }, '127.0.0.1')).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('on --insecure-lan, accepts private peers and refuses public ones', () => {
    expect(check(LAN, { host: '192.168.1.20:3002' }, '192.168.1.33').ok).toBe(true);
    expect(check(LAN, { host: '192.168.1.20:3002' }, '::ffff:10.1.2.3').ok).toBe(true);
    expect(check(LAN, { host: '192.168.1.20:3002' }, '203.0.113.9')).toMatchObject({
      ok: false,
      reason: 'This LAN table accepts private addresses only',
    });
  });

  it('on --insecure-lan, refuses a loopback peer naming a non-loopback host (a tunnel)', () => {
    expect(check(LAN, { host: 'localhost:3002' }, '127.0.0.1').ok).toBe(true);
    expect(check(LAN, { host: '192.168.1.20:3002' }, '127.0.0.1')).toMatchObject({
      ok: false,
      reason: 'A loopback peer must name a loopback host',
    });
  });

  it('keeps development mode loopback only', () => {
    const dev = config({}, ['--dev']);
    expect(check(dev, { host: '127.0.0.1:3002' }, '127.0.0.1').ok).toBe(true);
    expect(check(dev, { host: 'tables.example.com' }, '127.0.0.1').ok).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.0.9', true],
    ['100.64.0.1', false],
    ['8.8.8.8', false],
    ['fd12::1', true],
    ['fe80::1', true],
    ['2001:db8::1', false],
    ['127.0.0.1', false],
  ])('%s is private: %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('SocketLimiter', () => {
  it('caps concurrent sockets and opens per minute per address', () => {
    let now = 0;
    const limiter = new SocketLimiter({ maxConcurrent: 2, maxOpensPerMinute: 3, now: () => now });
    expect(limiter.admit('a')).toBe(true);
    expect(limiter.admit('a')).toBe(true);
    expect(limiter.admit('a')).toBe(false);
    // Another address is unaffected: a throttle delays one client, it does not lock others out.
    expect(limiter.admit('b')).toBe(true);
    limiter.release('a');
    expect(limiter.admit('a')).toBe(true);
    limiter.release('a');
    expect(limiter.admit('a')).toBe(false); // the fourth open within a minute
    now += 60_000;
    expect(limiter.admit('a')).toBe(true);
  });

  it('forgets idle addresses once too many are remembered, never one with a socket open', () => {
    let now = 0;
    const limiter = new SocketLimiter({ maxTracked: 3, now: () => now });
    expect(limiter.admit('held')).toBe(true);
    for (let i = 0; i < 10; i++) {
      now += 1;
      expect(limiter.admit(`a${i}`)).toBe(true);
      limiter.release(`a${i}`);
    }
    expect(limiter.tracked).toBeLessThanOrEqual(3);
    // The address still holding a socket is still counted against its cap.
    const capped = new SocketLimiter({ maxTracked: 1, maxConcurrent: 1, now: () => now });
    expect(capped.admit('held')).toBe(true);
    expect(capped.admit('other')).toBe(true);
    expect(capped.admit('held')).toBe(false);
  });
});
