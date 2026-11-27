/**
 * The Claude Messages API as a transport for `OpenAiCompatibleClient`. Model fallback, retries,
 * timeouts, attempt logging and answer parsing stay in the client; this file only turns one
 * prompt into a Messages request and the reply back into the chat-completions shape the client
 * already reads.
 *
 * The SDK is loaded on first use, so nothing that merely imports the AI code (the browser build
 * included) pulls it in, and the key only ever lives in the server's environment.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { AiConfig } from './config';
import type { AiPrompt } from './context';
import type { ChatCompletionBody } from './streaming';

/**
 * Thinking cannot be turned off on the current Claude models (Opus 5.5 rejects `disabled`, and
 * Sonnet 5.5 only offers `between_tools`, which is for tool loops). `max_tokens` caps thinking
 * and answer together, so a call with reasoning "off" still gets this much room to think at low
 * effort before it writes the answer. Unused tokens are not billed.
 */
export const ANTHROPIC_MIN_THINKING_TOKENS = 2048;

/** Server-side refusal fallback (beta): a declined request is re-run on a fallback model. */
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The models that offer the server-side fallback. Haiku 5.5 has none (a declined request stays
 * declined), so it, and any model not listed, is sent without the parameter.
 */
const SERVER_FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

export function supportsServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODELS.has(model);
}

/** An HTTP failure from the Messages API, flattened so the client classifies it like any other. */
export class AnthropicHttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly text: string,
  ) {
    super(`HTTP ${status}: ${text}`);
    this.name = 'AnthropicHttpFailure';
  }
}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Effort is the depth control. Reasoning "off" (or effort `none`) maps to `low`, the cheapest
 * setting, and on a model that accepts it thinking is also disabled outright
 * (`canDisableThinking`); this project's `max` is the API's `max`.
 */
export function anthropicEffort(
  config: Pick<AiConfig, 'reasoningEnabled' | 'reasoningEffort'>,
): Effort {
  const effort = config.reasoningEffort ?? 'low';
  if (config.reasoningEnabled !== true || effort === 'none') return 'low';
  return effort;
}

/**
 * One Messages request. System messages become the top-level `system`; the rest keep their
 * order. A cache breakpoint goes on the last message of the stable prefix (the prompt-cache
 * layout's prefix when it is on, otherwise the system primer), so the per-game constants are
 * read from cache on later calls, and a second one on the last card glossary message, if any.
 * No `temperature`: current models reject sampling parameters.
 */
/**
 * Models that accept `thinking: {"type": "disabled"}`. Anthropic's effort page (read 2026-11-26)
 * says Haiku 5.5 does, at effort `high` or below, and that Opus 5.5 rejects it with a 400 at every
 * effort. A model is listed only once its documentation says so.
 */
export function canDisableThinking(model: string): boolean {
  return /^claude-haiku-5-5(\b|$)/.test(model);
}

export function anthropicRequest(
  config: Pick<
    AiConfig,
    'reasoningEnabled' | 'reasoningEffort' | 'maxOutputTokens' | 'reasoningTokenHeadroom'
  >,
  model: string,
  prompt: AiPrompt,
  answerTokens: number,
): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const reasoningOn = config.reasoningEnabled === true && config.reasoningEffort !== 'none';
  // ADR 0055 decision 2: "reasoning off" really is off where the model allows it, rather than
  // effort `low` with thinking still on. Effort stays `low`, inside the `high`-or-below range.
  const thinkingOff = !reasoningOn && canDisableThinking(model);
  const thinkingRoom = thinkingOff
    ? 0
    : Math.max(
        ANTHROPIC_MIN_THINKING_TOKENS,
        reasoningOn ? (config.reasoningTokenHeadroom ?? 0) : 0,
      );

  const leadingSystem = prompt.messages.findIndex((m) => m.role !== 'system');
  const systemCount = leadingSystem === -1 ? prompt.messages.length : leadingSystem;
  const prefixCount = prompt.promptCache?.prefixMessageCount ?? systemCount;
  const breakpoint = Math.min(Math.max(prefixCount, 1), prompt.messages.length) - 1;
  // The card glossary follows the stable prefix and only ever grows, so a second breakpoint on its
  // last message lets the next call read all of it but the one message that call adds.
  const glossaryEnd = Math.max(prefixCount, 1) + (prompt.glossaryMessageCount ?? 0) - 1;
  const breakpoints = new Set([breakpoint]);
  if (glossaryEnd > breakpoint && glossaryEnd < prompt.messages.length - 1)
    breakpoints.add(glossaryEnd);
  const cache = { type: 'ephemeral' as const };

  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [];
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  prompt.messages.forEach((message, index) => {
    const block: Anthropic.Beta.Messages.BetaTextBlockParam = {
      type: 'text',
      text: message.content,
      ...(breakpoints.has(index) ? { cache_control: cache } : {}),
    };
    if (message.role === 'system') {
      // A system message after the conversation has started is still an operator instruction;
      // keep it in the system prompt rather than demoting it to a user turn.
      system.push(block);
      return;
    }
    messages.push({ role: message.role, content: [block] });
  });
  if (messages.length === 0) messages.push({ role: 'user', content: 'Answer now.' });

  return {
    model,
    max_tokens: answerTokens + thinkingRoom,
    ...(system.length > 0 ? { system } : {}),
    messages,
    output_config: { effort: anthropicEffort(config) },
    ...(thinkingOff ? { thinking: { type: 'disabled' as const } } : {}),
    ...(supportsServerFallback(model)
      ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default' as const }
      : {}),
  };
}

/** Make one Messages call and return it in the chat-completions shape the client parses. */
export async function callAnthropic(
  config: Pick<AiConfig, 'baseUrl' | 'apiKey' | 'requestTimeoutMs'>,
  body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ChatCompletionBody> {
  const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
  const client = new AnthropicSdk({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: fetchImpl,
    // The client owns retries and the deadline; the SDK's own would double them.
    maxRetries: 0,
    timeout: (config.requestTimeoutMs ?? 45_000) + 5_000,
  });

  let reply: Anthropic.Beta.Messages.BetaMessage;
  try {
    reply = await client.beta.messages.create(body, { signal });
  } catch (error) {
    if (error instanceof AnthropicSdk.APIError && typeof error.status === 'number') {
      throw new AnthropicHttpFailure(error.status, JSON.stringify(error.error ?? error.message));
    }
    if (error instanceof AnthropicSdk.APIUserAbortError) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    if (error instanceof AnthropicSdk.APIConnectionError) {
      // Worded so the retry layer's transport check recognises it.
      throw new Error(`fetch failed: ${error.message}`, { cause: error });
    }
    throw error;
  }

  const text = reply.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
  const usage = reply.usage;
  const promptTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return {
    id: reply.id,
    model: reply.model,
    provider: 'anthropic',
    choices: [
      {
        ...(reply.stop_reason === null ? {} : { finish_reason: reply.stop_reason }),
        message: { content: text },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens === null
        ? {}
        : { cache_read_input_tokens: usage.cache_read_input_tokens }),
      ...(usage.cache_creation_input_tokens === null
        ? {}
        : { cache_write_input_tokens: usage.cache_creation_input_tokens }),
    },
  };
}
