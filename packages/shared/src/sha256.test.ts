import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSha256, sha256Hex } from './sha256';

const node = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('equals node:crypto on every padding length and on non-ASCII text', () => {
    const samples: string[] = [];
    for (let n = 0; n <= 200; n++) samples.push('x'.repeat(n));
    samples.push(
      'Jötun Grunt',
      'Æther Vial — “quoted”',
      'emoji 🐉 and 日本語',
      'lone \ud800 surrogate',
      JSON.stringify({ oracleId: 'a1', name: 'Lim-Dûl’s Vault', keywords: ['Flying'] }),
    );
    for (const text of samples) expect(sha256Hex(text), text).toBe(node(text));
  });
});

describe('createSha256', () => {
  const nodeOf = (pieces: readonly string[]): string => {
    const hash = createHash('sha256');
    for (const piece of pieces) hash.update(piece);
    return hash.digest('hex');
  };
  const ours = (pieces: readonly string[]): string => {
    const hash = createSha256();
    for (const piece of pieces) hash.update(piece);
    return hash.digestHex();
  };

  it('equals node:crypto fed the same pieces, across every block boundary', () => {
    expect(ours([])).toBe(nodeOf([]));
    for (let size = 1; size <= 130; size++) {
      const text = 'é'.repeat(size) + 'x'.repeat(size % 7);
      const pieces: string[] = [];
      for (let at = 0; at < text.length; at += size % 13 || 1) {
        pieces.push(text.slice(at, at + (size % 13 || 1)));
      }
      expect(ours(pieces), String(size)).toBe(nodeOf(pieces));
      expect(ours([text]), String(size)).toBe(sha256Hex(text));
    }
  });

  it('encodes each piece alone, as node:crypto does with a split surrogate pair', () => {
    const pieces = ['dragon \ud83d', '\udc09 tail', '🐉', JSON.stringify({ n: 'Lim-Dûl' })];
    expect(ours(pieces)).toBe(nodeOf(pieces));
  });

  it('hashes a long transcript the same as node:crypto', () => {
    const pieces = Array.from({ length: 2_000 }, (_, i) =>
      JSON.stringify({ i, options: ['pass', `cast ${i}`, 'attack'.repeat(i % 9)] }),
    );
    expect(ours(pieces)).toBe(nodeOf(pieces));
  });

  it('refuses input after its digest', () => {
    const hash = createSha256().update('a');
    hash.digestHex();
    expect(() => hash.update('b')).toThrow();
  });
});
