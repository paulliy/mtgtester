/**
 * Stage 2 AI archetype refinement (ADR 0022 §5).
 *
 * The property under test is the same in every case: **the heuristic tag must survive.** This
 * call is a nicety layered on a deterministic classifier that already produced a usable answer,
 * so every failure mode has to return `null` rather than propagate. A deck import must never fail,
 * or produce a worse tag, because a model was slow, disabled, or wrong.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ArchetypeResult } from '../decks/archetype';
import type { AiClient } from './client';
import { refineArchetype, validateArchetypeResponse } from './archetype';

const HEURISTIC: ArchetypeResult = {
  tag: 'Gruul dragon tribal midrange',
  strategy: 'midrange',
  theme: 'dragon tribal',
  features: {
    totalCards: 100,
    lands: 36,
    creatures: 30,
    instants: 6,
    sorceries: 6,
    artifacts: 10,
    enchantments: 4,
    planeswalkers: 1,
    averageManaValue: 4.1,
    ramp: 12,
    spotRemoval: 6,
    boardWipes: 2,
    cardDraw: 7,
    tutors: 3,
    counterspells: 0,
    recursion: 2,
    sacOutlets: 1,
    stax: 0,
    aggressiveKeywords: 9,
    themeScores: {},
    topSubtype: { subtype: 'Dragon', count: 24 },
    commanderSharesTopSubtype: true,
  },
};

const INPUT = {
  heuristic: HEURISTIC,
  commanderNames: ['Test Dragon General'],
  cardNames: ['Shivan Dragon', 'Lightning Bolt'],
  colorIdentityName: 'Gruul',
};

const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };

/** A client whose raw response body is whatever the test supplies. */
function clientReturning(rawResponse: string): AiClient {
  return {
    activeModel: 'test/model',
    requestDecision: vi.fn().mockResolvedValue({
      response: { requestId: 'archetype', actionId: 0 },
      meta: {
        model: 'test/model',
        promptTokens: 100,
        responseTokens: 10,
        latencyMs: 20,
        wasRetry: false,
        wasFallback: false,
        rawResponse,
        costUsd: 0,
      },
    }),
  };
}

describe('validateArchetypeResponse', () => {
  it('accepts a confident, short tag', () => {
    expect(validateArchetypeResponse({ tag: 'Gruul dragon aggro', confidence: 0.9 })).toBe(
      'Gruul dragon aggro',
    );
  });

  it('normalises surrounding and repeated whitespace', () => {
    expect(validateArchetypeResponse({ tag: '  Gruul   dragon  aggro ', confidence: 0.8 })).toBe(
      'Gruul dragon aggro',
    );
  });

  it('rejects a low-confidence answer so the computed tag stands', () => {
    expect(validateArchetypeResponse({ tag: 'Gruul dragon aggro', confidence: 0.2 })).toBeNull();
  });

  it('treats a missing confidence as "not confident" rather than as certainty', () => {
    // The field is the model's escape hatch for a deck it cannot read; promoting its absence to
    // certainty would defeat the point of asking for it.
    expect(validateArchetypeResponse({ tag: 'Gruul dragon aggro' })).toBeNull();
  });

  it('rejects a tag that is a sentence rather than a label', () => {
    const essay =
      'This deck appears to be a Gruul deck that wants to cast large dragons and attack';
    expect(validateArchetypeResponse({ tag: essay, confidence: 1 })).toBeNull();
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['a non-string tag', { tag: 42, confidence: 1 }],
    ['an empty tag', { tag: '   ', confidence: 1 }],
    ['NaN confidence', { tag: 'Gruul aggro', confidence: Number.NaN }],
  ])('rejects %s', (_label, raw) => {
    expect(validateArchetypeResponse(raw)).toBeNull();
  });
});

describe('refineArchetype — the heuristic tag always survives', () => {
  it('returns null without calling the model when the feature is disabled', async () => {
    const client = clientReturning('{"tag":"Better tag","confidence":1}');

    expect(await refineArchetype(client, queue, INPUT, { enabled: false })).toBeNull();
    expect(client.requestDecision).not.toHaveBeenCalled();
  });

  it('returns null when there is no client configured', async () => {
    expect(await refineArchetype(null, queue, INPUT, { enabled: true })).toBeNull();
  });

  it('returns a better tag when the model is confident', async () => {
    const client = clientReturning('{"tag":"Gruul dragon tribal aggro","confidence":0.9}');

    expect(await refineArchetype(client, queue, INPUT, { enabled: true })).toBe(
      'Gruul dragon tribal aggro',
    );
  });

  it('returns null when the model merely agrees, so nothing is rewritten needlessly', async () => {
    const client = clientReturning(`{"tag":"${HEURISTIC.tag}","confidence":0.95}`);

    expect(await refineArchetype(client, queue, INPUT, { enabled: true })).toBeNull();
  });

  it('swallows a malformed response', async () => {
    const client = clientReturning('I think this is a dragons deck!');

    expect(await refineArchetype(client, queue, INPUT, { enabled: true })).toBeNull();
  });

  it('swallows a provider failure rather than failing the import', async () => {
    const client: AiClient = {
      activeModel: 'test/model',
      requestDecision: vi.fn().mockRejectedValue(new Error('502 upstream unavailable')),
    };

    expect(await refineArchetype(client, queue, INPUT, { enabled: true })).toBeNull();
  });

  it('sends card names and features but never oracle text', async () => {
    const client = clientReturning('{"tag":"Gruul dragon tribal aggro","confidence":0.9}');
    await refineArchetype(client, queue, INPUT, { enabled: true });

    const [prompt] = (client.requestDecision as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { messages: Array<{ content: string }> },
    ];
    const body = prompt.messages.map((message) => message.content).join('\n');

    expect(body).toContain('Shivan Dragon');
    expect(body).toContain('averageManaValue');
    // Ninety-nine cards of rules text is enormous and the features already summarise it.
    expect(body).not.toContain('oracleText');
    expect(body).not.toContain('Flying, haste');
  });
});
