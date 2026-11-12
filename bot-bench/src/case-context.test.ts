/**
 * ADR 0045 decision 6: a case can carry the strategist's view and the deals in force, and a scope
 * longer than one turn. The context reaches a model through the production guidance.
 */
import { describe, expect, it } from 'vitest';
import { loadCases, parseBenchCase, type BenchCase } from './case';
import { fakeProvider, type FakeTurn } from './fake-provider';
import { parseLineup } from './models';
import { runLineup } from './run';

const base = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(loadCases().find((c) => c.id === 'hold-negate-for-a-threat')!));

const context = {
  strategy: {
    intent: 'Keep Negate for the Wrath P4 is holding up.',
    threatOrder: ['P4', 'P2'],
    steering: { aggression: 0.3, hold: ['Negate'] },
  },
  deals: [
    {
      parties: ['P1', 'P3'],
      rounds: 1,
      obligations: [
        { kind: 'noCounter', by: 'P1', against: 'P3' },
        { kind: 'noAttack', by: 'P3', against: 'P1' },
      ],
    },
  ],
};

describe('case context and scope (ADR 0045)', () => {
  it('parses a context block and refuses a malformed one', () => {
    expect(parseBenchCase({ ...base(), context }).context?.deals).toHaveLength(1);
    expect(() =>
      parseBenchCase({
        ...base(),
        context: {
          deals: [{ parties: ['P1', 'P3'], rounds: 1, obligations: [{ kind: 'bribe' }] }],
        },
      }),
    ).toThrow(/kind/);
    expect(() =>
      parseBenchCase({
        ...base(),
        context: {
          deals: [
            {
              parties: ['P1', 'P3'],
              rounds: 1,
              obligations: [{ kind: 'noAttack', by: 'P2', against: 'P1' }],
            },
          ],
        },
      }),
    ).toThrow(/not a party/);
    expect(() =>
      parseBenchCase({ ...base(), context: { strategy: { threatOrder: ['P2'] } } }),
    ).toThrow(/intent/);
  });

  it('a multi-turn scope needs a window past the first turn, and is for turn cases', () => {
    const turn = JSON.parse(
      JSON.stringify(loadCases().find((c) => c.id === 'firebreathing-for-exact')!),
    ) as Record<string, unknown> & { position: { continue: Record<string, unknown> } };
    expect(() => parseBenchCase({ ...turn, turns: 2 })).toThrow(/reach past the first turn/);
    expect(
      parseBenchCase({
        ...turn,
        turns: 2,
        position: {
          ...turn.position,
          continue: { ...turn.position.continue, throughNextTurn: true },
        },
      }).turns,
    ).toBe(2);
    expect(() => parseBenchCase({ ...base(), turns: 2 })).toThrow(/turn cases/);
  });

  it("hands the strategist's view and the deals to a model through its guidance", async () => {
    const calls: FakeTurn[] = [];
    const pass = (turn: FakeTurn): string =>
      JSON.stringify({
        requestId: turn.requestId,
        actionId: turn.legalActions.find((a) => a.type === 'pass')!.id,
      });
    const withContext = parseBenchCase({ ...base(), context }) as BenchCase;
    await runLineup(
      [withContext],
      parseLineup([{ id: 'm', kind: 'llm', provider: 'openrouter', model: 'fake/m' }]),
      {
        mode: 'raw',
        trials: 1,
        concurrency: 1,
        spendCapUsd: null,
        env: { OPENROUTER_API_KEY: 'k' },
        fetchImpl: fakeProvider(pass, calls),
        sleepImpl: () => Promise.resolve(),
      },
    );
    const payload = JSON.parse(calls[0]!.messages[1]!.content) as {
      turnStrategy?: { intent?: string; threatOrder?: string[] };
      tableDeals?: { yourPromises: string[]; promisesToYou: string[] };
    };
    expect(payload.turnStrategy).toMatchObject({
      intent: context.strategy.intent,
      threatOrder: ['P4', 'P2'],
    });
    expect(payload.tableDeals?.yourPromises.join(' ')).toMatch(/P3/);
    expect(payload.tableDeals?.promisesToYou.length).toBe(1);
  });
});
