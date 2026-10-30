import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import type { EngineStackObject, GameContext, PendingTrigger } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { buildPlayerView } from '../src/view/view';
import { conjure, copies, forest, gameConfig, island, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;
const pinned = fixture.cards.find(({ card }) => card.name === 'Arcane Denial')!;

function pod(seed = 'arcane-denial'): GameContext {
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

function definition(card = pinned.card) {
  const def = interpretCard(card);
  expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  expect(def.spellAbility).toBeDefined();
  return def;
}

function targetSpell(
  ctx: GameContext,
  controllerId: PlayerId,
  options: { id?: string; uncounterable?: boolean } = {},
): EngineStackObject {
  const id = options.id ?? `target-${controllerId}`;
  const targetOracleId = `target-oracle-${controllerId}`;
  ctx.defs.set(
    targetOracleId,
    interpretCard(
      oracle({
        oracleId: targetOracleId,
        name: `Target spell controlled by ${controllerId}`,
        typeLine: 'Instant',
      }),
    ),
  );
  const entry: EngineStackObject = {
    id,
    sourceId: id,
    controllerId,
    kind: 'spell',
    description: `Target spell controlled by ${controllerId}`,
    targets: [],
    card: null,
    ability: {
      kind: 'spell',
      targets: [],
      effects: [],
      ...(options.uncounterable === true ? { cantBeCountered: true } : {}),
    },
    sourceOracleId: targetOracleId,
    sourceCardId: `target-card-${controllerId}`,
    isCommanderCast: false,
  };
  ctx.state.stack.push(entry);
  return entry;
}

function resolveArcaneDirect(ctx: GameContext, target: EngineStackObject): void {
  // The card as loaded from its pinned Oracle text, not the override object imported directly.
  const ability = definition().spellAbility!;
  pump(
    executeAbility(
      ctx,
      {
        cardId: 'arcane-card',
        name: 'Arcane Denial',
        oracleId: pinned.card.oracleId,
        controllerId: 'P1',
      },
      ability,
      [target.id],
    ),
  );
}

function resolvePending(
  ctx: GameContext,
  pending: PendingTrigger,
  drawCount?: number,
): ReturnType<typeof pump> {
  return pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      [],
      pending.triggerObjectCardId,
      pending.scope,
    ),
    (decision) => ({
      index:
        drawCount === undefined
          ? 0
          : decision.options.findIndex(
              (option) =>
                option.description === `Draw ${drawCount} card${drawCount === 1 ? '' : 's'}`,
            ),
      targets: new Map(),
    }),
  );
}

