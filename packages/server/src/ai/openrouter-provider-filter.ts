/**
 * OpenRouter Provider Caching Filter.
 * Queries OpenRouter's model endpoints API to identify providers that do not support
 * prompt caching (lacking `supports_implicit_caching` and `pricing.input_cache_read`).
 */

export interface OpenRouterEndpointPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  discount?: number;
}

export interface OpenRouterEndpoint {
  provider_name: string;
  supports_implicit_caching?: boolean;
  pricing?: OpenRouterEndpointPricing;
}

export interface OpenRouterEndpointsResponse {
  data?: {
    endpoints?: OpenRouterEndpoint[];
  };
}

interface CacheEntry {
  providers: string[];
  expiresAt: number;
}

const nonCachingCache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
/**
 * A failed lookup is cached too, briefly. Without it every decision in the game paid for
 * another doomed round-trip (with a 5s timeout in front of it) to re-learn the same nothing.
 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

/**
 * Determines whether an endpoint supports prompt caching.
 * Supports caching if `supports_implicit_caching` is true, or if `pricing.input_cache_read`
 * is defined, non-null, and positive.
 */
export function supportsCaching(endpoint: OpenRouterEndpoint): boolean {
  if (endpoint.supports_implicit_caching === true) {
    return true;
  }
  const cacheRead = endpoint.pricing?.input_cache_read;
  if (cacheRead !== undefined && cacheRead !== null && cacheRead !== '') {
    const val = Number(cacheRead);
    if (!Number.isNaN(val) && val > 0) {
      return true;
    }
  }
  return false;
}

/** Clear the in-memory cache of non-caching providers (primarily for unit testing). */
export function clearNonCachingProvidersCache(): void {
  nonCachingCache.clear();
}

/**
 * Fetch and return the list of provider names for a model on OpenRouter that do NOT
 * support prompt caching.
 *
 * Results are cached in memory for `ttlMs` milliseconds to avoid redundant HTTP requests.
 * If the endpoints request fails or if all providers lack caching, returns an empty array.
 */
export async function getNonCachingProviders(
  model: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = 'https://openrouter.ai/api/v1',
  ttlMs = DEFAULT_TTL_MS,
): Promise<string[]> {
  const cached = nonCachingCache.get(model);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.providers;
  }

  const cleanBase = baseUrl
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/+$/, '');
  /**
   * The route is `/models/:author/:slug/endpoints` — two path segments. Encoding the model as
   * a whole turned the separator into `%2F`, collapsing it to one segment that matches no
   * route, so this lookup 404'd for every slash-bearing model (which is all of them on
   * OpenRouter) and the caching filter silently did nothing.
   */
  const modelPath = model.split('/').map(encodeURIComponent).join('/');
  const url = `${cleanBase}/models/${modelPath}/endpoints`;

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      nonCachingCache.set(model, { providers: [], expiresAt: Date.now() + FAILURE_TTL_MS });
      return [];
    }

    const data = (await res.json()) as OpenRouterEndpointsResponse;
    const endpoints = data.data?.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      nonCachingCache.set(model, { providers: [], expiresAt: Date.now() + FAILURE_TTL_MS });
      return [];
    }

    const cachingProviders = new Set<string>();
    const nonCachingProviders = new Set<string>();

    for (const ep of endpoints) {
      if (!ep.provider_name) continue;
      if (supportsCaching(ep)) {
        cachingProviders.add(ep.provider_name);
      } else {
        nonCachingProviders.add(ep.provider_name);
      }
    }

    // Only exclude providers that don't cache if there is at least one provider that DOES cache.
    let result: string[] = [];
    if (cachingProviders.size > 0 && nonCachingProviders.size > 0) {
      result = Array.from(nonCachingProviders).filter((p) => !cachingProviders.has(p));
    }

    nonCachingCache.set(model, { providers: result, expiresAt: Date.now() + ttlMs });
    return result;
  } catch {
    // Return empty array on network failure or timeout to degrade gracefully
    nonCachingCache.set(model, { providers: [], expiresAt: Date.now() + FAILURE_TTL_MS });
    return [];
  }
}
