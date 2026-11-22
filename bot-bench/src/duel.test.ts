import { describe, expect, it } from 'vitest';
import { checkArms, fallbackShare, renderDuel, runDuel, seating, type DuelOptions } from './duel';
import { fakeProvider } from './fake-provider';
import { parseLineup } from './models';

const base = (extra: Partial<DuelOptions>): DuelOptions => ({
  arms: [],
  deals: 1,
  seed: 'duel-test',
  turnCap: 6,
  jobs: 1,
  spendCapUsd: null,
  env: {},
  sleepImpl: () => Promise.resolve(),
  ...extra,
});

const strategist = {
  kind: 'llm',
  id: 'planner',
  provider: 'openrouter',
  model: 'fake/planner-model',
} as const;

describe('duel seating', () => {
  it('alternates two arms around the table and rotates them, and gives four arms a seat each', () => {
    expect(seating(['a', 'b'], 0)).toEqual({ P1: 'a', P2: 'b', P3: 'a', P4: 'b' });
    expect(seating(['a', 'b'], 1)).toEqual({ P1: 'b', P2: 'a', P3: 'b', P4: 'a' });
    const four = [0, 1, 2, 3].map((r) => seating(['a', 'b', 'c', 'd'], r));
    // Over the four rotations every arm sits in every seat exactly once.
    for (const seat of ['P1', 'P2', 'P3', 'P4'] as const)
      expect(new Set(four.map((s) => s[seat]))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('refuses what a game cannot play faithfully', () => {
    const [a, b, c] = parseLineup([
      { id: 'a', kind: 'bot-led', escalation: [] },
      { id: 'b', kind: 'local', policy: 'heuristic' },
      { id: 'c', kind: 'llm', model: 'm', strategist: { kind: 'case' } },
    ]);
    expect(() => checkArms([a!, b!, c!])).toThrow(/2 or 4 arms/);
    expect(() => checkArms([a!, c!])).toThrow(/only in bench positions/);
    expect(() => checkArms([a!, a!])).toThrow(/listed twice/);
  });
});

describe('offline duels', () => {
  it('plays each deal once per rotation through the production pipeline, and counts each arm apart', async () => {
    const arms = parseLineup([
      { id: 'bot', kind: 'bot-led', escalation: [] },
      { id: 'jev', kind: 'decision', model: 'typesafe/jev-test', strategist },
    ]);
    const { games, summary } = await runDuel(base({ arms, offline: true }));
    expect(games).toHaveLength(2);
    expect(games.map((game) => game.seats['P1'])).toEqual(['bot', 'jev']);
    for (const game of games) {
      expect(game.turnCapped || game.winner !== null).toBe(true);
      // The decision model answered for itself, its strategist planned, and the bot arm spent nothing.
      expect(game.perArm['jev']!.sources['jev']).toBeGreaterThan(0);
      expect(game.perArm['jev']!.strategistCalls).toBeGreaterThan(0);
      expect(game.perArm['bot']!.sources['bot']).toBeGreaterThan(0);
      expect(game.perArm['bot']!.strategistCalls).toBe(0);
      expect(game.perArm['bot']!.requests).toEqual({ tactician: 0, strategist: 0, decision: 0 });
    }
    expect(summary.fairWinRate).toBe(0.5);
    expect(summary.arms.map((arm) => arm.seats)).toEqual([4, 4]);
    const markdown = renderDuel(
      { arms, seed: 'duel-test', turnCap: 6, offline: true },
      games,
      summary,
    );
    expect(markdown).toContain('Offline');
    expect(markdown).toContain('| bot ');
  }, 60_000);

  it('seats four arms one to a seat, through every rotation', async () => {
    const arms = parseLineup([
      { id: 'bot', kind: 'bot-led', escalation: [] },
      { id: 'plain', kind: 'local', policy: 'heuristic-plain' },
      { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat', strategist },
      { id: 'jev', kind: 'decision', model: 'typesafe/jev-test' },
    ]);
    const { games, summary } = await runDuel(base({ arms, offline: true, turnCap: 4 }));
    expect(games).toHaveLength(4);
    expect(summary.fairWinRate).toBe(0.25);
    expect(summary.arms.every((arm) => arm.seats === 4)).toBe(true);
    expect(games[0]!.perArm['chat']!.sources['primary']).toBeGreaterThan(0);
  }, 60_000);
});

describe('paid duels', () => {
  it('flags a model that kept falling back to the bot as not a fair test', async () => {
    const arms = parseLineup([
      { id: 'bot', kind: 'bot-led', escalation: [] },
      { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat' },
    ]);
    const fetchImpl = fakeProvider(() => 'I would rather not say.');
    const { games, summary } = await runDuel(
      base({ arms, fetchImpl, deals: 1, turnCap: 2, env: { OPENROUTER_API_KEY: 'k' } }),
    );
    const chat = summary.arms.find((arm) => arm.id === 'chat')!;
    expect(chat.fallbackShare).toBe(1);
    expect(fallbackShare(chat.totals)).toBe(1);
    expect(renderDuel({ arms, seed: 's', turnCap: 3 }, games, summary)).toMatch(
      /Not a fair test for fake\/chat/,
    );
  }, 60_000);

  it('stops starting games once the spend cap is reached', async () => {
    const arms = parseLineup([
      { id: 'bot', kind: 'bot-led', escalation: [] },
      { id: 'planned', kind: 'bot-led', escalation: [], strategist },
    ]);
    // Every strategist call reports $0.30; the cap is $0.50.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: 'gen',
          model: 'fake/planner-model',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  actionId: 0,
                  turnStrategy: { intent: 'x', plannedActions: [], steering: { aggression: 1 } },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;
    const { games, summary } = await runDuel(
      base({
        arms,
        fetchImpl,
        deals: 3,
        turnCap: 8,
        spendCapUsd: 0.5,
        env: { OPENROUTER_API_KEY: 'k' },
      }),
    );
    expect(summary.capped).toBe(true);
    expect(games.length).toBeLessThan(6);
    // Overshoot is at most the call that crossed the cap.
    expect(summary.spendUsd).toBeLessThanOrEqual(0.5 + 0.3 + 1e-9);
    expect(games.at(-1)!.capped).toBe(true);
    expect(summary.arms.find((arm) => arm.id === 'planned')!.totals.cappedRequests).toBeGreaterThan(
      0,
    );
  }, 60_000);
});
