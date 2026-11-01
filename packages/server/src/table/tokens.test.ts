import { describe, it, expect, vi } from 'vitest';
import {
  AttemptThrottle,
  CONFUSABLES,
  base64url,
  cleanDisplayName,
  constantTimeEqual,
  generateClaimId,
  generateHostSecret,
  generateHostToken,
  generateInviteCode,
  generateSeatToken,
  generateTableId,
  generateVerificationCode,
  normalizeDisplayName,
} from './tokens';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe('base64url', () => {
  it('matches the standard encoding without padding', () => {
    for (const bytes of [[], [0], [255], [1, 2], [250, 251, 252], [0, 1, 2, 3, 4]]) {
      const data = new Uint8Array(bytes);
      const expected = Buffer.from(data)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(base64url(data)).toBe(expected);
    }
  });
});

describe('generated secrets', () => {
  it('carry 256 bits for host secret, host token and seat token', () => {
    for (const make of [generateHostSecret, generateHostToken, generateSeatToken]) {
      const value = make();
      expect(value).toMatch(BASE64URL_RE);
      expect(value).toHaveLength(43); // 32 bytes, unpadded
    }
  });

  it('carry 128 bits for the invite code and table id', () => {
    for (const make of [generateInviteCode, generateTableId]) {
      const value = make();
      expect(value).toMatch(BASE64URL_RE);
      expect(value).toHaveLength(22); // 16 bytes, unpadded
    }
  });

  it('draw from crypto.getRandomValues and never repeat', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    try {
      generateSeatToken();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateSeatToken());
    for (let i = 0; i < 200; i++) seen.add(generateInviteCode());
    for (let i = 0; i < 200; i++) seen.add(generateClaimId());
    expect(seen.size).toBe(600);
  });

  it('makes a short verification code from an unambiguous alphabet', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(/^[A-HJKMNP-TW-Z2-9]{3}-[A-HJKMNP-TW-Z2-9]{3}$/);
    }
  });
});

describe('constantTimeEqual', () => {
  it('accepts equal strings and refuses different ones of the same length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('refuses unequal lengths without throwing', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('a', '')).toBe(false);
  });

  it('does not treat a zero-padded shorter string as equal', () => {
    expect(constantTimeEqual('abc', 'abc\u0000')).toBe(false);
    expect(constantTimeEqual('abc\u0000\u0000', 'abc')).toBe(false);
  });

  it('compares multi-byte characters by their bytes', () => {
    expect(constantTimeEqual('é', 'é')).toBe(true);
    expect(constantTimeEqual('é', 'e')).toBe(false);
  });
});

describe('AttemptThrottle', () => {
  const make = (start = 0) => {
    const clock = { t: start };
    const throttle = new AttemptThrottle({
      now: () => clock.t,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      forgetAfterMs: 60_000,
    });
    return { clock, throttle };
  };

  it('is free until the first failure', () => {
    const { throttle } = make();
    expect(throttle.check('1.2.3.4')).toBe(0);
  });

  it('delays after a failure, doubling up to the cap', () => {
    const { clock, throttle } = make();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      throttle.fail('a');
      delays.push(throttle.check('a'));
      clock.t += throttle.check('a'); // wait it out
    }
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000]);
  });

  it('delays rather than locks out: waiting the delay lets the next attempt through', () => {
    const { clock, throttle } = make();
    for (let i = 0; i < 50; i++) {
      throttle.fail('a');
      clock.t += throttle.check('a');
    }
    expect(throttle.check('a')).toBe(0);
    throttle.succeed('a');
    expect(throttle.check('a')).toBe(0);
  });

  it('counts down as time passes', () => {
    const { clock, throttle } = make();
    throttle.fail('a');
    clock.t += 40;
    expect(throttle.check('a')).toBe(60);
    clock.t += 60;
    expect(throttle.check('a')).toBe(0);
  });

  it('keeps addresses apart', () => {
    const { throttle } = make();
    throttle.fail('a');
    expect(throttle.check('a')).toBeGreaterThan(0);
    expect(throttle.check('b')).toBe(0);
  });

  it('forgets a quiet address, and a success clears it', () => {
    const { clock, throttle } = make();
    for (let i = 0; i < 5; i++) throttle.fail('a');
    clock.t += 61_000;
    expect(throttle.check('a')).toBe(0);
    throttle.fail('a');
    expect(throttle.check('a')).toBe(100); // starts over at the base delay
    throttle.succeed('a');
    expect(throttle.check('a')).toBe(0);
  });

  it('bounds the number of tracked addresses', () => {
    const throttle = new AttemptThrottle({ now: () => 0, maxTracked: 3 });
    for (const address of ['a', 'b', 'c', 'd']) throttle.fail(address);
    expect(throttle.check('a')).toBe(0); // oldest evicted
    expect(throttle.check('d')).toBeGreaterThan(0);
  });
});

