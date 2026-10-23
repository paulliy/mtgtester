import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import type { PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, declareAttacks, oracle, pump, spawn } from './fixtures';
import {
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  nextTurnOf,
  pinned,
  player,
  resolve,
} from './pr11-helpers';

const MILA = pinned('Mila, Crafty Companion // Lukka, Wayward Bonder');
const shock = () =>
  oracle({
    name: 'Test Shock',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Test Shock deals 2 damage to any target.',
  });
const walker = () =>
  oracle({
    name: 'Test Walker',
    typeLine: 'Legendary Planeswalker — Test',
    manaCost: '{3}',
    oracleText: '',
    loyalty: '3',
  });

const answer =
  (type: string) =>
  (decision: PendingDecision): { index: number; targets: Map<number, string> } => ({
    index: Math.max(
      0,
      decision.options.findIndex((option) => option.type === type),
    ),
    targets: new Map(),
  });

/** P2 attacks with `attacker` at `defender` (a player or planeswalker id) until triggers wait. */
function p2Attacks(ctx: GameContext, attacker: EnginePermanent, defender: string): void {
  Object.assign(ctx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1, phase: 'combat' });
  const gen = runCombatPhase(ctx);
  let step = gen.next();
  while (!step.done) {
    if (step.value.decisionType === 'declareAttackers') {
      step = gen.next(declareAttacks(step.value, (id) => (id === attacker.id ? defender : null)));
      continue;
    }
    if (ctx.state.stack.length > 0) return;
    step = gen.next({ index: 0, targets: new Map() });
  }
}

/** Cast Lukka from hand by its back face and resolve it. */
function lukkaOut(seed: string): { ctx: GameContext; lukka: EnginePermanent } {
  const ctx = game(seed);
  const card = conjure(ctx, 'P1', MILA, 'hand');
  addMana(player(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'R' }]);
  anyMana(ctx, 'P1', 4);
  const option = computePriorityOptions(ctx, player(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === card.id &&
      entry.description.includes('back face')
    );
  });
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  resolve(ctx);
  return { ctx, lukka: battlefield(ctx, 'Lukka, Wayward Bonder')[0]! };
}

