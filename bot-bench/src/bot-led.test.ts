import { describe, expect, it } from 'vitest';
import { loadCases } from './case';
import { parseLineup, parseModelList, publicEntry, resolveBotLedConfig } from './models';
import { fakeProvider, type FakeTurn } from './fake-provider';
import { runLineup, type RunOptions } from './run';
import { foldSeeds, seedGate } from './seeds';

const cases = loadCases();
const only = (...ids: string[]) => cases.filter((benchCase) => ids.includes(benchCase.id));
const options: RunOptions = {
  mode: 'raw',
  trials: 1,
  concurrency: 4,
  spendCapUsd: null,
  env: {},
  // Any request reaching the network is a bug in a bench that names no model.
  fetchImpl: (() =>
    Promise.reject(new Error('no network in this test'))) as unknown as typeof fetch,
  sleepImpl: () => Promise.resolve(),
};

describe('ADR 0043 lineups', () => {
  it('reads heuristic-plain and bot-led shorthand', () => {
    expect(parseModelList('local:heuristic-plain,bot-led:never')).toEqual([
      { id: 'local-heuristic-plain', kind: 'local', policy: 'heuristic-plain' },
      { id: 'bot-led-never', kind: 'bot-led', escalation: [] },
    ]);
    expect(parseModelList('bot-led:uncertain=openrouter/vendor/model')).toEqual([
      {
        id: 'bot-led-uncertain-openrouter-vendor-model',
        kind: 'bot-led',
        escalation: ['uncertain'],
        provider: 'openrouter',
        model: 'vendor/model',
      },
    ]);
  });

  it('refuses a bot-led shorthand with a malformed model, and reads its reasoning effort', () => {
    expect(() => parseModelList('bot-led:uncertain=foo')).toThrow(/provider\/model/);
    expect(() => parseModelList('bot-led:telepathy')).toThrow(/escalation must list/);
    expect(parseModelList('bot-led:uncertain=openrouter/vendor/model@low')[0]).toMatchObject({
      model: 'vendor/model',
      reasoning: 'low',
    });
  });

  it('refuses a bot-led entry that escalates with no model, or names an unknown trigger', () => {
    expect(() => parseLineup([{ id: 'b', kind: 'bot-led', escalation: ['uncertain'] }])).toThrow(
      /needs a model/,
    );
    expect(() => parseLineup([{ id: 'b', kind: 'bot-led', escalation: ['telepathy'] }])).toThrow(
      /escalation must list/,
    );
    expect(() => parseLineup([{ id: 'b', kind: 'bot-led' }])).toThrow(/escalation must list/);
  });

  it('expands a top-level seeds list over the seeded entries only', () => {
    const entries = parseLineup({
      seeds: ['a', 'b'],
      models: [
        { id: 'h', kind: 'local', policy: 'heuristic' },
        { id: 'r', kind: 'local', policy: 'random' },
        { id: 'fixed', kind: 'local', policy: 'heuristic', seed: 'own' },
        { id: 'led', kind: 'bot-led', escalation: [] },
      ],
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      'h.s1',
      'h.s2',
      'r',
      'fixed',
      'led.s1',
      'led.s2',
    ]);
    expect(entries[1]).toMatchObject({ seed: 'b', seedOf: 'h' });
    expect(publicEntry(entries[0]!)).toMatchObject({ seed: 'a', seedOf: 'h' });
    expect(() =>
      parseLineup({ seeds: ['a', 'a'], models: [{ id: 'h', kind: 'local', policy: 'heuristic' }] }),
    ).toThrow(/repeat/);
    expect(() => parseLineup({ sedes: ['a'], models: [] })).toThrow(/sedes/);
  });

  it('the checked-in gate lineup has eight seeds', async () => {
    const { loadLineupFile } = await import('./models');
    const entries = loadLineupFile('bot-bench/lineups/bot-gate.json');
    const seeds = new Set(entries.flatMap((entry) => (entry.kind === 'llm' ? [] : [entry.seed])));
    expect(seeds.size).toBe(8);
  });

  it('a bot-led entry that never escalates needs no key and plays in bot mode', () => {
    const [entry] = parseModelList('bot-led:never');
    if (entry?.kind !== 'bot-led') throw new Error('expected a bot-led entry');
    expect(resolveBotLedConfig(entry, { env: {}, mode: 'raw' })).toMatchObject({
      tacticalMode: 'bot',
      botEscalation: [],
      strategistEnabled: false,
    });
  });
});

