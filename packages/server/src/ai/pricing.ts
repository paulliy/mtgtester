/**
 * Dollar prices for models whose API reports no cost (ADR 0055 decision 5). OpenRouter returns
 * `usage.cost` on every call (ADR 0040); the Anthropic Messages API returns token counts only, so
 * a per-game spend cap on that path needs these figures.
 *
 * Prices are US dollars per million tokens, from Anthropic's pricing page
 * (https://platform.claude.com/docs/en/about-claude/pricing), read 2026-11-26. A request whose
 * prompt (every input token, cache reads and writes included) is over `longContextFrom` pays the
 * long-context row for the whole request. Cache writes are the five-minute rate, the only one this
 * project's `cache_control: { type: 'ephemeral' }` breakpoints use.
 *
 * Only models with a verified row belong here. A model with no row has no estimate, and a table
 * refuses to seat it (`assertPriced`) rather than run a game it cannot cap.
 */

export interface PriceRow {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPrice {
  standard: PriceRow;
  /** Prompt size, in tokens, above which `longContext` applies to the whole request. */
  longContextFrom: number;
  longContext: PriceRow;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': {
    standard: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    longContextFrom: 100_000,
    longContext: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
};

/**
 * The price-table key for a model id: Anthropic's own id (`claude-haiku-5-5`), or OpenRouter's
 * spelling of the same model (`anthropic/claude-haiku-5.5`).
 */
export function priceKey(model: string): string {
  return model.replace(/^anthropic\//, '').replaceAll('.', '-');
}

export function priceOf(model: string): ModelPrice | undefined {
  return PRICES[priceKey(model)];
}

/** Token counts as an attempt reports them; `promptTokens` includes cache reads and writes. */
export interface PricedUsage {
  promptTokens?: number | undefined;
  responseTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

/**
 * The cost of one attempt from its token counts, or `undefined` when the model has no row or the
 * attempt reported no tokens at all. Missing parts count as zero, so an attempt that failed after
 * sending its prompt is still charged for the prompt it was billed for.
 */
export function estimateCostUsd(model: string, usage: PricedUsage): number | undefined {
  const price = priceOf(model);
  if (price === undefined) return undefined;
  if (usage.promptTokens === undefined && usage.responseTokens === undefined) return undefined;
  const prompt = Math.max(0, usage.promptTokens ?? 0);
  const read = Math.max(0, usage.cacheReadTokens ?? 0);
  const write = Math.max(0, usage.cacheWriteTokens ?? 0);
  const fresh = Math.max(0, prompt - read - write);
  const row = prompt > price.longContextFrom ? price.longContext : price.standard;
  const perToken = (perMillion: number): number => perMillion / 1_000_000;
  return (
    fresh * perToken(row.input) +
    read * perToken(row.cacheRead) +
    write * perToken(row.cacheWrite) +
    Math.max(0, usage.responseTokens ?? 0) * perToken(row.output)
  );
}

/** Throws unless every model in `models` has a price row. */
export function assertPriced(models: readonly string[]): void {
  const missing = models.filter((model) => priceOf(model) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `no price for ${missing.join(', ')}: a table cannot cap spending on a model it cannot price`,
    );
  }
}
