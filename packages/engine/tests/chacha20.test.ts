import { describe, expect, it } from 'vitest';
import { castingCheckpoint } from '../src/casting/checkpoint';
import { Engine } from '../src/engine';
import { EngineUsageError } from '../src/errors';
import { ChaCha20Rng, bytesOfHex, chacha20Block, streamNonce, wordsOf } from '../src/rng/chacha20';
import { Prng } from '../src/rng/prng';
import { createGame } from '../src/state/game';
import { RuleBasedProvider, forestsPod, gameConfig } from './fixtures';

/** RFC 8439 §2.3.2 and §2.4.2 key: bytes 00 01 02 … 1f. */
const RFC_KEY = Array.from({ length: 32 }, (_, i) => i);
const hexBytes = (hex: string) => bytesOfHex(hex, hex.length / 2);
const KEY_HEX = 'a3'.repeat(16) + '5c'.repeat(16);

function keystreamBytes(rng: ChaCha20Rng, length: number): number[] {
  const bytes: number[] = [];
  while (bytes.length < length) {
    const word = rng.nextUint32();
    bytes.push(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, word >>> 24);
  }
  return bytes.slice(0, length);
}

describe('ChaCha20 (RFC 8439)', () => {
  it('matches the §2.3.2 block function vector', () => {
    const block = chacha20Block(wordsOf(RFC_KEY), 1, wordsOf(hexBytes('000000090000004a00000000')));
    const expected = wordsOf(
      hexBytes(
        '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
          'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
      ),
    );
    expect(block).toEqual(expected);
  });

  it('matches the §2.4.2 encryption vector as a keystream', () => {
    const plaintext = [
      ...new TextEncoder().encode(
        "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
      ),
    ];
    const rng = new ChaCha20Rng(RFC_KEY, wordsOf(hexBytes('000000000000004a00000000')), 1);
    const ciphertext = keystreamBytes(rng, plaintext.length).map((byte, i) => byte ^ plaintext[i]!);
    expect(ciphertext).toEqual(
      hexBytes(
        '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
          'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
          '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
          '5af90bbf74a35be6b40b8eedf2785e42874d',
      ),
    );
  });
});

describe('ChaCha20Rng as an engine random source (ADR 0031 decision 4)', () => {
  const key = bytesOfHex(KEY_HEX, 32);

  it('is deterministic for a key and stream, and streams differ', () => {
    const draws = (stream: number) => {
      const rng = new ChaCha20Rng(key, streamNonce(stream));
      return Array.from({ length: 40 }, () => rng.nextUint32());
    };
    expect(draws(0)).toEqual(draws(0));
    expect(draws(0)).not.toEqual(draws(1));
  });

  it('clones an independent stream at the current position', () => {
    const rng = new ChaCha20Rng(key, streamNonce(0));
    for (let i = 0; i < 21; i++) rng.nextUint32();
    const copy = rng.clone();
    const fromCopy = Array.from({ length: 20 }, () => copy.nextUint32());
    const fromRng = Array.from({ length: 20 }, () => rng.nextUint32());
    expect(fromCopy).toEqual(fromRng);
    copy.nextUint32();
    expect(copy.nextUint32()).not.toBe(rng.nextUint32());
  });

  it('rejects a bound outside [1, 2^32] as Prng does', () => {
    const rng = new ChaCha20Rng(key, streamNonce(0));
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(1.5)).toThrow(RangeError);
    expect(rng.nextInt(1)).toBe(0);
  });

  it('is rewound exactly by the casting checkpoint', () => {
    const ctx = createGame(gameConfig(forestsPod(8), { rng: 'chacha20', rngKey: KEY_HEX }));
    expect(ctx.rng).toBeInstanceOf(ChaCha20Rng);
    for (let i = 0; i < 5; i++) ctx.rng.nextUint32();
    const restore = castingCheckpoint(ctx);
    const first = Array.from({ length: 30 }, () => ctx.rng.nextUint32());
    restore();
    const again = Array.from({ length: 30 }, () => ctx.rng.nextUint32());
    expect(again).toEqual(first);
  });

  it('refuses a missing, malformed or misplaced key', () => {
    expect(() => createGame(gameConfig(forestsPod(8), { rng: 'chacha20' }))).toThrow(
      EngineUsageError,
    );
    expect(() =>
      createGame(gameConfig(forestsPod(8), { rng: 'chacha20', rngKey: KEY_HEX.slice(2) })),
    ).toThrow(EngineUsageError);
    expect(() => createGame(gameConfig(forestsPod(8), { rngKey: KEY_HEX }))).toThrow(
      EngineUsageError,
    );
  });

  it('keeps the key out of a played game’s events and state', () => {
    const engine = new Engine(
      gameConfig(forestsPod(10), { seed: 'public-label', rng: 'chacha20', rngKey: KEY_HEX }),
    );
    const provider = new RuleBasedProvider([], { fallback: 'first' });
    for (let i = 0; i < 2000; i++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'decision') engine.submit(provider.decide(step.request));
    }
    const serialized = JSON.stringify([
      engine.eventsSince(0),
      engine.getState(),
      engine.spectatorState(),
    ]).toLowerCase();
    expect(serialized).not.toContain(KEY_HEX.toLowerCase());
    expect(serialized).not.toContain('a3a3a3a3');
    // The key, not the public label, drove the game: the same label on the legacy RNG differs.
    const legacy = new Engine(gameConfig(forestsPod(10), { seed: 'public-label' }));
    const legacyProvider = new RuleBasedProvider([], { fallback: 'first' });
    for (let i = 0; i < 2000; i++) {
      const step = legacy.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'decision') legacy.submit(legacyProvider.decide(step.request));
    }
    const shape = (events: ReturnType<Engine['eventsSince']>) =>
      JSON.stringify(events.map((event) => [event.type, event.payload]));
    expect(shape(engine.eventsSince(0))).not.toBe(shape(legacy.eventsSince(0)));
  });
});

describe('legacy Prng', () => {
  it('produces the same stream as before the EngineRng interface', () => {
    // Pinned from `ec1b000`, before Prng implemented EngineRng.
    const rng = new Prng('legacy-pin');
    expect(Array.from({ length: 6 }, () => rng.nextUint32())).toEqual([
      446592076, 2485262871, 389799612, 373633261, 539741512, 3516627091,
    ]);
    expect(Array.from({ length: 6 }, () => rng.nextInt(7))).toEqual([4, 5, 0, 0, 4, 0]);
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    rng.shuffle(items);
    expect(items).toEqual([2, 9, 7, 8, 3, 5, 1, 4, 6, 10]);
  });
});
