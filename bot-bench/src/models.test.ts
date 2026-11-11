import { describe, expect, it } from 'vitest';
import { loadCases } from './case';
import { fakeProvider, pick, type FakeTurn } from './fake-provider';
import { modelMetrics } from './metrics';
import { parseLineup, parseModelList, publicEntry, resolveLlmConfig } from './models';
import { runLineup, type RunOptions, type TranscriptEntry } from './run';

const cases = loadCases();
const only = (...ids: string[]) => cases.filter((benchCase) => ids.includes(benchCase.id));
const options = (fetchImpl: typeof fetch, extra: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'raw',
  trials: 1,
  concurrency: 2,
  spendCapUsd: null,
  env: {},
  fetchImpl,
  sleepImpl: () => Promise.resolve(),
  ...extra,
});

describe('lineup parsing', () => {
  it('reads the --models shorthand', () => {
    expect(parseModelList('local:heuristic, openrouter:qwen/qwen3.7-flash@low')).toEqual([
      { id: 'local-heuristic', kind: 'local', policy: 'heuristic' },
      {
        id: 'qwen-qwen3.7-flash-low',
        kind: 'llm',
        provider: 'openrouter',
        model: 'qwen/qwen3.7-flash',
        reasoning: 'low',
      },
    ]);
  });

  it('refuses a typo instead of ignoring it', () => {
    expect(() => parseLineup([{ id: 'a', kind: 'llm', model: 'm', modle: 'x' }])).toThrow(/modle/);
    expect(() => parseLineup([{ id: 'a', kind: 'local', policy: 'genius' }])).toThrow(/policy/);
    expect(() => parseModelList('nonsense')).toThrow(/provider:model/);
    expect(() => parseModelList('mystery:model')).toThrow(/provider must be one of/);
    expect(() =>
      parseLineup([
        { id: 'a', kind: 'local', policy: 'random' },
        { id: 'a', kind: 'local', policy: 'heuristic' },
      ]),
    ).toThrow(/repeats id/);
  });

  it('never prints where the key comes from', () => {
    const [entry] = parseLineup([
      { id: 'm', kind: 'llm', model: 'x', baseUrl: 'https://example.test/v1', apiKeyEnv: 'MY_KEY' },
    ]);
    expect(JSON.stringify(publicEntry(entry!))).not.toContain('MY_KEY');
  });

  it('needs a key for a remote endpoint and takes it from the named variable', () => {
    const [entry] = parseModelList('groq:llama-test');
    if (entry?.kind !== 'llm') throw new Error('expected a model entry');
    expect(() => resolveLlmConfig(entry, { env: {}, mode: 'raw' })).toThrow(/GROQ_API_KEY/);
    const config = resolveLlmConfig(entry, { env: { GROQ_API_KEY: 'k' }, mode: 'raw' });
    expect(config).toMatchObject({
      apiKey: 'k',
      baseUrl: 'https://api.groq.com/openai/v1',
      models: ['llama-test'],
      heuristicsEnabled: false,
      decisionCacheEnabled: false,
      strategistEnabled: false,
    });
    expect(
      resolveLlmConfig(entry, { env: { GROQ_API_KEY: 'k' }, mode: 'production' }),
    ).toMatchObject({
      heuristicsEnabled: true,
    });
  });
});

