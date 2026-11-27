import { createHash } from 'node:crypto';
import type { AiPrompt, OpenAiMessage } from './context';

export interface PromptCacheMetadata {
  /** v2 (2026-11-15) moves `staticKeys` into the prefix and drops the duplicated commander name. */
  version: 'stable-prefix-v1' | 'stable-prefix-v2';
  role: 'tactician' | 'strategist';
  prefixHash: string;
  prefixMessageCount: number;
  /** A new local process does not prove the provider cache is cold. */
  coldStatus: 'unverified';
  completeResponseCacheAllowed: false;
}

export interface PromptCacheOptions {
  role: PromptCacheMetadata['role'];
  staticContext?: Record<string, unknown>;
  /**
   * Top-level payload keys that never change for this seat in this game. Each one present is moved,
   * value unchanged, from the changing observation into the stable prefix. Moving rather than
   * removing means a key can never be dropped from the prompt by accident.
   */
  staticKeys?: string[];
  /**
   * Move commander rules text into the prefix (default true). Strategist delta prompts (S6) keep
   * it in the observation instead, where a delta omits text the seat was already shown, so the
   * prefix stays the same for full and delta prompts.
   */
  splitCommanders?: boolean;
}

function splitCommanderDefinitions(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const definitions: Record<string, unknown> = {};
  const dynamicCommander = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
      const commander = item as Record<string, unknown>;
      const name = commander['name'];
      if (typeof name === 'string') {
        // Keyed by name already, so the name is not repeated inside the definition.
        definitions[name] = stable({
          manaCost: commander['manaCost'],
          typeLine: commander['typeLine'],
          oracleText: commander['oracleText'],
        });
      }
      return stable({
        name,
        zone: commander['zone'],
        castCount: commander['castCount'],
      });
    });
  };
  const you = payload['you'];
  if (typeof you === 'object' && you !== null && !Array.isArray(you)) {
    const recordValue = you as Record<string, unknown>;
    recordValue['commanders'] = dynamicCommander(recordValue['commanders']);
  }
  const opponents = payload['opponents'];
  if (Array.isArray(opponents)) {
    for (const opponent of opponents) {
      if (typeof opponent !== 'object' || opponent === null || Array.isArray(opponent)) continue;
      const recordValue = opponent as Record<string, unknown>;
      recordValue['commanders'] = dynamicCommander(recordValue['commanders']);
    }
  }
  return Object.keys(definitions).length === 0 ? null : definitions;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function hashMessages(messages: readonly OpenAiMessage[]): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(messages)))
    .digest('hex');
}

/**
 * Split immutable role/deck material ahead of the changing observation. Array order inside each
 * payload is preserved; only object keys are canonicalized. Request ids and timestamps remain in
 * the dynamic message and can never contaminate the prefix identity.
 */
export function preparePromptForCaching(prompt: AiPrompt, options: PromptCacheOptions): AiPrompt {
  if (prompt.messages.length < 2) return prompt;
  const system = prompt.messages[0]!;
  // The observation is the last user message; system messages after it (a decision's own primer
  // sections) stay after it.
  const dynamicIndex = prompt.messages.findLastIndex((message) => message.role === 'user');
  if (dynamicIndex < 1) return prompt;
  const dynamicMessage = prompt.messages[dynamicIndex]!;
  let dynamicContent = dynamicMessage.content;
  let extractedCommanders: Record<string, unknown> | null = null;
  const movedContext: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(dynamicContent) as Record<string, unknown>;
    for (const key of options.staticKeys ?? []) {
      if (parsed[key] === undefined) continue;
      movedContext[key] = parsed[key];
      delete parsed[key];
    }
    if (options.splitCommanders !== false) extractedCommanders = splitCommanderDefinitions(parsed);
    dynamicContent = JSON.stringify(parsed);
  } catch {
    // Non-JSON prompts still benefit from a stable system prefix; leave their body untouched.
  }
  const staticContext = {
    ...(options.staticContext ?? {}),
    ...movedContext,
    ...(extractedCommanders === null ? {} : { commanderDefinitions: extractedCommanders }),
  };
  const staticMessages: OpenAiMessage[] = [system];
  if (Object.keys(staticContext).length > 0) {
    staticMessages.push({
      role: 'user',
      content: JSON.stringify({ immutableContext: stable(staticContext) }),
    });
  }
  const messages = [
    ...staticMessages,
    ...prompt.messages.slice(1, dynamicIndex),
    { ...dynamicMessage, content: dynamicContent },
    ...prompt.messages.slice(dynamicIndex + 1),
  ];
  const prefixHash = hashMessages(staticMessages);
  const estimatedTokens = Math.ceil(
    messages.reduce((sum, item) => sum + item.content.length, 0) / 4,
  );
  return {
    ...prompt,
    messages,
    estimatedTokens,
    promptCache: {
      version: 'stable-prefix-v2',
      role: options.role,
      prefixHash,
      prefixMessageCount: staticMessages.length,
      coldStatus: 'unverified',
      completeResponseCacheAllowed: false,
    },
  };
}

/**
 * How providers with automatic prefix caching see a chat request: one token stream, each message
 * opened by its role. The separators only need to keep message boundaries distinct.
 */
function serializeForPrefix(messages: readonly OpenAiMessage[]): string {
  return messages.map((message) => `\u0000${message.role}\u0000${message.content}`).join('');
}

/** Characters per cache block: about 64 tokens, the granularity of block-based prefix caches. */
export const PREFIX_CACHE_BLOCK_CHARS = 256;

/**
 * 1,024 tokens at the census's four characters per token: the shortest prefix several provider
 * caches will store. A shorter repeated prefix may earn nothing.
 */
export const MIN_CACHED_PREFIX_CHARS = 4_096;

/**
 * An exact, offline model of an automatic prefix cache, for the hill-climb census. It remembers
 * every prompt it has seen (no expiry, no eviction) and reports how much of a new prompt repeats,
 * in whole blocks, a prefix of one already sent. That is the most a provider cache could serve, so
 * it is an upper bound on cache reads and a measure of the prompt layout, not of the provider.
 */
export class PrefixCacheModel {
  private readonly seen = new Set<string>();

  /** Records one prompt; returns its length and how many of its leading characters were cacheable. */
  observe(messages: readonly OpenAiMessage[]): {
    chars: number;
    cacheableChars: number;
    /** `cacheableChars` when it reaches `MIN_CACHED_PREFIX_CHARS`, else 0. */
    longPrefixChars: number;
  } {
    const text = serializeForPrefix(messages);
    const blocks = Math.floor(text.length / PREFIX_CACHE_BLOCK_CHARS);
    let chain = '';
    let cacheableBlocks = 0;
    let stillCached = true;
    for (let block = 0; block < blocks; block++) {
      const start = block * PREFIX_CACHE_BLOCK_CHARS;
      chain = createHash('sha256')
        .update(chain)
        .update(text.slice(start, start + PREFIX_CACHE_BLOCK_CHARS))
        .digest('base64');
      if (stillCached && this.seen.has(chain)) cacheableBlocks++;
      else stillCached = false;
      this.seen.add(chain);
    }
    const cacheableChars = cacheableBlocks * PREFIX_CACHE_BLOCK_CHARS;
    return {
      chars: text.length,
      cacheableChars,
      longPrefixChars: cacheableChars >= MIN_CACHED_PREFIX_CHARS ? cacheableChars : 0,
    };
  }
}
