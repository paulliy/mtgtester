import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { isForced, type EngineActionOption } from '../src/decisions';
import { manualManaPlan, type ActivateManaAbilityPayload } from '../src/mana/manual';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const painland = () =>
  oracle({
    name: 'Test Wastes',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}.\n{T}: Add {W} or {U}. This land deals 1 damage to you.',
  });

const tomb = () =>
  oracle({
    name: 'Test Tomb',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}{C}. This land deals 2 damage to you.',
  });

const bear = () => oracle({ name: 'Test Bear', manaCost: '{1}', cmc: 1 });

/** P1's main phase, with P1 opted in to manual mana unless `manual` is false. */
function setup(manual = true): { ctx: GameContext; player: GameContext['state']['players'][0] } {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'manual-mana' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const player = ctx.state.players.find((p) => p.id === 'P1')!;
  if (manual) player.manualMana = true;
  return { ctx, player };
}

const manaOptions = (ctx: GameContext, player: GameContext['state']['players'][0]) =>
  computePriorityOptions(ctx, player).filter((option) => option.type === 'activateManaAbility');

function apply(ctx: GameContext, option: EngineActionOption): void {
  const player = ctx.state.players.find((p) => p.id === 'P1')!;
  pump(
    applyPriorityAction(ctx, player, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

describe('manual mana activation (ADR 0030)', () => {
  it('is offered only to a player who opted in', () => {
    const bot = setup(false);
    spawn(bot.ctx, 'P1', forest());
    expect(manaOptions(bot.ctx, bot.player)).toEqual([]);

    const human = setup();
    spawn(human.ctx, 'P1', forest());
    expect(manaOptions(human.ctx, human.player).map((option) => option.description)).toEqual([
      'Forest: add {G}',
    ]);
  });

  it('offers one option per mana a source can make, and none for a tapped source', () => {
    const { ctx, player } = setup();
    spawn(ctx, 'P1', painland());
    spawn(ctx, 'P1', tomb());
    spawn(ctx, 'P1', forest(), { tapped: true });
    expect(manaOptions(ctx, player).map((option) => option.description)).toEqual([
      'Test Wastes: add {C}',
      'Test Wastes: add {W}',
      'Test Wastes: add {U}',
      'Test Tomb: add {C}{C}',
    ]);
  });

  it('taps the source, floats its mana and applies its rider', () => {
    const { ctx, player } = setup();
    const wastes = spawn(ctx, 'P1', painland());
    const life = player.life;
    const white = manaOptions(ctx, player).find((o) => o.description === 'Test Wastes: add {W}')!;
    apply(ctx, white);
    expect(wastes.tapped).toBe(true);
    expect(player.manaPool.W).toBe(1);
    expect(player.life).toBe(life - 1);
    expect(manaOptions(ctx, player)).toEqual([]);
    expect(ctx.state.eventLog.at(-1)).toMatchObject({
      type: 'manaAbilityActivated',
      actorSeat: 'P1',
      payload: { name: 'Test Wastes', mana: '{W}' },
    });
  });

  it('pays the next spell from the floating mana before tapping anything else', () => {
    const { ctx, player } = setup();
    const first = spawn(ctx, 'P1', forest());
    const second = spawn(ctx, 'P1', forest());
    const card = conjure(ctx, 'P1', bear(), 'hand');
    const tapSecond = manaOptions(ctx, player).find(
      (option) => (option.payload as ActivateManaAbilityPayload).cardId === second.cardId,
    )!;
    apply(ctx, tapSecond);
    expect(second.tapped).toBe(true);
    expect(player.manaPool.G).toBe(1);

    const cast = computePriorityOptions(ctx, player).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === card.id,
    )!;
    apply(ctx, cast);
    expect(first.tapped).toBe(false);
    expect(player.manaPool.G).toBe(0);
  });

  it('keeps a window of only passes and mana abilities quiet', () => {
    const { ctx, player } = setup();
    spawn(ctx, 'P1', forest());
    const options = computePriorityOptions(ctx, player);
    expect(options.some((option) => option.type === 'activateManaAbility')).toBe(true);
    expect(isForced({ decisionType: 'priority', player: 'P1', prompt: '', options })).toBe(true);

    conjure(ctx, 'P1', bear(), 'hand');
    const withSpell = computePriorityOptions(ctx, player);
    expect(
      isForced({ decisionType: 'priority', player: 'P1', prompt: '', options: withSpell }),
    ).toBe(false);
  });

  it('refuses mana the source cannot make, or a source that is already tapped', () => {
    const { ctx, player } = setup();
    const land = spawn(ctx, 'P1', forest());
    const forged: ActivateManaAbilityPayload = {
      kind: 'activateManaAbility',
      cardId: land.cardId,
      ability: 0,
      symbols: ['U'],
    };
    expect(() => manualManaPlan(ctx, 'P1', player, forged)).toThrow(/cannot make that mana/);
    land.tapped = true;
    expect(() => manualManaPlan(ctx, 'P1', player, { ...forged, symbols: ['G'] })).toThrow(
      /cannot be activated now/,
    );
  });
});