describe('a model in the tested seat, through the production pipeline', () => {
  const lineup = parseLineup([
    { id: 'fake', kind: 'llm', provider: 'openrouter', model: 'fake/secret-model-name' },
  ]);

  it('sends the production primer and scores the best answer', async () => {
    const calls: FakeTurn[] = [];
    const transcripts: TranscriptEntry[] = [];
    const fetchImpl = fakeProvider(
      (turn) => ({
        content: pick(turn, 'Cast Lightning Bolt', ['P4'], 'P4 is at 3'),
        promptTokens: 1500,
        completionTokens: 40,
        cost: 0.0002,
      }),
      calls,
    );
    const [result] = await runLineup(
      only('burn-out-the-low-player'),
      lineup,
      options(fetchImpl, { onTranscript: (entry) => transcripts.push(entry) }),
    );
    const played = result!.cases[0]!;
    expect(played.score.score).toBe(1);
    expect(played.run.decisions[0]).toMatchObject({
      action: 'Cast Lightning Bolt ({R}) → P4',
      source: 'model',
      note: 'P4 is at 3',
      promptTokens: 1500,
      responseTokens: 40,
      costUsd: 0.0002,
      costSource: 'reported',
      requests: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toContain('Check for lethal first');
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({ modelId: 'fake', caseId: 'burn-out-the-low-player' });
    const metrics = modelMetrics(result!, only('burn-out-the-low-player'), 1);
    expect(metrics.cost).toMatchObject({
      totalUsd: 0.0002,
      source: 'reported',
      providerRequests: 1,
    });
    expect(metrics.accuracy.grades.best).toBe(1);
    expect(metrics.reliability.firstTryLegal).toBe(1);
  });

  it('counts a corrective retry, and estimates cost from the price list when none is reported', async () => {
    const priced = parseLineup([
      {
        id: 'priced',
        kind: 'llm',
        provider: 'openrouter',
        model: 'fake/priced',
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      },
    ]);
    const fetchImpl = fakeProvider((turn) =>
      turn.attempt === 1
        ? JSON.stringify({ requestId: turn.requestId, actionId: 42 })
        : pick(turn, 'Cast Lightning Bolt', ['P4']),
    );
    const [result] = await runLineup(only('burn-out-the-low-player'), priced, options(fetchImpl));
    const decision = result!.cases[0]!.run.decisions[0]!;
    expect(decision.source).toBe('model-retry');
    expect(decision.requests).toBe(2);
    expect(decision.costSource).toBe('estimated');
    // Two requests of 1200 prompt and 30 output tokens at $1 and $2 per million.
    expect(decision.costUsd).toBeCloseTo((2400 * 1 + 60 * 2) / 1_000_000, 10);
    expect(result!.cases[0]!.score.score).toBe(1);
    expect(result!.cases[0]!.score.flags.join(' ')).toMatch(/corrective retry/);
    expect(modelMetrics(result!, only('burn-out-the-low-player'), 1).reliability).toMatchObject({
      correctiveRetries: 1,
      firstTryLegal: 0,
    });
  });

  it('scores nothing when the model never gives a legal answer and the bot has to play', async () => {
    const fetchImpl = fakeProvider(() => 'I think attacking is good here.');
    const [result] = await runLineup(only('counter-the-finisher'), lineup, options(fetchImpl));
    const played = result!.cases[0]!;
    // The heuristic fallback finds the counter, but that is not the model's answer.
    expect(played.run.decisions[0]).toMatchObject({ source: 'fallback' });
    // The first reply and the corrective retry, each sent again by the client's own retry.
    expect(played.run.decisions[0]!.requests).toBeGreaterThanOrEqual(2);
    expect(played.run.decisions[0]!.failure).toMatch(/no legal answer/);
    expect(played.score.score).toBe(0);
    expect(modelMetrics(result!, only('counter-the-finisher'), 1).accuracy.grades.noAnswer).toBe(1);
  });

  it('plays a whole turn decision by decision and meets every objective', async () => {
    const fetchImpl = fakeProvider((turn) => {
      const has = (text: string) => turn.legalActions.some((a) => a.description.includes(text));
      if (has('Play Plains')) return pick(turn, 'Play Plains');
      if (has('Cast Wrath of God')) return pick(turn, 'Cast Wrath of God');
      if (has('Cast Serra Angel')) return pick(turn, 'Cast Serra Angel');
      return pick(turn, 'Pass and yield');
    });
    const [result] = await runLineup(only('wrath-then-rebuild'), lineup, options(fetchImpl));
    const played = result!.cases[0]!;
    expect(played.run.decisions.slice(0, 3).map((decision) => decision.action)).toEqual([
      'Play Plains',
      'Cast Wrath of God ({2}{W}{W})',
      'Cast Serra Angel ({3}{W}{W})',
    ]);
    expect(played.score.score).toBe(1);
    expect(played.run.termination).toBe('complete');
  });

  it('stops asking a model that loops, and says so', async () => {
    const fetchImpl = fakeProvider((turn) => pick(turn, 'Pass priority'));
    const looping = { ...only('clear-the-blocker-and-pump')[0]!, maxActorDecisions: 2 };
    const [result] = await runLineup([looping], lineup, options(fetchImpl));
    expect(result!.cases[0]!.run.decisions).toHaveLength(2);
    expect(result!.cases[0]!.run.termination).toBe('decision_cap');
    expect(result!.cases[0]!.score.flags.join(' ')).toMatch(/stopped asking after 2 decisions/);
  });

  it('gives up on a model whose provider keeps failing instead of scoring the fallback', async () => {
    const fetchImpl = fakeProvider(() => ({ status: 401, body: 'invalid_api_key' }));
    const [result] = await runLineup(cases, lineup, options(fetchImpl));
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/failed at the provider/);
    expect(result!.cases.length).toBeLessThan(cases.length);
  });

  it("never credits the fallback bot's play to the model on a whole turn", async () => {
    // Every answer is prose: the pipeline's fallback bot would find the Overrun kill.
    const fetchImpl = fakeProvider(() => ({ content: 'I would cast Overrun and attack.' }));
    const [result] = await runLineup(only('overrun-for-the-kill'), lineup, options(fetchImpl));
    const entry = result!.cases[0]!;
    expect(entry.run.decisions.every((decision) => decision.source === 'fallback')).toBe(true);
    expect(entry.run.log.join('\n')).not.toMatch(/Overrun/);
    // Only what holding still achieves on its own is met: keeping every creature (2 of 10).
    const met = (entry.score.objectives ?? []).filter((objective) => objective.met);
    expect(met.map((objective) => objective.label)).toEqual(['P1 loses no creature']);
    expect(entry.score.score).toBeCloseTo(0.2);
  }, 60_000);

  it('stops a failing provider mid-turn, even if a later request would succeed', async () => {
    const calls: FakeTurn[] = [];
    // The first three requests fail at the provider; from the fourth on it would answer.
    const fetchImpl = fakeProvider(
      (turn) =>
        calls.length <= 3
          ? { status: 401, body: 'invalid_api_key' }
          : { content: pick(turn, 'Pass priority') },
      calls,
    );
    const [result] = await runLineup(
      only('clear-the-blocker-and-pump'),
      lineup,
      options(fetchImpl),
    );
    // The fourth decision is never sent, and the turn played by the fallback is not scored.
    expect(calls).toHaveLength(3);
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/3 decisions in a row failed at the provider/);
    expect(result!.cases).toHaveLength(0);
    expect(result!.unscored?.[0]?.decisions).toHaveLength(3);
  });

  it('stops spending once the cap is passed', async () => {
    const fetchImpl = fakeProvider((turn) => ({ content: pick(turn, 'Pass priority'), cost: 0.6 }));
    const [result] = await runLineup(
      only('burn-out-the-low-player', 'hold-the-counter', 'land-for-the-turn'),
      lineup,
      options(fetchImpl, { spendCapUsd: 1 }),
    );
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/spend cap/);
    expect(result!.cases).toHaveLength(2);
  });

  it('counts price-list estimates against the spend cap', async () => {
    const calls: FakeTurn[] = [];
    // The provider reports no charge; the lineup's price list makes each request $0.60.
    const fetchImpl = fakeProvider(
      (turn) => ({
        content: pick(turn, 'Pass priority'),
        promptTokens: 600_000,
        completionTokens: 0,
      }),
      calls,
    );
    const priced = parseLineup([
      {
        id: 'priced',
        kind: 'llm',
        provider: 'openrouter',
        model: 'fake/priced',
        pricing: { inputPerMTok: 1, outputPerMTok: 1 },
      },
    ]);
    const [result] = await runLineup(
      only('wrath-then-rebuild'),
      priced,
      options(fetchImpl, { spendCapUsd: 0.5 }),
    );
    expect(calls).toHaveLength(1);
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/spend cap of \$0\.50 reached during wrath-then-rebuild/);
  });

  it('never counts an unpriced decision as free', async () => {
    let sent = 0;
    const fetchImpl = fakeProvider((turn) =>
      // Only the first request reports a charge; the rest come back with no price at all.
      sent++ === 0
        ? { content: pick(turn, 'Pass priority'), cost: 0.01 }
        : { content: pick(turn, 'Pass priority') },
    );
    const [result] = await runLineup(only('wrath-then-rebuild'), lineup, options(fetchImpl));
    const { cost } = modelMetrics(result!, only('wrath-then-rebuild'), 1);
    expect(sent).toBeGreaterThan(1);
    expect(cost.source).toBe('partial');
    const unpriced = result!.cases[0]!.run.decisions.filter((d) => d.costUsd === undefined);
    expect(unpriced.length).toBeGreaterThan(0);
    expect(cost.unpricedDecisions).toBe(unpriced.length);
    // A lower bound, and an average over the priced decisions only (one paid $0.01; a request
    // that failed before any generation is a known $0), never spread over the unpriced ones.
    const priced = result!.cases[0]!.run.decisions.filter((d) => d.costUsd !== undefined);
    expect(cost.totalUsd).toBeCloseTo(0.01);
    expect(cost.perDecisionUsd).toBeCloseTo(0.01 / priced.length);
    expect(cost.perGameUsd).toBeCloseTo((0.01 / priced.length) * 300);
  });

  it('keeps reported charges and estimates only the unpriced attempts', async () => {
    // The first attempt is billed $0.60 but returns prose; the retry answers with no price.
    const fetchImpl = fakeProvider((turn) =>
      turn.attempt === 1
        ? { content: 'I would pass here.', cost: 0.6, promptTokens: 1000, completionTokens: 10 }
        : { content: pick(turn, 'Pass priority'), promptTokens: 1000, completionTokens: 10 },
    );
    const priced = parseLineup([
      {
        id: 'priced',
        kind: 'llm',
        provider: 'openrouter',
        model: 'fake/priced',
        pricing: { inputPerMTok: 1, outputPerMTok: 1 },
      },
    ]);
    const [result] = await runLineup(only('hold-the-counter'), priced, options(fetchImpl));
    const decision = result!.cases[0]!.run.decisions[0]!;
    expect(decision.requests).toBe(2);
    expect(decision.costSource).toBe('estimated');
    // $0.60 reported, plus 1,010 tokens at $1 per million for the retry.
    expect(decision.costUsd).toBeCloseTo(0.60101, 6);
  });

  it('keeps a cost unknown when an earlier attempt may have been billed', async () => {
    // Each request's first attempt starts a generation (it streams an id and some text), then
    // the stream breaks; the retry succeeds and reports its charge. The broken attempt may have
    // been billed too, and nothing reported what it cost.
    const answer = fakeProvider((turn) => ({ content: pick(turn, 'Pass priority'), cost: 0.01 }));
    const seen = new Set<string>();
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const requestId = (JSON.parse(body.messages[1]!.content) as { ctx: { reqId: string } }).ctx
        .reqId;
      if (seen.has(requestId)) return answer(url as string, init as RequestInit);
      seen.add(requestId);
      const chunks = [
        { id: 'gen-1', choices: [{ delta: { content: '{"requestId":' } }] },
        { id: 'gen-1', error: { code: 502, message: 'upstream stream broke' } },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const [result] = await runLineup(only('hold-the-counter'), lineup, options(fetchImpl));
    const decision = result!.cases[0]!.run.decisions[0]!;
    expect(decision.requests).toBe(2);
    expect(decision.costUsd).toBeUndefined();
    expect(decision.costSource).toBe('unknown');
  });

  it('stops in the middle of a whole-turn case once the cap is passed', async () => {
    const calls: FakeTurn[] = [];
    const fetchImpl = fakeProvider(
      (turn) => ({ content: pick(turn, 'Pass priority'), cost: 0.6 }),
      calls,
    );
    const [result] = await runLineup(
      only('wrath-then-rebuild'),
      lineup,
      options(fetchImpl, { spendCapUsd: 0.5 }),
    );
    // The first request takes spend past the cap; nothing more is sent, and the cut-off case
    // is not scored on the play the model was never asked for.
    expect(calls).toHaveLength(1);
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/spend cap of \$0\.50 reached during wrath-then-rebuild/);
    expect(result!.cases).toHaveLength(0);
    // What the cut-off case already spent still counts, though it is not scored.
    expect(result!.unscored?.map((entry) => entry.caseId)).toEqual(['wrath-then-rebuild']);
    const { cost, accuracy } = modelMetrics(result!, only('wrath-then-rebuild'), 1);
    expect(cost.providerRequests).toBe(1);
    expect(cost.totalUsd).toBeCloseTo(0.6);
    expect(cost.source).toBe('reported');
    expect(accuracy.casesPlayed).toBe(0);
  });
});
