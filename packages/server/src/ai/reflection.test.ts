/**
 * Post-game AI self-reflection (ADR 0022 §7).
 *
 * Two properties carry most of the weight here:
 *
 *   1. **The anti-cheat boundary does not relax when the game ends.** A reflection for P1 must
 *      contain no other seat's hand and no library ordering — the same rule brief §7.1 applies to
 *      every in-game prompt. The game being over is not a reason to hand a model information its
 *      seat never had; a review written with knowledge the seat lacked is hindsight, not a lesson.
 *   2. **Nothing here can fail loudly.** The game is already decided and already reported. Every
 *      malformed, slow, or missing answer degrades to `null` and the other seats still publish.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PlayerView, SpectatorLogLine } from '@mtg/shared';
import { assembleReflectionPrompt, type ReflectionContext } from './context';
import type { AiClient } from './client';
import type { AiReflection } from '@mtg/shared';
import {
  condenseSeatLog,
  publishReflections,
  runReflection,
  validateReflection,
} from './reflection';

/** A view for P1 in which every opponent field is populated, so a leak would be visible. */
function fixtureView(): PlayerView {
  return {
    seat: 'P1',
    life: 12,
    hand: [
      {
        id: 'c1',
        name: 'Grizzly Bears',
        manaCost: '{1}{G}',
        typeLine: 'Creature — Bear',
        oracleText: 'Vanilla creature.',
      },
    ],
    deck: [{ id: 'd1', name: 'Forest' }],
    graveyard: [{ id: 'g1', name: 'Giant Growth' }],
    exile: [],
    commanders: [{ name: 'Llanowar Elves', zone: 'command', castCount: 1 }],
    availableMana: { G: 2 },
    manaSources: [{ name: 'Forest', symbols: ['G'], count: 1 }],
    opponents: [
      {
        seat: 'P2',
        life: 40,
        handSize: 7,
        librarySize: 92,
        graveyard: [{ id: 'og1', name: 'Sol Ring' }],
        commanders: [{ name: 'Krenko, Mob Boss', zone: 'battlefield', castCount: 2 }],
        poisonCounters: 0,
        commanderDamageDealtToYou: 9,
      },
    ],
    battlefield: [
      { id: 'p1', controller: 'P1', name: 'Forest', tapped: false, status: [] },
      { id: 'p2', controller: 'P2', name: 'Goblin Token', tapped: false, status: [] },
    ],
    stack: [],
    recentLog: ['T9 P2 combatDamage'],
  };
}

function fixtureContext(overrides: Partial<ReflectionContext> = {}): ReflectionContext {
  return {
    seat: 'P1',
    position: 3,
    seatCount: 4,
    lossReason: 'lifeZero',
    turnCount: 14,
    winnerSeat: 'P2',
    view: fixtureView(),
    decisions: [{ turn: 3, phase: 'precombatMain', action: 'Play Forest' }],
    publicLog: ['T3 P1 plays Forest'],
    ...overrides,
  };
}

function line(overrides: Partial<SpectatorLogLine>): SpectatorLogLine {
  return { sequence: 1, turn: 1, actorSeat: 'P1', text: 'does a thing', ...overrides };
}

function clientReturning(rawResponse: string): AiClient {
  return {
    activeModel: 'test/model',
    requestDecision: vi.fn().mockResolvedValue({
      response: { requestId: 'reflection', actionId: 0 },
      meta: {
        model: 'test/model', promptTokens: 500, responseTokens: 120, latencyMs: 900,
        wasRetry: false, wasFallback: false, rawResponse, costUsd: 0,
      },
    }),
  };
}

const queue = { enqueue: <T,>(fn: () => Promise<T>) => fn() };

const GOOD_RESPONSE = JSON.stringify({
  summary: 'I ramped well but never answered the Krenko board.',
  keyMistakes: [{ turn: 6, what: 'Tapped out for a ramp spell', better: 'Held up removal' }],
  keyPlays: [{ turn: 3, what: 'Curved out on lands' }],
  threatRead: 'P2 was the threat from turn 5; I read P3 as the threat instead.',
});

