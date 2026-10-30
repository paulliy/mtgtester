/**
 * Contract tests for `CardDefinition.entersUnlessDiscard` ("if this would enter, you may discard a
 * land card instead … if you don't, put it into its owner's graveyard"): a replacement on every
 * move onto the battlefield from another zone (CR 614.1c), whichever effect makes it. Contract
 * tests may not use the scenario runner (their evidence hashes this file's closure).
 */
import { describe, expect, it } from 'vitest';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  oracle,
  pick,
  pump,
  registerCustomDef,
} from './fixtures';

const trinket = oracle({ name: 'Contract Diamond', typeLine: 'Artifact', manaCost: '{0}' });
const definition = (): CardDefinition => ({
  ...interpretCard(trinket),
  modeled: true,
  unmodeledReasons: [],
  entersUnlessDiscard: { filter: ofType('Land') },
});

function game(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'enters-unless-discard' },
    ),
  );
  registerCustomDef(ctx, definition());
  return ctx;
}
const names = (cards: ReadonlyArray<{ name: string }>) => cards.map((card) => card.name);

describe('entersUnlessDiscard replacement contract', () => {
  it('executes on any move onto the battlefield: the land is discarded and it enters', () => {
    const ctx = game();
    const diamond = conjure(ctx, 'P1', trinket, 'graveyard');
    conjure(ctx, 'P1', island(), 'hand');
    const asked: string[][] = [];
    pump(moveObject(ctx, diamond, { zone: 'battlefield' }), (decision) => {
      asked.push(decision.options.map((option) => option.description));
      return pick(decision, 'Discard Island');
    });
    expect(names(ctx.state.battlefield)).toContain('Contract Diamond');
    expect(names(playerById(ctx, 'P1').graveyard)).toEqual(['Island']);
    expect(asked).toEqual([
      ['Discard Island', "Discard nothing: put Contract Diamond into its owner's graveyard"],
    ]);
  });

  it('does nothing it should not: no land in hand, or declining, puts it in the graveyard', () => {
    const ctx = game();
    const diamond = conjure(ctx, 'P1', trinket, 'hand');
    conjure(ctx, 'P1', bear(), 'hand');
    pump(moveObject(ctx, diamond, { zone: 'battlefield' }), () => {
      throw new Error('a nonland card is never offered');
    });
    expect(names(playerById(ctx, 'P1').graveyard)).toEqual(['Contract Diamond']);
    expect(names(playerById(ctx, 'P1').hand)).toContain('Test Bear');

    const declined = game();
    const second = conjure(declined, 'P1', trinket, 'hand');
    conjure(declined, 'P1', island(), 'hand');
    pump(moveObject(declined, second, { zone: 'battlefield' }), (decision) =>
      pick(decision, /^Discard nothing/),
    );
    expect(names(playerById(declined, 'P1').graveyard)).toEqual(['Contract Diamond']);
    expect(names(playerById(declined, 'P1').hand)).toContain('Island');
    expect(names(declined.state.battlefield)).not.toContain('Contract Diamond');
  });

  it('validation rejects malformed IR for it', () => {
    expect(validateCardDefinition(definition())).toEqual([]);
    const malformed = { ...definition(), entersUnlessDiscard: { filter: { kind: 'bogus' } } };
    expect(validateCardDefinition(malformed as unknown as CardDefinition).length).toBeGreaterThan(
      0,
    );
  });

  it('its capability is derived from the definition field', () => {
    expect(deriveCardCapabilities(definition()).join(' ')).toMatch(/entersUnlessDiscard/);
  });
});
