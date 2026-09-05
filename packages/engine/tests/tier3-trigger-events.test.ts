import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { drawCards } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { createTokens, moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  keywordCreature,
  oracle,
  pump,
  spawn,
} from './fixtures';

function pod(seed = 'tier3-trigger-events'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const player of ctx.state.players) {
    conjure(ctx, player.id, forest(), 'library');
    conjure(ctx, player.id, forest(), 'library');
    conjure(ctx, player.id, forest(), 'library');
  }
  return ctx;
}

const sacrificeWatcher = oracle({
  name: 'Sacrifice Watcher',
  typeLine: 'Creature — Devil',
  manaCost: '{1}{B}',
  power: '2',
  toughness: '2',
  oracleText: 'Whenever you sacrifice a creature, draw a card.',
});

const tokenWatcher = oracle({
  name: 'Token Watcher',
  typeLine: 'Creature — Bat',
  manaCost: '{3}{B}',
  power: '2',
  toughness: '3',
  oracleText: 'Whenever you create one or more tokens, draw that many cards.',
});

const anointedProcession = oracle({
  name: 'Test Anointed Procession',
  typeLine: 'Enchantment',
  manaCost: '{3}{W}',
  power: null,
  toughness: null,
  oracleText:
    'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.',
});

const drawWatcher = oracle({
  name: 'Draw Watcher',
  typeLine: 'Creature — Archer',
  manaCost: '{1}{B}',
  power: '1',
  toughness: '1',
  oracleText:
    'Whenever an opponent draws a card except the first one they draw in each of their draw steps, draw a card.',
});

const graveyardWatcher = oracle({
  name: 'Graveyard Watcher',
  typeLine: 'Legendary Creature — Human Knight',
  manaCost: '{3}{B}{B}',
  power: '5',
  toughness: '4',
  oracleText:
    'Whenever another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard, ~ deals 1 damage to each opponent.',
});

const servo: Parameters<typeof createTokens>[1] = {
  name: 'Servo',
  typeLine: 'Artifact Creature — Servo',
  types: ['Artifact', 'Creature'],
  subtypes: ['Servo'],
  colors: [],
  power: 1,
  toughness: 1,
};