describe('assembleReflectionPrompt — the seat sees only what it saw (brief §7.1)', () => {
  it("carries no opponent's hand contents and no library ordering", () => {
    const body = assembleReflectionPrompt(fixtureContext())
      .messages.map((message) => message.content)
      .join('\n');

    // The opponent's hand is a count in the PlayerView and must stay one here.
    expect(body).toContain('"hand":7');
    expect(body).not.toContain('Sol Ring');
    // The seat's own library order is secret even from itself (brief §7.1), so no deck list at all.
    expect(body).not.toContain('"deck"');
    expect(body).not.toContain('librarySize');
  });

  it('does not carry the decision primer — there is nothing left to decide', () => {
    // `RULES_PRIMER` instructs the model to pick an actionId from a legal menu and to answer in a
    // decision-shaped JSON. Both contradict a review, so a review must not be given it.
    const body = assembleReflectionPrompt(fixtureContext())
      .messages.map((message) => message.content)
      .join('\n');

    expect(body).not.toContain('legalActions');
    expect(body).not.toContain('actionId');
  });

  it('carries the outcome, the seat’s own decisions, and its own archetype', () => {
    const body = assembleReflectionPrompt(
      fixtureContext({ archetypeTag: 'Selesnya tokens midrange' }),
    )
      .messages.map((message) => message.content)
      .join('\n');

    expect(body).toContain('"finishedPosition":3');
    expect(body).toContain('lifeZero');
    expect(body).toContain('Play Forest');
    expect(body).toContain('Selesnya tokens midrange');
  });

  it('omits the archetype rather than sending an empty one', () => {
    const body = assembleReflectionPrompt(fixtureContext({ archetypeTag: '' }))
      .messages.map((message) => message.content)
      .join('\n');

    expect(body).not.toContain('yourDeckArchetype');
  });

  it('reports a halted game as "did not finish" rather than as position 0', () => {
    const body = assembleReflectionPrompt(fixtureContext({ position: 0 }))
      .messages.map((message) => message.content)
      .join('\n');

    expect(body).toContain('did not finish');
  });
});

describe('condenseSeatLog', () => {
  it("keeps the seat's own actions and every elimination, and drops other seats' noise", () => {
    const condensed = condenseSeatLog(
      [
        line({ sequence: 1, actorSeat: 'P1', text: 'plays Forest' }),
        line({ sequence: 2, actorSeat: 'P2', text: 'casts Sol Ring' }),
        line({ sequence: 3, actorSeat: 'P3', text: 'is eliminated', emphasis: 'elimination' }),
      ],
      'P1',
    );

    expect(condensed).toEqual(['T1 P1 plays Forest', 'T1 P3 is eliminated']);
  });

  it('keeps the tail when a game runs long', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      line({ sequence: i, turn: i, text: `action ${i}` }),
    );

    const condensed = condenseSeatLog(lines, 'P1', 10);

    expect(condensed).toHaveLength(10);
    expect(condensed.at(-1)).toContain('action 199');
  });
});

describe('validateReflection', () => {
  it('accepts a well-formed review', () => {
    const result = validateReflection(JSON.parse(GOOD_RESPONSE), 14);

    expect(result?.summary).toContain('ramped well');
    expect(result?.keyMistakes[0]).toEqual({
      turn: 6,
      what: 'Tapped out for a ramp spell',
      better: 'Held up removal',
    });
    expect(result?.keyPlays).toHaveLength(1);
  });

  it('clamps a hallucinated turn to a turn the game actually had', () => {
    // Each turn is a jump link in the UI; an unclamped 900 would be a control that goes nowhere.
    const result = validateReflection(
      { summary: 'ok', keyMistakes: [{ turn: 900, what: 'something' }] },
      14,
    );

    expect(result?.keyMistakes[0]?.turn).toBe(14);
  });

  it('truncates rather than trusting a model that writes an essay', () => {
    const result = validateReflection({ summary: 'x'.repeat(5_000) }, 14);

    expect(result?.summary).toHaveLength(600);
  });

  it('caps the lists at 5 mistakes and 3 plays', () => {
    const result = validateReflection(
      {
        summary: 'ok',
        keyMistakes: Array.from({ length: 20 }, (_, i) => ({ turn: i, what: `m${i}` })),
        keyPlays: Array.from({ length: 20 }, (_, i) => ({ turn: i, what: `p${i}` })),
      },
      14,
    );

    expect(result?.keyMistakes).toHaveLength(5);
    expect(result?.keyPlays).toHaveLength(3);
  });

  it('drops a moment with no text rather than rendering an empty bullet', () => {
    const result = validateReflection(
      { summary: 'ok', keyMistakes: [{ turn: 4 }, { turn: 5, what: 'real' }] },
      14,
    );

    expect(result?.keyMistakes).toEqual([{ turn: 5, what: 'real' }]);
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['a review with no summary', { keyMistakes: [{ turn: 1, what: 'x' }] }],
    ['a blank summary', { summary: '   ' }],
  ])('rejects %s — an empty card is worse than none', (_label, raw) => {
    expect(validateReflection(raw, 14)).toBeNull();
  });
});

