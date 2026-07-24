/**
 * State-based actions (brief §5.6, CR 704) — every listed SBA, driven through the
 * priority checkpoint over surgically built states.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import { GameOverSignal } from '../src/signals';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import {
  bear,
  copies,
  forest,
  gameConfig,
  keywordCreature,
  oracle,
  pick,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

function ctx4(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed: 'sba' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.turnNumber = 2;
  return ctx;
}

function customDef(
  partial: Partial<CardDefinition> & { oracleId: string; name: string },
): CardDefinition {
  return {
    typeLine: partial.typeLine ?? 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
    subtypes: [],
    colors: [],
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    keywords: [],
    manaAbilities: [],
    entersTapped: false,
    spellEffects: [],
    triggers: [],
    modeled: true,
    unmodeledReasons: [],
    ...partial,
  };
}

describe('state-based actions (brief §5.6)', () => {
  it('a player at 0 or less life loses', () => {
    const ctx = ctx4();
    const p3 = ctx.state.players.find((p) => p.id === 'P3');
    if (p3 !== undefined) p3.life = 0;
    pump(priorityCheckpoint(ctx));
    expect(p3?.hasLost).toBe(true);
    expect(p3?.lossReason).toBe('lifeZeroOrLess');
    expect(ctx.state.turnOrder).toEqual(['P1', 'P2', 'P4']);
  });

  it('a player who attempted to draw from an empty library loses at the NEXT check', () => {
    const ctx = ctx4();
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (p2 !== undefined) p2.attemptedDrawFromEmptyLibrary = true;
    pump(priorityCheckpoint(ctx));
    expect(p2?.lossReason).toBe('emptyLibraryDraw');
  });

  it('ten or more poison counters lose', () => {
    const ctx = ctx4();
    const p4 = ctx.state.players.find((p) => p.id === 'P4');
    if (p4 !== undefined) p4.poisonCounters = 10;
    pump(priorityCheckpoint(ctx));
    expect(p4?.lossReason).toBe('poisonCounters');
  });

  it('21+ damage from a single commander loses (commander damage tracked per source)', () => {
    const ctx = ctx4();
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (p2 !== undefined) p2.commanderDamageTaken = { 'enemy-commander': 21 };
    pump(priorityCheckpoint(ctx));
    expect(p2?.lossReason).toBe('commanderDamage');
    // 20 from one + 20 from another does NOT lose.
    const ctx2 = ctx4();
    const q2 = ctx2.state.players.find((p) => p.id === 'P2');
    if (q2 !== undefined) q2.commanderDamageTaken = { a: 20, b: 20 };
    pump(priorityCheckpoint(ctx2));
    expect(q2?.hasLost).toBe(false);
  });

  it('a creature with toughness ≤ 0 goes to the graveyard (counters included)', () => {
    const ctx = ctx4();
    const victim = spawn(ctx, 'P1', bear());
    victim.counters['-1/-1'] = 2;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === victim.cardId)).toBeUndefined();
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.graveyard.some((c) => c.cardId === victim.cardId)).toBe(true);
  });

  it('lethal marked damage destroys; indestructible survives; deathtouch damage is lethal', () => {
    const ctx = ctx4();
    const normal = spawn(ctx, 'P1', bear());
    normal.damageMarked = 2;
    const tough = spawn(
      ctx,
      'P2',
      keywordCreature('Test Immortal', 'Indestructible', '{2}', '2/2'),
    );
    tough.damageMarked = 5;
    const touched = spawn(ctx, 'P3', keywordCreature('Test Touched', '', '{3}', '4/4'));
    touched.damageMarked = 1;
    touched.damagedByDeathtouch = true;

    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === normal.cardId)).toBeUndefined();
    expect(ctx.state.battlefield.find((p) => p.cardId === tough.cardId)).toBeDefined();
    expect(ctx.state.battlefield.find((p) => p.cardId === touched.cardId)).toBeUndefined();
  });

  it('a planeswalker with zero loyalty goes to the graveyard', () => {
    const ctx = ctx4();
    const pwCard = oracle({
      name: 'Test Walker',
      typeLine: 'Legendary Planeswalker — Test',
      power: null,
      toughness: null,
      loyalty: '3',
    });
    registerCustomDef(
      ctx,
      customDef({
        oracleId: pwCard.oracleId,
        name: 'Test Walker',
        typeLine: pwCard.typeLine,
        types: ['Planeswalker'],
        supertypes: ['Legendary'],
      }),
    );
    const pw = spawn(ctx, 'P1', pwCard);
    pw.counters['loyalty'] = 0;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === pw.cardId)).toBeUndefined();
  });

  it('legend rule: controller chooses which copy to keep (AI decision)', () => {
    const ctx = ctx4();
    const legend = (): ReturnType<typeof oracle> =>
      oracle({
        name: 'Test Legend',
        typeLine: 'Legendary Creature — Test',
        power: '3',
        toughness: '3',
      });
    const first = spawn(ctx, 'P1', legend());
    const second = spawn(ctx, 'P1', legend());

    const { decisions } = pump(priorityCheckpoint(ctx), (d) => pick(d, second.id));
    expect(decisions.some((d) => d.decisionType === 'legendRule')).toBe(true);
    expect(ctx.state.battlefield.find((p) => p.id === second.id)).toBeDefined();
    expect(ctx.state.battlefield.find((p) => p.id === first.id)).toBeUndefined();
    // Different controllers each keeping one is NOT a legend-rule violation.
    const ctx2 = ctx4();
    spawn(ctx2, 'P1', legend());
    spawn(ctx2, 'P2', legend());
    const { decisions: d2 } = pump(priorityCheckpoint(ctx2));
    expect(d2).toHaveLength(0);
    expect(ctx2.state.battlefield).toHaveLength(2);
  });

  it('an aura attached to nothing goes to the graveyard', () => {
    const ctx = ctx4();
    const auraCard = oracle({
      name: 'Test Aura',
      typeLine: 'Enchantment — Aura',
      power: null,
      toughness: null,
    });
    registerCustomDef(
      ctx,
      customDef({
        oracleId: auraCard.oracleId,
        name: 'Test Aura',
        typeLine: auraCard.typeLine,
        subtypes: ['Aura'],
      }),
    );
    const aura = spawn(ctx, 'P1', auraCard);
    aura.attachedTo = null;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((p) => p.cardId === aura.cardId)).toBeUndefined();
  });

  it('illegally attached equipment becomes unattached (stays on the battlefield)', () => {
    const ctx = ctx4();
    const eqCard = oracle({
      name: 'Test Blade',
      typeLine: 'Artifact — Equipment',
      power: null,
      toughness: null,
    });
    registerCustomDef(
      ctx,
      customDef({
        oracleId: eqCard.oracleId,
        name: 'Test Blade',
        typeLine: eqCard.typeLine,
        types: ['Artifact'],
        subtypes: ['Equipment'],
      }),
    );
    const eq = spawn(ctx, 'P1', eqCard);
    eq.attachedTo = 'nonexistent-object';
    pump(priorityCheckpoint(ctx));
    const after = ctx.state.battlefield.find((p) => p.cardId === eq.cardId);
    expect(after).toBeDefined();
    expect(after?.attachedTo).toBeNull();
  });

  it('+1/+1 and -1/-1 counters annihilate in pairs', () => {
    const ctx = ctx4();
    const creature = spawn(ctx, 'P1', bear());
    creature.counters['+1/+1'] = 3;
    creature.counters['-1/-1'] = 1;
    pump(priorityCheckpoint(ctx));
    const after = ctx.state.battlefield.find((p) => p.cardId === creature.cardId);
    expect(after?.counters['+1/+1']).toBe(2);
    expect(after?.counters['-1/-1']).toBeUndefined();
  });

  it('a token that leaves the battlefield ceases to exist', () => {
    const ctx = ctx4();
    const token = spawn(ctx, 'P1', bear(), { isToken: true });
    const result = pump(moveObject(ctx, token, { zone: 'graveyard' }));
    expect(result.value).toBeNull();
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    expect(p1?.graveyard).toHaveLength(0);
    expect(ctx.state.eventLog.some((e) => e.type === 'tokenCeased')).toBe(true);
  });

  it('all remaining players losing simultaneously is a drawn game → halt (brief §4)', () => {
    const ctx = ctx4();
    for (const p of ctx.state.players) p.life = 0;
    let signal: GameOverSignal | null = null;
    try {
      pump(priorityCheckpoint(ctx));
    } catch (err) {
      if (err instanceof GameOverSignal) signal = err;
      else throw err;
    }
    expect(signal).not.toBeNull();
    expect(signal?.winner).toBeNull();
    expect(signal?.haltReason).toContain('draw');
  });

  it('SBAs repeat until none apply (a kill cascading into a second SBA)', () => {
    const ctx = ctx4();
    // A 2/2 with lethal damage AND its controller at 0 life: both SBAs fire in one
    // checkpoint, in repeated passes.
    const creature = spawn(ctx, 'P2', bear());
    creature.damageMarked = 5;
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (p2 !== undefined) p2.life = -2;
    pump(priorityCheckpoint(ctx));
    expect(p2?.hasLost).toBe(true);
    // The creature left the game with its owner (CR 800.4a).
    expect(ctx.state.battlefield.find((p) => p.cardId === creature.cardId)).toBeUndefined();
  });
});
