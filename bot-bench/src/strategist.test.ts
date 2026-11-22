import { describe, expect, it } from 'vitest';
import type { JevDecisionsTransport } from '../../packages/server/src/ai/jev-client';
import { anonymise, identifyingNames } from './bundle';
import { loadCases, type BenchCase } from './case';
import { fakeProvider, pick, type FakeTurn } from './fake-provider';
import { modelMetrics } from './metrics';
import { crossLineup, parseLineup, parseModelList, publicEntry } from './models';
import { runLineup, type RunOptions, type TranscriptEntry } from './run';
import { openCase } from './play';
import {
  StrategistLane,
  parseStrategist,
  parseStrategistList,
  resolveStrategistClientConfig,
  type LlmStrategist,
} from './strategist';
import { loadAiConfig, configForRole } from '../../packages/server/src/ai/config';
import { RequestQueue } from '../../packages/server/src/ai/queue';

const cases = loadCases();
const only = (...ids: string[]) => cases.filter((benchCase) => ids.includes(benchCase.id));
const options = (fetchImpl: typeof fetch, extra: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'raw',
  trials: 1,
  concurrency: 1,
  spendCapUsd: null,
  env: {},
  fetchImpl,
  sleepImpl: () => Promise.resolve(),
  ...extra,
});

const STRATEGIST_MODEL = 'fake/planner-model';

interface StrategistReply {
  intent?: string;
  plannedActions?: Array<Record<string, unknown>>;
  steering?: Record<string, unknown>;
  status?: number;
  cost?: number;
}

/**
 * Routes each request by the model it names: the strategist model gets `strategist`'s scripted
 * plan, everything else goes to the tactician's fake. Strategist requests are recorded in `seen`.
 */
