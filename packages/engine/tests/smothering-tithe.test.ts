import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { drawCards, executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { buildPlayerView } from '../src/view/view';
import { formatPlayerLog } from '../src/view/spectator';
import { conjure, copies, forest, gameConfig, oracle, pick, plains, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;
const tithe = fixture.cards.find((entry) => entry.card.name === 'Smothering Tithe');
if (tithe === undefined) throw new Error('missing pinned Smothering Tithe fixture');

function pod(seed = 'smothering-tithe'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function player(ctx: GameContext, id: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

function treasureCount(ctx: GameContext, controllerId = 'P1'): number {
  return ctx.state.battlefield.filter(
    (permanent) => permanent.controllerId === controllerId && permanent.name === 'Treasure',
  ).length;
}

function resolveTithe(ctx: GameContext, choice: 'pay' | 'decline' = 'decline') {
  return pump(runPrioritySequence(ctx), (decision) => {
    // Tithe's trigger is mandatory for its controller: only the drawing opponent chooses, to pay.
    expect(decision.decisionType).not.toBe('optionalTrigger');
    if (decision.decisionType === 'orderTriggers') {
      return { index: 0, targets: new Map() };
    }
    if (decision.options.some((option) => option.description === 'Pay {2}')) {
      expect(decision.player).not.toBe('P1');
      return pick(decision, choice === 'pay' ? 'Pay {2}' : "Don't pay {2}");
    }
    return pick(decision, 'Pass');
  });
}

describe('Smothering Tithe', () => {
  it('smothering-tithe-pinned-oracle-supported — pins exact local Oracle and both supported ids', () => {
    expect(tithe.sha256).toBe('38346bcc71227873ac4c358bd89d277f9d1f94a65e7778392c5e0aefeb7ab2c4');
    expect(tithe.card.oracleText).toBe(
      'Whenever an opponent draws a card, that player may pay {2}. If the player doesn\'t, you create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")',
    );
    expect(interpretCard(tithe.card).modeled).toBe(true);
    expect(interpretCard({ ...tithe.card, oracleId: 'oracle-smothering-tithe' }).modeled).toBe(
      true,
    );
  });

  it('smothering-tithe-opponent-draw-decline — asks the drawing opponent and creates one Treasure', () => {
    const ctx = pod('decline');
    spawn(ctx, 'P1', tithe.card);
    const drawingOpponent = player(ctx, 'P2');
    drawingOpponent.manaEntries = [{ symbol: 'C' }, { symbol: 'C' }];

    pump(drawCards(ctx, drawingOpponent, 1));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const result = resolveTithe(ctx, 'decline');

    expect(
      result.decisions.some(
        (decision) =>
          decision.player === 'P2' &&
          decision.options.some((option) => option.description === "Don't pay {2}"),
      ),
    ).toBe(true);
    expect(drawingOpponent.manaEntries).toHaveLength(2);
    expect(treasureCount(ctx)).toBe(1);
    expect(
      ctx.state.eventLog.some(
        (event) =>
          event.type === 'unlessNotPaid' &&
          event.actorSeat === 'P2' &&
          event.payload['reason'] === 'declined',
      ),
    ).toBe(true);
    expect(
      formatPlayerLog(ctx.state.eventLog, 'P3').some((line) => /doesn't pay \{2\}/.test(line.text)),
    ).toBe(true);
  });

  it('smothering-tithe-opponent-draw-pay — activates normal mana sources and consumes the payer mana', () => {
    const ctx = pod('pay-with-sources');
    spawn(ctx, 'P1', tithe.card);
    const first = spawn(ctx, 'P2', forest());
    const second = spawn(ctx, 'P2', plains());

    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    resolveTithe(ctx, 'pay');

    expect(first.tapped).toBe(true);
    expect(second.tapped).toBe(true);
    expect(player(ctx, 'P2').manaEntries).toHaveLength(0);
    expect(treasureCount(ctx)).toBe(0);
    expect(
      ctx.state.eventLog.some((event) => event.type === 'unlessPaid' && event.actorSeat === 'P2'),
    ).toBe(true);
    expect(
      formatPlayerLog(ctx.state.eventLog, 'P3').some((line) => /pays \{2\}/.test(line.text)),
    ).toBe(true);
  });

  it('smothering-tithe-opponent-unable-to-pay — creates one Treasure without offering an illegal payment', () => {
    const ctx = pod('unable');
    spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    const result = resolveTithe(ctx);

    expect(
      result.decisions.some((decision) =>
        decision.options.some((option) => option.description === 'Pay {2}'),
      ),
    ).toBe(false);
    expect(treasureCount(ctx)).toBe(1);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'unlessNotPaid' && event.payload['reason'] === 'unable',
      ),
    ).toBe(true);
  });

  it('smothering-tithe-controller-draw-does-not-trigger — excludes self draws', () => {
    const ctx = pod('self-draw');
    spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P1'), 1));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(treasureCount(ctx)).toBe(0);
  });

  it('smothering-tithe-failed-draw-does-not-trigger — requires an actual card draw', () => {
    const ctx = pod('failed-draw');
    spawn(ctx, 'P1', tithe.card);
    player(ctx, 'P2').library = [];
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    expect(player(ctx, 'P2').attemptedDrawFromEmptyLibrary).toBe(true);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(treasureCount(ctx)).toBe(0);
  });

  it('smothering-tithe-multiple-copies — each Tithe creates its own Treasure', () => {
    const ctx = pod('multiple-copies');
    spawn(ctx, 'P1', tithe.card);
    spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    resolveTithe(ctx);
    expect(treasureCount(ctx)).toBe(2);
  });

  it('smothering-tithe-different-controllers — each captured controller receives its Treasure', () => {
    const ctx = pod('different-controllers');
    spawn(ctx, 'P1', tithe.card);
    spawn(ctx, 'P3', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId).sort()).toEqual([
      'P1',
      'P3',
    ]);
    resolveTithe(ctx);
    expect(treasureCount(ctx, 'P1')).toBe(1);
    expect(treasureCount(ctx, 'P3')).toBe(1);
  });

  it('smothering-tithe-one-trigger-per-card-drawn — preserves event-player ownership and distinguishable ordering', () => {
    const ctx = pod('multi-player-multi-draw');
    spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 2));
    pump(drawCards(ctx, player(ctx, 'P3'), 1));

    expect(ctx.state.pendingTriggers.map((trigger) => trigger.scope?.eventPlayerId)).toEqual([
      'P2',
      'P2',
      'P3',
    ]);
    const placed = pump(priorityCheckpoint(ctx));
    const ordering = placed.decisions.find((decision) => decision.decisionType === 'orderTriggers');
    expect(ordering?.player).toBe('P1');
    expect(ordering?.options.some((option) => option.description.includes('P2'))).toBe(true);
    expect(ordering?.options.some((option) => option.description.includes('P3'))).toBe(true);
    resolveTithe(ctx);
    expect(treasureCount(ctx)).toBe(3);
  });

  it('smothering-tithe-source-leaves — an already-triggered ability uses its captured controller', () => {
    const ctx = pod('source-leaves');
    const source = spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    resolveTithe(ctx);

    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === source.cardId)).toBe(
      false,
    );
    expect(treasureCount(ctx, 'P1')).toBe(1);
  });

  it('smothering-tithe-source-changes-controller — the stack trigger keeps its original controller', () => {
    const ctx = pod('source-changes-controller');
    const source = spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    source.controllerId = 'P3';
    resolveTithe(ctx);
    expect(treasureCount(ctx, 'P1')).toBe(1);
    expect(treasureCount(ctx, 'P3')).toBe(0);
  });

  it('smothering-tithe-countered-trigger — countering the stack object prevents payment and Treasure', () => {
    const ctx = pod('countered-trigger');
    spawn(ctx, 'P1', tithe.card);
    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    pump(priorityCheckpoint(ctx));
    const trigger = ctx.state.stack.at(-1);
    if (trigger === undefined) throw new Error('missing Tithe trigger');

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'counter-card',
          name: 'Counter Trigger',
          oracleId: 'counter-trigger',
          controllerId: 'P3',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'stackObject' }],
          effects: [{ op: 'counter', target: 0 }],
        },
        [trigger.id],
      ),
    );

    expect(ctx.state.stack).toHaveLength(0);
    expect(treasureCount(ctx)).toBe(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterSpell')).toBe(true);
  });

  it('smothering-tithe-pending-routing-clone-hash-and-hidden-info — preserves payer and does not leak the draw', () => {
    const ctx = pod('clone-hash-hidden');
    spawn(ctx, 'P1', tithe.card);
    const secret = oracle({ name: 'Tithe Secret Alpha', typeLine: 'Creature — Secret' });
    const secretObject = conjure(ctx, 'P2', secret, 'library');
    const drawingOpponent = player(ctx, 'P2');
    drawingOpponent.library = [
      secretObject,
      ...drawingOpponent.library.filter((card) => card.cardId !== secretObject.cardId),
    ];
    pump(drawCards(ctx, drawingOpponent, 1));

    const canonical = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const cloned = structuredClone(ctx.state.pendingTriggers);
    const replayed = JSON.parse(JSON.stringify(ctx.state.pendingTriggers)) as typeof cloned;
    expect(cloned).toEqual(ctx.state.pendingTriggers);
    expect(canonical(replayed)).toBe(canonical(ctx.state.pendingTriggers));
    expect(replayed[0]?.scope?.eventPlayerId).toBe('P2');
    replayed[0]!.scope!.eventPlayerId = 'P3';
    expect(canonical(replayed)).not.toBe(canonical(ctx.state.pendingTriggers));

    resolveTithe(ctx);
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).toContain('Tithe Secret Alpha');
    expect(JSON.stringify(buildPlayerView(ctx, 'P1'))).not.toContain('Tithe Secret Alpha');
    expect(JSON.stringify(buildPlayerView(ctx, 'P3'))).not.toContain('Tithe Secret Alpha');
    expect(treasureCount(ctx)).toBe(1);
  });

  it('smothering-tithe-normal-cast-priority-stack — legally casts and resolves before triggering', () => {
    const ctx = pod('normal-cast');
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', plains());
    conjure(ctx, 'P1', tithe.card, 'hand');
    let cast = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.player === 'P1' && !cast) {
        cast = true;
        return pick(decision, 'Cast Smothering Tithe');
      }
      return pick(decision, 'Pass');
    });

    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
    expect(
      ctx.state.battlefield.some(
        (permanent) => permanent.name === 'Smothering Tithe' && permanent.controllerId === 'P1',
      ),
    ).toBe(true);
    expect(
      ctx.state.battlefield
        .filter((permanent) => permanent.controllerId === 'P1' && permanent.name === 'Plains')
        .every((permanent) => permanent.tapped),
    ).toBe(true);

    pump(drawCards(ctx, player(ctx, 'P2'), 1));
    resolveTithe(ctx);
    expect(treasureCount(ctx)).toBe(1);
  });

  it('smothering-tithe-restricted-mana-cannot-pay — treats the tax as a non-casting payment', () => {
    const ctx = pod('restricted-mana');
    spawn(ctx, 'P1', tithe.card);
    const drawingOpponent = player(ctx, 'P2');
    drawingOpponent.manaEntries = [
      {
        symbol: 'C',
        restriction: { purposes: ['castSpell'], description: 'cast spells' },
      },
      {
        symbol: 'C',
        restriction: { purposes: ['castSpell'], description: 'cast spells' },
      },
    ];

    pump(drawCards(ctx, drawingOpponent, 1));
    const result = resolveTithe(ctx);

    expect(
      result.decisions.some((decision) =>
        decision.options.some((option) => option.description === 'Pay {2}'),
      ),
    ).toBe(false);
    expect(drawingOpponent.manaEntries).toHaveLength(2);
    expect(treasureCount(ctx)).toBe(1);
  });
});
