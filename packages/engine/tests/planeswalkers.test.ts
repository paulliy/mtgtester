import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { parseManaCost, planPayment } from '../src/mana/cost';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { queueTriggersForEvent } from '../src/state/objects';
import { priorityCheckpoint } from '../src/sba/sba';
import { runPrioritySequence } from '../src/turn/priority';

const kiora = () =>
  oracle({
    name: 'Kiora, Behemoth Beckoner',
    manaCost: '{2}{G/U}',
    cmc: 3,
    colors: ['G', 'U'],
    colorIdentity: ['G', 'U'],
    typeLine: 'Legendary Planeswalker — Kiora',
    loyalty: '7',
    oracleText:
      'Whenever a creature you control with power 4 or greater enters, draw a card.\n−1: Untap target permanent.',
  });

const sivitri = () =>
  oracle({
    name: 'Sivitri, Dragon Master',
    manaCost: '{2}{U}{B}',
    cmc: 4,
    colors: ['B', 'U'],
    colorIdentity: ['B', 'U'],
    typeLine: 'Legendary Planeswalker — Sivitri',
    loyalty: '4',
    oracleText:
      "+1: Until your next turn, creatures can't attack you or planeswalkers you control unless their controller pays 2 life for each of those creatures.\n−3: Search your library for a Dragon card, reveal it, put it into your hand, then shuffle.\n−7: Destroy all non-Dragon creatures.\nSivitri, Dragon Master can be your commander.",
  });

function pod(seed = 'planeswalkers-test'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Increment 17: Planeswalkers & Hybrid Mana', () => {
  it('correctly models Kiora and Sivitri', () => {
    expect(interpretCard(kiora()).modeled).toBe(true);
    expect(interpretCard(sivitri()).modeled).toBe(true);
  });

  it('parses hybrid cost {2}{G/U} and allows payment with G or U', () => {
    const cost = parseManaCost('{2}{G/U}').cost!;
    expect(cost.generic).toBe(2);
    expect(cost.hybrid).toEqual([['G', 'U']]);

    // Test payment with 2 generic (from Forest) + 1 G
    const planG = planPayment(
      cost,
      [],
      [
        { cardId: 'f1', units: [['G']], costs: [{ kind: 'tap' }] },
        { cardId: 'f2', units: [['G']], costs: [{ kind: 'tap' }] },
        { cardId: 'f3', units: [['G']], costs: [{ kind: 'tap' }] },
      ],
    );
    expect(planG).not.toBeNull();

    // Test payment with 2 generic + 1 U
    const planU = planPayment(
      cost,
      [],
      [
        { cardId: 'f1', units: [['G']], costs: [{ kind: 'tap' }] },
        { cardId: 'f2', units: [['G']], costs: [{ kind: 'tap' }] },
        { cardId: 'island', units: [['U']], costs: [{ kind: 'tap' }] },
      ],
    );
    expect(planU).not.toBeNull();
  });

  it('spawns Planeswalker with printed loyalty counters and triggers 0-loyalty death SBA', () => {
    const ctx = pod();
    const pw = spawn(ctx, 'P1', kiora());
    expect(pw.counters['loyalty']).toBe(7);

    // Reduce loyalty to 0
    pw.counters['loyalty'] = 0;
    const { value: ranSba } = pump(priorityCheckpoint(ctx));
    expect(ranSba).toBe(true);
    expect(ctx.state.battlefield.find((p) => p.id === pw.id)).toBeUndefined();
  });

  it('Kiora triggers draw on creature with power >= 4 entering', () => {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;
    const kioraPerm = spawn(ctx, 'P1', kiora());

    const bigCreature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Big Beast', typeLine: 'Creature — Beast', power: '4', toughness: '4' }),
    );

    queueTriggersForEvent(ctx, 'enters', [{ permanent: bigCreature }]);

    expect(ctx.state.pendingTriggers.length).toBe(1);
    const initialHandCount = p1.hand.length;

    const pending = ctx.state.pendingTriggers.pop()!;
    pump(
      executeAbility(
        ctx,
        { cardId: kioraPerm.cardId, name: kioraPerm.name, oracleId: kioraPerm.oracleId, controllerId: 'P1' },
        pending.ability,
        [],
      ),
    );

    expect(p1.hand.length).toBe(initialHandCount + 1);
  });
});

const p1Of = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

describe('CR 606.3: loyalty ability activation is once per PERMANENT per turn', () => {
  it('activating one loyalty ability takes every other loyalty ability of that planeswalker off the table too', () => {
    const ctx = pod();
    spawn(ctx, 'P1', sivitri());

    const before = computePriorityOptions(ctx, p1Of(ctx));
    expect(before.some((o) => o.description.startsWith('Sivitri, Dragon Master: +1:'))).toBe(true);
    expect(before.some((o) => o.description.startsWith('Sivitri, Dragon Master: −3:'))).toBe(true);

    let activated = false;
    pump(runPrioritySequence(ctx), (d) => {
      const i = !activated ? d.options.findIndex((o) => o.description.includes('+1:')) : -1;
      if (i >= 0) {
        activated = true;
        return { index: i, targets: new Map() };
      }
      return { index: 0, targets: new Map() }; // Pass priority
    });

    const after = computePriorityOptions(ctx, p1Of(ctx));
    expect(after.some((o) => o.description.startsWith('Sivitri, Dragon Master: +1:'))).toBe(false);
    // Not just the ability that was used — CR 606.3 blocks the *permanent's* other loyalty
    // abilities too, since only one loyalty ability activation is allowed per planeswalker
    // per turn, regardless of which ability.
    expect(after.some((o) => o.description.startsWith('Sivitri, Dragon Master: −3:'))).toBe(false);
  });

  // Real card, real oracleId — hits the hand-authored override registered in
  // overrides/token-triumph.ts, whose activated abilities omitted `oncePerTurn: true`. The
  // once-per-turn restriction on loyalty abilities comes from CR 606.3 itself (any ability
  // costing loyalty), not from that flag, so legality no longer depends on every override
  // remembering to set it.
  it("Ajani, Caller of the Pride's +1 can only be activated once per turn even though the override never set oncePerTurn", () => {
    const ctx = pod();
    const ajaniPerm = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Ajani, Caller of the Pride',
        oracleId: '1d5ff280-7f4d-4801-aefd-9b6e6b1f2818',
        manaCost: '{2}{W}{W}',
        cmc: 4,
        colors: ['W'],
        colorIdentity: ['W'],
        typeLine: 'Legendary Planeswalker — Ajani',
        loyalty: '3',
      }),
    );
    const creature = spawn(ctx, 'P1', oracle({ name: 'Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }));

    const before = computePriorityOptions(ctx, p1Of(ctx));
    expect(before.some((o) => o.description.includes('+1/+1 counter'))).toBe(true);

    let activated = false;
    pump(runPrioritySequence(ctx), (d) => {
      const i = !activated ? d.options.findIndex((o) => o.description.includes('+1/+1 counter')) : -1;
      if (i >= 0) {
        activated = true;
        return { index: i, targets: new Map([[0, creature.id]]) };
      }
      return { index: 0, targets: new Map() };
    });

    expect(ajaniPerm.counters['loyalty']).toBe(4);
    const after = computePriorityOptions(ctx, p1Of(ctx));
    expect(after.some((o) => o.description.includes('+1/+1 counter'))).toBe(false);
  });
});
