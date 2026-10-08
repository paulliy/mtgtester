import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/counter-targets-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
type Cast = Extract<PriorityActionPayload, { kind: 'castSpell' }>;
function setup(card: OracleCard, targetController: PlayerId = 'P1', creature = false) {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  const targetPlayer = ctx.state.players.find((player) => player.id === targetController)!;
  const target = conjure(
    ctx,
    targetController,
    oracle({
      name: 'Counter target probe',
      typeLine: creature ? 'Creature' : 'Instant',
      manaCost: '{0}',
      power: creature ? '2' : null,
      toughness: creature ? '2' : null,
      oracleText: creature ? '' : 'You gain 3 life.',
    }),
    'hand',
  );
  ctx.state.priorityPlayerIndex = creature ? 0 : ctx.state.turnOrder.indexOf(targetController);
  pump(
    applyPriorityAction(
      ctx,
      targetPlayer,
      { kind: 'castSpell', objectId: target.id, fromCommand: false },
      { index: 0, targets: new Map() },
    ),
  );
  const targetSpell = ctx.state.stack[0]!;
  ctx.state.priorityPlayerIndex = 0;
  const counter = conjure(ctx, 'P1', card, 'hand');
  addMana(player, [{ symbol: 'U' }, { symbol: 'U' }, { symbol: 'U' }]);
  const options = () =>
    computePriorityOptions(ctx, player).filter(
      (option) =>
        (option.payload as Cast).kind === 'castSpell' &&
        (option.payload as Cast).objectId === counter.id,
    );
  const cast = (targetId: string) =>
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: counter.id, fromCommand: false },
        { index: 0, targets: new Map([[0, targetId]]) },
      ),
    );
  return { ctx, player, targetPlayer, target, targetSpell, counter, options, cast };
}

