import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

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