function routed(
  strategist: (call: number) => StrategistReply,
  tactician: typeof fetch,
  seen: string[] = [],
): typeof fetch {
  return (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    if (body.model !== STRATEGIST_MODEL) return tactician(url as string, init as RequestInit);
    seen.push(body.messages.map((message) => message.content).join('\n'));
    const reply = strategist(seen.length);
    if (reply.status !== undefined) return new Response('upstream down', { status: reply.status });
    const content = JSON.stringify({
      actionId: 0,
      turnStrategy: {
        intent: reply.intent ?? 'Wipe the board, then rebuild.',
        plannedActions: reply.plannedActions ?? [],
        ...(reply.steering !== undefined && { steering: reply.steering }),
      },
    });
    return new Response(
      JSON.stringify({
        id: `fake-strategist-${seen.length}`,
        model: 'fake/secret-planner',
        provider: 'FakeBackend',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 3000, completion_tokens: 200, cost: reply.cost ?? 0.001 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

/** The wrath-then-rebuild line, played by a fake tactician that also records its prompts. */
function rebuildTactician(calls: FakeTurn[]): typeof fetch {
  return fakeProvider((turn) => {
    const has = (text: string) => turn.legalActions.some((a) => a.description.includes(text));
    const answer = has('Play Plains')
      ? 'Play Plains'
      : has('Cast Wrath of God')
        ? 'Cast Wrath of God'
        : has('Cast Serra Angel')
          ? 'Cast Serra Angel'
          : 'Pass and yield';
    return { content: pick(turn, answer), cost: 0.0002 };
  }, calls);
}

const strategist = {
  kind: 'llm',
  id: 'planner',
  provider: 'openrouter',
  model: STRATEGIST_MODEL,
} as const;

describe('strategist lineups', () => {
  it('crosses every tactician with every strategist, and pairs local bots with none and case only', () => {
    const lineup = parseLineup({
      strategists: [{ kind: 'none' }, { kind: 'case' }, strategist],
      tacticians: [
        { id: 'bot', kind: 'bot-led', escalation: [] },
        { id: 'plain', kind: 'local', policy: 'heuristic' },
        { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat' },
      ],
    });
    expect(lineup.map((entry) => entry.id)).toEqual([
      'bot.st-none',
      'bot.st-case',
      'bot.st-planner',
      'plain.st-none',
      'plain.st-case',
      'chat.st-none',
      'chat.st-case',
      'chat.st-planner',
    ]);
    expect(publicEntry(lineup[2]!)).toMatchObject({
      tactician: { id: 'bot', label: 'card-aware bot (bot-led, never escalates)' },
      strategist: { id: 'planner', kind: 'llm', model: STRATEGIST_MODEL },
    });
  });

  it('refuses what would quietly measure something else', () => {
    expect(() =>
      parseLineup([{ id: 'a', kind: 'local', policy: 'heuristic', strategist }]),
    ).toThrow(/local bot reads no strategy/);
    expect(() =>
      parseLineup({
        strategists: [{ kind: 'none' }],
        tacticians: [{ id: 'a', kind: 'llm', model: 'm', strategist: { kind: 'case' } }],
      }),
    ).toThrow(/names no strategist/);
    expect(() =>
      parseLineup([{ id: 'a', kind: 'llm', model: 'm', strategist: { kind: 'llm' } }]),
    ).toThrow(/model must be a non-empty string/);
    expect(() =>
      parseLineup([{ id: 'a', kind: 'llm', model: 'm', strategist: { kind: 'none', model: 'x' } }]),
    ).toThrow(/unknown field "model"/);
    expect(() =>
      parseLineup({ models: [{ id: 'a', kind: 'llm', model: 'm' }], strategists: [] }),
    ).toThrow(/either models, or strategists/);
  });

  it('reads the --strategists shorthand and crosses it with --models', () => {
    const specs = parseStrategistList('none, openrouter:z-ai/glm-5.3-flash@low');
    expect(specs).toEqual([
      { kind: 'none', id: 'none' },
      {
        kind: 'llm',
        id: 'z-ai-glm-5.3-flash-low',
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        reasoning: 'low',
      },
    ]);
    const lineup = crossLineup(parseModelList('local:heuristic,decision:typesafe/jev-1.14'), specs);
    expect(lineup.map((entry) => entry.id)).toEqual([
      'local-heuristic.st-none',
      'typesafe-jev-1.14.st-none',
      'typesafe-jev-1.14.st-z-ai-glm-5.3-flash-low',
    ]);
  });

  it("never prints where the strategist's key comes from", () => {
    const [entry] = parseLineup([
      {
        id: 'a',
        kind: 'llm',
        model: 'm',
        strategist: { ...strategist, apiKeyEnv: 'PLANNER_KEY' },
      },
    ]);
    expect(JSON.stringify(publicEntry(entry!))).not.toContain('PLANNER_KEY');
  });
});

describe('a live strategist in front of the tactician', () => {
  it("plans the seat's turn once, and the chat tactician plays with the plan in its prompt", async () => {
    const tactician: FakeTurn[] = [];
    const planned: string[] = [];
    const transcripts: TranscriptEntry[] = [];
    const lineup = parseLineup([
      { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat', strategist },
    ]);
    const [result] = await runLineup(
      only('wrath-then-rebuild'),
      lineup,
      options(
        routed(
          () => ({ intent: 'Wipe the board, then rebuild.' }),
          rebuildTactician(tactician),
          planned,
        ),
        { onTranscript: (entry) => transcripts.push(entry) },
      ),
    );
    const played = result!.cases[0]!;
    expect(played.score.score).toBe(1);
    // P3 pumps Shivan Dragon three times in response to the Wrath: the first non-pass action
    // starts the one re-plan a turn allows; the next two reset the coordinator's generation
    // while it is in flight, so its answer is billed and dropped, as in a live game.
    expect(planned).toHaveLength(2);
    // The strategist planned P1's own turn from P1's view.
    expect(planned[0]).toContain('Create the active player turn strategy.');
    // The first decision waited for it and carries it; the tactician saw the intent.
    const [first, second, third] = played.run.decisions;
    expect(first!.strategist).toMatchObject({
      requests: 1,
      costUsd: 0.001,
      costSource: 'reported',
      strategy: { intent: 'Wipe the board, then rebuild.' },
    });
    expect(second!.strategist).toBeUndefined();
    expect(third!.strategist).toMatchObject({ requests: 1, costUsd: 0.001 });
    expect(third!.strategist!.failure).toMatch(/dropped as stale/);
    expect(tactician[0]!.messages[1]!.content).toContain('Wipe the board, then rebuild.');
    // The decision's own figures stay the tactician's.
    expect(first!.costUsd).toBe(0.0002);
    expect(first!.requests).toBe(1);
    expect(transcripts.filter((entry) => entry.role === 'strategist')).toHaveLength(2);

    const metrics = modelMetrics(result!, only('wrath-then-rebuild'), 1);
    expect(metrics.strategist).toMatchObject({ calls: 2, failures: 1, planSteps: 0 });
    expect(metrics.strategist!.totalUsd).toBeCloseTo(0.002);
    expect(metrics.cost.totalUsd).toBeCloseTo(0.0002 * played.run.decisions.length);
    expect(metrics.strategist!.combinedUsd).toBeCloseTo(
      0.002 + 0.0002 * played.run.decisions.length,
    );
  });

  it('plays a planned step that matches the menu without asking the tactician', async () => {
    const tactician: FakeTurn[] = [];
    const lineup = parseLineup([
      { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat', strategist },
    ]);
    const [result] = await runLineup(
      only('wrath-then-rebuild'),
      lineup,
      options(
        routed(
          () => ({
            plannedActions: [
              { type: 'playLand', name: 'Plains', phase: 'precombatMain', step: null },
            ],
          }),
          rebuildTactician(tactician),
        ),
      ),
    );
    const [first] = result!.cases[0]!.run.decisions;
    expect(first).toMatchObject({ action: 'Play Plains', source: 'plan', requests: 0 });
    expect(first!.strategist!.strategy!.plannedActions).toEqual(['playLand Plains']);
    expect(tactician.some((turn) => turn.legalActions.some((a) => a.type === 'playLand'))).toBe(
      false,
    );
    expect(modelMetrics(result!, only('wrath-then-rebuild'), 1).strategist!.planSteps).toBe(1);
  });

  it('steers a bot-led tactician with knobs, with no tactician model at all', async () => {
    const planned: string[] = [];
    const lineup = parseLineup([{ id: 'bot', kind: 'bot-led', escalation: [], strategist }]);
    const never = (() =>
      Promise.reject(new Error('no tactician model'))) as unknown as typeof fetch;
    const [result] = await runLineup(
      only('develop-the-board'),
      lineup,
      options(routed(() => ({ intent: 'Develop.', steering: { aggression: 0 } }), never, planned)),
    );
    const played = result!.cases[0]!;
    expect(result!.status).toBe('complete');
    expect(planned).toHaveLength(1);
    // The bot-led primer asks for knobs, not steps.
    expect(planned[0]).toMatch(/steering/i);
    expect(played.run.decisions[0]!.strategist!.strategy).toMatchObject({
      steering: { aggression: 0 },
    });
    expect(played.run.decisions.every((decision) => decision.requests === 0)).toBe(true);
  });

  it("is never called on another seat's turn", async () => {
    const planned: string[] = [];
    const lineup = parseLineup([
      { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat', strategist },
    ]);
    const tactician = fakeProvider((turn) => pick(turn, 'Cast Counterspell'));
    const [result] = await runLineup(
      only('counter-the-finisher'),
      lineup,
      options(routed(() => ({}), tactician, planned)),
    );
    expect(planned).toHaveLength(0);
    expect(result!.cases[0]!.run.decisions[0]!.strategist).toBeUndefined();
    expect(modelMetrics(result!, only('counter-the-finisher'), 1).strategist).toMatchObject({
      calls: 0,
    });
  });

  it('stops an entry whose strategist provider keeps failing, instead of scoring it as no strategist', async () => {
    const lineup = parseLineup([
      { id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat', strategist },
    ]);
    const tactician = fakeProvider((turn) => pick(turn, 'Pass and yield'));
    const turns = cases.filter((benchCase) => benchCase.scope === 'turn').slice(0, 5);
    const [result] = await runLineup(
      turns,
      lineup,
      options(routed(() => ({ status: 503 }), tactician)),
    );
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/strategist calls in a row failed at the provider/);
    expect(result!.cases.length).toBeLessThan(turns.length);
  }, 60_000);

  it("drops a case's hand-written strategy behind `none`, and keeps it behind `case`", async () => {
    const base = only('wrath-then-rebuild')[0]!;
    const withContext: BenchCase = {
      ...base,
      context: { strategy: { intent: 'HAND WRITTEN INTENT' } },
    };
    const prompts = async (kind: 'none' | 'case'): Promise<string> => {
      const calls: FakeTurn[] = [];
      await runLineup(
        [withContext],
        parseLineup([
          {
            id: 'chat',
            kind: 'llm',
            provider: 'openrouter',
            model: 'fake/chat',
            strategist: { kind },
          },
        ]),
        options(rebuildTactician(calls)),
      );
      return calls[0]!.messages[1]!.content;
    };
    expect(await prompts('case')).toContain('HAND WRITTEN INTENT');
    expect(await prompts('none')).not.toContain('HAND WRITTEN INTENT');
  });

  it('waits for the plan before a decision model is asked, and plays matching steps first', async () => {
    const asked: string[] = [];
    const transport: JevDecisionsTransport = {
      create({ decisionsRequest }) {
        const criteria = Object.entries(decisionsRequest.questions.action.criteria) as Array<
          [string, { description: string }]
        >;
        asked.push(criteria.map(([, c]) => c.description).join(' | '));
        const want = ['Cast Wrath of God', 'Cast Serra Angel', 'Pass and yield'].find((text) =>
          criteria.some(([, c]) => c.description.includes(text)),
        );
        const choice = criteria.find(([, c]) => c.description.includes(want ?? ''))?.[0] ?? '';
        return Promise.resolve({
          id: 'gen-1',
          model: `${decisionsRequest.model}-20261101`,
          answers: { action: { type: 'choice', choice, confidence: 0.9 } },
          usage: { inputTokens: 900, outputTokens: 0, cost: 0.00009 },
        });
      },
    };
    const lineup = parseLineup([
      { id: 'jev', kind: 'decision', model: 'typesafe/jev-test', strategist },
    ]);
    const [result] = await runLineup(
      only('wrath-then-rebuild'),
      lineup,
      options(
        routed(
          () => ({
            plannedActions: [
              { type: 'playLand', name: 'Plains', phase: 'precombatMain', step: null },
            ],
          }),
          (() => Promise.reject(new Error('no chat tactician'))) as unknown as typeof fetch,
        ),
        { decisionTransport: transport },
      ),
    );
    const played = result!.cases[0]!;
    expect(played.run.decisions[0]).toMatchObject({ action: 'Play Plains', source: 'plan' });
    expect(played.run.decisions[0]!.strategist).toMatchObject({ requests: 1 });
    expect(asked.some((text) => text.includes('Play Plains'))).toBe(false);
    expect(played.score.score).toBe(1);
  });
});

describe('a blind bundle of strategist pairs', () => {
  it('renames the strategist apart from the tactician and leaves none of its names', async () => {
    const lineup = parseLineup({
      strategists: [{ kind: 'none' }, strategist],
      tacticians: [{ id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat' }],
    });
    const transcripts: TranscriptEntry[] = [];
    const results = await runLineup(
      only('wrath-then-rebuild'),
      lineup,
      options(
        routed(
          () => ({ intent: `I am ${STRATEGIST_MODEL} and I plan to wipe.` }),
          rebuildTactician([]),
        ),
        { onTranscript: (entry) => transcripts.push(entry) },
      ),
    );
    const paired = results.find((result) => result.model.id === 'chat.st-planner')!;
    expect(identifyingNames(paired.model)).toContain(STRATEGIST_MODEL);
    const shown = anonymise(results, transcripts, 'run-1');
    const text = JSON.stringify(shown.models) + JSON.stringify(shown.transcripts);
    for (const name of identifyingNames(paired.model).filter((n) => n.includes('planner')))
      expect(text).not.toContain(name);
    const renamed = shown.models.find(
      (model) =>
        model.model['strategist'] !== undefined &&
        (model.model['strategist'] as { kind: string }).kind === 'llm',
    )!;
    expect(renamed.model['strategist']).toMatchObject({ kind: 'llm', label: 'Strategist A' });
    expect(renamed.model['tactician']).toMatchObject({ label: 'Tactician A' });
    expect(text).toContain('I am Strategist A and I plan to wipe.');
  });
});

describe('the end of a case', () => {
  it('reports a strategist call still in flight as cancelled, never as a provider failure', async () => {
    const benchCase = only('wrath-then-rebuild')[0]!;
    const { engine, request } = openCase(benchCase);
    // A provider that never answers: the request hangs until it is aborted.
    let sent!: () => void;
    const inFlight = new Promise<void>((resolve) => (sent = resolve));
    // The client's model-endpoints lookup is answered; only the strategist call itself hangs.
    const hanging = ((url: unknown, init?: { signal?: AbortSignal }) =>
      String(url).includes('/endpoints')
        ? Promise.resolve(new Response('not found', { status: 404 }))
        : new Promise<Response>((_resolve, reject) => {
            sent();
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })) as unknown as typeof fetch;
    const spec = parseStrategist(strategist, 'test') as LlmStrategist;
    const runtime = { env: {}, fetchImpl: hanging, sleepImpl: () => Promise.resolve() };
    const config = {
      ...configForRole(loadAiConfig({}), 'tactician'),
      tacticalMode: 'model' as const,
    };
    const lane = new StrategistLane(
      engine,
      benchCase,
      spec,
      { ...config, strategistEnabled: true },
      resolveStrategistClientConfig(spec, runtime),
      new RequestQueue({ rpmLimit: 1000, concurrency: 1 }),
      runtime,
    );
    lane.coordinator.prepare(request);
    await inFlight;
    const tail = await lane.close();
    expect(tail).toHaveLength(1);
    for (const call of tail) {
      expect(call.failure).toMatch(/^cancelled/);
      expect(call.waitMs).toBe(0);
    }
  });
});

describe('role aliases across rebuilds', () => {
  it("keeps a strategist's alias when a later run adds another strategist", async () => {
    const tactician = rebuildTactician([]);
    const run = async (specs: unknown[]) =>
      runLineup(
        only('develop-the-board'),
        parseLineup({
          strategists: specs,
          tacticians: [{ id: 'chat', kind: 'llm', provider: 'openrouter', model: 'fake/chat' }],
        }),
        options(routed(() => ({}), tactician)),
      );
    const first = await run([strategist]);
    const before = anonymise(first, [], 'run-2');
    const second = await run([
      strategist,
      { ...strategist, id: 'aaa-other', model: 'other/planner' },
      { ...strategist, id: 'zzz-other', model: 'third/planner' },
    ]);
    const after = anonymise(second, [], 'run-2', before.key, before.roles);
    const aliasOf = (roles: typeof before.roles, id: string) =>
      roles.find((role) => role.role === 'Strategist' && role.id === id)?.alias;
    expect(aliasOf(after.roles, 'planner')).toBe(aliasOf(before.roles, 'planner'));
    const letters = after.roles.filter((role) => role.role === 'Strategist').map((r) => r.alias);
    expect(new Set(letters).size).toBe(3);
  });
});
