/**
 * Token and counter doubling as CR 616 replacements — Doubling Season, Parallel Lives,
 * Hardened Scales (the EDH-staple coverage plan's Tier 2 item 7).
 *
 * `damageDoubled` was already the precedent: a replacement effect is a `RuleStatic`, not a
 * layer op, because there is no permanent whose characteristics change — the EVENT is what gets
 * replaced. These two are the same shape over token creation and counter placement.
 *
 * Applied inside `createToken` and `addCounters` rather than at each of their ~40 call sites,
 * which is the only way "twice that many" holds for every effect that has ever created a token,
 * including ones written before these cards existed.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { createToken } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const doublingSeason = (): OracleCard =>
  oracle({
    name: 'Test Doubling Season',
    typeLine: 'Enchantment',
    manaCost: '{4}{G}',
    colors: ['G'],
    colorIdentity: ['G'],
    power: null,
    toughness: null,
    oracleText:
      'If you would create one or more tokens, create twice that many of those tokens instead.\nIf you would put one or more counters on a permanent you control, put twice that many of those counters on it instead.',
  });

const hardenedScales = (): OracleCard =>
  oracle({
    name: 'Test Hardened Scales',
    typeLine: 'Enchantment',
    manaCost: '{G}',
    colors: ['G'],
    colorIdentity: ['G'],
    power: null,
    toughness: null,
    oracleText:
      'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
  });

const SAPROLING = {
  name: 'Saproling',
  typeLine: 'Creature — Saproling',
  types: ['Creature'],
  subtypes: ['Saproling'],
  colors: ['G' as const],
  power: 1,
  toughness: 1,
};

function pod(seed = 'doubling'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(6, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const tokensOf = (ctx: GameContext, controllerId: string, name: string): number =>
  ctx.state.battlefield.filter((p) => p.controllerId === controllerId && p.name === name).length;

describe('token doubling', () => {
  it('parses both halves of Doubling Season as rule statics', () => {
    const def = interpretCard(doublingSeason());

    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toEqual([
      { kind: 'tokensMultiplied', factor: 2 },
      { kind: 'countersMultiplied', factor: 2, subject: { kind: 'controller', who: 'you' } },
    ]);
  });

  it('creates two tokens where an effect asks for one', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());

    createToken(ctx, SAPROLING, 'P1');

    expect(tokensOf(ctx, 'P1', 'Saproling')).toBe(2);
  });

  it('doubles every token of a multi-token effect', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());

    pump(
      executeAbility(
        ctx,
        { cardId: 'src-1', name: 'Test Token Maker', oracleId: 'o-maker', controllerId: 'P1' },
        { kind: 'spell', targets: [], effects: [{ op: 'createToken', spec: SAPROLING, count: { kind: 'const', n: 3 } }] },
        [],
      ),
    );

    expect(tokensOf(ctx, 'P1', 'Saproling')).toBe(6);
  });

  it('quadruples under two Doubling Seasons (CR 616.1 — apply one, then the other)', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());
    spawn(ctx, 'P1', oracle({ ...doublingSeason(), oracleId: 'oracle-doubling-season-2' }));

    createToken(ctx, SAPROLING, 'P1');

    expect(tokensOf(ctx, 'P1', 'Saproling')).toBe(4);
  });

  it('does not double an opponent’s tokens', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());

    createToken(ctx, SAPROLING, 'P2');

    expect(tokensOf(ctx, 'P2', 'Saproling')).toBe(1);
  });

  it('stops doubling once the enchantment leaves', () => {
    const ctx = pod();
    const season = spawn(ctx, 'P1', doublingSeason());

    createToken(ctx, SAPROLING, 'P1');
    ctx.state.battlefield = ctx.state.battlefield.filter((p) => p.id !== season.id);
    createToken(ctx, SAPROLING, 'P1');

    expect(tokensOf(ctx, 'P1', 'Saproling')).toBe(3); // two, then one
  });
});

describe('counter doubling', () => {
  const putCounters = (ctx: GameContext, targetId: string, count: number): void => {
    pump(
      executeAbility(
        ctx,
        { cardId: 'src-1', name: 'Test Counter Source', oracleId: 'o-counters', controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'putCounters', target: 0, counter: '+1/+1', count }],
        },
        [targetId],
      ),
    );
  };

  it('doubles counters on a permanent you control', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());
    const bear = spawn(ctx, 'P1', oracle({ name: 'Test Bear', typeLine: 'Creature — Bear' }));

    putCounters(ctx, bear.id, 2);

    expect(bear.counters['+1/+1']).toBe(4);
  });

  it('adds one under Hardened Scales, and only to +1/+1 counters', () => {
    const ctx = pod();
    spawn(ctx, 'P1', hardenedScales());
    const bear = spawn(ctx, 'P1', oracle({ name: 'Test Bear', typeLine: 'Creature — Bear' }));

    putCounters(ctx, bear.id, 2);
    expect(bear.counters['+1/+1']).toBe(3);

    pump(
      executeAbility(
        ctx,
        { cardId: 'src-2', name: 'Test Charge Source', oracleId: 'o-charge', controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 2 }],
        },
        [bear.id],
      ),
    );
    expect(bear.counters['charge']).toBe(2); // a different counter kind is untouched
  });

  it('multiplies before adding when both are out', () => {
    // Doubling Season and Hardened Scales together put 2n + 1, not 2(n + 1).
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());
    spawn(ctx, 'P1', hardenedScales());
    const bear = spawn(ctx, 'P1', oracle({ name: 'Test Bear', typeLine: 'Creature — Bear' }));

    putCounters(ctx, bear.id, 3);

    expect(bear.counters['+1/+1']).toBe(7);
  });

  it('does not touch counters on a permanent you do not control', () => {
    const ctx = pod();
    spawn(ctx, 'P1', doublingSeason());
    const theirs = spawn(ctx, 'P2', oracle({ name: 'Test Rival Bear', typeLine: 'Creature — Bear' }));

    putCounters(ctx, theirs.id, 2);

    expect(theirs.counters['+1/+1']).toBe(2);
  });
});