function loyalty(
  ctx: GameContext,
  lukka: EnginePermanent,
  prefix: string,
  targets: ReadonlyMap<number, string> = new Map(),
  choose?: (decision: PendingDecision) => { index: number; targets: Map<number, string> },
): PendingDecision[] {
  const option = computePriorityOptions(ctx, player(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return (
      payload.kind === 'activateAbility' &&
      payload.objectId === lukka.id &&
      entry.description.includes(prefix)
    );
  });
  expect(option, `Lukka ${prefix}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  return pump(resolveTopOfStack(ctx), choose).decisions;
}

describe('Mila, Crafty Companion // Lukka, Wayward Bonder', () => {
  it('mila-modeled — both faces model under the Oracle and fixture ids', () => {
    for (const oracleId of [MILA.oracleId, fixtureOracleId(MILA.name)]) {
      const def = interpretCard({ ...MILA, oracleId } as typeof MILA);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.alternativeCasts?.[0]?.spellFace?.loyalty).toBe(5);
    }
  });

  it('mila-c01-positive — an opponent attacking your planeswalker adds a loyalty counter to each of yours', () => {
    const ctx = game('mila-walker-attack');
    spawn(ctx, 'P1', MILA);
    const attacked = spawn(ctx, 'P1', walker());
    const other = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Other Walker',
        typeLine: 'Legendary Planeswalker — Other',
        manaCost: '{3}',
        oracleText: '',
        loyalty: '2',
      }),
    );
    const attacker = spawn(ctx, 'P2', bear());
    p2Attacks(ctx, attacker, attacked.id);
    const before = [attacked.counters['loyalty'], other.counters['loyalty']];
    expect(ctx.state.stack.at(-1)?.description).toContain('put a loyalty counter');
    resolve(ctx);
    expect([attacked.counters['loyalty'], other.counters['loyalty']]).toEqual(
      before.map((n) => (n ?? 0) + 1),
    );
  });

  it('mila-c01-negative — an attack on you alone does not trigger', () => {
    const ctx = game('mila-player-attack');
    spawn(ctx, 'P1', MILA);
    spawn(ctx, 'P1', walker());
    const attacker = spawn(ctx, 'P2', bear());
    p2Attacks(ctx, attacker, 'P1');
    expect(ctx.state.stack.some((entry) => entry.description.includes('loyalty counter'))).toBe(
      false,
    );
  });

  it("mila-c02-positive — an opponent's spell targeting your permanent lets you draw", () => {
    const ctx = game('mila-targeted');
    spawn(ctx, 'P1', MILA);
    const mine = spawn(ctx, 'P1', bear());
    Object.assign(ctx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1 });
    castFromHand(ctx, 'P2', shock(), new Map([[0, mine.id]]), { R: 1 });
    checkpoint(ctx);
    const hand = player(ctx, 'P1').hand.length;
    expect(ctx.state.stack.at(-1)?.description).toContain('you may draw a card');
    pump(resolveTopOfStack(ctx), answer('accept'));
    expect(player(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('mila-c02-negative — your own spell targeting your permanent does not trigger', () => {
    const ctx = game('mila-self-target');
    spawn(ctx, 'P1', MILA);
    const mine = spawn(ctx, 'P1', bear());
    castFromHand(ctx, 'P1', shock(), new Map([[0, mine.id]]), { R: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('lukka-face — the back face is cast for {4}{R}{R} and enters as a 5-loyalty red planeswalker', () => {
    const { ctx, lukka } = lukkaOut('lukka-cast');
    const chars = computeCharacteristics(ctx, lukka);
    expect([chars.types, chars.colors, lukka.counters['loyalty']]).toEqual([
      ['Planeswalker'],
      ['R'],
      5,
    ]);
  });

  it('lukka-c03-positive — +1 discarding a creature card draws two, another card draws one', () => {
    const { ctx, lukka } = lukkaOut('lukka-plus');
    const p1 = player(ctx, 'P1');
    const creature = conjure(ctx, 'P1', bear(), 'hand');
    const handBefore = p1.hand.length;
    loyalty(ctx, lukka, 'You may discard', new Map(), (decision) => ({
      index: Math.max(
        0,
        decision.options.findIndex((option) => option.description.includes(creature.name)),
      ),
      targets: new Map(),
    }));
    expect(p1.hand.length).toBe(handBefore - 1 + 2);
    expect(lukka.counters['loyalty']).toBe(6);
    const { ctx: ctx2, lukka: lukka2 } = lukkaOut('lukka-plus-land');
    const land = conjure(
      ctx2,
      'P1',
      oracle({ name: 'Test Land', typeLine: 'Land', manaCost: null as never, oracleText: '' }),
      'hand',
    );
    const before2 = player(ctx2, 'P1').hand.length;
    loyalty(ctx2, lukka2, 'You may discard', new Map(), (decision) => ({
      index: Math.max(
        0,
        decision.options.findIndex((option) => option.description.includes(land.name)),
      ),
      targets: new Map(),
    }));
    expect(player(ctx2, 'P1').hand.length).toBe(before2 - 1 + 1);
  });

  it('lukka-c03-decline — +1 without discarding draws nothing', () => {
    const { ctx, lukka } = lukkaOut('lukka-plus-decline');
    conjure(ctx, 'P1', bear(), 'hand');
    const before = player(ctx, 'P1').hand.length;
    loyalty(ctx, lukka, 'You may discard', new Map(), answer('decline'));
    expect(player(ctx, 'P1').hand.length).toBe(before);
  });

  it('lukka-c04-positive — −2 returns a creature card with haste and exiles it at your next upkeep', () => {
    const { ctx, lukka } = lukkaOut('lukka-minus-two');
    const card = conjure(ctx, 'P1', bear(), 'graveyard');
    loyalty(ctx, lukka, 'Return target creature', new Map([[0, card.id]]));
    const [returned] = battlefield(ctx, 'Test Bear');
    expect(returned).toBeDefined();
    expect(computeCharacteristics(ctx, returned!).keywords).toContain('haste');
    expect(lukka.counters['loyalty']).toBe(3);
    nextTurnOf(ctx, 'P2');
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(1);
    nextTurnOf(ctx, 'P1');
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(0);
    expect(ctx.state.exile.some((entry) => entry.name === 'Test Bear')).toBe(true);
  });

  it('lukka-c05-positive — the −7 emblem makes each creature you control that enters deal its power', () => {
    const { ctx, lukka } = lukkaOut('lukka-emblem');
    lukka.counters['loyalty'] = 7;
    loyalty(ctx, lukka, 'emblem');
    expect(player(ctx, 'P1').emblems).toHaveLength(1);
    const life = player(ctx, 'P2').life;
    castFromHand(
      ctx,
      'P1',
      oracle({
        name: 'Test Ogre',
        typeLine: 'Creature — Ogre',
        manaCost: '{2}',
        oracleText: '',
        power: '3',
        toughness: '3',
      }),
      new Map(),
      { C: 2 },
    );
    resolve(ctx);
    checkpoint(ctx);
    const trigger = ctx.state.stack.at(-1)!;
    expect(trigger.description).toContain('deals damage equal to its power');
    trigger.targets = ['P2'];
    resolve(ctx);
    expect(player(ctx, 'P2').life).toBe(life - 3);
  });
});
