import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from './hash';

describe('canonicalJson key ordering', () => {
  it('sorts keys by UTF-16 code unit rather than locale collation', () => {
    // localeCompare reports 'a' < 'B' and 'i' < 'I'; a code-unit comparator reports the opposite.
    // Locale collation is ICU-data dependent, so it cannot seal a hash that must reproduce on CI.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    expect(canonicalJson({ i: 1, I: 2 })).toBe('{"I":2,"i":1}');
  });

  it('applies the same order at every depth and inside arrays', () => {
    expect(canonicalJson({ z: 1, A: 2, a: 3, Z: 4 })).toBe('{"A":2,"Z":4,"a":3,"z":1}');
    expect(canonicalJson({ outer: { b: 1, B: 2 } })).toBe('{"outer":{"B":2,"b":1}}');
    expect(canonicalJson([{ i: 1, I: 2 }])).toBe('[{"I":2,"i":1}]');
  });

  it('keeps array order because legal menus and transcripts are semantic', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('produces a distinct digest for the two orderings', () => {
    expect(sha256({ a: 1, B: 2 })).toBe(sha256({ B: 2, a: 1 }));
    expect(sha256({ a: 1, B: 2 })).not.toBe(sha256({ a: 1, b: 2 }));
  });
});
