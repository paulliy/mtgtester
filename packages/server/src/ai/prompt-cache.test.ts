import { describe, expect, it } from 'vitest';
import type { AiPrompt } from './context';
import {
  ANTHROPIC_MIN_CACHED_PREFIX_TOKENS,
  AnthropicCacheModel,
  MIN_CACHED_PREFIX_CHARS,
  PREFIX_CACHE_BLOCK_CHARS,
  preparePromptForCaching,
  PrefixCacheModel,
} from './prompt-cache';

const BLOCK = PREFIX_CACHE_BLOCK_CHARS;

describe('PrefixCacheModel', () => {
  it('finds nothing cacheable in the first prompt it sees', () => {
    const cache = new PrefixCacheModel();
    const seen = cache.observe([{ role: 'system', content: 'x'.repeat(BLOCK * 4) }]);
    expect(seen.cacheableChars).toBe(0);
    expect(seen.chars).toBeGreaterThan(BLOCK * 4);
  });

  it('counts whole repeated blocks only, up to the first difference', () => {
    const cache = new PrefixCacheModel();
    const stable = 's'.repeat(BLOCK * 3);
    cache.observe([
      { role: 'system', content: stable },
      { role: 'user', content: 'a'.repeat(BLOCK * 2) },
    ]);
    const seen = cache.observe([
      { role: 'system', content: stable },
      { role: 'user', content: 'b'.repeat(BLOCK * 2) },
    ]);
    // The system message plus its role markers covers three whole blocks, and the fourth block
    // already holds the first changed character.
    expect(seen.cacheableChars).toBe(BLOCK * 3);
  });

  it('never resumes matching after a difference, even when later text repeats', () => {
    const cache = new PrefixCacheModel();
    const tail = 't'.repeat(BLOCK * 3);
    cache.observe([{ role: 'user', content: `A${tail}` }]);
    expect(cache.observe([{ role: 'user', content: `B${tail}` }]).cacheableChars).toBe(0);
  });

  it('treats a moved message boundary as a difference', () => {
    const cache = new PrefixCacheModel();
    const text = 'm'.repeat(BLOCK * 2);
    cache.observe([{ role: 'system', content: text }]);
    expect(cache.observe([{ role: 'user', content: text }]).cacheableChars).toBe(0);
  });

  it('counts a long-prefix hit only when the repeated prefix reaches 1,024 tokens', () => {
    const cache = new PrefixCacheModel();
    const short = [{ role: 'system' as const, content: 's'.repeat(BLOCK * 2) }];
    cache.observe(short);
    expect(cache.observe(short)).toMatchObject({ cacheableChars: BLOCK * 2, longPrefixChars: 0 });
    const long = [
      { role: 'system' as const, content: 'l'.repeat(MIN_CACHED_PREFIX_CHARS + BLOCK) },
    ];
    cache.observe(long);
    const seen = cache.observe(long);
    expect(seen.cacheableChars).toBeGreaterThanOrEqual(MIN_CACHED_PREFIX_CHARS);
    expect(seen.longPrefixChars).toBe(seen.cacheableChars);
  });

  it('serves a repeat of any earlier prompt, not only the last one', () => {
    const cache = new PrefixCacheModel();
    const first = [{ role: 'system' as const, content: 'f'.repeat(BLOCK * 2) }];
    cache.observe(first);
    cache.observe([{ role: 'system', content: 'g'.repeat(BLOCK * 2) }]);
    expect(cache.observe(first).cacheableChars).toBe(BLOCK * 2);
  });
});

