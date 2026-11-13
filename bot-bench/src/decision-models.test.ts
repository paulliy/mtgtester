import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  JevChoiceCriterion,
  JevDecisionsRequest,
} from '../../packages/server/src/ai/jev-context';
import type { JevDecisionsTransport } from '../../packages/server/src/ai/jev-client';
import { newManifest, writeBundle, writeModelResult } from './bundle';
import { loadCases, parseBenchCase, type BenchCase } from './case';
import { modelMetrics } from './metrics';
import { parseLineup, parseModelList, publicEntry, resolveDecisionKey } from './models';
import { runLineup, type RunOptions, type TranscriptEntry } from './run';
import { readZipArchive } from './zip';

const cases = loadCases();
const only = (...ids: string[]) => cases.filter((benchCase) => ids.includes(benchCase.id));

type Reply =
  | { choice: string; confidence?: number; probabilities?: Record<string, number>; cost?: number }
  | { refusal: true }
  | { error: string };

/** A stand-in for the Decisions API: hands each request to a scripted model. */
function fakeDecisions(
  model: (request: JevDecisionsRequest) => Reply,
  calls: JevDecisionsRequest[] = [],
): JevDecisionsTransport {
  return {
    create({ decisionsRequest }) {
      calls.push(decisionsRequest);
      const reply = model(decisionsRequest);
      if ('error' in reply) return Promise.reject(new Error(reply.error));
      const usage = { inputTokens: 900, outputTokens: 0, cost: 0.00009 };
      if ('refusal' in reply)
        // What the SDK hands back for an answer type it does not know.
        return Promise.resolve({
          model: `${decisionsRequest.model}-20261101`,
          answers: { action: { type: 'UNKNOWN', raw: { type: 'refusal' }, isUnknown: true } },
          usage,
        });
      return Promise.resolve({
        id: 'gen-1',
        model: `${decisionsRequest.model}-20261101`,
        answers: {
          action: {
            type: 'choice',
            choice: reply.choice,
            ...(reply.confidence !== undefined && { confidence: reply.confidence }),
            ...(reply.probabilities !== undefined && { probabilities: reply.probabilities }),
          },
        },
        usage: { ...usage, ...(reply.cost !== undefined && { cost: reply.cost }) },
      });
    },
  };
}

/** The option whose description contains `text` and, when given, whose target is named `target`. */
function option(request: JevDecisionsRequest, text: string, target?: string): string {
  const entries = Object.entries(request.questions.action.criteria) as Array<
    [string, JevChoiceCriterion]
  >;
  const found = entries.find(
    ([, criterion]) =>
      criterion.description.includes(text) &&
      (target === undefined ||
        criterion.target?.['player'] === target ||
        criterion.target?.['name'] === target),
  );
  if (found === undefined) throw new Error(`no option "${text}" ${target ?? ''}`);
  return found[0];
}

function pass(request: JevDecisionsRequest): Reply {
  const entries = Object.entries(request.questions.action.criteria) as Array<
    [string, JevChoiceCriterion]
  >;
  const passing = entries.find(([, c]) => /pass/i.test(c.description)) ?? entries[0]!;
  return { choice: passing[0] };
}

const options = (
  decisionTransport: JevDecisionsTransport,
  extra: Partial<RunOptions> = {},
): RunOptions => ({
  mode: 'raw',
  trials: 1,
  concurrency: 2,
  spendCapUsd: null,
  env: {},
  decisionTransport,
  sleepImpl: () => Promise.resolve(),
  ...extra,
});

