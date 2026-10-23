import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import type { PendingDecision } from '../src/decisions';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext } from '../src/state/types';
import { bear, conjure, oracle, pump, spawn } from './fixtures';
import { anyMana, castFromHand, checkpoint, game, pinned, player, resolve } from './pr11-helpers';

const ARCHAIC = pinned('Wandering Archaic // Explore the Vastlands');
const shock = () =>
  oracle({
    name: 'Test Shock',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Test Shock deals 2 damage to any target.',
  });

/** P2, on its own turn, casts Test Shock at `targetId` with Wandering Archaic on P1's side. */
function opponentShocks(seed: string): { ctx: GameContext; targetId: string } {
  const ctx = game(seed);
  spawn(ctx, 'P1', ARCHAIC);
  const target = spawn(ctx, 'P1', bear());
  Object.assign(ctx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1 });
  castFromHand(ctx, 'P2', shock(), new Map([[0, target.id]]), { R: 1 });
  checkpoint(ctx);
  return { ctx, targetId: target.id };
}

const pick =
  (choose: (decision: PendingDecision) => string | undefined) => (decision: PendingDecision) => {
    const type = choose(decision);
    const index = type === undefined ? 0 : decision.options.findIndex((o) => o.type === type);
    return { index: Math.max(0, index), targets: new Map() };
  };

describe('Wandering Archaic // Explore the Vastlands', () => {
  it('archaic-modeled — the trigger and the sorcery face model under both ids', () => {
    for (const oracleId of [ARCHAIC.oracleId, fixtureOracleId(ARCHAIC.name)]) {
      const def = interpretCard({ ...ARCHAIC, oracleId } as typeof ARCHAIC);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.alternativeCasts?.[0]?.spellFace?.name).toBe('Explore the Vastlands');
    }
  });

  it("archaic-c01-positive — an opponent's instant that isn't paid for is copied for you, with new targets", () => {
    const { ctx } = opponentShocks('archaic-copy');
    const trigger = ctx.state.stack.at(-1)!;
    expect(trigger.controllerId).toBe('P1');
    const seen = resolveWith(ctx, (decision) => (decision.player === 'P1' ? 'accept' : undefined));
    expect(seen.some((d) => d.player === 'P1' && d.options.some((o) => o.type === 'accept'))).toBe(
      true,
    );
    const copy = ctx.state.stack.at(-1)!;
    expect(copy.description).toContain('Test Shock');
    expect(copy.controllerId).toBe('P1');
    expect(ctx.state.stack).toHaveLength(2);
  });

  it('archaic-c01-paid — an opponent who pays {2} prevents the copy', () => {
    const { ctx } = opponentShocks('archaic-paid');
    anyMana(ctx, 'P2', 2);
    const seen = resolveWith(ctx, (decision) =>
      decision.player === 'P2'
        ? decision.options.find((o) => o.type !== 'decline')?.type
        : 'accept',
    );
    expect(seen.some((d) => d.player === 'P2')).toBe(true);
    expect(seen.some((d) => d.player === 'P1')).toBe(false);
    expect(ctx.state.stack.map((entry) => entry.controllerId)).toEqual(['P2']);
  });

  it('archaic-c01-decline — you may decline the copy', () => {
    const { ctx } = opponentShocks('archaic-decline');
    resolveWith(ctx, () => 'decline');
    expect(ctx.state.stack.map((entry) => entry.controllerId)).toEqual(['P2']);
  });

  it('archaic-c01-negative — your own instants and opponents’ creature spells do not trigger', () => {
    const ctx = game('archaic-negative');
    spawn(ctx, 'P1', ARCHAIC);
    castFromHand(ctx, 'P1', shock(), new Map([[0, 'P2']]), { R: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    resolve(ctx);
    Object.assign(ctx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1 });
    castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Test Cub',
        typeLine: 'Creature — Cat',
        manaCost: '{G}',
        oracleText: '',
        power: '1',
        toughness: '1',
      }),
      new Map(),
      { G: 1 },
    );
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('vastlands-c02-positive — each player takes a land and an instant or sorcery from their top five and gains 3 life', () => {
    const ctx = game('vastlands');
    for (const id of ['P1', 'P2']) {
      conjure(ctx, id, shock(), 'library');
      conjure(ctx, id, bear(), 'library');
    }
    const card = conjure(ctx, 'P1', ARCHAIC, 'hand');
    anyMana(ctx, 'P1', 3);
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
    const lives = ctx.state.players.map((p) => p.life);
    const hands = ctx.state.players.map((p) => p.hand.length);
    const libraries = ctx.state.players.map((p) => p.library.length);
    resolve(ctx);
    ctx.state.players.forEach((p, i) => {
      expect(p.life).toBe(lives[i]! + 3);
      // A Plains (land) and, for P1 and P2, Test Shock: the bear stays behind.
      const taken = i < 2 ? 2 : 1;
      expect(p.hand.length).toBe(hands[i]! + taken);
      expect(p.library.length).toBe(libraries[i]! - taken);
    });
    expect(player(ctx, 'P1').hand.some((c) => c.name === 'Test Shock')).toBe(true);
    expect(
      player(ctx, 'P1')
        .library.slice(-3)
        .some((c) => c.name === 'Test Bear'),
    ).toBe(true);
    // In the graveyard it has only its front face's characteristics (CR 712.8a).
    expect(player(ctx, 'P1').graveyard.map((c) => c.name)).toContain('Wandering Archaic');
  });
});

function resolveWith(
  ctx: GameContext,
  choose: (decision: PendingDecision) => string | undefined,
): PendingDecision[] {
  return pump(resolveTopOfStack(ctx), pick(choose)).decisions;
}
