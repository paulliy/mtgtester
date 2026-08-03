import { describe, expect, it } from 'vitest';
import { executeAbility, payAbilityCosts } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { evaluateValueIn } from '../src/effects/values';
import { selectMatches, powerAtMost, HAS_ANY_COUNTER } from '../src/cards/selector';

function setupGame() {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) })), { seed: 'batch2-test' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Batch 2 engine primitives', () => {
  it('putCountersEachChosen puts counters on chosen targets', () => {
    const ctx = setupGame();
    const c1 = spawn(ctx, 'P1', oracle({ name: 'Bear 1', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' }));
    const c2 = spawn(ctx, 'P1', oracle({ name: 'Bear 2', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' }));
    const source = spawn(ctx, 'P1', oracle({ name: 'Rishkar', typeLine: 'Creature — Elf', manaCost: '{2}{G}' }));

    pump(
      executeAbility(
        ctx,
        { cardId: source.cardId, name: source.name, oracleId: source.oracleId, controllerId: source.controllerId },
        {
          kind: 'activated',
          targets: [{ kind: 'creature', count: { min: 0, max: 2 } }],
          effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
          description: 'Put counter on chosen',
        },
        [],
        undefined,
        undefined,
        { 0: [c1.id, c2.id] },
      ),
    );

    expect(c1.counters['+1/+1']).toBe(1);
    expect(c2.counters['+1/+1']).toBe(1);
  });

  it('exileEachChosen exiles chosen targets', () => {
    const ctx = setupGame();
    const a1 = spawn(ctx, 'P2', oracle({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}' }));
    const a2 = spawn(ctx, 'P2', oracle({ name: 'Sylvan Library', typeLine: 'Enchantment', manaCost: '{1}{G}' }));
    const source = spawn(ctx, 'P1', oracle({ name: 'Sylvan Rec', typeLine: 'Instant', manaCost: '{3}{G}{W}' }));

    pump(
      executeAbility(
        ctx,
        { cardId: source.cardId, name: source.name, oracleId: source.oracleId, controllerId: source.controllerId },
        {
          kind: 'spell',
          targets: [{ kind: 'artifactOrEnchantment', count: { min: 0, max: 2 } }],
          effects: [{ op: 'exileEachChosen', targetSlot: 0 }],
          description: 'Exile chosen',
        },
        [],
        undefined,
        undefined,
        { 0: [a1.id, a2.id] },
      ),
    );

    expect(ctx.state.battlefield.find((p) => p.id === a1.id)).toBeUndefined();
    expect(ctx.state.battlefield.find((p) => p.id === a2.id)).toBeUndefined();
  });

  it('selector powerAtMost and HAS_ANY_COUNTER match correctly', () => {
    const candidate1 = {
      cardId: 'c1',
      controllerId: 'P1',
      types: ['Creature'],
      supertypes: [],
      subtypes: ['Bear'],
      colors: [],
      power: 2,
      keywords: [],
      isToken: false,
      enteredThisTurn: false,
      hasAnyCounter: false,
    };
    const candidate2 = { ...candidate1, power: 3, hasAnyCounter: true };
    const source = { cardId: 's1', controllerId: 'P1' };

    expect(selectMatches(candidate1, powerAtMost(2), source)).toBe(true);
    expect(selectMatches(candidate2, powerAtMost(2), source)).toBe(false);
    expect(selectMatches(candidate1, HAS_ANY_COUNTER, source)).toBe(false);
    expect(selectMatches(candidate2, HAS_ANY_COUNTER, source)).toBe(true);
  });

  it('evaluates commanderCastCount, lifeTotal, and countOpponentsWithFewerCreatures', () => {
    const ctx = setupGame();
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    p1.commanderCastCount = { 'cmd-1': 2 };

    const castVal = evaluateValueIn(ctx, { kind: 'commanderCastCount', player: 'you' }, { controllerId: 'P1' });
    expect(castVal).toBe(2);

    const lifeVal = evaluateValueIn(ctx, { kind: 'lifeTotal', scope: 'you' }, { controllerId: 'P1' });
    expect(lifeVal).toBe(40);

    spawn(ctx, 'P1', oracle({ name: 'Bear 1', typeLine: 'Creature', manaCost: '{1}' }));
    spawn(ctx, 'P1', oracle({ name: 'Bear 2', typeLine: 'Creature', manaCost: '{1}' }));

    const oppVal = evaluateValueIn(ctx, { kind: 'countOpponentsWithFewerCreatures' }, { controllerId: 'P1' });
    expect(oppVal).toBe(1);
  });

  it('regainControlOfOwnCreatures returns stolen creatures to owners', () => {
    const ctx = setupGame();
    const c1 = spawn(ctx, 'P1', oracle({ name: 'Stolen Bear', typeLine: 'Creature', manaCost: '{1}' }));
    c1.controllerId = 'P2';

    const source = spawn(ctx, 'P1', oracle({ name: 'Trostani', typeLine: 'Creature', manaCost: '{4}' }));

    pump(
      executeAbility(
        ctx,
        { cardId: source.cardId, name: source.name, oracleId: source.oracleId, controllerId: source.controllerId },
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          targets: [],
          effects: [{ op: 'regainControlOfOwnCreatures' }],
          description: 'Regain control of own creatures',
        },
        [],
      ),
    );

    expect(c1.controllerId).toBe('P1');
  });

  it('discardHand cost discards all cards from player hand', () => {
    const ctx = setupGame();
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    p1.hand = [
      { id: 'o-100', cardId: 'h1', oracleId: 'o1', ownerId: 'P1', name: 'Card 1', typeLine: 'Instant', oracleText: '', manaCost: null, isToken: false, isCommander: false, zone: 'hand' },
      { id: 'o-101', cardId: 'h2', oracleId: 'o2', ownerId: 'P1', name: 'Card 2', typeLine: 'Sorcery', oracleText: '', manaCost: null, isToken: false, isCommander: false, zone: 'hand' },
    ];
    const source = spawn(ctx, 'P1', oracle({ name: 'Slate', typeLine: 'Artifact', manaCost: '{4}' }));

    pump(payAbilityCosts(ctx, p1, source, [{ kind: 'discardHand' }], 'tap'));
    pump(
      executeAbility(
        ctx,
        { cardId: source.cardId, name: source.name, oracleId: source.oracleId, controllerId: source.controllerId },
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
          description: 'Draw a card',
        },
        [],
      ),
    );

    expect(p1.hand).toHaveLength(1); // 1 drawn after discarding 2
    expect(p1.graveyard).toHaveLength(2);
  });
});
