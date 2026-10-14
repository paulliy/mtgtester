import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { isPathWithinRoot } from '../../../../scripts/contracts/source-containment';

describe('canonical primitive source containment', () => {
  it('accepts a Windows source inside the canonical root', () => {
    expect(isPathWithinRoot('C:\\repo', 'C:\\repo\\scripts\\contract.ts', win32)).toBe(true);
  });
  it('accepts a POSIX source inside the canonical root', () => {
    expect(isPathWithinRoot('/repo', '/repo/scripts/contract.ts', posix)).toBe(true);
  });
  it('rejects the root itself and its parent on both platforms', () => {
    for (const source of ['C:\\repo', 'C:\\'])
      expect(isPathWithinRoot('C:\\repo', source, win32)).toBe(false);
    for (const source of ['/repo', '/'])
      expect(isPathWithinRoot('/repo', source, posix)).toBe(false);
  });
  it('rejects a sibling sharing the root name prefix on both platforms', () => {
    expect(isPathWithinRoot('C:\\repo', 'C:\\repository\\contract.ts', win32)).toBe(false);
    expect(isPathWithinRoot('/repo', '/repository/contract.ts', posix)).toBe(false);
  });
  it('rejects another Windows drive or UNC share', () => {
    expect(isPathWithinRoot('C:\\repo', 'D:\\repo\\contract.ts', win32)).toBe(false);
    expect(isPathWithinRoot('C:\\repo', '\\\\server\\share\\repo\\contract.ts', win32)).toBe(false);
  });
  it('rejects normalized parent traversal on both platforms', () => {
    expect(isPathWithinRoot('C:\\repo', 'C:\\repo\\..\\escape.ts', win32)).toBe(false);
    expect(isPathWithinRoot('/repo', '/repo/../escape.ts', posix)).toBe(false);
  });
});
