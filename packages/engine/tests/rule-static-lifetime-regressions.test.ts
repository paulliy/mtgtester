import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { hasNoMaximumHandSize } from '../src/state/queries';
import { resolveTopOfStack } from '../src/stack/stack';
import { runTurn } from '../src/turn/turn';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  mountain,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };
const tower = fixture.cards
  .map((entry) => entry.card)
  .find((card) => card.name === 'Reliquary Tower')!;
// Blood Moon is not in the coverage deck fixture. Supply its complete printed rules text
// to the ordinary interpreter, rather than injecting a CardDefinition or a layer operation.
const moon = oracle({
  name: 'Blood Moon',
  typeLine: 'Enchantment',
  manaCost: '{2}{R}',
  cmc: 3,
  colors: ['R'],
  colorIdentity: ['R'],
  power: null,
  toughness: null,
  oracleText: 'Nonbasic lands are Mountains.',
});

describe('printed rule statics versus computed ability removal', () => {
  it.each([
    [true, true],
    [false, true],
    [true, false],
  ])('cleanup with Blood Moon=%s, Reliquary Tower=%s', (castMoon, hasTower) => {
    expect(interpretCard(tower).modeled).toBe(true);
    expect(interpretCard(moon).modeled).toBe(true);
    const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(6, forest) }))));
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P1',
      activePlayerIndex: 0,
      turnNumber: 4,
      phase: 'precombatMain',
      step: null,
    });
    const permanent = hasTower ? spawn(ctx, 'P1', tower) : undefined;
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', mountain());
    const player = ctx.state.players[0]!;
    for (let i = 0; i < 8; i++) conjure(ctx, 'P1', forest(), 'hand');
    if (castMoon) {
      const card = conjure(ctx, 'P1', moon, 'hand');
      const cast = computePriorityOptions(ctx, player).find(
        (option) => option.type === 'castSpell' && option.description.includes(card.name),
      )!;
      expect(cast).toBeDefined();
      pump(
        applyPriorityAction(ctx, player, cast.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      pump(resolveTopOfStack(ctx));
    }
    const characteristics =
      permanent === undefined ? undefined : computeCharacteristics(ctx, permanent);
    if (characteristics) {
      expect(characteristics.loseAbilities).toBe(castMoon);
      expect(characteristics.manaAbilities).toEqual(
        castMoon ? [{ units: [['R']] }] : interpretCard(tower).manaAbilities,
      );
    }
    // Run a whole ordinary turn after the cast, including normal draw and cleanup. Every
    // priority response passes; cleanup choices discard the first card when actually offered.
    pump(runTurn(ctx), (decision) => pick(decision, /Pass|Discard|does not/));
    expect(player.hand).toHaveLength(hasTower && !castMoon ? 9 : 7);
    expect(hasNoMaximumHandSize(ctx, 'P1')).toBe(hasTower && !castMoon);
  });
});
