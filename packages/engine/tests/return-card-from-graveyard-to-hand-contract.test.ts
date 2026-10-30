/**
 * Contract tests for the `returnCardFromGraveyardToHand` primitive, started with card:new
 * --primitive: "return a <kind> card from your graveyard to your hand", chosen as the effect
 * resolves from the controller's whole graveyard, not targeted. Contract tests may not use the
 * scenario runner (their evidence hashes this file's closure).
 */
import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { EFFECT_REFERENCE_CONTRACTS } from '../src/cards/effect-reference-contracts';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { spell } from '../src/cards/templates';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import {
  bear,
  bolt,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

const effect: Effect = { op: 'returnCardFromGraveyardToHand', filter: ofType('Creature') };
const ability = spell({ effects: [effect], description: 'Return a creature card' });

function game(): GameContext {
  return createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'return-card-contract' },
    ),
  );
}

const source = (ctx: GameContext) =>
  spawn(ctx, 'P1', oracle({ name: 'Contract Returner', typeLine: 'Artifact', manaCost: '{1}' }));
const names = (cards: ReadonlyArray<{ name: string }>) => cards.map((card) => card.name);

describe('returnCardFromGraveyardToHand primitive contract', () => {
  it('executes through a real spell or ability, with the engine path', () => {
    const ctx = game();
    conjure(ctx, 'P1', bear(), 'graveyard');
    conjure(ctx, 'P1', bolt(), 'graveyard');
    const ox = oracle({
      name: 'Contract Ox',
      typeLine: 'Creature — Ox',
      manaCost: '{2}',
      power: '2',
      toughness: '4',
    });
    conjure(ctx, 'P1', ox, 'graveyard');
    const asked: string[][] = [];
    pump(executeAbility(ctx, source(ctx), ability, []), (decision) => {
      asked.push(decision.options.map((option) => option.description));
      return pick(decision, /Test Bear/);
    });
    const p1 = playerById(ctx, 'P1');
    expect(names(p1.hand)).toContain('Test Bear');
    expect(names(p1.graveyard).sort()).toEqual(['Contract Ox', 'Test Bolt']);
    // Only the two creatures were offered; the instant was not.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.some((description) => description.includes('Test Bolt'))).toBe(false);
  });

  it('does nothing it should not: the negative case', () => {
    const ctx = game();
    conjure(ctx, 'P1', bolt(), 'graveyard');
    conjure(ctx, 'P2', bear(), 'graveyard');
    const hand = playerById(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, source(ctx), ability, []), () => {
      throw new Error('nothing qualifies, so nothing is asked');
    });
    // Neither the controller's instant nor an opponent's creature is returned.
    expect(playerById(ctx, 'P1').hand).toHaveLength(hand);
    expect(names(playerById(ctx, 'P2').graveyard)).toEqual(['Test Bear']);
  });

  it('validation rejects malformed IR for it', () => {
    const takenuma = interpretCard(
      oracle({ name: 'Contract Card', typeLine: 'Sorcery', manaCost: '{B}' }),
    );
    const withFilter = (filter: unknown) =>
      validateCardDefinition({
        ...takenuma,
        modeled: true,
        unmodeledReasons: [],
        spellAbility: spell({
          effects: [{ op: 'returnCardFromGraveyardToHand', filter } as Effect],
          description: 'Return a card',
        }),
      });
    expect(withFilter(ofType('Creature'))).toEqual([]);
    expect(withFilter(undefined).map((issue) => issue.message)).toContain(
      'expected selector expression',
    );
    expect(withFilter({ kind: 'bogus' }).map((issue) => issue.message)).toContain(
      'unknown selector expression kind',
    );
  });

  it('every reference it reads or writes resolves (effect-reference-contracts)', () => {
    // It reads no target slot or earlier result: the card is chosen on resolution.
    expect(EFFECT_REFERENCE_CONTRACTS.returnCardFromGraveyardToHand).toEqual({});
  });

  it('its capability tag matches what the executor supports', () => {
    const definition = {
      ...interpretCard(oracle({ name: 'Contract Card', typeLine: 'Sorcery', manaCost: '{B}' })),
      spellAbility: ability,
    };
    expect(deriveCardCapabilities(definition)).toContain('Effect.returnCardFromGraveyardToHand');
  });
});
