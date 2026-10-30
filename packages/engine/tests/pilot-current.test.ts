/**
 * The phase 6 pilot's current-workflow batch (`overrides/pilot-current.ts`): behavior tests per
 * card, through the cost, legality and resolution paths a real game takes.
 */
import { describe, expect, it } from 'vitest';
import {
  computePriorityOptions,
  costReductionFor,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { landPlayLimitFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { pinStore } from './scenario/pin-store';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerDef,
  spawn,
  swamp,
} from './fixtures';

/** A two-player game in P1's precombat main phase, turn 3, with empty boards. */
function mainPhase(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
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

const castable = (ctx: GameContext, objectId: string): boolean =>
  computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });

const spellCard = (name: string, manaCost: string, colors: Array<'B' | 'R'>) =>
  oracle({
    name,
    typeLine: 'Sorcery',
    manaCost,
    colors,
    colorIdentity: colors,
    oracleText: 'You gain 1 life.',
  });

describe('Jet Medallion', () => {
  const black = () => spellCard('Pilot Black Sorcery', '{1}{B}', ['B']);
  const red = () => spellCard('Pilot Red Sorcery', '{1}{R}', ['R']);
  const blackRed = () => spellCard('Pilot Black-Red Sorcery', '{1}{B}{R}', ['B', 'R']);
  const onlyBlack = () => spellCard('Pilot Pip Sorcery', '{B}', ['B']);

  it('jet-medallion-reduces-black — black spells you cast cost {1} less, a multicolored black one too', () => {
    const ctx = mainPhase('jet-medallion-black');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    for (const card of [black(), blackRed()]) registerDef(ctx, card);
    expect(costReductionFor(ctx, 'P1', black().oracleId, 'c-black').generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', blackRed().oracleId, 'c-black-red').generic).toBe(1);
  });

  it('jet-medallion-not-other-colors — a nonblack spell and an opponent’s black spell cost the same', () => {
    const ctx = mainPhase('jet-medallion-negative');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    for (const card of [black(), red()]) registerDef(ctx, card);
    expect(costReductionFor(ctx, 'P1', red().oracleId, 'c-red').generic).toBe(0);
    expect(costReductionFor(ctx, 'P2', black().oracleId, 'c-black').generic).toBe(0);
  });

  it('jet-medallion-castable — one Swamp casts a {1}{B} spell, and not a {1}{R} one or a {B}{B}', () => {
    const ctx = mainPhase('jet-medallion-castable');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    spawn(ctx, 'P1', swamp());
    const blackSpell = conjure(ctx, 'P1', black(), 'hand');
    const redSpell = conjure(ctx, 'P1', red(), 'hand');
    const twoPips = conjure(ctx, 'P1', spellCard('Pilot Two Pips', '{B}{B}', ['B']), 'hand');
    expect(castable(ctx, blackSpell.id)).toBe(true);
    expect(castable(ctx, redSpell.id)).toBe(false);
    // Only generic mana is reduced (CR 601.2f): {B}{B} still needs two black.
    expect(castable(ctx, twoPips.id)).toBe(false);
  });

  it('jet-medallion-colored-only — a spell whose cost is all {B} costs the same', () => {
    const ctx = mainPhase('jet-medallion-pip');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    registerDef(ctx, onlyBlack());
    expect(costReductionFor(ctx, 'P1', onlyBlack().oracleId, 'c-pip').generic).toBe(1);
    const pip = conjure(ctx, 'P1', onlyBlack(), 'hand');
    expect(castable(ctx, pip.id)).toBe(false);
    spawn(ctx, 'P1', swamp());
    expect(castable(ctx, pip.id)).toBe(true);
  });

  it('jet-medallion-without-it — the same {1}{B} spell needs two lands without the Medallion', () => {
    const ctx = mainPhase('jet-medallion-absent');
    spawn(ctx, 'P1', swamp());
    const blackSpell = conjure(ctx, 'P1', black(), 'hand');
    expect(castable(ctx, blackSpell.id)).toBe(false);
  });
});

describe('Explore', () => {
  const landPlayOffered = (ctx: GameContext): boolean =>
    computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
      (option) => (option.payload as PriorityActionPayload).kind === 'playLand',
    );
  /** Resolve Explore for P1, as its spell ability does on resolution. */
  const resolveExplore = (ctx: GameContext): void => {
    const card = pinStore.get('Explore');
    // A source P1 controls stands in for the resolving spell.
    pump(executeAbility(ctx, spawn(ctx, 'P1', card), interpretCard(card).spellAbility!, []));
  };

  it('explore-extra-land-play — after a land this turn, you may play one more, and you draw', () => {
    const ctx = mainPhase('explore-extra');
    conjure(ctx, 'P1', forest(), 'hand');
    const p1 = playerById(ctx, 'P1');
    p1.landsPlayedThisTurn = 1;
    expect(landPlayOffered(ctx)).toBe(false);
    const hand = p1.hand.length;
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P1')).toBe(2);
    expect(landPlayOffered(ctx)).toBe(true);
    expect(p1.hand.length).toBe(hand + 1);
  });

  it('explore-lapses — the extra land play is gone next turn', () => {
    const ctx = mainPhase('explore-lapse');
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P1')).toBe(2);
    ctx.state.turnNumber += 1;
    expect(landPlayLimitFor(ctx, 'P1')).toBe(1);
  });

  it('explore-twice — two Explores this turn give two more land plays', () => {
    const ctx = mainPhase('explore-twice');
    resolveExplore(ctx);
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P1')).toBe(3);
  });

  it('explore-only-you — an opponent gets no extra land play', () => {
    const ctx = mainPhase('explore-only-you');
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P2')).toBe(1);
  });
});