describe('display-name normalization', () => {
  it('folds case and compatibility forms', () => {
    expect(normalizeDisplayName('ALICE')).toBe(normalizeDisplayName('alice'));
    expect(normalizeDisplayName('ＡＬＩＣＥ')).toBe(normalizeDisplayName('alice')); // fullwidth
    expect(normalizeDisplayName('Straße')).toBe(normalizeDisplayName('strasse'));
  });

  it('maps Cyrillic and Greek lookalikes to Latin', () => {
    // Cyrillic а е о р с х, and Greek ο, in place of Latin letters.
    expect(normalizeDisplayName('аеорсх')).toBe('aeopcx');
    expect(normalizeDisplayName('Bоb')).toBe(normalizeDisplayName('Bob')); // Cyrillic о
    expect(normalizeDisplayName('Βοb')).toBe(normalizeDisplayName('Bob')); // Greek Β and ο
    expect(normalizeDisplayName('Ρаul')).toBe(normalizeDisplayName('Paul'));
    expect(normalizeDisplayName('Cаrol')).toBe(normalizeDisplayName('Carol'));
    expect(normalizeDisplayName('хх')).toBe('xx');
    expect(normalizeDisplayName('ΟΟ')).toBe('oo'); // Greek capital omicron
  });

  it('treats capital I, lowercase l, 1 and | as one shape', () => {
    const forms = ['Ilya', 'llya', 'l1ya', '|lya'].map(normalizeDisplayName);
    expect(new Set(forms).size).toBe(1);
  });

  it('removes zero-width and bidi characters', () => {
    expect(normalizeDisplayName('Al​ice')).toBe(normalizeDisplayName('Alice'));
    expect(normalizeDisplayName('A﻿lice')).toBe(normalizeDisplayName('Alice'));
    expect(normalizeDisplayName('‮Alice‬')).toBe(normalizeDisplayName('Alice'));
    expect(normalizeDisplayName('Al⁠ice')).toBe(normalizeDisplayName('Alice'));
  });

  it('removes tag characters and other default-ignorable code points', () => {
    expect(normalizeDisplayName('Bob\u{E0041}')).toBe(normalizeDisplayName('Bob'));
    expect(normalizeDisplayName('Bo\u{E0001}b')).toBe(normalizeDisplayName('Bob'));
    expect(normalizeDisplayName('Bo\u{1D173}b\u{1D17A}')).toBe(normalizeDisplayName('Bob'));
    expect(normalizeDisplayName('Bo\u0600b')).toBe(normalizeDisplayName('Bob')); // a Cf character
  });

  it('ignores accents and separators', () => {
    expect(normalizeDisplayName('Álice')).toBe(normalizeDisplayName('Alice'));
    expect(normalizeDisplayName('Mary  Jane')).toBe(normalizeDisplayName('Mary_Jane'));
  });

  it('keeps unrelated names distinct', () => {
    expect(normalizeDisplayName('Alice')).not.toBe(normalizeDisplayName('Alicia'));
    expect(normalizeDisplayName('Bob')).not.toBe(normalizeDisplayName('Rob'));
  });

  it('covers every mapped confusable with a Latin, digit-free target', () => {
    for (const [from, to] of Object.entries(CONFUSABLES)) {
      expect(from).toHaveLength(1);
      expect(to).toMatch(/^[a-z]$/);
    }
    for (const char of ['а', 'е', 'о', 'р', 'с', 'х', 'ο']) {
      expect(CONFUSABLES[char]).toBeDefined();
    }
  });
});

describe('cleanDisplayName', () => {
  it('trims, collapses spaces and strips invisible characters', () => {
    expect(cleanDisplayName('  Al​ice   B  ')).toBe('Alice B');
    expect(cleanDisplayName('‮Alice')).toBe('Alice');
  });

  it('strips tag characters and other default-ignorable code points', () => {
    expect(cleanDisplayName('Bob\u{E0041}')).toBe('Bob');
    expect(cleanDisplayName('Bo\u{1D173}b')).toBe('Bob');
    expect(cleanDisplayName('\u{E0041}\u{E0042}')).toBeNull();
  });

  it('refuses empty, invisible-only and over-long names', () => {
    expect(cleanDisplayName('')).toBeNull();
    expect(cleanDisplayName('   ')).toBeNull();
    expect(cleanDisplayName('​​')).toBeNull();
    expect(cleanDisplayName('x'.repeat(24))).toBe('x'.repeat(24));
    expect(cleanDisplayName('x'.repeat(25))).toBeNull();
  });

  it('refuses a name the comparison fold would erase', () => {
    expect(cleanDisplayName('. _ -')).toBeNull();
  });
});
