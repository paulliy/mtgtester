import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { spell, triggered, whenEnters } from '../src/cards/templates';
import { SOLDIER_1_1, SERVO_1_1 } from '../src/cards/tokens';
import { constant } from '../src/cards/value';
import { ofType } from '../src/cards/selector';
import { countPermanents, type Condition } from '../src/cards/condition';
import { computeCharacteristics } from '../src/effects/continuous';
import { playerById } from '../src/state/objects';
import { oracle, registerCustomDef, spawn } from './fixtures';
import {
  sharedOpponentPod,
  castSharedOpponentSpell,
  settleSharedOpponentSpell,
} from './shared-opponent-fixtures';

function fixture(ctx: ReturnType<typeof sharedOpponentPod>, count: number, amount: number) {
  const lines = [
    `Choose an opponent. You and that player each create ${count} 1/1 white Soldier creature tokens.`,
    `Choose an opponent. You gain ${amount} life for each creature you control and that player gains ${amount} life for each creature they control.`,
  ];
  const card = oracle({
    name: 'Independent shared-opponent probe',
    typeLine: 'Instant',
    manaCost: '{3}{W}',
    oracleText: lines.join('\n'),
  });
  const base = interpretCard(card);
  expect(base.unmodeledReasons).toHaveLength(2);
  const remaining = base.unmodeledReasons.filter(
    (reason) => !lines.some((line) => reason.includes(line)),
  );
  expect(remaining).toEqual([]);
  registerCustomDef(ctx, {
    ...base,
    modeled: remaining.length === 0,
    unmodeledReasons: remaining,
    spellAbility: spell({
      effects: [
        { op: 'shareTokensWithChosenOpponent', spec: SOLDIER_1_1, count: constant(count) },
        { op: 'shareCreatureLifeWithChosenOpponent', amount: constant(amount) },
      ],
    }),
  });
  return card;
}
describe('independent shared-opponent effect contracts', () => {
  it('shared-opponent-simultaneous-life-observation — the first life event sees both updated totals', () => {
    const ctx = sharedOpponentPod();
    const card = fixture(ctx, 0, 4);
    const text =
      'Whenever a player gains life, if you have 44 or more life, create a 1/1 colorless Servo artifact creature token.';
    const watcher = oracle({
      name: 'Simultaneous life observer',
      typeLine: 'Artifact',
      oracleText: text,
    });
    const base = interpretCard(watcher);
    expect(base.unmodeledReasons).toHaveLength(1);
    const remaining = base.unmodeledReasons.filter((reason) => !reason.includes(text));
    expect(remaining).toEqual([]);
    registerCustomDef(ctx, {
      ...base,
      modeled: remaining.length === 0,
      unmodeledReasons: remaining,
      triggers: [
        triggered(
          { when: 'gainsLife', player: 'each' },
          {
            condition: {
              kind: 'compareValues',
              left: { kind: 'lifeTotal', scope: 'you' },
              cmp: '>=',
              right: constant(44),
            },
            effects: [{ op: 'createToken', spec: SERVO_1_1, count: constant(1) }],
          },
        ),
      ],
    });
    spawn(ctx, 'P2', watcher);
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx, ['P2', 'P2']);
    expect(ctx.state.players.map((player) => player.life)).toEqual([44, 44, 40, 40]);
    expect(
      ctx.state.battlefield.filter(
        (permanent) => permanent.isToken && permanent.controllerId === 'P2',
      ),
    ).toHaveLength(2);
  });
  it.each([0, 1, 2])(
    'shared-opponent-count-%i — real casts keep creator ownership and evaluate independent recipient life totals',
    (count) => {
      const ctx = sharedOpponentPod();
      const card = fixture(ctx, count, 3);
      castSharedOpponentSpell(ctx, card);
      settleSharedOpponentSpell(ctx);
      for (const id of ['P1', 'P2'])
        expect(
          ctx.state.battlefield.filter(
            (permanent) =>
              permanent.isToken && permanent.ownerId === id && permanent.controllerId === id,
          ),
        ).toHaveLength(count);
      expect(ctx.state.players.map((player) => player.life)).toEqual([
        40 + 3 * (1 + count),
        40,
        43,
        40,
      ]);
    },
  );
  it('shared-opponent-simultaneous-token-entry — every token entry observer sees the complete pair of batches', () => {
    const ctx = sharedOpponentPod();
    const card = fixture(ctx, 2, 1);
    const watcher = oracle({ name: 'Shared batch observer', typeLine: 'Artifact' });
    registerCustomDef(ctx, {
      ...interpretCard(watcher),
      triggers: [
        triggered(whenEnters(ofType('Creature')), {
          condition: countPermanents(ofType('Creature'), 'all', '>=', 8),
          effects: [{ op: 'gainLife', amount: constant(1) }],
        }),
      ],
    });
    spawn(ctx, 'P4', watcher);
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx);
    expect(ctx.state.players.map((player) => player.life)).toEqual([43, 40, 41, 44]);
  });
  it('shared-opponent-zero-life — zero gains do not fabricate life events or transfer another player total', () => {
    const ctx = sharedOpponentPod();
    const card = fixture(ctx, 1, 0);
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx);
    expect(ctx.state.players.map((player) => player.life)).toEqual([40, 40, 40, 40]);
    expect(ctx.state.eventLog.filter((event) => event.type === 'lifeGain')).toEqual([]);
  });
  it('shared-opponent-frozen-life-counts — the first gain cannot animate an extra creature for the second recipient', () => {
    const ctx = sharedOpponentPod();
    const card = fixture(ctx, 0, 4);
    const text =
      'As long as you have 44 or more life, artifacts are creatures with base power and toughness 1/1.';
    const animator = oracle({
      name: 'Life-driven Animator',
      typeLine: 'Creature — Artificer',
      power: '2',
      toughness: '2',
      oracleText: text,
    });
    const base = interpretCard(animator);
    expect(base.unmodeledReasons).toHaveLength(1);
    const remaining = base.unmodeledReasons.filter((reason) => !reason.includes(text));
    expect(remaining).toEqual([]);
    const condition: Condition = {
      kind: 'compareValues',
      left: { kind: 'lifeTotal', scope: 'you' },
      cmp: '>=',
      right: constant(44),
    };
    registerCustomDef(ctx, {
      ...base,
      modeled: remaining.length === 0,
      unmodeledReasons: remaining,
      staticEffects: [
        { affects: ofType('Artifact'), condition, op: { layer: 4, addTypes: ['Creature'] } },
        {
          affects: ofType('Artifact'),
          condition,
          op: { layer: 7, sublayer: 'b', power: constant(1), toughness: constant(1) },
        },
      ],
    });
    spawn(ctx, 'P1', animator);
    const relic = spawn(ctx, 'P2', oracle({ name: 'Later Creature Relic', typeLine: 'Artifact' }));
    expect(computeCharacteristics(ctx, relic).types).not.toContain('Creature');
    castSharedOpponentSpell(ctx, card);
    settleSharedOpponentSpell(ctx, ['P2', 'P2']);
    expect(playerById(ctx, 'P1').life).toBe(48);
    expect(playerById(ctx, 'P2').life).toBe(44);
    expect(computeCharacteristics(ctx, relic).types).toContain('Creature');
  });
});
