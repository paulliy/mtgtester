/**
 * Answer compiler prompts through the Claude API. The stage's fixed prefix goes in the system
 * prompt with a cache breakpoint, so after the first call each card pays cache-read prices for it.
 *
 * Credentials come from the SDK's usual sources (ANTHROPIC_API_KEY, or an `ant auth login`
 * profile). Model and concurrency are environment settings:
 *   CARD_COMPILER_MODEL        default claude-haiku-5-5
 *   CARD_COMPILER_RETRY_MODEL  default claude-sonnet-5-5 (used for compile rounds 2 and later)
 *   CARD_COMPILER_CONCURRENCY  default 4
 */
import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Dollars per million tokens: input, output, cache read, cache write (5-minute). Prices are the
 * standard tier; Haiku 5.5 costs more above 100K prompt tokens, which compile prompts stay under.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
};

/** Cost of one call, or null for a model with no price in the table. */
export function costOf(model: string, usage: Anthropic.Usage): number | null {
  const price = PRICES[model];
  if (price === undefined) return null;
  const [input, output, read, writeCost] = price;
  return (
    (usage.input_tokens * input +
      usage.output_tokens * output +
      (usage.cache_read_input_tokens ?? 0) * read +
      (usage.cache_creation_input_tokens ?? 0) * writeCost) /
    1_000_000
  );
}

export async function answerPrompts(
  stage: string,
  prefix: string,
  pending: { prompt: string; answer: string }[],
  usageLog: string,
): Promise<void> {
  const client = new Anthropic();
  const base = process.env['CARD_COMPILER_MODEL'] ?? 'claude-haiku-5-5';
  const retry = process.env['CARD_COMPILER_RETRY_MODEL'] ?? 'claude-sonnet-5-5';
  const concurrency = Number(process.env['CARD_COMPILER_CONCURRENCY'] ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(
      `CARD_COMPILER_CONCURRENCY must be a positive integer, got "${process.env['CARD_COMPILER_CONCURRENCY']}"`,
    );
  for (const model of new Set([base, retry]))
    if (PRICES[model] === undefined)
      console.warn(`warning: no price for ${model}; usage is logged but its cost is not counted`);
  let failed = 0;
  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const round = /\.r(\d+)\.md$/.exec(job.prompt)?.[1];
      const model = stage === 'compile' && round !== undefined && Number(round) > 1 ? retry : base;
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 16_000,
          output_config: { effort: 'low' },
          system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: readFileSync(job.prompt, 'utf8') }],
        });
      } catch (error) {
        // The SDK has already retried. Leave this prompt pending and keep the other workers going,
        // so calls already in flight are not lost.
        if (!(error instanceof Anthropic.APIError)) throw error;
        failed++;
        console.error(`${stage} ${job.prompt.split('/').pop()} ${model} failed: ${error.message}`);
        continue;
      }
      appendFileSync(
        usageLog,
        `${JSON.stringify({ stage, prompt: job.prompt, model, usage: response.usage, stopReason: response.stop_reason, costUsd: costOf(model, response.usage) })}\n`,
      );
      console.log(`${stage} ${job.prompt.split('/').pop()} ${model} ${response.stop_reason}`);
      // A cut-off or refused answer says nothing about the card. Leave the prompt pending rather
      // than spend one of the card's compile rounds on it.
      if (response.stop_reason !== 'end_turn') {
        failed++;
        continue;
      }
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      mkdirSync(job.answer.slice(0, job.answer.lastIndexOf('/')), { recursive: true });
      writeFileSync(job.answer, text);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failed > 0)
    console.warn(`${failed} prompts left pending (API error or incomplete answer); run exec again`);
}