describe('decision model lineup entries', () => {
  it('reads the --models shorthand', () => {
    expect(
      parseModelList('decision:typesafe/jev-1.14, decision:google/gemini-decision-1@hold'),
    ).toEqual([
      { id: 'typesafe-jev-1.14', kind: 'decision', model: 'typesafe/jev-1.14' },
      {
        id: 'google-gemini-decision-1-hold',
        kind: 'decision',
        model: 'google/gemini-decision-1',
        unsupported: 'hold',
      },
    ]);
  });

  it('refuses fields and settings a decision model does not take', () => {
    expect(() =>
      parseLineup([{ id: 'a', kind: 'decision', model: 'm', reasoning: 'low' }]),
    ).toThrow(/reasoning/);
    expect(() =>
      parseLineup([{ id: 'a', kind: 'decision', model: 'm', unsupported: 'pass' }]),
    ).toThrow(/bot or hold/);
    expect(() => parseModelList('decision:typesafe/jev-1.14@low')).toThrow(/bot or hold/);
  });

  it('needs a key, never prints where it comes from, and shows the effective settings', () => {
    const [entry] = parseLineup([
      { id: 'd', kind: 'decision', model: 'typesafe/jev-1.14', apiKeyEnv: 'MY_DECISION_KEY' },
    ]);
    if (entry?.kind !== 'decision') throw new Error('expected a decision entry');
    expect(() => resolveDecisionKey(entry, { env: {}, mode: 'raw' })).toThrow(/MY_DECISION_KEY/);
    expect(resolveDecisionKey(entry, { env: { MY_DECISION_KEY: 'k' }, mode: 'raw' })).toBe('k');
    const shown = publicEntry(entry);
    expect(JSON.stringify(shown)).not.toContain('MY_DECISION_KEY');
    expect(shown).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      expandTargets: true,
      unsupported: 'bot',
      label: 'typesafe/jev-1.14 (decision model)',
    });
    const [plain] = parseModelList('decision:google/gemini-decision-1');
    if (plain?.kind !== 'decision') throw new Error('expected a decision entry');
    expect(resolveDecisionKey(plain, { env: { OPENROUTER_API_KEY: 'o' }, mode: 'raw' })).toBe('o');
    expect(
      resolveDecisionKey(plain, {
        env: { OPENROUTER_API_KEY: 'o', AI_JEV_API_KEY: 'j' },
        mode: 'raw',
      }),
    ).toBe('j');
  });
});