describe('Tier 3 trigger-event vocabulary', () => {
  it('parses every new event family without dropping any trigger head', () => {
    const sacrificed = interpretCard(sacrificeWatcher);
    const tokens = interpretCard(tokenWatcher);
    const draws = interpretCard(drawWatcher);
    const graveyard = interpretCard(graveyardWatcher);

    expect(sacrificed.modeled, sacrificed.unmodeledReasons.join('; ')).toBe(true);
    expect(sacrificed.triggers.map((ability) => ability.trigger?.when)).toEqual(['sacrificed']);
    expect(tokens.modeled, tokens.unmodeledReasons.join('; ')).toBe(true);
    expect(tokens.triggers.map((ability) => ability.trigger?.when)).toEqual(['tokenCreated']);
    expect(draws.modeled, draws.unmodeledReasons.join('; ')).toBe(true);
    expect(draws.triggers[0]?.trigger).toMatchObject({
      when: 'drawsCard',
      player: 'opponent',
      condition: { kind: 'notFirstDrawInOwnDrawStep' },
    });
    expect(graveyard.modeled, graveyard.unmodeledReasons.join('; ')).toBe(true);
    expect(graveyard.triggers.map((ability) => ability.trigger?.when)).toEqual([
      'dies',
      'putIntoGraveyardFromAnywhere',
      'leavesGraveyard',
    ]);
  });

  it('fires sacrificed exactly once through the moveObject reason chokepoint', () => {
    const ctx = pod('tier3-sacrifice');
    spawn(ctx, 'P1', sacrificeWatcher);
    const victim = spawn(ctx, 'P1', keywordCreature('Victim', '', '{G}', '1/1'));
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const handBefore = player.hand.length;

    pump(moveObject(ctx, victim, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));

    expect(player.hand).toHaveLength(handBefore + 1);
  });

  it('fires tokenCreated after count multipliers and carries the final batch size', () => {
    const ctx = pod('tier3-token-created');
    spawn(ctx, 'P1', tokenWatcher);
    spawn(ctx, 'P1', anointedProcession);
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const handBefore = player.hand.length;

    const created = createTokens(ctx, servo, 1, 'P1');

    expect(created).toHaveLength(2);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.triggerCount).toBe(2);
    pump(runPrioritySequence(ctx));
    expect(player.hand).toHaveLength(handBefore + 2);
  });

  it('exempts only the opponent own-draw-step draw, not their first draw of any turn', () => {
    // The exemption is "the first one they draw in each of THEIR DRAW STEPS" — not the first
    // draw of the turn. On someone else's turn an opponent has no draw step at all, so every
    // draw they take (a Windfall, a Rhystic Study) triggers, including the first.
    const ctx = pod('tier3-draws');
    spawn(ctx, 'P1', drawWatcher);
    const watcherController = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const drawingPlayer = ctx.state.players.find((candidate) => candidate.id === 'P2')!;
    const handBefore = watcherController.hand.length;

    // P1's turn, precombat main: P2 has no draw step here, so their very first draw triggers.
    pump(drawCards(ctx, drawingPlayer, 1));
    expect(drawingPlayer.cardsDrawnThisTurn).toBe(1);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(watcherController.hand).toHaveLength(handBefore + 1);

    // Now P2's own draw step. The turn-based draw is exempt…
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'beginning';
    ctx.state.step = 'draw';
    for (const player of ctx.state.players) player.cardsDrawnThisDrawStep = 0;

    pump(drawCards(ctx, drawingPlayer, 1));
    expect(drawingPlayer.cardsDrawnThisDrawStep).toBe(1);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    // …but a second draw in the same step is not.
    pump(drawCards(ctx, drawingPlayer, 1));
    expect(drawingPlayer.cardsDrawnThisDrawStep).toBe(2);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(watcherController.hand).toHaveLength(handBefore + 2);
  });

  it('fires an ordinal draw trigger exactly once, not on every later draw', () => {
    const ctx = pod('tier3-ordinal-draw');
    const secondDrawWatcher = oracle({
      name: 'Second Draw Watcher',
      typeLine: 'Creature — Wizard',
      manaCost: '{1}{U}',
      power: '1',
      toughness: '2',
      oracleText: 'Whenever you draw your second card each turn, draw a card.',
    });
    const def = interpretCard(secondDrawWatcher);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.triggers[0]?.trigger).toMatchObject({
      condition: { kind: 'eventPlayerDrawCount', cmp: '==', n: 2 },
    });

    spawn(ctx, 'P1', secondDrawWatcher);
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;

    pump(drawCards(ctx, player, 1));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    pump(drawCards(ctx, player, 1));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    ctx.state.pendingTriggers.length = 0;
    // The third and fourth draws must NOT re-trigger: "your second card" is one draw a turn.
    pump(drawCards(ctx, player, 1));
    pump(drawCards(ctx, player, 1));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('observes nonbattlefield graveyard entry, leaving your graveyard, and dies without double firing', () => {
    const ctx = pod('tier3-graveyard-crossings');
    spawn(ctx, 'P1', graveyardWatcher);
    const opponent = ctx.state.players.find((candidate) => candidate.id === 'P2')!;
    const creatureCard = keywordCreature('Grave Traveler', '', '{1}{G}', '2/2');
    const fromHand = conjure(ctx, 'P2', creatureCard, 'hand');

    const moved = pump(moveObject(ctx, fromHand, { zone: 'graveyard' })).value;
    expect(moved).not.toBeNull();
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(opponent.life).toBe(39);

    const ownGraveyardCard = conjure(ctx, 'P1', creatureCard, 'graveyard');
    pump(moveObject(ctx, ownGraveyardCard, { zone: 'hand' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(opponent.life).toBe(38);

    const dying = spawn(ctx, 'P2', keywordCreature('Dying Creature', '', '{G}', '1/1'));
    pump(moveObject(ctx, dying, { zone: 'graveyard' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(opponent.life).toBe(37);
  });
});
