import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { queueSpellCopy } from '../src/stack/copy';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { createToken } from '../src/state/objects';
import { TREASURE } from '../src/cards/tokens';
import { manaCost } from '../src/cards/templates';
import { resolveTopOfStack } from '../src/stack/stack';
import { cloneContractContext } from './helpers/contract-harness';

function setup() {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 3;
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Divided copy probe',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      colors: ['R'],
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  ctx.defs.set(card.oracleId, {
    ...ctx.defs.get(card.oracleId)!,
    spellAbility: {
      kind: 'spell',
      targets: [{ kind: 'creature', count: { min: 2, max: 2 } }],
      effects: [{ op: 'dealDamageDivided', targetSlot: 0, total: { kind: 'const', n: 3 } }],
    },
  });
  for (const name of ['First copy target', 'Second copy target'])
    spawn(ctx, 'P2', oracle({ name, typeLine: 'Creature', power: '5', toughness: '5' }));
  pump(
    applyPriorityAction(
      ctx,
      player,
      { kind: 'castSpell', objectId: card.id, fromCommand: false },
      { index: 0, targets: new Map() },
    ),
  );
  return { ctx, original: ctx.state.stack[0]! };
}

describe('independent spell copy object contract', () => {
  it('preserves announced counted targets and division without sharing mutable selections', () => {
    const { ctx, original } = setup();
    const events = [...ctx.state.eventLog];
    const copy = queueSpellCopy(ctx, original, 'P2');
    expect(copy.card).toBeNull();
    expect(copy.controllerId).toBe('P2');
    expect(copy.sourceId).toBe(copy.id);
    expect(copy.sourceCardId).toBe(copy.id);
    expect(copy.sourceOracleId).toBe(original.sourceOracleId);
    expect(copy.spellDefinition).toBe(original.spellDefinition);
    expect(copy.countTargets).toEqual(original.countTargets);
    expect(copy.divisionAmounts).toEqual(original.divisionAmounts);
    expect(copy.countTargets![0]).toHaveLength(2);
    expect(Object.values(copy.divisionAmounts!).sort()).toEqual([1, 2]);
    expect(copy.countTargets![0]).not.toBe(original.countTargets![0]);
    expect(copy.divisionAmounts).not.toBe(original.divisionAmounts);
    copy.countTargets![0]!.pop();
    copy.divisionAmounts![original.countTargets![0]![0]!] = 99;
    expect(original.countTargets![0]).toHaveLength(2);
    expect(Object.values(original.divisionAmounts!).sort()).toEqual([1, 2]);
    expect(ctx.state.eventLog).toEqual(events);
  });

  it.each([
    'activatedAbility',
    'triggeredAbility',
    'tentative',
    'noAbility',
    'wrongAbility',
    'missingDefinition',
  ])('rejects %s without allocating, mutating state, or advancing RNG', (variant) => {
    const { ctx, original } = setup();
    if (variant === 'activatedAbility' || variant === 'triggeredAbility') original.kind = variant;
    if (variant === 'tentative') original.castInProgress = true;
    if (variant === 'noAbility') original.ability = null;
    if (variant === 'wrongAbility')
      original.ability = { kind: 'activated', targets: [], effects: [] };
    if (variant === 'missingDefinition') {
      delete original.spellDefinition;
      ctx.defs.delete(original.sourceOracleId);
    }
    const before = cloneContractContext(ctx);
    expect(() => queueSpellCopy(ctx, original, 'P2')).toThrow();
    expect(ctx.state).toEqual(before.state);
    expect(ctx.debugLog).toEqual(before.debugLog);
    expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
  });
});

it('a normal spell copy preserves choices while resolving with zero mana spent to cast it', () => {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 3;
  const card = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Independent spent-mana spell',
      typeLine: 'Sorcery',
      manaCost: '{X}{G}',
      oracleText: 'You gain 1 life.',
    }),
    'hand',
  );
  const definition = {
    ...ctx.defs.get(card.oracleId)!,
    optionalAdditionalCost: { mechanic: 'kicker' as const, cost: manaCost('{1}') },
    spellAbility: {
      kind: 'spell' as const,
      targets: [],
      effects: [
        { op: 'gainLife' as const, amount: { kind: 'manaSpent' as const } },
        { op: 'gainLife' as const, amount: { kind: 'treasureManaSpent' as const } },
      ],
    },
  };
  ctx.defs.set(card.oracleId, definition);
  spawn(ctx, 'P1', forest());
  createToken(ctx, TREASURE, 'P1');
  createToken(ctx, TREASURE, 'P1');
  pump(
    applyPriorityAction(
      ctx,
      player,
      { kind: 'castSpell', objectId: card.id, fromCommand: false, x: 1, optionalCostCount: 1 },
      { index: 0, targets: new Map() },
    ),
  );
  const original = ctx.state.stack[0]!;
  expect(original.triggerScope).toMatchObject({ manaSpent: 3, treasureManaSpent: 2 });
  const copy = queueSpellCopy(ctx, original, 'P1');
  expect(copy.announcedX).toBe(1);
  expect(copy.optionalCostCounts).toEqual({ kicker: 1 });
  const life = player.life;
  pump(resolveTopOfStack(ctx));
  expect(player.life).toBe(life);
  expect(original.triggerScope).toMatchObject({ manaSpent: 3, treasureManaSpent: 2 });
  pump(resolveTopOfStack(ctx));
  expect(player.life).toBe(life + 5);
});