describe('a decision model in the tested seat, through the production decision lane', () => {
  const lineup = parseLineup([{ id: 'decider', kind: 'decision', model: 'vendor/decider-1' }]);

  it('offers each target as its own option, plays the choice, and records its confidence', async () => {
    const calls: JevDecisionsRequest[] = [];
    const transcripts: TranscriptEntry[] = [];
    const transport = fakeDecisions((request) => {
      const bolt = option(request, 'Lightning Bolt', 'P4');
      return { choice: bolt, confidence: 0.8, probabilities: { [bolt]: 0.8 }, cost: 0.00004 };
    }, calls);
    const [result] = await runLineup(
      only('burn-out-the-low-player'),
      lineup,
      options(transport, { onTranscript: (entry) => transcripts.push(entry) }),
    );
    const played = result!.cases[0]!;
    expect(played.score.score).toBe(1);
    expect(played.run.decisions[0]).toMatchObject({
      action: 'Cast Lightning Bolt ({R}) → P4',
      source: 'model',
      note: 'confidence 0.80, margin over the runner-up 0.80',
      promptTokens: 900,
      costUsd: 0.00004,
      costSource: 'reported',
      requests: 1,
    });
    // A typed request: the asked-for model, no chat primer, the menu only as Choice options.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('vendor/decider-1');
    expect(calls[0]!.state['legalActions']).toBeUndefined();
    expect(JSON.stringify(calls[0])).not.toContain('Check for lethal first');
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({ modelId: 'decider', status: 'accepted' });
    const metrics = modelMetrics(result!, only('burn-out-the-low-player'), 1);
    expect(metrics.accuracy.grades.best).toBe(1);
    expect(metrics.reliability).toMatchObject({ firstTryLegal: 1, botAnswered: 0 });
    expect(metrics.cost).toMatchObject({ totalUsd: 0.00004, source: 'reported' });
  });

  it('hands an attack it cannot express to the bot, says so, and sends nothing', async () => {
    const calls: JevDecisionsRequest[] = [];
    const [result] = await runLineup(
      only('lethal-alpha-strike'),
      lineup,
      options(fakeDecisions(pass, calls)),
    );
    const decision = result!.cases[0]!.run.decisions[0]!;
    expect(decision).toMatchObject({ source: 'bot-handoff', requests: 0, costUsd: 0 });
    expect(decision.note).toMatch(/cannot express this \(requires_coupled_assignment\)/);
    expect(calls).toHaveLength(0);
    expect(result!.status).toBe('complete');
    expect(result!.cases[0]!.score.flags.join(' ')).toMatch(/answered by the heuristic bot/);
    const metrics = modelMetrics(result!, only('lethal-alpha-strike'), 1);
    expect(metrics.reliability).toMatchObject({ decisions: 1, botAnswered: 1, firstTryLegal: 0 });
    // The bot found the lethal attack; the model's own one-decision score has nothing to count.
    expect(metrics.accuracy).toMatchObject({ single: 1, singleOwn: null });
    // The bot's instant answer is not the model's speed.
    expect(metrics.speed.decisions).toBe(0);
  });

  it('holds still on an attack with unsupported: hold, without counting a provider failure', async () => {
    const holding = parseLineup([
      { id: 'holder', kind: 'decision', model: 'vendor/decider-1', unsupported: 'hold' },
    ]);
    const [result] = await runLineup(
      only('lethal-alpha-strike', 'keep-blockers-home', 'block-the-trampler', 'chump-the-giant'),
      holding,
      options(fakeDecisions(pass)),
    );
    expect(result!.status).toBe('complete');
    expect(result!.cases).toHaveLength(4);
    for (const played of result!.cases) {
      expect(played.run.decisions[0]).toMatchObject({ source: 'fallback', requests: 0 });
      expect(played.run.decisions[0]!.failure).toMatch(/^unsupported:/);
      expect(played.score.score).toBe(0);
    }
  });

  it('plays a whole turn: the model develops, the bot declares the attack', async () => {
    const transport = fakeDecisions((request) => {
      const has = (text: string) =>
        Object.values(request.questions.action.criteria).some((c) => c.description.includes(text));
      if (has('Play Plains')) return { choice: option(request, 'Play Plains') };
      if (has('Cast Wrath of God')) return { choice: option(request, 'Cast Wrath of God') };
      if (has('Cast Serra Angel')) return { choice: option(request, 'Cast Serra Angel') };
      return pass(request);
    });
    const [result] = await runLineup(only('wrath-then-rebuild'), lineup, options(transport));
    const played = result!.cases[0]!;
    expect(played.run.decisions.slice(0, 3).map((decision) => decision.action)).toEqual([
      'Play Plains',
      'Cast Wrath of God ({2}{W}{W})',
      'Cast Serra Angel ({3}{W}{W})',
    ]);
    expect(played.score.score).toBe(1);
  });

  it('scores a refusal as no answer, keeps its charge, and does not mistake it for a dead provider', async () => {
    const [result] = await runLineup(
      only('counter-the-finisher', 'hold-the-counter', 'counter-the-sweeper', 'leak-or-cancel'),
      lineup,
      options(fakeDecisions(() => ({ refusal: true }))),
    );
    expect(result!.status).toBe('complete');
    const decision = result!.cases[0]!.run.decisions[0]!;
    expect(decision.source).toBe('fallback');
    expect(decision.failure).toMatch(/^no legal answer: the model refused to answer/);
    expect(decision.costUsd).toBe(0.00009);
    expect(result!.cases[0]!.score.score).toBe(0);
  });

  it('refuses an option key the menu never offered', async () => {
    const [result] = await runLineup(
      only('counter-the-finisher'),
      lineup,
      options(fakeDecisions(() => ({ choice: 'action_9999' }))),
    );
    const decision = result!.cases[0]!.run.decisions[0]!;
    expect(decision.source).toBe('fallback');
    expect(decision.failure).toMatch(/not a legal action key/);
  });

  it('gives up on a model whose provider keeps failing', async () => {
    const [result] = await runLineup(
      cases,
      lineup,
      options(fakeDecisions(() => ({ error: 'Not Found: no such model' }))),
    );
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/failed at the provider \(provider error: .*no such model/);
  });

  it('still gives up when attacks the bot answered sit between the failures', async () => {
    // Two failures, an attack the bot answers without a request, then a whole turn whose
    // decisions fail and whose attack the bot answers again. The bot's answers say nothing about
    // the provider, so they must not reset the streak.
    const [result] = await runLineup(
      only(
        'burn-out-the-low-player',
        'counter-the-finisher',
        'lethal-alpha-strike',
        'wrath-then-rebuild',
      ),
      lineup,
      options(fakeDecisions(() => ({ error: 'Proxy refused to open a tunnel: 403 Forbidden' }))),
    );
    expect(result!.status).toBe('aborted');
    expect(result!.abortReason).toMatch(/3 decisions in a row failed at the provider/);
  });

  it('answers a decision with one sensible answer locally in production mode', async () => {
    const calls: JevDecisionsRequest[] = [];
    const [result] = await runLineup(
      only('tapped-land-when-idle'),
      lineup,
      options(fakeDecisions(pass, calls), { mode: 'production' }),
    );
    const sources = result!.cases[0]!.run.decisions.map((decision) => decision.source);
    expect(sources.every((source) => source === 'heuristic' || source === 'model')).toBe(true);
    expect(calls.length).toBe(sources.filter((source) => source === 'model').length);
  });
});

