import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { evaluateValueIn } from '../src/effects/values';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const base = () =>
  interpretCard(
    oracle({
      name: 'Independent event-player authoring witness',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
  );
const effects: Effect[] = [
  { op: 'draw', count: { kind: 'const', n: 1 }, player: 'eventPlayer' },
  { op: 'drawUpToN', count: 1, player: 'eventPlayer' },
  { op: 'manifestTop', player: 'eventPlayer' },
  { op: 'loseLifeTarget', target: 'eventPlayer', amount: { kind: 'const', n: 1 } },
  { op: 'gainLife', amount: { kind: 'lifeTotal', scope: 'eventPlayer' } },
];
describe('event-player references require a bound owning context', () => {
  for (const draws of [0, 1])
    it(`a normal opponent cast evaluates its event-player condition with ${draws} earlier draws`, () => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = 'P2';
      ctx.state.activePlayerIndex = 1;
      ctx.state.phase = 'precombatMain';
      ctx.state.players[0]!.cardsDrawnThisTurn = 9;
      ctx.state.players[1]!.cardsDrawnThisTurn = draws;
      const watcher = spawn(
        ctx,
        'P1',
        oracle({ name: 'Independent caster condition witness', typeLine: 'Enchantment' }),
      );
      const def = {
        ...ctx.defs.get(watcher.oracleId)!,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: {
              when: 'castsSpell' as const,
              caster: 'each' as const,
              condition: { kind: 'eventPlayerDrawCount' as const, cmp: '==' as const, n: 1 },
            },
            targets: [],
            effects: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 3 } }],
          },
        ],
      };
      expect(validateCardDefinition(def)).toEqual([]);
      ctx.defs.set(watcher.oracleId, def);
      const card = conjure(
        ctx,
        'P2',
        oracle({
          name: 'Independent opponent cast',
          typeLine: 'Instant',
          manaCost: '{0}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      pump(
        applyPriorityAction(
          ctx,
          ctx.state.players[1]!,
          { kind: 'castSpell', objectId: card.id, fromCommand: false },
          { index: 0, targets: new Map() },
        ),
      );
      pump(runPrioritySequence(ctx));
      expect(ctx.state.players[0]!.life).toBe(draws === 1 ? 43 : 40);
      expect(ctx.state.players[1]!.life).toBe(41);
    });

  for (const effect of effects)
    for (const owner of ['spell', 'entry', 'unscoped delayed'] as const)
      it(`${effect.op} rejects an unbound ${owner} event player`, () => {
        const ability = { kind: 'spell' as const, targets: [], effects: [effect] };
        const def =
          owner === 'spell'
            ? { ...base(), spellAbility: ability }
            : owner === 'entry'
              ? {
                  ...base(),
                  spellAbility: null,
                  triggers: [
                    {
                      ...ability,
                      kind: 'triggered' as const,
                      trigger: { when: 'enters' as const, subject: { kind: 'self' as const } },
                    },
                  ],
                }
              : {
                  ...base(),
                  spellAbility: {
                    ...ability,
                    effects: [
                      {
                        op: 'registerDelayedTrigger' as const,
                        when: 'upkeep' as const,
                        expiry: 'onFire' as const,
                        ability: { ...ability, kind: 'triggered' as const },
                      },
                    ],
                  },
                };
        expect(
          validateCardDefinition(def).some((issue) => issue.message.includes('event player')),
        ).toBe(true);
      });
  it('an explicit event-player life-total read cannot fall back to the ability controller', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    expect(() =>
      evaluateValueIn(ctx, { kind: 'lifeTotal', scope: 'eventPlayer' }, { controllerId: 'P1' }),
    ).toThrow('event player');
    expect(evaluateValueIn(ctx, { kind: 'lifeTotal' }, { controllerId: 'P1' })).toBe(40);
  });
  for (const turnPlayer of ['P1', 'P2'] as const)
    it(`an ordinary end-step trigger binds the active ${turnPlayer} for values and draw routing`, () => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      ctx.state.currentTurnPlayer = turnPlayer;
      ctx.state.phase = 'ending';
      ctx.state.step = 'end';
      const watcher = spawn(
        ctx,
        'P1',
        oracle({ name: 'Independent each-end-step player witness', typeLine: 'Enchantment' }),
      );
      const recipient = ctx.state.players.find((player) => player.id === turnPlayer)!;
      recipient.life = 7;
      const original = ctx.state.players[0]!.life;
      const hands = ctx.state.players.map((player) => player.hand.length);
      const def = {
        ...ctx.defs.get(watcher.oracleId)!,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: { when: 'endStep' as const, player: 'each' as const },
            targets: [],
            effects: [effects[4]!, effects[0]!],
          },
        ],
      };
      expect(validateCardDefinition(def)).toEqual([]);
      ctx.defs.set(watcher.oracleId, def);
      queueStepTriggers(ctx, 'endStep');
      pump(runPrioritySequence(ctx));
      expect(ctx.state.players[0]!.life).toBe(original + 7);
      ctx.state.players.forEach((player, index) =>
        expect(player.hand).toHaveLength(hands[index]! + (player.id === turnPlayer ? 1 : 0)),
      );
    });
});
