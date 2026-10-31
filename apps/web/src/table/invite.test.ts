import { describe, expect, it } from 'vitest';
import { inviteCodeFor } from './invite';

describe('inviteCodeFor', () => {
  it('reads the fragment, decoding it', () => {
    expect(inviteCodeFor('#abc', undefined)).toBe('abc');
    expect(inviteCodeFor('#a%20b', undefined)).toBe('a b');
    expect(inviteCodeFor(undefined, undefined)).toBe('');
  });

  it('survives a fragment that is not valid percent-encoding', () => {
    expect(inviteCodeFor('#%', undefined)).toBe('%');
    expect(inviteCodeFor('#%E0%A4%A', undefined)).toBe('%E0%A4%A');
  });

  it("prefers the table state's current invite over a stale fragment", () => {
    expect(inviteCodeFor('#old', 'rotated')).toBe('rotated');
    expect(inviteCodeFor('#old', '')).toBe('old');
  });
});