describe('runReflection — every failure is silent and local', () => {
  it('returns a review, tagged with the seat, position, and model', async () => {
    const result = await runReflection(clientReturning(GOOD_RESPONSE), queue, fixtureContext(), {
      gameId: 'g1',
    });

    expect(result?.seat).toBe('P1');
    expect(result?.position).toBe(3);
    expect(result?.model).toBe('test/model');
    expect(result?.keyMistakes[0]?.turn).toBe(6);
  });

  it('returns null with no client configured', async () => {
    expect(await runReflection(null, queue, fixtureContext(), { gameId: 'g1' })).toBeNull();
  });

  it('swallows a malformed response', async () => {
    const client = clientReturning('Well, I think I played pretty well actually!');

    expect(await runReflection(client, queue, fixtureContext(), { gameId: 'g1' })).toBeNull();
  });

  it('swallows a provider failure — the game is already over and already reported', async () => {
    const client: AiClient = {
      activeModel: 'test/model',
      requestDecision: vi.fn().mockRejectedValue(new Error('504 gateway timeout')),
    };

    expect(await runReflection(client, queue, fixtureContext(), { gameId: 'g1' })).toBeNull();
  });

  it('records the call as a billed `reflection` so it shows up in the cost counters', async () => {
    const logger = { log: vi.fn() };

    await runReflection(clientReturning(GOOD_RESPONSE), queue, fixtureContext(), {
      gameId: 'g1',
      logger: logger as unknown as Parameters<typeof runReflection>[3]['logger'],
    });

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0]?.[4]).toBe('reflection');
  });
});

describe('publishReflections — one slow or failing seat never costs the others', () => {
  function reflectionFor(seat: string): AiReflection {
    return {
      seat,
      position: 1,
      summary: `${seat} review`,
      keyMistakes: [],
      keyPlays: [],
      threatRead: '',
      model: 'test/model',
    };
  }

  const contexts = ['P1', 'P2', 'P3'].map((seat) => fixtureContext({ seat }));

  it('publishes each review as it lands, then a final complete message', async () => {
    const progress: Array<{ count: number; complete: boolean }> = [];

    await publishReflections(
      contexts,
      (context) => Promise.resolve(reflectionFor(context.seat)),
      (reflections, complete) => progress.push({ count: reflections.length, complete }),
    );

    // Three incremental pushes, then the terminal one — the screen fills in seat by seat.
    expect(progress).toEqual([
      { count: 1, complete: false },
      { count: 2, complete: false },
      { count: 3, complete: false },
      { count: 3, complete: true },
    ]);
  });

  it('still publishes the other seats when one returns nothing', async () => {
    const landed = await publishReflections(
      contexts,
      (context) => Promise.resolve(context.seat === 'P2' ? null : reflectionFor(context.seat)),
      () => {},
    );

    expect(landed.map((entry) => entry.seat).sort()).toEqual(['P1', 'P3']);
  });

  it('still publishes the other seats when one throws outright', async () => {
    const landed = await publishReflections(
      contexts,
      (context) =>
        context.seat === 'P2'
          ? Promise.reject(new Error('persistence blew up'))
          : Promise.resolve(reflectionFor(context.seat)),
      () => {},
    );

    expect(landed.map((entry) => entry.seat).sort()).toEqual(['P1', 'P3']);
  });

  it('reports completion even when every seat failed, so nothing waits forever', async () => {
    const progress: Array<{ count: number; complete: boolean }> = [];

    await publishReflections(
      contexts,
      () => Promise.resolve(null),
      (reflections, complete) => progress.push({ count: reflections.length, complete }),
    );

    expect(progress).toEqual([{ count: 0, complete: true }]);
  });
});
