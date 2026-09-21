import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNonCachingProvidersCache,
  getNonCachingProviders,
  supportsCaching,
} from './openrouter-provider-filter';

describe('openrouter-provider-filter', () => {
  beforeEach(() => {
    clearNonCachingProvidersCache();
  });

  describe('supportsCaching', () => {
    it('returns true when supports_implicit_caching is true', () => {
      expect(supportsCaching({ provider_name: 'DeepSeek', supports_implicit_caching: true })).toBe(
        true,
      );
    });

    it('returns true when pricing.input_cache_read is a positive string number', () => {
      expect(
        supportsCaching({
          provider_name: 'NextBit',
          supports_implicit_caching: false,
          pricing: { input_cache_read: '0.00000005' },
        }),
      ).toBe(true);
    });

    it('returns false when supports_implicit_caching is false and input_cache_read is undefined/null', () => {
      expect(
        supportsCaching({
          provider_name: 'Morph',
          supports_implicit_caching: false,
        }),
      ).toBe(false);

      expect(
        supportsCaching({
          provider_name: 'DeepInfra',
          supports_implicit_caching: false,
          pricing: { prompt: '0.0000001' },
        }),
      ).toBe(false);
    });
  });

  describe('getNonCachingProviders', () => {
    it('fetches model endpoints and returns names of providers that do not support caching', async () => {
      const mockEndpointsResponse = {
        data: {
          endpoints: [
            {
              provider_name: 'NextBit',
              supports_implicit_caching: false,
              pricing: { input_cache_read: '0.00000005' },
            },
            {
              provider_name: 'DeepSeek',
              supports_implicit_caching: true,
              pricing: { input_cache_read: '0.00000001' },
            },
            { provider_name: 'Morph', supports_implicit_caching: false },
            {
              provider_name: 'DeepInfra',
              supports_implicit_caching: false,
              pricing: { prompt: '0.0000001' },
            },
          ],
        },
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockEndpointsResponse,
      });

      const nonCaching = await getNonCachingProviders(
        'deepseek/deepseek-v4-flash',
        mockFetch as unknown as typeof fetch,
      );

      expect(nonCaching).toEqual(['Morph', 'DeepInfra']);
      // `/models/:author/:slug/endpoints` is two path segments. Percent-encoding the model as
      // one string collapsed them into a segment that matches no route, so this 404'd for
      // every slash-bearing model and the filter silently never applied.
      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('caches a failed lookup so it is not re-attempted on every decision', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

      expect(
        await getNonCachingProviders('vendor/gone', mockFetch as unknown as typeof fetch),
      ).toEqual([]);
      expect(
        await getNonCachingProviders('vendor/gone', mockFetch as unknown as typeof fetch),
      ).toEqual([]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('uses in-memory cache on subsequent requests for the same model', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            endpoints: [
              {
                provider_name: 'NextBit',
                supports_implicit_caching: false,
                pricing: { input_cache_read: '0.00000005' },
              },
              { provider_name: 'Morph', supports_implicit_caching: false },
            ],
          },
        }),
      });

      const call1 = await getNonCachingProviders('model-x', mockFetch as unknown as typeof fetch);
      const call2 = await getNonCachingProviders('model-x', mockFetch as unknown as typeof fetch);

      expect(call1).toEqual(['Morph']);
      expect(call2).toEqual(['Morph']);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns empty array if fetch fails or API returns HTTP error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await getNonCachingProviders(
        'model-error',
        mockFetch as unknown as typeof fetch,
      );
      expect(result).toEqual([]);
    });

    it('returns empty array if all providers lack caching to prevent blocking the model entirely', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            endpoints: [
              { provider_name: 'ProviderA', supports_implicit_caching: false },
              { provider_name: 'ProviderB', supports_implicit_caching: false },
            ],
          },
        }),
      });

      const result = await getNonCachingProviders(
        'no-cache-model',
        mockFetch as unknown as typeof fetch,
      );
      expect(result).toEqual([]);
    });
  });
});
