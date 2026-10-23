import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import type { GameContext } from '../src/state/types';
import { oracle, plains, spawn } from './fixtures';
import {
  battlefield,
  castFromHand,
  checkpoint,
  game,
  nextTurnOf,
  pinned,
  player,
  preferring,
  resolve,
} from './pr11-helpers';

const VAULT = pinned('Mana Vault');
const REMORA = pinned('Mystic Remora');

const threeDrop = (): OracleCard =>
  oracle({ name: 'Three Drop', typeLine: 'Artifact', manaCost: '{3}', oracleText: '' });
const opponentSorcery = (): OracleCard =>
  oracle({
    name: 'Divination Test',
    typeLine: 'Sorcery',
    manaCost: '{1}',
    oracleText: 'You gain 1 life.',
  });
const opponentCreature = (): OracleCard =>
  oracle({
    name: 'Cheap Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}',
    power: '2',
    toughness: '2',
  });

function turnOf(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
}

function lands(ctx: GameContext, playerId: string, count: number): void {
  for (let index = 0; index < count; index++) spawn(ctx, playerId, plains());
}

describe('PR11 lifecycle cards — modeled', () => {
  it('pr11-lifecycle-modeled — Mana Vault and Mystic Remora model with every reason cleared', () => {
    for (const card of [VAULT, REMORA]) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
    }
  });
});

describe('Mana Vault', () => {
  it('vault-c04 — {T}: Add {C}{C}{C} pays for a three-mana spell by itself', () => {
    const ctx = game('pr11-vault-mana');
    const vault = spawn(ctx, 'P1', VAULT);
    castFromHand(ctx, 'P1', threeDrop());
    expect(vault.tapped).toBe(true);
    resolve(ctx);
    expect(battlefield(ctx, 'Three Drop')).toHaveLength(1);
  });

  it('vault-c01 — it does not untap during your untap step; other permanents do', () => {
    const ctx = game('pr11-vault-untap');
    const vault = spawn(ctx, 'P1', VAULT, { tapped: true });
    const land = spawn(ctx, 'P1', plains(), { tapped: true });
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(land.tapped).toBe(false);
    expect(vault.tapped).toBe(true);
  });

  it('vault-c02-positive — paying {4} at upkeep untaps it, before the draw-step damage', () => {
    const ctx = game('pr11-vault-pay');
    const vault = spawn(ctx, 'P1', VAULT, { tapped: true });
    lands(ctx, 'P1', 4);
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P1', preferring('payMana'));
    expect(vault.tapped).toBe(false);
    expect(player(ctx, 'P1').life).toBe(life);
    expect(battlefield(ctx, 'Plains').every((land) => land.tapped)).toBe(true);
  });

  it('vault-c02-c03 — declining leaves it tapped, and it deals 1 damage at your draw step', () => {
    const ctx = game('pr11-vault-decline');
    const vault = spawn(ctx, 'P1', VAULT, { tapped: true });
    lands(ctx, 'P1', 4);
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(vault.tapped).toBe(true);
    expect(player(ctx, 'P1').life).toBe(life - 1);
  });

  it('vault-c03-negative — untapped at the draw step, or on another player’s turn, no damage', () => {
    const ctx = game('pr11-vault-untapped');
    spawn(ctx, 'P1', VAULT);
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(player(ctx, 'P1').life).toBe(life);

    const other = game('pr11-vault-other-turn');
    spawn(other, 'P1', VAULT, { tapped: true });
    const otherLife = player(other, 'P1').life;
    nextTurnOf(other, 'P2', preferring('decline'));
    expect(player(other, 'P1').life).toBe(otherLife);
  });
});

describe('Mystic Remora', () => {
  it('remora-c01-paid — each upkeep adds an age counter and asks {1} per counter', () => {
    const ctx = game('pr11-remora-upkeep');
    const remora = spawn(ctx, 'P1', REMORA);
    lands(ctx, 'P1', 3);
    nextTurnOf(ctx, 'P1', preferring('payCost'));
    expect(remora.counters['age']).toBe(1);
    expect(battlefield(ctx, 'Mystic Remora')).toEqual([remora]);
    expect(battlefield(ctx, 'Plains').filter((land) => land.tapped)).toHaveLength(1);
    nextTurnOf(ctx, 'P1', preferring('payCost'));
    expect(remora.counters['age']).toBe(2);
    expect(battlefield(ctx, 'Plains').filter((land) => land.tapped)).toHaveLength(2);
    expect(battlefield(ctx, 'Mystic Remora')).toEqual([remora]);
  });

  it('remora-c01-unpaid — declining, or being unable to pay, sacrifices it', () => {
    const ctx = game('pr11-remora-decline');
    spawn(ctx, 'P1', REMORA);
    lands(ctx, 'P1', 3);
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(battlefield(ctx, 'Mystic Remora')).toEqual([]);
    expect(player(ctx, 'P1').graveyard.some((card) => card.name === 'Mystic Remora')).toBe(true);

    const broke = game('pr11-remora-broke');
    spawn(broke, 'P1', REMORA);
    nextTurnOf(broke, 'P1', preferring('payCost'));
    expect(battlefield(broke, 'Mystic Remora')).toEqual([]);
  });

  it('remora-c02-positive — an opponent’s noncreature spell lets you draw unless they pay {4}', () => {
    const ctx = game('pr11-remora-draw');
    spawn(ctx, 'P1', REMORA);
    const hand = player(ctx, 'P1').hand.length;
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', opponentSorcery(), new Map(), { C: 1 });
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('remora-c02-paid — the opponent paying {4} stops the draw', () => {
    const ctx = game('pr11-remora-tax');
    spawn(ctx, 'P1', REMORA);
    lands(ctx, 'P2', 4);
    const hand = player(ctx, 'P1').hand.length;
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', opponentSorcery(), new Map(), { C: 1 });
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').hand.length).toBe(hand);
    expect(battlefield(ctx, 'Plains').filter((land) => land.tapped)).toHaveLength(4);
  });

  it('remora-c02-negative — creature spells and your own spells do not trigger it', () => {
    const ctx = game('pr11-remora-filter');
    spawn(ctx, 'P1', REMORA);
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', opponentCreature(), new Map(), { C: 1 });
    checkpoint(ctx);
    resolve(ctx);
    turnOf(ctx, 'P1');
    castFromHand(ctx, 'P1', opponentSorcery(), new Map(), { C: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell']);
  });
});
