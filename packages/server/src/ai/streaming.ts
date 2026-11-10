/**
 * Streamed chat completions and billed-cost lookup (ADR 0040).
 *
 * Why stream: OpenRouter bills a NON-streamed request in full even after the client gives up on
 * it, because the model keeps generating. A streamed request that is aborted stops generation and
 * billing at supported providers. Streaming also hands us the generation id in the first chunk, so
 * even an attempt we abandon can be looked up later for what it actually cost.
 */

/** The non-streamed response body, which is what the rest of the client already understands. */
export interface ChatCompletionBody {
  id?: string;
  model?: string;
  provider?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string; reasoning?: string; reasoning_content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
    cache_write_input_tokens?: number;
  };
  error?: { code?: number | string; message?: string };
}

/**
 * What a stream has delivered so far. Filled in as chunks arrive, so an attempt that times out
 * mid-stream still knows its generation id and roughly how much it produced.
 */
export interface StreamProgress {
  id?: string;
  model?: string;
  provider?: string;
  /** Characters of answer plus visible reasoning received; a token estimate is `chars / 4`. */
  chars: number;
}

export function newStreamProgress(): StreamProgress {
  return { chars: 0 };
}

/** A body is a server-sent event stream only when the server says so; test doubles never do. */
export function isEventStream(res: Response): boolean {
  const type = res.headers?.get?.('content-type') ?? '';
  return type.includes('text/event-stream') && res.body !== null && res.body !== undefined;
}

/** An error the provider reported inside an otherwise successful (HTTP 200) stream. */
export class StreamedProviderError extends Error {
  constructor(
    readonly code: number | string | undefined,
    message: string,
  ) {
    super(`Provider error mid-stream${code === undefined ? '' : ` (${code})`}: ${message}`);
    this.name = 'StreamedProviderError';
  }
}

interface StreamChunk {
  id?: string;
  model?: string;
  provider?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: ChatCompletionBody['usage'];
  error?: { code?: number | string; message?: string };
}

/**
 * Read an OpenAI-compatible SSE stream into the same shape as a non-streamed body. `progress` is
 * updated as chunks arrive; if the read is aborted, the caller still has it.
 */
export async function readChatCompletionStream(
  res: Response,
  progress: StreamProgress,
): Promise<ChatCompletionBody> {
  const body = res.body;
  if (body === null) throw new Error('Streamed response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let usage: ChatCompletionBody['usage'];

  const handleLine = (line: string): void => {
    // Blank lines end an event; lines starting with ':' are keep-alive comments
    // (OpenRouter sends ": OPENROUTER PROCESSING" while a request is queued).
    if (line === '' || line.startsWith(':') || !line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return; // A partial or non-JSON line carries nothing we can use.
    }
    if (chunk.error !== undefined) {
      throw new StreamedProviderError(chunk.error.code, chunk.error.message ?? 'unknown error');
    }
    if (progress.id === undefined && typeof chunk.id === 'string') progress.id = chunk.id;
    if (progress.model === undefined && typeof chunk.model === 'string')
      progress.model = chunk.model;
    if (progress.provider === undefined && typeof chunk.provider === 'string')
      progress.provider = chunk.provider;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === 'string') {
      content += delta.content;
      progress.chars += delta.content.length;
    }
    const thought = delta?.reasoning ?? delta?.reasoning_content;
    if (typeof thought === 'string') {
      reasoning += thought;
      progress.chars += thought.length;
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) handleLine(buffer.replace(/\r$/, ''));

  return {
    ...(progress.id === undefined ? {} : { id: progress.id }),
    ...(progress.model === undefined ? {} : { model: progress.model }),
    ...(progress.provider === undefined ? {} : { provider: progress.provider }),
    choices: [
      {
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
        message: { content, ...(reasoning === '' ? {} : { reasoning }) },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

/** What OpenRouter billed for one generation, from `GET /api/v1/generation?id=`. */
export interface GenerationCost {
  generationId: string;
  costUsd: number;
  promptTokens?: number;
  responseTokens?: number;
  model?: string;
  provider?: string;
}

interface GenerationResponse {
  data?: {
    id?: string;
    total_cost?: number;
    tokens_prompt?: number;
    tokens_completion?: number;
    native_tokens_prompt?: number;
    native_tokens_completion?: number;
    model?: string;
    provider_name?: string;
  };
}

/**
 * Ask OpenRouter what a generation cost. Stats can take a few seconds to appear (404 until then),
 * so this retries with backoff; it returns null if the stats never show up.
 */
export async function lookupGenerationCost(
  generationId: string,
  options: {
    baseUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    delaysMs?: readonly number[];
  },
): Promise<GenerationCost | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delays = options.delaysMs ?? [500, 2000, 5000];
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = `${base}/generation?id=${encodeURIComponent(generationId)}`;

  for (let i = 0; i <= delays.length; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as GenerationResponse;
        const data = body.data;
        if (data !== undefined && typeof data.total_cost === 'number') {
          const promptTokens = data.native_tokens_prompt ?? data.tokens_prompt;
          const responseTokens = data.native_tokens_completion ?? data.tokens_completion;
          return {
            generationId,
            costUsd: data.total_cost,
            ...(promptTokens === undefined ? {} : { promptTokens }),
            ...(responseTokens === undefined ? {} : { responseTokens }),
            ...(data.model === undefined ? {} : { model: data.model }),
            ...(data.provider_name === undefined ? {} : { provider: data.provider_name }),
          };
        }
      } else if (res.status !== 404) {
        return null; // Auth or server trouble: retrying a lookup will not help.
      }
    } catch {
      // Network blip or lookup timeout: fall through to the next delay.
    }
    const delay = delays[i];
    if (delay === undefined) break;
    await sleep(delay);
  }
  return null;
}
