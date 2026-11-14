/**
 * The provisional trust tier (H1): a machine-checked patch from the review queue may play only in
 * a game that opts in, never shadows reviewed behavior, and is visible wherever a person or a
 * report can see the card.
 */

import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { interpretProvisional, type ProvisionalPatch } from '../src/cards/provisional';
import { getOverride } from '../src/cards/overrides/index';
import { Engine } from '../src/engine';
import { RandomDecisionProvider } from '../src/providers/providers';
import { EngineUsageError } from '../src/errors';
import { createGame } from '../src/state/game';
import { provisionalUseOf, stampProvisional } from '../src/state/provisional-use';
import { buildSpectatorState, formatSpectatorLog } from '../src/view/spectator';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

/** A line the grammar cannot read, so the card is unmodeled without its patch. */
const ODD_LINE = '{T}: Each opponent loses 1 life and you gain 1 life, then hum a tune.';

const oddity = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Provisional Oddity',
    typeLine: 'Artifact',
    manaCost: '{2}',
    power: null,
    toughness: null,
    oracleText: ODD_LINE,
  });

/** The line exactly as the interpreter reports it, which is what `handledLines` must hold. */
function reportedLine(): string {
  const reason = interpretCard(oddity()).unmodeledReasons.find((r) => r.includes('hum a tune'));
  const quoted = reason === undefined ? null : /"([\s\S]*)"$/.exec(reason);
  if (quoted === null) throw new Error(`unexpected reasons: ${String(reason)}`);
  return quoted[1] as string;
}

function patch(overrides: Partial<ProvisionalPatch> = {}): ProvisionalPatch {
  return {
    handledLines: [reportedLine()],
    source: 'compiler@test',
    def: {
      activatedAbilities: [
        {
          costs: [{ kind: 'tap' }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              { op: 'eachOpponentLosesLife', amount: 1 },
              { op: 'gainLife', amount: { kind: 'const', n: 1 } },
            ],
            description: ODD_LINE,
          },
        },
      ],
    } as ProvisionalPatch['def'],
    ...overrides,
  };
}

function provisionalDef() {
  const result = interpretProvisional(oddity(), patch());
  if (!result.ok) throw new Error(`patch rejected: ${result.kind} ${result.issues.join('; ')}`);
  return result.definition;
}

describe('interpretProvisional', () => {
  it('builds a modeled definition marked provisional, and leaves the registry as it was', () => {
    expect(interpretCard(oddity()).modeled).toBe(false);
    const def = provisionalDef();
    expect(def.modeled).toBe(true);
    expect(def.trust).toBe('provisional');
    expect(def.trustSource).toBe('compiler@test');
    expect(def.activatedAbilities).toHaveLength(1);
    // Nothing stays registered: every other caller still sees the card as unmodeled.
    expect(getOverride(oddity().oracleId)).toBeUndefined();
    expect(interpretCard(oddity()).modeled).toBe(false);
  });

  it('skips a card the interpreter already models, so a patch cannot double an ability', () => {
    const plain = oracle({ name: 'Test Plain Rock', typeLine: 'Artifact', manaCost: '{1}' });
    const result = interpretProvisional(plain, patch());
    expect(result).toMatchObject({ ok: false, kind: 'modeled' });
  });

  it('refuses a patch that sets identity or trust fields', () => {
    for (const field of ['name', 'trust']) {
      const bad = patch({ def: { ...patch().def, [field]: 'x' } as ProvisionalPatch['def'] });
      expect(interpretProvisional(oddity(), bad)).toMatchObject({ ok: false, kind: 'invalid' });
    }
  });

  it('reports a malformed patch object instead of throwing', () => {
    const shapes: unknown[] = [
      null,
      [],
      { ...patch(), def: null },
      { ...patch(), def: [] },
      { ...patch(), handledLines: 'a line' },
      { ...patch(), handledLines: [1] },
      { ...patch(), source: undefined },
    ];
    for (const shape of shapes)
      expect(interpretProvisional(oddity(), shape as ProvisionalPatch)).toMatchObject({
        ok: false,
        kind: 'invalid',
      });
  });

  it('reports malformed IR instead of throwing', () => {
    const bad = patch({
      def: {
        activatedAbilities: [
          {
            costs: [{ kind: 'tap' }],
            timing: 'any',
            ability: { kind: 'activated', targets: [], effects: [{ op: 'noSuchOp' }] },
          },
        ],
      } as unknown as ProvisionalPatch['def'],
    });
    expect(interpretProvisional(oddity(), bad).ok).toBe(false);
  });

  it('reports a patch whose handled lines no longer match the card', () => {
    const stale = patch({ handledLines: ['{T}: Some other line.'] });
    expect(interpretProvisional(oddity(), stale)).toMatchObject({ ok: false });
  });
});

