import { describe, expect, it } from 'vitest';
import { crc32, readZipArchive, zipArchive } from './zip';

describe('zipArchive', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips files, including non-ASCII names and text', () => {
    const entries = [
      { path: 'bundle/README.md', data: Buffer.from('# Judge bundle\n'.repeat(200)) },
      { path: 'bundle/cases/01-é.md', data: Buffer.from('Dreadmaw → P3') },
      { path: 'bundle/empty.txt', data: Buffer.alloc(0) },
    ];
    const files = readZipArchive(zipArchive(entries));
    expect([...files.keys()]).toEqual(entries.map((entry) => entry.path));
    for (const entry of entries) expect(files.get(entry.path)?.equals(entry.data)).toBe(true);
  });

  it('is byte-for-byte reproducible', () => {
    const entries = [{ path: 'a.txt', data: Buffer.from('same') }];
    expect(zipArchive(entries).equals(zipArchive(entries))).toBe(true);
  });

  it('refuses a path that would escape the archive root', () => {
    expect(() => zipArchive([{ path: '../evil', data: Buffer.alloc(0) }])).toThrow(/unsafe/);
  });
});