describe('preparePromptForCaching staticKeys', () => {
  const base = (turn: number, extra: Record<string, unknown> = {}): AiPrompt => ({
    messages: [
      { role: 'system', content: 'Stable role contract' },
      {
        role: 'user',
        content: JSON.stringify({
          ctx: { turn },
          yourStrategyProfile: { archetype: 'control' },
          strategyTask: { horizon: 'turn' },
          ...extra,
        }),
      },
    ],
    estimatedTokens: 20,
  });

  it('moves each listed key into the prefix with its value unchanged', () => {
    const prompt = preparePromptForCaching(base(1), {
      role: 'strategist',
      staticKeys: ['strategyTask', 'yourStrategyProfile'],
    });
    expect(JSON.parse(prompt.messages[1]!.content)).toEqual({
      immutableContext: {
        strategyTask: { horizon: 'turn' },
        yourStrategyProfile: { archetype: 'control' },
      },
    });
    expect(JSON.parse(prompt.messages.at(-1)!.content)).toEqual({ ctx: { turn: 1 } });
  });

  it('gives two turns of one seat the same prefix', () => {
    const options = {
      role: 'strategist' as const,
      staticKeys: ['strategyTask', 'yourStrategyProfile'],
    };
    const one = preparePromptForCaching(base(1), options);
    const two = preparePromptForCaching(base(2), options);
    expect(one.promptCache?.prefixHash).toBe(two.promptCache?.prefixHash);
  });

  it('skips a listed key the payload does not have', () => {
    const prompt = preparePromptForCaching(
      {
        messages: [
          { role: 'system', content: 'Stable role contract' },
          { role: 'user', content: JSON.stringify({ ctx: { turn: 1 } }) },
        ],
        estimatedTokens: 10,
      },
      { role: 'strategist', staticKeys: ['yourStrategyProfile'] },
    );
    expect(prompt.messages).toHaveLength(2);
    expect(JSON.parse(prompt.messages[1]!.content)).toEqual({ ctx: { turn: 1 } });
  });
});

describe('AnthropicCacheModel', () => {
  // The Haiku 5.5 row: read 0.1x and five-minute write 1.25x the input price.
  const price = { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125 };
  const MIN = ANTHROPIC_MIN_CACHED_PREFIX_TOKENS * 4;
  const system = { role: 'system' as const, content: 's'.repeat(MIN) };
  const glossary = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: 'user' as const, content: `g${i}`.repeat(50) }));
  const prompt = (glossaryCount: number, observation: string) => ({
    messages: [system, ...glossary(glossaryCount), { role: 'user' as const, content: observation }],
    glossaryMessageCount: glossaryCount,
  });

  it('writes up to its last breakpoint on the first call and reads nothing', () => {
    const cache = new AnthropicCacheModel(price);
    const billed = cache.observe(prompt(2, 'o'.repeat(400)));
    const glossaryChars = glossary(2).reduce((sum, m) => sum + m.content.length, 0);
    expect(billed.readChars).toBe(0);
    expect(billed.writeChars).toBe(MIN + glossaryChars);
    expect(billed.billedChars).toBeCloseTo((MIN + glossaryChars) * 1.25 + 400);
  });

  it('reads the earlier glossary and writes only the message a call adds', () => {
    const cache = new AnthropicCacheModel(price);
    cache.observe(prompt(2, 'o'.repeat(400)));
    const billed = cache.observe(prompt(3, 'p'.repeat(400)));
    const [g0, g1, g2] = glossary(3);
    expect(billed.readChars).toBe(MIN + g0!.content.length + g1!.content.length);
    expect(billed.writeChars).toBe(g2!.content.length);
    expect(billed.billedChars).toBeCloseTo(billed.readChars * 0.1 + billed.writeChars * 1.25 + 400);
  });

  it('never caches the observation after the last breakpoint, however often it repeats', () => {
    const cache = new AnthropicCacheModel(price);
    cache.observe(prompt(1, 'same'.repeat(100)));
    const billed = cache.observe(prompt(1, 'same'.repeat(100)));
    expect(billed.chars - billed.readChars - billed.writeChars).toBe(400);
  });

  it('stores no prefix shorter than the minimum, so it bills that prefix at the input price', () => {
    const cache = new AnthropicCacheModel(price);
    const short = {
      messages: [
        { role: 'system' as const, content: 'x'.repeat(100) },
        { role: 'user' as const, content: 'y' },
      ],
    };
    cache.observe(short);
    const billed = cache.observe(short);
    expect(billed).toMatchObject({ readChars: 0, writeChars: 0, billedChars: 101 });
  });
});
