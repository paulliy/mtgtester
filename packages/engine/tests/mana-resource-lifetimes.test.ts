import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { Engine } from '../src/engine';
import { interpretCard } from '../src/cards/interpret';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import { planPayment, parseManaCost } from '../src/mana/cost';
import { conjure, copies, forest, gameConfig, pump, spawn } from './fixtures';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };
const real = (name: string) => {
  const card = fixture.cards.map((entry) => entry.card).find((c) => c.name === name);
  if (!card) throw new Error(`Missing fixture: ${name}`);
  expect(interpretCard(card).modeled, JSON.stringify(interpretCard(card).unmodeledReasons)).toBe(
    true,
  );
  return card;
};

function pod() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(6, forest) }))));
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

describe('mana payment shared resources and source lifetimes', () => {
  it('Phyrexian Tower must allow its chosen sacrifice to produce mana first', () => {
    const tower = real('Phyrexian Tower');
    const elves = real('Llanowar Elves');
    const cultivate = real('Cultivate');
    const engine = new Engine(
      gameConfig([
        { cards: [tower, elves, cultivate, ...copies(7, forest)] },
        { cards: copies(8, forest) },
      ]),
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 4,
          hand: [{ playerId: 'P1', cardNames: [cultivate.name] }],
          battlefield: [{ playerId: 'P1', cardNames: [tower.name, elves.name] }],
        },
      },
    );
    const step = engine.advance();
    expect(step.kind).toBe('decision');
    if (step.kind !== 'decision') throw new Error('Expected priority');
    const cast = step.request.legalActions.find(
      (a) => a.type === 'castSpell' && a.description.includes(cultivate.name),
    );
    expect(cast).toBeDefined();
    engine.submit({ requestId: step.request.requestId, actionId: cast!.id });
    // The only sacrifice is auto-resolved; the public engine must reach the next priority
    // window after tapping the Elf for G, then sacrificing it to Tower for BB.
    let error: unknown;
    try {
      engine.advance();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeUndefined();
    expect(engine.getState().players[0]!.graveyard.some((p) => p.name === elves.name)).toBe(true);
    expect(
      engine.getState().stack.some((p) => p.description.includes(cultivate.name)) ||
        engine.getState().players[0]!.graveyard.some((p) => p.name === cultivate.name),
    ).toBe(true);
  });

  it('Ashnod Altar may be activated twice to cast Hedron Archive', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real("Ashnod's Altar"));
    spawn(ctx, 'P1', real('Solemn Simulacrum'));
    spawn(ctx, 'P1', real('Solemn Simulacrum'));
    const archive = conjure(ctx, 'P1', real('Hedron Archive'), 'hand');
    const player = ctx.state.players[0]!;
    const options = computePriorityOptions(ctx, player);
    const cast = options.find(
      (a) => a.type === 'castSpell' && a.description.includes(archive.name),
    );
    const plan = planPayment(
      parseManaCost('{4}' as never).cost!,
      player.manaEntries,
      manaSourcesFor(ctx, 'P1'),
    );
    expect(cast).toBeDefined();
    expect(plan?.tapSources).toHaveLength(2);
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack.some((p) => p.description.includes(archive.name))).toBe(true);
    expect(player.graveyard.filter((p) => p.name === 'Solemn Simulacrum')).toHaveLength(2);
    expect(player.manaEntries).toEqual([]);
  });

  it('Altar cannot reuse a sacrificed creature to pay a larger cost', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real("Ashnod's Altar"));
    spawn(ctx, 'P1', real('Solemn Simulacrum'));
    spawn(ctx, 'P1', real('Solemn Simulacrum'));
    expect(
      planPayment(parseManaCost('{5}' as never).cost!, [], manaSourcesFor(ctx, 'P1')),
    ).toBeNull();
  });

  it('two Mana Confluences cannot each spend the same last point of life', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real('Mana Confluence'));
    spawn(ctx, 'P1', real('Mana Confluence'));
    const target = spawn(ctx, 'P2', real('Solemn Simulacrum'));
    const trophy = conjure(ctx, 'P1', real("Assassin's Trophy"), 'hand');
    const player = ctx.state.players[0]!;
    player.life = 1;
    const cast = computePriorityOptions(ctx, player).find(
      (a) => a.type === 'castSpell' && a.description.includes(trophy.name),
    );
    if (cast) {
      pump(
        applyPriorityAction(ctx, player, cast.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map([[0, target.id]]),
        }),
      );
    }
    expect(cast).toBeUndefined();
  });

  it('control: two Mana Confluences can pay with two available life', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real('Mana Confluence'));
    spawn(ctx, 'P1', real('Mana Confluence'));
    const target = spawn(ctx, 'P2', real('Solemn Simulacrum'));
    const trophy = conjure(ctx, 'P1', real("Assassin's Trophy"), 'hand');
    const player = ctx.state.players[0]!;
    player.life = 2;
    const cast = computePriorityOptions(ctx, player).find(
      (a) => a.type === 'castSpell' && a.description.includes(trophy.name),
    );
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, target.id]]),
      }),
    );
    expect(player.life).toBe(0);
    expect(ctx.state.stack.some((p) => p.description.includes(trophy.name))).toBe(true);
  });

  it('control: one Altar activation suffices to cast Sol Ring', () => {
    const ctx = pod();
    spawn(ctx, 'P1', real("Ashnod's Altar"));
    const fodder = spawn(ctx, 'P1', real('Solemn Simulacrum'));
    const ring = conjure(ctx, 'P1', real('Sol Ring'), 'hand');
    const player = ctx.state.players[0]!;
    const cast = computePriorityOptions(ctx, player).find(
      (a) => a.type === 'castSpell' && a.description.includes(ring.name),
    );
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(player.graveyard.some((p) => p.cardId === fodder.cardId)).toBe(true);
    expect(player.manaEntries).toEqual([{ symbol: 'C' }]);
    expect(ctx.state.stack.some((p) => p.description.includes(ring.name))).toBe(true);
  });
});
