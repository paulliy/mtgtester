import { createHash } from 'node:crypto';
import type { AiPrompt, OpenAiMessage } from './context';

export interface PromptCacheMetadata {
  version: 'stable-prefix-v1';
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
  removeDynamicKeys?: string[];
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
        definitions[name] = stable({
          name,
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
  const dynamicMessage = prompt.messages.at(-1)!;
  let dynamicContent = dynamicMessage.content;
  let extractedCommanders: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(dynamicContent) as Record<string, unknown>;
    for (const key of options.removeDynamicKeys ?? []) delete parsed[key];
    extractedCommanders = splitCommanderDefinitions(parsed);
    dynamicContent = JSON.stringify(parsed);
  } catch {
    // Non-JSON prompts still benefit from a stable system prefix; leave their body untouched.
  }
  const staticContext = {
    ...(options.staticContext ?? {}),
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
    ...prompt.messages.slice(1, -1),
    { ...dynamicMessage, content: dynamicContent },
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
      version: 'stable-prefix-v1',
      role: options.role,
      prefixHash,
      prefixMessageCount: staticMessages.length,
      coldStatus: 'unverified',
      completeResponseCacheAllowed: false,
    },
  };
}
