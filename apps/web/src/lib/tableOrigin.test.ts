import { describe, expect, it } from 'vitest';
import { tableHttpUrl, tableOriginFrom, tableSocketUrl } from './tableOrigin';

describe('table origin', () => {
  it("uses the page's own origin unless one is configured", () => {
    expect(tableOriginFrom(undefined, 'https://decktester.poilygon.dev')).toBe(
      'https://decktester.poilygon.dev',
    );
    expect(tableOriginFrom('  ', 'http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(tableOriginFrom('https://tables.poilygon.dev/', 'https://decktester.poilygon.dev')).toBe(
      'https://tables.poilygon.dev',
    );
  });

  it('builds HTTP and socket addresses on that origin', () => {
    expect(tableHttpUrl('/tables', 'https://tables.poilygon.dev')).toBe(
      'https://tables.poilygon.dev/tables',
    );
    expect(tableSocketUrl('/tables/abc/ws', 'https://tables.poilygon.dev')).toBe(
      'wss://tables.poilygon.dev/tables/abc/ws',
    );
    expect(tableSocketUrl('/tables/abc/ws', 'http://127.0.0.1:3002')).toBe(
      'ws://127.0.0.1:3002/tables/abc/ws',
    );
  });
});