describe('the game opt-in', () => {
  const seats = () => [{ cards: [...copies(8, forest), oddity()] }, { cards: copies(9, forest) }];

  it('refuses provisional definitions unless allowProvisional is set', () => {
    expect(() =>
      createGame(gameConfig(seats(), { provisionalDefinitions: [provisionalDef()] })),
    ).toThrow(EngineUsageError);
  });

  it('refuses a definition passed as provisional that is not marked so', () => {
    const { trust: _trust, ...unmarked } = provisionalDef();
    expect(() =>
      createGame(
        gameConfig(seats(), { allowProvisional: true, provisionalDefinitions: [unmarked] }),
      ),
    ).toThrow(EngineUsageError);
  });

  it('leaves a game that does not opt in exactly as before', () => {
    const ctx = createGame(gameConfig(seats()));
    expect(ctx.defs.get(oddity().oracleId)?.modeled).toBe(false);
    expect(ctx.state.provisionalAnnounced).toBeUndefined();
  });

  it('plays the card, logs its first use once, marks it in views and stamps the result', () => {
    const ctx = createGame(
      gameConfig(seats(), { allowProvisional: true, provisionalDefinitions: [provisionalDef()] }),
    );
    expect(ctx.defs.get(oddity().oracleId)?.trust).toBe('provisional');
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.turnNumber = 3;
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    const perm = spawn(ctx, 'P1', oddity());
    const p1 = ctx.state.players[0]!;

    const activate = (): void => {
      const option = computePriorityOptions(ctx, p1).find(
        (o) =>
          o.type === 'activateAbility' && (o.payload as { objectId?: string }).objectId === perm.id,
      );
      expect(option, 'the provisional ability is offered').toBeDefined();
      pump(
        applyPriorityAction(
          ctx,
          p1,
          option!.payload as PriorityActionPayload,
          {
            index: 0,
            targets: new Map(),
          } as never,
        ),
      );
    };
    const before = ctx.state.eventLog.length;
    activate();
    // Announced after the action took effect: the line closes the activation's own events.
    const firstUse = ctx.state.eventLog.slice(before);
    expect(firstUse.length).toBeGreaterThan(1);
    expect(firstUse.at(-1)?.type).toBe('provisionalCardUsed');
    perm.tapped = false;
    activate();

    const used = ctx.state.eventLog.filter((e) => e.type === 'provisionalCardUsed');
    expect(used).toHaveLength(1);
    expect(used[0]!.payload).toMatchObject({
      name: 'Test Provisional Oddity',
      source: 'compiler@test',
    });
    expect(formatSpectatorLog(used)[0]?.text).toMatch(/provisional/);

    const board = buildSpectatorState(ctx).battlefield.find((p) => p.id === perm.id);
    expect(board?.provisional).toBe(true);
    const forestView = buildSpectatorState(ctx).battlefield.find((p) => p.name === 'Forest');
    expect(forestView === undefined || forestView.provisional === undefined).toBe(true);

    const stamped = stampProvisional(ctx, {
      gameId: 'g',
      winnerSeat: null,
      finishingOrder: [],
      turnCount: 3,
      halted: false,
      haltReason: null,
    });
    expect(stamped.provisionalCards).toEqual(['Test Provisional Oddity']);
  });

  it('keeps a face-down provisional permanent anonymous until it is turned face up', () => {
    const ctx = createGame(
      gameConfig(seats(), { allowProvisional: true, provisionalDefinitions: [provisionalDef()] }),
    );
    const perm = spawn(ctx, 'P1', oddity());
    perm.faceDown = true;
    const activate = { kind: 'activateAbility', objectId: perm.id, index: 0 } as const;
    expect(provisionalUseOf(ctx, activate)).toBeNull();
    expect(provisionalUseOf(ctx, { kind: 'turnFaceUp', objectId: perm.id })).toMatchObject({
      name: 'Test Provisional Oddity',
    });
    expect(buildSpectatorState(ctx).battlefield.find((p) => p.id === perm.id)?.provisional).toBe(
      true,
    );
  });

  it('stamps the result a driven game returns', () => {
    const engine = new Engine(
      gameConfig(seats(), {
        allowProvisional: true,
        provisionalDefinitions: [provisionalDef()],
        turnCap: 1,
      }),
    );
    const provider = new RandomDecisionProvider('provisional');
    let step = engine.advance();
    for (let i = 0; i < 2000 && step.kind !== 'gameOver'; i++) {
      if (step.kind === 'decision') engine.submit(provider.decide(step.request));
      step = engine.advance();
    }
    expect(step.kind).toBe('gameOver');
    if (step.kind === 'gameOver')
      expect(step.result.provisionalCards).toEqual(['Test Provisional Oddity']);
  });
});