describe('Arcane Denial — corrected next-turn upkeep semantics', () => {
  it('arcane-denial-pinned-oracle-and-alias — pins and models both ids', () => {
    expect(pinned.sha256).toBe('7d764e957064fa08627fd48a85e1ea9aa50de341ffa09a88c2d36d0598156746');
    expect(pinned.card.oracleText).toBe(
      "Counter target spell. Its controller may draw up to two cards at the beginning of the next turn's upkeep.\nYou draw a card at the beginning of the next turn's upkeep.",
    );
    definition();
    definition({ ...pinned.card, oracleId: 'oracle-arcane-denial' });
  });

  it('arcane-denial-normal-cast-priority-stack — pays mana, targets, counters, and resolves', () => {
    const ctx = pod('normal-cast-path');
    const target = targetSpell(ctx, 'P4');
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', pinned.card, 'hand');
    let cast = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.player === 'P1' && !cast) {
        cast = true;
        const index = decision.options.findIndex((option) =>
          option.description.includes('Cast Arcane Denial'),
        );
        return { index, targets: new Map([[0, target.id]]) };
      }
      return pick(decision, 'Pass');
    });

    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterSpell')).toBe(true);
    expect(
      ctx.state.battlefield.filter((permanent) => permanent.controllerId === 'P1'),
    ).toHaveLength(2);
    expect(
      ctx.state.battlefield
        .filter((permanent) => permanent.controllerId === 'P1')
        .every((permanent) => permanent.tapped),
    ).toBe(true);
    expect(ctx.state.delayedTriggers).toHaveLength(2);
  });

  it.each(['P2', 'P3', 'P4'] as const)(
    'arcane-denial-both-draws-fire-at-first-next-upkeep — both triggers fire at %s upkeep',
    (nextActivePlayer) => {
      const ctx = pod(`next-upkeep-multiplayer-${nextActivePlayer}`);
      const target = targetSpell(ctx, 'P4');
      resolveArcaneDirect(ctx, target);

      expect(ctx.state.delayedTriggers).toHaveLength(2);
      expect(ctx.state.delayedTriggers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            controllerId: 'P1',
            affectedPlayerId: 'P4',
            when: 'upkeep',
            expiry: 'onFire',
          }),
          expect.objectContaining({
            controllerId: 'P1',
            affectedPlayerId: 'P1',
            when: 'upkeep',
            expiry: 'onFire',
          }),
        ]),
      );
      // Neither draw is restricted to a particular player's step: the printed clause is "at the
      // beginning of the next turn's upkeep", not "your next upkeep".
      expect(ctx.state.delayedTriggers.every((trigger) => trigger.player === undefined)).toBe(true);
      expect(ctx.state.delayedTriggers.every((trigger) => !('stepPlayerId' in trigger))).toBe(true);

      // Whoever's turn comes next, the first upkeep fires BOTH delayed triggers once and removes
      // them; the recipients stay the ones captured at resolution.
      ctx.state.currentTurnPlayer = nextActivePlayer;
      queueStepTriggers(ctx, 'upkeep');

      expect(ctx.state.pendingTriggers).toHaveLength(2);
      expect(ctx.state.delayedTriggers).toHaveLength(0);
      expect(
        ctx.state.pendingTriggers.map((trigger) => trigger.scope?.eventPlayerId).sort(),
      ).toEqual(['P1', 'P4']);
      expect(ctx.state.pendingTriggers.every((trigger) => trigger.controllerId === 'P1')).toBe(
        true,
      );

      const optional = ctx.state.pendingTriggers.find(
        (trigger) => trigger.scope?.eventPlayerId === 'P4',
      )!;
      const mandatory = ctx.state.pendingTriggers.find(
        (trigger) => trigger.scope?.eventPlayerId === 'P1',
      )!;
      const { decisions: optionalDecisions } = resolvePending(ctx, optional, 2);
      const { decisions: mandatoryDecisions } = resolvePending(ctx, mandatory);

      expect(optionalDecisions.map((decision) => decision.player)).toEqual(['P4']);
      expect(mandatoryDecisions).toHaveLength(0);
      expect(ctx.state.players[3]!.hand).toHaveLength(2);
      expect(ctx.state.players[0]!.hand).toHaveLength(1);
    },
  );

  it('arcane-denial-fires-once-at-the-first-upkeep-only — later upkeeps queue nothing', () => {
    const ctx = pod('first-upkeep-only');
    resolveArcaneDirect(ctx, targetSpell(ctx, 'P4'));

    // P2's upkeep is the next turn's upkeep, so it consumes both `onFire` triggers.
    ctx.state.currentTurnPlayer = 'P2';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    expect(ctx.state.delayedTriggers).toHaveLength(0);

    // The affected player's own later upkeep must not fire them a second time.
    ctx.state.pendingTriggers = [];
    ctx.state.currentTurnPlayer = 'P4';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it.each([0, 1, 2])(
    'arcane-denial-affected-player-chooses-zero-one-or-two — routes draw-%i to the targeted spell controller',
    (chosen) => {
      const ctx = pod(`affected-draw-${chosen}`);
      resolveArcaneDirect(ctx, targetSpell(ctx, 'P4'));
      ctx.state.currentTurnPlayer = 'P4';
      queueStepTriggers(ctx, 'upkeep');
      const optional = ctx.state.pendingTriggers.find(
        (trigger) => trigger.scope?.eventPlayerId === 'P4',
      )!;
      const before = ctx.state.players[3]!.hand.length;
      const { decisions } = resolvePending(ctx, optional, chosen);

      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.player).toBe('P4');
      expect(decisions[0]?.options.map((option) => option.description)).toEqual([
        'Draw 0 cards',
        'Draw 1 card',
        'Draw 2 cards',
      ]);
      expect(ctx.state.players[3]!.hand).toHaveLength(before + chosen);
    },
  );

  it('arcane-denial-short-library-retains-zero-one-two-choice — offers all choices', () => {
    const ctx = pod('affected-draw-short-library');
    const affected = ctx.state.players[3]!;
    affected.library = [];
    resolveArcaneDirect(ctx, targetSpell(ctx, 'P4'));
    ctx.state.currentTurnPlayer = 'P4';
    queueStepTriggers(ctx, 'upkeep');
    const optional = ctx.state.pendingTriggers.find(
      (trigger) => trigger.scope?.eventPlayerId === 'P4',
    )!;
    const { decisions } = resolvePending(ctx, optional, 2);

    expect(decisions[0]?.options.map((option) => option.description)).toEqual([
      'Draw 0 cards',
      'Draw 1 card',
      'Draw 2 cards',
    ]);
    expect(affected.attemptedDrawFromEmptyLibrary).toBe(true);
  });

  it('arcane-denial-schedules-same-next-upkeep-caster-mandatory-draw — routes the mandatory card', () => {
    const ctx = pod('caster-mandatory');
    resolveArcaneDirect(ctx, targetSpell(ctx, 'P4'));
    ctx.state.currentTurnPlayer = 'P1';
    queueStepTriggers(ctx, 'upkeep');
    const mandatory = ctx.state.pendingTriggers.find(
      (trigger) => trigger.scope?.eventPlayerId === 'P1',
    )!;
    const before = ctx.state.players[0]!.hand.length;
    const { decisions } = resolvePending(ctx, mandatory);
    expect(decisions).toHaveLength(0);
    expect(ctx.state.players[0]!.hand).toHaveLength(before + 1);
  });

  it('arcane-denial-uncounterable-target-still-schedules-draws — captures controller at resolution', () => {
    const ctx = pod('uncounterable-controller-capture');
    const target = targetSpell(ctx, 'P3', { uncounterable: true });
    target.controllerId = 'P4';
    resolveArcaneDirect(ctx, target);

    expect(ctx.state.stack).toContain(target);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterPrevented')).toBe(true);
    expect(ctx.state.delayedTriggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ affectedPlayerId: 'P4' }),
        expect.objectContaining({ affectedPlayerId: 'P1' }),
      ]),
    );
  });

  it('arcane-denial-illegal-target-schedules-nothing — fizzles without delayed triggers', () => {
    const ctx = pod('illegal-target');
    ctx.state.stack.push({
      id: 'arcane-stack',
      sourceId: 'arcane-card',
      controllerId: 'P1',
      kind: 'spell',
      description: 'Arcane Denial',
      targets: ['missing-stack-object'],
      card: null,
      ability: definition().spellAbility!,
      sourceOracleId: pinned.card.oracleId,
      sourceCardId: 'arcane-card',
      isCommanderCast: false,
    });
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it('arcane-denial-simultaneous-trigger-order — uses the same-controller ordering decision', () => {
    const ctx = pod('simultaneous-ordering');
    resolveArcaneDirect(ctx, targetSpell(ctx, 'P4'));
    ctx.state.currentTurnPlayer = 'P4';
    queueStepTriggers(ctx, 'upkeep');
    const { decisions } = pump(priorityCheckpoint(ctx));
    const ordering = decisions.find((decision) => decision.decisionType === 'orderTriggers');
    expect(ordering?.player).toBe('P1');
    expect(ordering?.options).toHaveLength(2);
    expect(ctx.state.stack).toHaveLength(2);

    // Resolve both off the stack: neither trigger is a "you may" (the draw-up-to-two carries its
    // own 0/1/2 choice), so no yes/no is asked, only P4's choice of how many cards to draw.
    const resolved = [] as ReturnType<typeof pump>['decisions'];
    while (ctx.state.stack.length > 0) {
      resolved.push(
        ...pump(resolveTopOfStack(ctx), (decision) => ({
          index: decision.options.findIndex((option) => option.description === 'Draw 2 cards'),
          targets: new Map(),
        })).decisions,
      );
    }
    expect(resolved.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(resolved.map((decision) => decision.player)).toEqual(['P4']);
    expect(ctx.state.players[3]!.hand).toHaveLength(2);
    expect(ctx.state.players[0]!.hand).toHaveLength(1);
  });

  it('arcane-denial-delayed-routing-clone-hash-hidden-info — preserves state and privacy', () => {
    const ctx = pod('persistence-hidden-info');
    conjure(
      ctx,
      'P4',
      oracle({ name: 'Arcane Secret Beta', typeLine: 'Creature — Secret' }),
      'library',
    );
    conjure(
      ctx,
      'P4',
      oracle({ name: 'Arcane Secret Alpha', typeLine: 'Creature — Secret' }),
      'library',
    );
    resolveArcaneDirect(ctx, targetSpell(ctx, 'P4'));
    const canonical = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const cloned = structuredClone(ctx.state.delayedTriggers);
    const replayed = JSON.parse(JSON.stringify(ctx.state.delayedTriggers)) as typeof cloned;
    expect(cloned).toEqual(ctx.state.delayedTriggers);
    expect(canonical(replayed)).toBe(canonical(ctx.state.delayedTriggers));
    replayed[0]!.affectedPlayerId = 'P3';
    expect(canonical(replayed)).not.toBe(canonical(ctx.state.delayedTriggers));

    ctx.state.currentTurnPlayer = 'P4';
    queueStepTriggers(ctx, 'upkeep');
    for (const pending of [...ctx.state.pendingTriggers]) {
      resolvePending(ctx, pending, pending.scope?.eventPlayerId === 'P4' ? 2 : undefined);
    }
    const p4Names = ctx.state.players[3]!.hand.map((card) => card.name);
    expect(JSON.stringify(buildPlayerView(ctx, 'P4'))).toContain(p4Names[0]!);
    expect(JSON.stringify(buildPlayerView(ctx, 'P3'))).not.toContain(p4Names[0]!);
  });
});
