/**
 * `reanimateAndLoseLife` (Reanimate) and the destroy-then-lose-life-equal-to-mana-value ordering
 * fix (Feed the Swarm). Both exist because `manaValueOfTarget`/mana value in general can only be
 * read from a card that is actually LOCATED somewhere: `reanimateAndLoseLife` reads it from the
 * graveyard before moving the card (the battlefield lookup `manaValueOfTarget` uses would find
 * nothing once it's already been moved — a new object identity, per zone-change semantics), and
 * the destroy block reorders its effects so the mana-value read happens before `destroy` removes
 * the target from the battlefield.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'reanimate'): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(3, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('reanimation and mana-value-based life loss', () => {
  it('parses Reanimate\'s shape into one combined effect targeting any graveyard', () => {
    const def = interpretCard(
      oracle({
        name: 'Reanimate Test',
        typeLine: 'Sorcery',
        manaCost: '{B}',
        power: null,
        toughness: null,
        oracleText:
          "Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to that card's mana value.",
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets).toEqual([
      { kind: 'cardInGraveyard', filter: { kind: 'type', value: 'Creature' }, graveyardOwnerScope: 'any' },
    ]);
    expect(def.spellAbility?.effects).toEqual([{ op: 'reanimateAndLoseLife', target: 0 }]);
  });

  it('reanimates a card from an OPPONENT\'s graveyard under the caster\'s control, and charges life for its real mana value', () => {
    const ctx = pod();
    const caster = spawn(ctx, 'P1', oracle({ name: 'Test Caster', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    // A four-mana-value creature sitting in P2's graveyard.
    const corpse = conjure(
      ctx,
      'P2',
      oracle({ name: 'Test Corpse', typeLine: 'Creature — Zombie', manaCost: '{2}{B}{B}', power: '3', toughness: '3' }),
      'graveyard',
    );

    const p1BeforeLife = ctx.state.players.find((p) => p.id === 'P1')!.life;
    pump(
      executeAbility(
        ctx,
        caster,
        { kind: 'spell', targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'any' }], effects: [{ op: 'reanimateAndLoseLife', target: 0 }] },
        [corpse.id],
      ),
    );

    const reanimated = ctx.state.battlefield.find((p) => p.cardId === corpse.cardId);
    expect(reanimated).toBeDefined();
    expect(reanimated?.controllerId).toBe('P1');
    expect(ctx.state.players.find((p) => p.id === 'P2')!.graveyard.some((c) => c.cardId === corpse.cardId)).toBe(false);
    expect(ctx.state.players.find((p) => p.id === 'P1')!.life).toBe(p1BeforeLife - 4);
  });

  it('does nothing (no life loss either) if the target already left the graveyard', () => {
    const ctx = pod();
    const caster = spawn(ctx, 'P1', oracle({ name: 'Test Caster 2', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    const p1BeforeLife = ctx.state.players.find((p) => p.id === 'P1')!.life;

    pump(
      executeAbility(
        ctx,
        caster,
        { kind: 'spell', targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'any' }], effects: [{ op: 'reanimateAndLoseLife', target: 0 }] },
        ['nonexistent-id'],
      ),
    );

    expect(ctx.state.players.find((p) => p.id === 'P1')!.life).toBe(p1BeforeLife);
  });

  it('reads a destroyed target\'s mana value BEFORE destroying it (Feed the Swarm)', () => {
    const def = interpretCard(
      oracle({
        name: 'Feed the Swarm Test',
        typeLine: 'Sorcery',
        manaCost: '{1}{B}',
        power: null,
        toughness: null,
        oracleText:
          "Destroy target creature or enchantment an opponent controls. You lose life equal to that permanent's mana value.",
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'loseLife', amount: { kind: 'manaValueOfTarget', target: 0 } },
      { op: 'destroy', target: 0 },
    ]);

    const ctx = pod();
    const caster = spawn(ctx, 'P1', oracle({ name: 'Test Caster 3', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    const target = spawn(ctx, 'P2', oracle({ name: 'Test Target', typeLine: 'Creature — Bear', manaCost: '{3}{B}', power: '3', toughness: '3' }));

    const p1BeforeLife = ctx.state.players.find((p) => p.id === 'P1')!.life;
    pump(
      executeAbility(
        ctx,
        caster,
        {
          kind: 'spell',
          targets: [{ kind: 'permanent' }],
          effects: [
            { op: 'loseLife', amount: { kind: 'manaValueOfTarget', target: 0 } },
            { op: 'destroy', target: 0 },
          ],
        },
        [target.id],
      ),
    );

    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(false);
    expect(ctx.state.players.find((p) => p.id === 'P1')!.life).toBe(p1BeforeLife - 4);
  });

  it('parses and executes "target player draws N cards and loses N life" (Sign in Blood)', () => {
    const def = interpretCard(
      oracle({
        name: 'Sign in Blood Test',
        typeLine: 'Sorcery',
        manaCost: '{1}{B}',
        power: null,
        toughness: null,
        oracleText: 'Target player draws two cards and loses 2 life.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'player' }]);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'drawTarget', target: 0, count: { kind: 'const', n: 2 } },
      { op: 'loseLifeTarget', target: 0, amount: { kind: 'const', n: 2 } },
    ]);

    const ctx = pod();
    const caster = spawn(ctx, 'P1', oracle({ name: 'Test Caster 4', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }));
    conjure(ctx, 'P2', oracle({ name: 'Library Card A' }), 'library');
    conjure(ctx, 'P2', oracle({ name: 'Library Card B' }), 'library');
    const p2 = ctx.state.players.find((p) => p.id === 'P2')!;
    const beforeHand = p2.hand.length;
    const beforeLife = p2.life;

    pump(
      executeAbility(
        ctx,
        caster,
        { kind: 'spell', targets: [{ kind: 'player' }], effects: [{ op: 'drawTarget', target: 0, count: { kind: 'const', n: 2 } }, { op: 'loseLifeTarget', target: 0, amount: { kind: 'const', n: 2 } }] },
        ['P2'],
      ),
    );

    expect(p2.hand.length).toBe(beforeHand + 2);
    expect(p2.life).toBe(beforeLife - 2);
  });
});
