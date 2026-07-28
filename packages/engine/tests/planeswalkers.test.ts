import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { parseManaCost, planPayment } from '../src/mana/cost';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { queueTriggersForEvent } from '../src/state/objects';
import { priorityCheckpoint } from '../src/sba/sba';

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
