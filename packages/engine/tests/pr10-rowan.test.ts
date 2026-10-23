import { describe, expect, it } from 'vitest';
import { resolveTopOfStack } from '../src/stack/stack';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import type { PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { declareAttacks, declareBlocks, conjure, oracle, pump, spawn } from './fixtures';
import {
  activate,
  bear,
  castFromHand,
  choose,
  p,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

const rowan = pinned('Rowan Kenrith');

/** P1's Rowan Kenrith with `loyalty` loyalty, entered without its enter trigger. */
function rowanFor(seed: string, loyalty = 4) {
  const ctx = pod(seed);
  const walker = spawn(ctx, 'P1', rowan);
  walker.counters['loyalty'] = loyalty;
  return { ctx, walker };
}

/** Whether each of `creatures` must attack in a declaration on `playerId`'s turn number `turn`. */
function mustAttack(
  ctx: GameContext,
  playerId: string,
  turn: number,
  ...creatures: EnginePermanent[]
) {
  ctx.state.turnNumber = turn;
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  let required: (boolean | undefined)[] = [];
  pump(runCombatAndExtraCombats(ctx), (decision: PendingDecision) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      const subjects = decision.presentationAttackDeclaration.subjects;
      required = creatures.map(
        (creature) => subjects.find((subject) => subject.subjectId === creature.id)?.mustAttack,
      );
      // A required attacker attacks the first player it may; nobody else attacks.
      return declareAttacks(decision, (_id, subject) =>
        subject.mustAttack ? (subject.defenders[0]?.playerId ?? null) : null,
      );
    }
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
  return required;
}

const healer = (name: string) =>
  oracle({
    name,
    typeLine: 'Creature — Human Cleric',
    power: '1',
    toughness: '1',
    oracleText: '{T}: You gain 2 life.',
  });

describe('PR10.30 Rowan Kenrith', () => {
  it('pr10-rowan-kenrith-pinned-oracle-supported — every line is modeled', () => {
    const def = pinnedDefinition('Rowan Kenrith');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.activatedAbilities).toHaveLength(3);
    expect(def.triggers).toHaveLength(1);
  });

  it("pr10-rowan-kenrith-plus-two — that player's creatures must attack during their next turn only", () => {
    const { ctx, walker } = rowanFor('pr10-rowan-plus');
    const turn = ctx.state.turnNumber;
    const target = spawn(ctx, 'P2', bear('Rowan Target Bear'));
    const bystander = spawn(ctx, 'P3', bear('Rowan Bystander Bear'));
    activate(ctx, 'P1', walker, new Map([[0, 'P2']]));
    settle(ctx);
    expect(walker.counters['loyalty']).toBe(6);
    // P3's turn is not P2's; then P2's next turn requires its creatures, even new ones.
    expect(mustAttack(ctx, 'P3', turn + 2, bystander)).toEqual([false]);
    const latecomer = spawn(ctx, 'P2', bear('Rowan Latecomer'));
    // It came under P2's control before that turn began, so it can attack then.
    latecomer.summoningSick = false;
    expect(mustAttack(ctx, 'P2', turn + 1, target, latecomer)).toEqual([true, true]);
  });

  it('pr10-rowan-kenrith-minus-two — 3 damage to each tapped creature that player controls', () => {
    const { ctx, walker } = rowanFor('pr10-rowan-minus');
    const tapped = spawn(ctx, 'P2', bear('Rowan Tapped', { power: '3', toughness: '3' }));
    tapped.tapped = true;
    const untapped = spawn(ctx, 'P2', bear('Rowan Untapped', { power: '3', toughness: '3' }));
    const mine = spawn(ctx, 'P1', bear('Rowan Own Tapped', { power: '3', toughness: '3' }));
    mine.tapped = true;
    activate(ctx, 'P1', walker, new Map([[0, 'P2']]), undefined, 1);
    settle(ctx);
    expect(walker.counters['loyalty']).toBe(2);
    const alive = (perm: EnginePermanent) =>
      ctx.state.battlefield.some((candidate) => candidate.id === perm.id);
    expect([alive(tapped), alive(untapped), alive(mine)]).toEqual([false, true, true]);
  });

  it("pr10-rowan-kenrith-emblem — the target player's activated abilities are copied", () => {
    const { ctx, walker } = rowanFor('pr10-rowan-emblem', 8);
    activate(ctx, 'P1', walker, new Map([[0, 'P1']]), undefined, 2);
    settle(ctx);
    expect(p(ctx, 'P1').emblems.map((emblem) => emblem.name)).toEqual(['Rowan Kenrith emblem']);
    const cleric = spawn(ctx, 'P1', healer('Rowan Cleric'));
    const life = p(ctx, 'P1').life;
    activate(ctx, 'P1', cleric);
    putPendingTriggersOnStack(ctx);
    settle(ctx);
    // The ability and its copy each resolve; the copy was not activated, so it doesn't loop.
    expect(p(ctx, 'P1').life).toBe(life + 4);
  });

  it("pr10-rowan-kenrith-emblem-owner — only the emblem's owner's activations are copied", () => {
    const { ctx, walker } = rowanFor('pr10-rowan-emblem-owner', 8);
    activate(ctx, 'P1', walker, new Map([[0, 'P2']]), undefined, 2);
    settle(ctx);
    expect(p(ctx, 'P1').emblems).toHaveLength(0);
    expect(p(ctx, 'P2').emblems).toHaveLength(1);
    const cleric = spawn(ctx, 'P1', healer('Rowan Own Cleric'));
    const life = p(ctx, 'P1').life;
    activate(ctx, 'P1', cleric);
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack.filter((entry) => entry.kind === 'triggeredAbility')).toHaveLength(0);
    settle(ctx);
    expect(p(ctx, 'P1').life).toBe(life + 2);
  });

  it('pr10-rowan-kenrith-partner-with — the target player may search for Will Kenrith', () => {
    const ctx = pod('pr10-rowan-partner');
    const will = conjure(
      ctx,
      'P1',
      oracle({ name: 'Will Kenrith', typeLine: 'Legendary Planeswalker — Will', loyalty: '4' }),
      'library',
    );
    castFromHand(ctx, 'P1', rowan);
    pump(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, 'P1']]) }));
    settle(ctx, (decision) =>
      decision.options.some((option) => option.description === 'Search')
        ? choose('Search')(decision)
        : choose('Will Kenrith')(decision),
    );
    expect(p(ctx, 'P1').hand.some((card) => card.cardId === will.cardId)).toBe(true);
  });

  it('pr10-rowan-kenrith-partner-decline — declining leaves the library unsearched', () => {
    const ctx = pod('pr10-rowan-partner-decline');
    const will = conjure(
      ctx,
      'P1',
      oracle({ name: 'Will Kenrith', typeLine: 'Legendary Planeswalker — Will', loyalty: '4' }),
      'library',
    );
    const order = p(ctx, 'P1').library.map((card) => card.id);
    castFromHand(ctx, 'P1', rowan);
    pump(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, 'P1']]) }));
    settle(ctx, choose("Don't search"));
    expect(p(ctx, 'P1').library.map((card) => card.id)).toEqual(order);
    expect(p(ctx, 'P1').library[0]?.id).toBe(will.id);
  });
});
