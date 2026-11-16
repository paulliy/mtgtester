import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import type { AiClient } from './client';
import { DEFAULT_AI_CONFIG, loadAiConfig } from './config';
import { assembleStrategistPrompt } from './strategy-context';
import {
  applyStrategistDelta as applyDelta,
  compactStrategistPayload as compact_,
  deltaBaseFrom,
  STRATEGIST_DELTA_PRIMER_TEXT,
} from './strategist-delta';
import { StrategyCoordinator } from './strategy-coordinator';

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const compactStrategistPayload = (payload: Payload): Payload => compact_(payload) as Payload;
const applyStrategistDelta = (...args: Parameters<typeof applyDelta>): Payload =>
  applyDelta(...args) as Payload;

const RUBY_TEXT =
  'Haste\nWhenever Ruby attacks while you control a creature with power 4 or greater.';
const BREENA_TEXT = 'Flying\nWhenever a player attacks one of your opponents, draw a card.';
const VENTMAW_TEXT = 'Flying\nWhenever this creature attacks, add {R}{R}{R}{G}{G}{G}.';
const BRIDGE_TEXT = 'Hideaway 4\nThis land enters tapped.\n{T}: Add {G}.';

function makeView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [
      {
        id: 'o-1',
        name: 'Savage Ventmaw',
        manaCost: '{4}{R}{G}',
        typeLine: 'Creature — Dragon',
        power: 4,
        toughness: 4,
        oracleText: VENTMAW_TEXT,
      },
      { id: 'o-2', name: 'Forest', typeLine: 'Basic Land — Forest', oracleText: '' },
    ],
    deck: [],
    graveyard: [{ id: 'o-3', name: 'Path to Exile' }],
    exile: [{ id: 'o-4', name: 'Up the Beanstalk' }],
    commanders: [
      {
        name: 'Ruby, Daring Tracker',
        zone: 'command',
        castCount: 0,
        manaCost: '{R}{G}',
        typeLine: 'Legendary Creature — Human Scout',
        oracleText: RUBY_TEXT,
      },
    ],
    availableMana: { G: 1 },
    manaSources: [
      { name: 'Forest', symbols: ['G'], count: 1 },
      { name: 'Forest', symbols: ['G'], count: 1 },
      { name: 'Mosswort Bridge', symbols: ['G'], count: 1 },
    ],
    opponents: [
      {
        seat: 'P2',
        life: 40,
        handSize: 7,
        librarySize: 90,
        graveyard: [],
        commanders: [
          {
            name: 'Breena, the Demagogue',
            zone: 'battlefield',
            castCount: 1,
            manaCost: '{1}{W}{B}',
            typeLine: 'Legendary Creature — Bird Warlock',
            oracleText: BREENA_TEXT,
          },
        ],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
      {
        seat: 'P3',
        life: 40,
        handSize: 7,
        librarySize: 90,
        graveyard: [],
        commanders: [],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
    battlefield: [
      {
        id: 'o-10',
        controller: 'P1',
        name: 'Forest',
        tapped: false,
        typeLine: 'Basic Land — Forest',
        status: [],
      },
      {
        id: 'o-11',
        controller: 'P1',
        name: 'Forest',
        tapped: true,
        typeLine: 'Basic Land — Forest',
        status: [],
      },
      {
        id: 'o-12',
        controller: 'P1',
        name: 'Mosswort Bridge',
        tapped: false,
        typeLine: 'Land',
        oracleText: BRIDGE_TEXT,
        status: [],
      },
      {
        id: 'o-13',
        controller: 'P2',
        name: 'Breena, the Demagogue',
        tapped: true,
        typeLine: 'Legendary Creature — Bird Warlock',
        keywords: ['flying'],
        power: 3,
        toughness: 3,
        oracleText: BREENA_TEXT,
        status: [],
      },
      {
        id: 'o-14',
        controller: 'P3',
        name: 'Plains',
        tapped: false,
        typeLine: 'Basic Land — Plains',
        status: [],
      },
    ],
    stack: [],
    recentLog: [
      'T6 -- phaseBegin phase=combat',
      'T6 P2 attack attacker=Breena, the Demagogue target=P3',
      'T7 P1 turnBegin turn=7 player=P1',
      'T7 P1 untap player=P1 count=1',
      'T7 P1 castSpell player=P1 name=Rampant Growth',
      'T7 P1 resolved description=Rampant Growth',
    ],
    ...overrides,
  } as PlayerView;
}

function strategyRequest(turn = 7): DecisionRequest {
  return {
    requestId: `g-t${turn}-P1-strategy`,
    gameId: 'g',
    turn,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'general',
    prompt: 'Create the active player turn strategy.',
    legalActions: [{ id: 0, type: 'planTurn', description: 'Return the turn strategy' }],
  };
}

const observation = (prompt: { messages: Array<{ content: string }> }): Payload =>
  JSON.parse(prompt.messages.at(-1)!.content) as Payload;

function plainPayload(view: PlayerView, turn = 7): Payload {
  return observation(
    assembleStrategistPrompt(strategyRequest(turn), view, [], 'Gruul midrange', {
      botSteering: true,
    }),
  );
}

describe('compactStrategistPayload', () => {
  it('drops ids, the action menu, turn-structure log lines and the one row per land', () => {
    const compact = compactStrategistPayload(plainPayload(makeView()));
    expect(compact).not.toHaveProperty('legalActions');
    expect(compact['ctx']).toEqual({ turn: 7, phase: 'precombatMain', step: null, ap: 'P1' });
    expect(compact['you'].hand.map((card: Payload) => card['id'])).toEqual([undefined, undefined]);
    expect(compact['you'].graveyard).toEqual(['Path to Exile']);
    expect(compact['publicExile']).toEqual(['Up the Beanstalk']);
    expect(compact['recentLog']).toEqual([
      'T6 P2 attack attacker=Breena, the Demagogue target=P3',
      'T7 P1 castSpell player=P1 name=Rampant Growth',
    ]);
    expect(compact['lands']).toEqual({
      P1: { Forest: 2, 'Mosswort Bridge': 1 },
      P3: { Plains: 1 },
    });
    expect(compact['untappedLands']).toEqual({ P1: 2, P3: 1 });
    expect(compact['landText']).toEqual({ 'Mosswort Bridge': BRIDGE_TEXT });
    expect(compact['you'].manaSources).toEqual([
      { name: 'Forest', symbols: ['G'], count: 2 },
      { name: 'Mosswort Bridge', symbols: ['G'], count: 1 },
    ]);
  });

  it('keeps every nonland permanent with its state, grouped by controller', () => {
    const compact = compactStrategistPayload(plainPayload(makeView()));
    expect(compact['battlefield']).toEqual({
      P2: [
        {
          name: 'Breena, the Demagogue',
          type: 'Legendary Creature — Bird Warlock',
          keywords: ['flying'],
          p: 3,
          t: 3,
          text: BREENA_TEXT,
          tapped: true,
        },
      ],
    });
  });

  it('loses no card name and no rules text the plain payload carries', () => {
    const plain = JSON.stringify(plainPayload(makeView()));
    const compact = JSON.stringify(compactStrategistPayload(plainPayload(makeView())));
    for (const text of [RUBY_TEXT, BREENA_TEXT, VENTMAW_TEXT, BRIDGE_TEXT]) {
      expect(plain).toContain(JSON.stringify(text).slice(1, -1));
      expect(compact).toContain(JSON.stringify(text).slice(1, -1));
    }
    for (const name of ['Savage Ventmaw', 'Mosswort Bridge', 'Plains', 'Path to Exile']) {
      expect(compact).toContain(name);
    }
    expect(compact.length).toBeLessThan(plain.length);
  });

  it('keeps a land that is also a creature, or has a status, as a full row', () => {
    const view = makeView({
      battlefield: [
        {
          id: 'o-20',
          controller: 'P1',
          name: 'Dryad Arbor',
          tapped: false,
          typeLine: 'Land Creature — Forest Dryad',
          power: 1,
          toughness: 1,
          status: ['summoningSick'],
        },
      ],
    } as Partial<PlayerView>);
    const compact = compactStrategistPayload(plainPayload(view));
    expect(compact['battlefield'].P1[0].name).toBe('Dryad Arbor');
    expect(compact['lands']).toEqual({});
  });
});

describe('applyStrategistDelta', () => {
  const steering = { aggression: 0.8, targetOrder: ['P2'] };

  it('omits rules text only for cards the seat was shown at its last plan', () => {
    const before = makeView();
    const base = deltaBaseFrom(before, 5, 'Ramp into dragons.', steering);
    const now = makeView({
      hand: [
        ...before.hand,
        {
          id: 'o-30',
          name: 'Bloodbraid Challenger',
          manaCost: '{3}{R}{G}',
          typeLine: 'Creature — Elf Berserker',
          oracleText: 'Cascade\nHaste',
        },
      ],
    });
    const payload = applyStrategistDelta(compactStrategistPayload(plainPayload(now)), now, {
      base,
      wake: ['P2 power'],
    });
    const hand = payload['you'].hand as Payload[];
    expect(hand.find((c) => c['name'] === 'Savage Ventmaw')).not.toHaveProperty('text');
    expect(hand.find((c) => c['name'] === 'Savage Ventmaw')?.['cost']).toBe('{4}{R}{G}');
    expect(hand.find((c) => c['name'] === 'Bloodbraid Challenger')?.['text']).toBe(
      'Cascade\nHaste',
    );
    expect(payload['battlefield'].P2[0]).not.toHaveProperty('text');
    expect(payload).not.toHaveProperty('landText');
  });

  it('omits known commander text but keeps a commander it has not seen', () => {
    const all = makeView();
    const before = makeView({
      opponents: all.opponents.slice(1),
      battlefield: all.battlefield.filter((perm) => perm.controller !== 'P2'),
    });
    const base = deltaBaseFrom(before, 5, 'x', steering);
    const now = makeView();
    const payload = applyStrategistDelta(compactStrategistPayload(plainPayload(now)), now, {
      base,
      wake: [],
    });
    expect(payload['you'].commanders[0]).not.toHaveProperty('oracleText');
    expect(payload['you'].commanders[0].manaCost).toBe('{R}{G}');
    expect(payload['opponents'][0].commanders[0].oracleText).toBe(BREENA_TEXT);
  });

  it('carries the last intent and knobs, what woke it, life swings and what left', () => {
    const before = makeView();
    const base = deltaBaseFrom(before, 5, 'Ramp into dragons.', steering);
    const now = makeView({
      life: 33,
      battlefield: before.battlefield.filter((perm) => perm.name !== 'Breena, the Demagogue'),
    });
    const payload = applyStrategistDelta(compactStrategistPayload(plainPayload(now)), now, {
      base,
      wake: ['P2 power'],
    });
    expect(payload['sinceYourLastPlan']).toEqual({
      turn: 5,
      intent: 'Ramp into dragons.',
      steering,
      tableChanges: ['P2 power'],
      lifeChanges: { P1: -7 },
      leftBattlefield: ['Breena, the Demagogue (P2)'],
    });
  });

  it("does not list an eliminated player's board as having left", () => {
    const before = makeView();
    const base = deltaBaseFrom(before, 5, 'x', steering);
    const now = makeView({ opponents: before.opponents.slice(1) });
    const payload = applyStrategistDelta(compactStrategistPayload(plainPayload(now)), now, {
      base,
      wake: ['P2 gone'],
    });
    expect(payload['sinceYourLastPlan']).not.toHaveProperty('leftBattlefield');
  });

  it('keeps only decisions from the last plan turn on', () => {
    const view = makeView();
    const payload = observation(
      assembleStrategistPrompt(
        strategyRequest(),
        view,
        [
          { turn: 3, phase: 'precombatMain', action: 'Play Forest' },
          { turn: 5, phase: 'precombatMain', action: 'Cast Rampant Growth' },
          { turn: 7, phase: 'beginning', action: 'Keep' },
        ],
        'Gruul midrange',
        { botSteering: true, delta: { base: deltaBaseFrom(view, 5, 'x', steering), wake: [] } },
      ),
    );
    expect(payload['yourRecentDecisions'].map((d: Payload) => d['turn'])).toEqual([5, 7]);
  });
});

describe('assembleStrategistPrompt with delta prompts', () => {
  it('is unchanged when delta prompts are off', () => {
    const view = makeView();
    const a = assembleStrategistPrompt(strategyRequest(), view, [], 'Gruul', { botSteering: true });
    const b = assembleStrategistPrompt(strategyRequest(), view, [], 'Gruul', {
      botSteering: true,
      tacticianFlag: false,
    });
    expect(b).toEqual(a);
    expect(a.messages[0]!.content).not.toContain('sinceYourLastPlan');
    expect(observation(a)).toHaveProperty('legalActions');
  });

  it('never applies to model-led tactics', () => {
    const view = makeView();
    const plain = assembleStrategistPrompt(strategyRequest(), view, [], 'Gruul');
    const flagged = assembleStrategistPrompt(strategyRequest(), view, [], 'Gruul', {
      delta: { base: deltaBaseFrom(view, 5, 'x', {}), wake: [] },
    });
    expect(flagged).toEqual(plain);
  });

  it('uses one primer for full and delta prompts, so the cached prefix is shared', () => {
    const view = makeView();
    const full = assembleStrategistPrompt(strategyRequest(), view, [], 'Gruul', {
      botSteering: true,
      delta: true,
    });
    const delta = assembleStrategistPrompt(strategyRequest(), view, [], 'Gruul', {
      botSteering: true,
      delta: { base: deltaBaseFrom(view, 5, 'x', {}), wake: [] },
    });
    expect(full.messages[0]!.content.endsWith(STRATEGIST_DELTA_PRIMER_TEXT)).toBe(true);
    expect(delta.messages[0]).toEqual(full.messages[0]);
    expect(observation(full)).not.toHaveProperty('sinceYourLastPlan');
    expect(observation(delta)).toHaveProperty('sinceYourLastPlan');
    expect(delta.estimatedTokens).toBeLessThan(full.estimatedTokens);
  });
});

describe('StrategyCoordinator with delta prompts', () => {
  function client(): AiClient {
    return {
      activeModel: 'm',
      requestDecision: vi.fn().mockImplementation(async () => ({
        response: {
          requestId: 'strategy',
          actionId: 0,
          turnStrategy: { intent: 'Pressure P2.', steering: { aggression: 0.9 } },
        },
        meta: {
          model: 'm',
          promptTokens: 1,
          responseTokens: 1,
          latencyMs: 1,
          wasRetry: false,
          wasFallback: false,
          rawResponse: '{}',
        },
      })),
    };
  }

  /** Plans P1's turns 1, 5, 9, ... with `everyTurn`, so every one of them is a call. */
  async function prompts(config: Partial<typeof DEFAULT_AI_CONFIG>, calls: number) {
    const strategist = client();
    const engine = { view: vi.fn(() => makeView()), addDebug: vi.fn() } as unknown as Engine;
    const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() };
    const coordinator = new StrategyCoordinator(
      strategist,
      queue,
      engine,
      {
        ...DEFAULT_AI_CONFIG,
        tacticalMode: 'bot',
        strategistReplan: 'everyTurn',
        ...config,
      },
      undefined,
      undefined,
      new Map([['P1', 'Gruul midrange']]),
    );
    for (let call = 0; call < calls; call++) {
      coordinator.prepare({ ...strategyRequest(1 + call * 4), decisionType: 'priority' });
      await coordinator.settled();
    }
    const sent = vi
      .mocked(strategist.requestDecision)
      .mock.calls.map((args) => args[0] as { messages: Array<{ content: string }> });
    return { sent, stats: coordinator.strategistStats };
  }

  it('is off by default, and the env switch turns it on', () => {
    expect(DEFAULT_AI_CONFIG.strategistDeltaEnabled).toBe(false);
    expect(DEFAULT_AI_CONFIG.strategistDeltaRefreshEvery).toBe(3);
    const config = loadAiConfig({
      AI_STRATEGIST_DELTA_ENABLED: 'true',
      AI_STRATEGIST_DELTA_REFRESH: '5',
    });
    expect(config.strategistDeltaEnabled).toBe(true);
    expect(config.strategistDeltaRefreshEvery).toBe(5);
  });

  it('sends a full prompt first, then deltas, then a full one after refreshEvery deltas', async () => {
    const { sent, stats } = await prompts({ strategistDeltaEnabled: true }, 6);
    const kinds = sent.map((prompt) =>
      observation(prompt)['sinceYourLastPlan'] === undefined ? 'full' : 'delta',
    );
    expect(kinds).toEqual(['full', 'delta', 'delta', 'delta', 'full', 'delta']);
    expect(stats.delta).toBe(4);
    const second = observation(sent[1]!);
    expect(second['sinceYourLastPlan']).toMatchObject({
      turn: 1,
      intent: 'Pressure P2.',
      steering: { aggression: 0.9 },
    });
    // The refresh prompt carries the rules text again.
    expect(JSON.stringify(observation(sent[4]!))).toContain('Hideaway 4');
    expect(JSON.stringify(second)).not.toContain('Hideaway 4');
  });

  it('keeps one cacheable prefix for full and delta prompts', async () => {
    const { sent } = await prompts(
      { strategistDeltaEnabled: true, providerPromptCacheLayoutEnabled: true },
      2,
    );
    expect(sent[1]!.messages.slice(0, -1)).toEqual(sent[0]!.messages.slice(0, -1));
    const prefix = JSON.parse(sent[0]!.messages[1]!.content);
    expect(prefix.immutableContext).not.toHaveProperty('commanderDefinitions');
    expect(prefix.immutableContext.yourStrategyProfile.archetype).toBe('Gruul midrange');
  });

  it('leaves every prompt as it was when off', async () => {
    const off = await prompts({}, 3);
    const explicit = await prompts({ strategistDeltaEnabled: false }, 3);
    expect(explicit.sent).toEqual(off.sent);
    for (const prompt of off.sent)
      expect(observation(prompt)).not.toHaveProperty('sinceYourLastPlan');
    expect(off.stats.delta).toBe(0);
  });

  it('does nothing in model-led tactics', async () => {
    const plain = await prompts({ tacticalMode: 'model' }, 2);
    const flagged = await prompts({ tacticalMode: 'model', strategistDeltaEnabled: true }, 2);
    expect(flagged.sent).toEqual(plain.sent);
  });

  it('never sends a delta with refreshEvery 0', async () => {
    const { stats } = await prompts(
      { strategistDeltaEnabled: true, strategistDeltaRefreshEvery: 0 },
      3,
    );
    expect(stats.delta).toBe(0);
  });
});