describe('the card-aware bot in the tested seat', () => {
  it('local:heuristic has card knowledge and heuristic-plain does not', async () => {
    // Stoke the Flames to the face of the player on four: the plain bot reads the target slot as
    // neutral and takes the first option (ADR 0043's table).
    const results = await runLineup(
      only('stoke-the-flames-lethal'),
      parseModelList('local:heuristic,local:heuristic-plain'),
      options,
    );
    expect(results.map((result) => result.cases[0]!.score.score)).toEqual([1, 0]);
  });

  it('bot-led never plays as the local card-aware bot on the same seed, and records each consultation', async () => {
    const results = await runLineup(
      only('stoke-the-flames-lethal', 'burn-to-finish'),
      parseLineup({
        seeds: ['x'],
        models: [
          { id: 'h', kind: 'local', policy: 'heuristic' },
          { id: 'led', kind: 'bot-led', escalation: [] },
        ],
      }),
      options,
    );
    const [local, botLed] = results;
    expect(botLed!.status).toBe('complete');
    expect(botLed!.cases.map((entry) => entry.run.decisions.map((d) => d.actionKey))).toEqual(
      local!.cases.map((entry) => entry.run.decisions.map((d) => d.actionKey)),
    );
    for (const entry of botLed!.cases) {
      expect(entry.run.decisions.every((decision) => decision.source === 'bot')).toBe(true);
      expect(entry.run.escalations).toMatchObject({ escalated: 0 });
      expect(entry.run.escalations!.consulted).toBe(entry.run.decisions.length);
    }
    expect(local!.cases[0]!.run.escalations).toBeUndefined();
  });

  it('records an escalated decision, its reasons, and the model answering it', async () => {
    const calls: FakeTurn[] = [];
    const answer = (turn: FakeTurn): string => {
      const pass =
        turn.legalActions.find((action) => action.type === 'pass') ?? turn.legalActions[0]!;
      return JSON.stringify({ requestId: turn.requestId, actionId: pass.id });
    };
    const results = await runLineup(
      only('stoke-the-flames-lethal'),
      parseLineup([
        // A huge margin makes every real choice a close call.
        {
          id: 'esc',
          kind: 'bot-led',
          escalation: ['uncertain'],
          margin: 1000,
          provider: 'openrouter',
          model: 'fake/m',
        },
      ]),
      { ...options, env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: fakeProvider(answer, calls) },
    );
    const run = results[0]!.cases[0]!.run;
    expect(calls.length).toBeGreaterThan(0);
    expect(run.decisions[0]).toMatchObject({
      escalated: true,
      reasons: ['uncertain'],
      source: 'model',
    });
    expect(run.escalations).toMatchObject({
      escalated: calls.length,
      byReason: { uncertain: calls.length },
    });
  });

  it('the seed gate folds seeds and flags a lowered case', async () => {
    const results = await runLineup(
      only('stoke-the-flames-lethal', 'pump-the-unblocked-attacker'),
      parseLineup({
        seeds: ['p', 'q'],
        models: [
          { id: 'plain', kind: 'local', policy: 'heuristic-plain' },
          // The card-aware bot before ADR 0043's fixes, which still lost the pump case.
          { id: 'aware', kind: 'local', policy: 'heuristic', fixes: [] },
        ],
      }),
      options,
    );
    const folded = foldSeeds(results);
    expect(folded.map((entry) => entry.id)).toEqual(['plain', 'aware']);
    expect(folded[0]!.seeds).toEqual(['p', 'q']);
    expect(folded[0]!.label).toBe('heuristic-plain (local, no model)');
    expect(folded[0]!.caseRuns['stoke-the-flames-lethal']).toBe(2);
    const gate = seedGate(folded[0]!, folded[1]!);
    expect(gate.improvements.map((r) => r.caseId)).toContain('stoke-the-flames-lethal');
    // Without ADR 0043's fixes the card-aware bot still loses the pump case.
    expect(gate.regressions.map((r) => r.caseId)).toContain('pump-the-unblocked-attacker');
    expect(gate.pass).toBe(false);
  });
});
