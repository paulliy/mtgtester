import { describe, expect, it } from 'vitest';
import type { Effect, TargetSpec } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup() {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  let sequence = 0;
  function cast(effects: Effect[], targets: TargetSpec[] = [], ids: string[] = []) {
    const card = conjure(
      ctx,
      'P1',
      oracle({
        name: `Independent specialized response ${sequence++}`,
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const def = {
      ...ctx.defs.get(card.oracleId)!,
      spellAbility: { kind: 'spell' as const, targets, effects },
    };
    expect(validateCardDefinition(def)).toEqual([]);
    ctx.defs.set(card.oracleId, def);
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: card.id, fromCommand: false },
        { index: 0, targets: new Map(ids.map((id, index) => [index, id])) },
      ),
    );
    pump(resolveTopOfStack(ctx));
  }
  return { ctx, player, cast };
}

describe('specialized instructions preserve shared object and payment contracts', () => {
  for (const repeats of [1, 2])
    it(`a normal spell moving one commander ${repeats} times never substitutes another command-zone card`, () => {
      const { ctx, player, cast } = setup();
      const chosen = conjure(
        ctx,
        'P1',
        oracle({ name: 'Independent chosen commander', typeLine: 'Legendary Creature' }),
        'command',
        { isCommander: true },
      );
      const other = conjure(
        ctx,
        'P1',
        oracle({ name: 'Independent other commander', typeLine: 'Legendary Creature' }),
        'command',
        { isCommander: true },
      );
      player.commanderCardIds.push(chosen.cardId, other.cardId);
      const before = player.commandZone.length;
      cast(
        Array.from({ length: repeats }, (): Effect => ({
          op: 'commandZoneToBattlefield',
          target: 0,
        })),
        [{ kind: 'commanderInCommandZone' }],
        [chosen.id],
      );
      expect(ctx.state.battlefield.some((object) => object.cardId === chosen.cardId)).toBe(true);
      expect(player.commandZone).toHaveLength(before - 1);
      expect(player.commandZone).toContain(other);
    });
  for (const movement of ['stayed', 'exiled', 'returned'] as const)
    it(`a normal death-trigger counter transfer uses the departing facts after the card ${movement}`, () => {
      const { ctx, cast } = setup();
      const watcher = spawn(
        ctx,
        'P1',
        oracle({ name: 'Independent departed counter watcher', typeLine: 'Enchantment' }),
      );
      const recipient = spawn(ctx, 'P1', oracle({ name: 'Independent counter recipient' }));
      const victim = spawn(ctx, 'P1', oracle({ name: 'Independent departing counter creature' }));
      victim.counters['charge'] = 2;
      const base = ctx.defs.get(watcher.oracleId)!;
      const def = {
        ...base,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: {
              when: 'dies' as const,
              subject: {
                kind: 'permanent' as const,
                selector: { kind: 'type' as const, value: 'Creature' },
              },
            },
            targets: [{ kind: 'creature' as const }],
            effects: [{ op: 'transferCountersFromTriggerObject' as const, target: 0 }],
          },
        ],
      };
      expect(validateCardDefinition(def)).toEqual([]);
      ctx.defs.set(watcher.oracleId, def);
      cast([{ op: 'destroy', target: 0 }], [{ kind: 'creature' }], [victim.id]);
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      ctx.defs.set(watcher.oracleId, base);
      const grave = ctx.state.players[0]!.graveyard.find((card) => card.cardId === victim.cardId)!;
      if (movement === 'exiled')
        cast([{ op: 'exileCard', target: 0 }], [{ kind: 'cardInGraveyard' }], [grave.id]);
      if (movement === 'returned') {
        cast(
          [{ op: 'graveyardToBattlefield', target: 0 }],
          [{ kind: 'cardInGraveyard' }],
          [grave.id],
        );
        ctx.state.battlefield.find((object) => object.cardId === victim.cardId)!.counters[
          'charge'
        ] = 9;
      }
      pump(runPrioritySequence(ctx), (decision) => ({
        index: 0,
        targets:
          decision.decisionType === 'chooseTargets' ? new Map([[0, recipient.id]]) : new Map(),
      }));
      expect(recipient.counters['charge']).toBe(2);
    });
  for (const movement of ['live', 'blinked', 'destroyed', 'unfunded', 'declined', 'zero'] as const)
    it(`normal entry-trigger life payment respects a ${movement} event object`, () => {
      const { ctx, player, cast } = setup();
      const watcher = spawn(
        ctx,
        'P1',
        oracle({ name: 'Independent optional life watcher', typeLine: 'Enchantment' }),
      );
      const base = ctx.defs.get(watcher.oracleId)!;
      const def = {
        ...base,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: {
              when: 'enters' as const,
              subject: {
                kind: 'permanent' as const,
                selector: { kind: 'type' as const, value: 'Creature' },
              },
            },
            targets: [],
            effects: [{ op: 'mayPayLifeForTriggerPowerAndCounter' as const }],
          },
        ],
      };
      expect(validateCardDefinition(def)).toEqual([]);
      ctx.defs.set(watcher.oracleId, def);
      const creature = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Independent optional-life entrant',
          manaCost: '{0}',
          power: movement === 'zero' ? '0' : '2',
          toughness: '2',
        }),
        'hand',
      );
      pump(
        applyPriorityAction(
          ctx,
          player,
          { kind: 'castSpell', objectId: creature.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      );
      pump(resolveTopOfStack(ctx));
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      ctx.defs.set(watcher.oracleId, base);
      const first = ctx.state.battlefield.find((object) => object.cardId === creature.cardId)!;
      if (movement === 'blinked' || movement === 'destroyed')
        cast(
          [{ op: movement === 'blinked' ? 'blinkTarget' : 'destroy', target: 0 }],
          [{ kind: 'creature' }],
          [first.id],
        );
      if (movement === 'unfunded') player.life = 1;
      const before = player.life;
      let offeredPayment = false;
      pump(runPrioritySequence(ctx), (decision) => {
        const index = decision.options.findIndex((option) => option.type === 'payLife');
        if (index >= 0) offeredPayment = true;
        const decline = decision.options.findIndex((option) => option.type === 'decline');
        return {
          index: movement === 'declined' && decline >= 0 ? decline : index >= 0 ? index : 0,
          targets: new Map(),
        };
      });
      const current = ctx.state.battlefield.find((object) => object.cardId === creature.cardId);
      if (movement === 'unfunded') {
        expect(offeredPayment).toBe(false);
        expect(player.life).toBe(before);
      } else if (movement === 'declined' || movement === 'zero') expect(player.life).toBe(before);
      else expect(player.life).toBe(before - 2);
      expect(current?.counters['+1/+1'] ?? 0).toBe(movement === 'live' ? 2 : 0);
    });
});
