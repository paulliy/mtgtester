/**
 * Protection's E in DEBT (CR 702.16d) applies to Auras put onto the battlefield, which choose a
 * host without targeting (CR 303.4f), and to attach effects (CR 701.3b): a permanent with
 * protection from black can't become enchanted by a black Aura. An Aura already on an illegal
 * host, by protection or its enchant restriction, goes to the graveyard (CR 704.5m).
 */
import { describe, expect, it } from 'vitest';
import { priorityCheckpoint } from '../src/sba/sba';
import { canAttach, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import type { PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const BLACK_AURA = oracle({
  name: 'Lab Black Aura',
  typeLine: 'Enchantment — Aura',
  manaCost: '{B}',
  colors: ['B'],
  oracleText: 'Enchant creature\nEnchanted creature gets -1/-0.',
});
const WARDED = oracle({
  name: 'Lab Warded',
  typeLine: 'Creature — Knight',
  power: '2',
  toughness: '2',
  oracleText: 'Protection from black',
});
const PLAIN = oracle({
  name: 'Lab Plain',
  typeLine: 'Creature — Bear',
  power: '2',
  toughness: '2',
});
const OWN_AURA = oracle({
  name: 'Lab Own Aura',
  typeLine: 'Enchantment — Aura',
  manaCost: '{W}',
  colors: ['W'],
  oracleText: 'Enchant creature you control\nEnchanted creature gets +1/+0.',
});
const OTHER = oracle({
  name: 'Lab Other',
  typeLine: 'Creature — Bear',
  power: '1',
  toughness: '1',
});

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Aura attachment respects protection (CR 702.16d)', () => {
  it('an Aura put onto the battlefield is not offered a host with protection from its color', () => {
    const ctx = pod('aura-pro');
    spawn(ctx, 'P2', WARDED);
    const plain = spawn(ctx, 'P2', PLAIN);
    spawn(ctx, 'P2', OTHER);
    const aura = conjure(ctx, 'P1', BLACK_AURA, 'graveyard');
    const offered: string[] = [];
    pump(
      moveObject(ctx, aura, { zone: 'battlefield', controllerId: 'P1' }),
      (decision: PendingDecision) => {
        offered.push(...decision.options.map((option) => option.description));
        return { index: 0, targets: new Map() };
      },
    );
    expect(offered).toEqual(['Enchant Lab Plain', 'Enchant Lab Other']);
    expect(ctx.state.battlefield.find((perm) => perm.name === 'Lab Black Aura')?.attachedTo).toBe(
      plain.id,
    );
  });

  it('with only a protected creature it stays in its zone (CR 303.4i)', () => {
    const ctx = pod('aura-pro-only');
    spawn(ctx, 'P2', WARDED);
    const aura = conjure(ctx, 'P1', BLACK_AURA, 'graveyard');
    pump(moveObject(ctx, aura, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Lab Black Aura')).toBe(false);
    expect(ctx.state.players[0]!.graveyard.some((card) => card.name === 'Lab Black Aura')).toBe(
      true,
    );
  });

  it('an attach effect cannot move it onto a protected creature', () => {
    const ctx = pod('aura-pro-attach');
    const plain = spawn(ctx, 'P2', PLAIN);
    const warded = spawn(ctx, 'P2', WARDED);
    const aura = spawn(ctx, 'P1', BLACK_AURA);
    aura.attachedTo = plain.id;
    expect(canAttach(ctx, aura, warded)).toBe(false);
    const other = spawn(ctx, 'P2', OTHER);
    expect(canAttach(ctx, aura, other)).toBe(true);
  });

  it('an Aura on a creature with protection from its color goes to the graveyard (CR 704.5m)', () => {
    const ctx = pod('aura-pro-sba');
    const warded = spawn(ctx, 'P2', WARDED);
    const plain = spawn(ctx, 'P2', PLAIN);
    const onWarded = spawn(ctx, 'P1', BLACK_AURA);
    onWarded.attachedTo = warded.id;
    const onPlain = spawn(ctx, 'P1', BLACK_AURA);
    onPlain.attachedTo = plain.id;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.includes(onWarded)).toBe(false);
    expect(ctx.state.battlefield.includes(onPlain)).toBe(true);
  });

  it('"enchant creature you control" goes to the graveyard when another player gains control of the creature', () => {
    const ctx = pod('aura-own-sba');
    const mine = spawn(ctx, 'P1', PLAIN);
    const kept = spawn(ctx, 'P1', OTHER);
    const aura = spawn(ctx, 'P1', OWN_AURA);
    aura.attachedTo = mine.id;
    const stays = spawn(ctx, 'P1', OWN_AURA);
    stays.attachedTo = kept.id;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.includes(aura)).toBe(true);
    mine.controllerId = 'P2';
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.includes(aura)).toBe(false);
    expect(ctx.state.battlefield.includes(stays)).toBe(true);
  });
});
