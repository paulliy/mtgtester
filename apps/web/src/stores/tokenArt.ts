/**
 * Token art lookups, shared by every battlefield tile. Each distinct token is searched once per
 * browser: results (misses included) are kept in memory and in localStorage. Requests run one at a
 * time with a short gap, as Scryfall asks of API clients, so a board of new tokens never bursts.
 */

import { reactive } from 'vue';
import { defineStore } from 'pinia';
import type { ScryfallSearchCard, TokenArt, TokenArtKey } from '../lib/tokenArt';
import { pickTokenPrinting, tokenArtCacheKey, tokenSearchQueries } from '../lib/tokenArt';

const STORAGE_KEY = 'mtg.tokenArt.v1';
const REQUEST_GAP_MS = 120;
const SEARCH_URL = 'https://api.scryfall.com/cards/search';

function loadCache(): Record<string, TokenArt | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, TokenArt | null>);
  } catch {
    return {};
  }
}

export const useTokenArtStore = defineStore('tokenArt', () => {
  /** Settled lookups: a printing, or null when nothing matched. Absent while pending. */
  const results = reactive<Record<string, TokenArt | null>>(loadCache());
  const queued = new Set<string>();
  const queue: { cacheKey: string; key: TokenArtKey }[] = [];
  let running = false;

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(results));
    } catch {
      // Storage full or blocked: the in-memory results still serve this session.
    }
  }

  async function search(key: TokenArtKey): Promise<TokenArt | null> {
    for (const { query, exact } of tokenSearchQueries(key)) {
      const url = `${SEARCH_URL}?order=released&dir=desc&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      // 404 is Scryfall's "no cards matched"; anything else non-OK is a failed lookup.
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`Scryfall search ${response.status}`);
      const body = (await response.json()) as { data?: ScryfallSearchCard[] };
      const printing = pickTokenPrinting(body.data ?? [], key.name);
      if (printing !== null) return { ...printing, exact };
    }
    return null;
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        results[next.cacheKey] = await search(next.key);
        persist();
      } catch {
        // Offline or rate-limited: leave it unsettled so a later tile can ask again.
        queued.delete(next.cacheKey);
      }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
    }
    running = false;
  }

  /** The art for this token: a printing, null for a known miss, undefined while unknown. */
  function lookup(key: TokenArtKey): TokenArt | null | undefined {
    const cacheKey = tokenArtCacheKey(key);
    if (cacheKey in results) return results[cacheKey];
    if (!queued.has(cacheKey)) {
      queued.add(cacheKey);
      queue.push({ cacheKey, key });
      void drain();
    }
    return undefined;
  }

  return { lookup };
});