describe("a case's context reaches a decision model", () => {
  it('sends the strategy and the deals in the state, as a chat model gets them', async () => {
    const base = JSON.parse(
      JSON.stringify(cases.find((benchCase) => benchCase.id === 'hold-negate-for-a-threat')!),
    ) as Record<string, unknown>;
    const withContext = parseBenchCase({
      ...base,
      context: {
        strategy: { intent: 'Keep Negate for the Wrath P4 is holding up.', threatOrder: ['P4'] },
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
      },
    }) as BenchCase;
    const calls: JevDecisionsRequest[] = [];
    await runLineup(
      [withContext],
      parseLineup([{ id: 'decider', kind: 'decision', model: 'vendor/decider-1' }]),
      options(fakeDecisions(pass, calls)),
    );
    const state = calls[0]!.state as {
      turnStrategy?: { intent?: string };
      tableDeals?: { yourPromises: string[]; promisesToYou: string[] };
    };
    expect(state.turnStrategy?.intent).toMatch(/Keep Negate/);
    expect(state.tableDeals?.yourPromises.join(' ')).toMatch(/P3/);
    expect(state.tableDeals?.promisesToYou.length).toBe(1);
  });
});

describe('a judge bundle with decision models', () => {
  it('anonymises them as candidates and shows judges what they were sent', async () => {
    const SECRET = 'secretvendor/zorblax-decide-7';
    const lineup = parseLineup([
      { id: 'local-heuristic', kind: 'local', policy: 'heuristic' },
      { id: 'zorblax-decider', kind: 'decision', model: SECRET },
      {
        id: 'plain-decider',
        kind: 'decision',
        model: 'othervendor/plain-decide-2',
        expandTargets: false,
      },
    ]);
    const selected = only('burn-out-the-low-player', 'lethal-alpha-strike');
    const transcripts: TranscriptEntry[] = [];
    const results = await runLineup(
      selected,
      lineup,
      options(
        fakeDecisions((request) => ({ choice: option(request, 'Lightning Bolt', 'P4') })),
        { onTranscript: (entry) => transcripts.push(entry) },
      ),
    );
    const directory = mkdtempSync(join(tmpdir(), 'bot-bench-decision-'));
    try {
      writeFileSync(
        join(directory, 'run.json'),
        JSON.stringify({
          ...newManifest('decision-run', 'raw', 1, selected, null, '2026-01-01T00:00:00.000Z'),
          modelIds: lineup.map((entry) => entry.id),
        }),
      );
      for (const result of results)
        writeModelResult(
          directory,
          result,
          transcripts.filter((entry) => entry.modelId === result.model.id),
        );
      const built = await writeBundle(directory, cases, { blind: true });
      const files = readZipArchive(readFileSync(built.zipPath));
      const all = [...files.values()].map((data) => data.toString('utf8')).join('\n');
      for (const name of ['zorblax', 'secretvendor', 'othervendor', 'plain-decide', 'openrouter'])
        expect(all.toLowerCase()).not.toContain(name);
      const file = (suffix: string): string =>
        [...files].find(([name]) => name.endsWith(suffix))![1].toString('utf8');
      expect(file('/PRIMER.md')).toContain('What the decision models were given');
      const burn = file('/cases/01-burn-out-the-low-player.md');
      expect(burn).toContain('The exact decision-model request for this decision');
      // Each target-expansion setting shows what it was sent: the Bolt has an open target, so an
      // entry without expansion was sent nothing.
      expect(burn).toContain('### Entries with `expandTargets: true`');
      expect(burn).toMatch(
        /### Entries with `expandTargets: false`\s+None\. This decision cannot be expressed as one choice \(`requires_ambiguous_target_choice`\)/,
      );
      expect(file('/cases/02-lethal-alpha-strike.md')).toMatch(
        /None\. This decision cannot be expressed as one choice/,
      );
      expect(file('/models/model-a.md')).toBeDefined();
      expect(built.leaks).toEqual([]);
      const key = JSON.parse(readFileSync(built.keyPath!, 'utf8')) as {
        aliases: Array<{ alias: string; model: { model: string; kind: string } }>;
      };
      expect(key.aliases).toContainEqual(
        expect.objectContaining({
          model: expect.objectContaining({ model: SECRET, kind: 'decision' }),
        }),
      );
      expect(key.aliases).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