describe('counterspell target controller follows pinned Oracle clauses', () => {
  it('pins canonical Oracle identities and exact independent projections', () => {
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Counterspell',
      'Negate',
      'Mana Leak',
      'Stubborn Denial',
      'Force of Negation',
    ]);
    for (const entry of fixture.cards) {
      expect(entry.card.oracleId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(createHash('sha256').update(JSON.stringify(entry.card)).digest('hex')).toBe(
        entry.sha256,
      );
      expect(interpretCard(entry.card).spellAbility?.targets[0]?.controller).toBeUndefined();
    }
  });

  for (const { card } of fixture.cards) {
    const slug = card.name.toLowerCase().replaceAll(' ', '-');
    it.each(['P1', 'P2'] as const)(
      `${slug}-target-controller-%s: counters an unpaid spell through normal casting and resolution`,
      (controller) => {
        const state = setup(card, controller);
        expect(state.options()[0]?.targets?.[0]?.options).toContain(state.targetSpell.id);
        const beforeLife = state.targetPlayer.life;
        state.cast(state.targetSpell.id);
        expect(state.ctx.state.stack).toHaveLength(2);
        pump(resolveTopOfStack(state.ctx), (decision) => ({
          index: Math.max(
            0,
            decision.options.findIndex((option) => option.type === 'decline'),
          ),
          targets: new Map(),
        }));
        expect(state.ctx.state.stack).toHaveLength(0);
        expect(
          (card.name === 'Force of Negation'
            ? state.ctx.state.exile
            : state.targetPlayer.graveyard
          ).some((object) => object.cardId === state.target.cardId),
        ).toBe(true);
        expect(state.targetPlayer.life).toBe(beforeLife);
      },
    );

    it(`${slug}-reject-self: rejects its own proposed stack incarnation`, () => {
      const state = setup(card);
      const before = cloneContractContext(state.ctx);
      expect(() => state.cast(`o-${state.ctx.state.nextObjectNum}`)).toThrow();
      expect(state.ctx.state).toEqual(before.state);
      expect(state.player.hand).toContain(state.counter);
    });

    it(`${slug}-spell-only-targets: excludes an actual activated ability`, () => {
      const state = setup(card);
      const permanent = spawn(
        state.ctx,
        'P1',
        oracle({
          name: 'Counter ability probe',
          typeLine: 'Creature',
          manaCost: '{0}',
          power: '2',
          toughness: '2',
          oracleText: '{T}: You gain 1 life.',
        }),
      );
      const activation = computePriorityOptions(state.ctx, state.player).find(
        (option) =>
          (option.payload as PriorityActionPayload).kind === 'activateAbility' &&
          (option.payload as { objectId?: string }).objectId === permanent.id,
      )!;
      expect(activation).toBeDefined();
      pump(
        applyPriorityAction(state.ctx, state.player, activation.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      const ability = state.ctx.state.stack.at(-1)!;
      expect(ability.kind).toBe('activatedAbility');
      expect(state.options()[0]?.targets?.[0]?.options).not.toContain(ability.id);
      expect(() => state.cast(ability.id)).toThrow();
    });

    if (card.name === 'Mana Leak' || card.name === 'Stubborn Denial') {
      it.each(['P1', 'P2'] as const)(
        `${slug}-controller-pays-%s: the target's controller can pay the tax`,
        (controller) => {
          const state = setup(card, controller);
          state.cast(state.targetSpell.id);
          const tax = card.name === 'Mana Leak' ? 3 : 1;
          addMana(
            state.targetPlayer,
            Array.from({ length: tax }, () => ({ symbol: 'U' as const })),
          );
          const beforeMana = state.targetPlayer.manaEntries.length;
          pump(resolveTopOfStack(state.ctx), (decision) => ({
            index: decision.options.findIndex((option) => option.type === 'payCost'),
            targets: new Map(),
          }));
          expect(state.ctx.state.stack.map((entry) => entry.id)).toEqual([state.targetSpell.id]);
          expect(state.targetPlayer.manaEntries).toHaveLength(beforeMana - tax);
        },
      );
    }

    if (card.name === 'Stubborn Denial') {
      it.each(['P1', 'P2'] as const)(
        `${slug}-ferocious-%s: no tax decision with a power-four creature at resolution`,
        (controller) => {
          const state = setup(card, controller);
          state.cast(state.targetSpell.id);
          spawn(
            state.ctx,
            'P1',
            oracle({
              name: 'Ferocious probe',
              typeLine: 'Creature',
              manaCost: '{0}',
              power: '4',
              toughness: '4',
            }),
          );
          addMana(state.targetPlayer, [{ symbol: 'U' }]);
          const result = pump(resolveTopOfStack(state.ctx));
          expect(result.decisions).toHaveLength(0);
          expect(state.ctx.state.stack).toHaveLength(0);
        },
      );
    }
  }

  it.each(['Negate', 'Stubborn Denial', 'Force of Negation'])(
    '%s-reject-creature: a noncreature counter rejects a creature spell',
    (name) => {
      const card = fixture.cards.find(({ card }) => card.name === name)!.card;
      const state = setup(card, 'P1', true);
      expect(state.options()).toHaveLength(0);
      expect(() => state.cast(state.targetSpell.id)).toThrow();
      const unrestricted = setup(fixture.cards[0]!.card, 'P1', true);
      expect(unrestricted.options()[0]?.targets?.[0]?.options).toContain(
        unrestricted.targetSpell.id,
      );
    },
  );
});

it('the pinned Force of Negation clause does not invent a controller restriction and preserves the printed alternative', () => {
  const { card, sha256 } = JSON.parse(
    readFileSync('packages/engine/tests/fixtures/force-negation-review-oracle.json', 'utf8'),
  ) as { card: OracleCard; sha256: string };
  expect(card.oracleId).toBe('ac2173f9-f223-440a-9231-fd98762bdc6f');
  expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
  const definition = interpretCard(card);
  expect(definition.modeled).toBe(true);
  expect(definition.spellAbility?.targets).toEqual([{ kind: 'noncreatureSpell' }]);
  expect(sha256).toBe('b8a0dc17dcd160b416c672ab9e916b5615465e19a3d3a4a2bddcc23138561cf4');
  expect(definition.alternativeCasts).toHaveLength(1);
  expect(
    interpretCard({ ...card, oracleId: 'fixture-force-negation-review' }).spellAbility?.targets,
  ).toEqual([{ kind: 'noncreatureSpell' }]);
});
