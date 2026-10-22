import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability, Effect } from '../src/cards/definition';
import { ofType } from '../src/cards/selector';
import { executeAbility } from '../src/effects/resolve';
import { moveObjects, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

const coveragePins = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const songbirds = coveragePins.cards.find(({ card }) => card.name === "Songbirds' Blessing")!.card;

function setup(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 2 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  const player = playerById(ctx, 'P1');
  player.hand = [];
  player.library = [];
  return ctx;
}

const artifact = oracle({
  name: 'Artifact look card',
  typeLine: 'Artifact',
  manaCost: '{2}',
  cmc: 2,
  oracleText: '',
});
const creature = oracle({
  name: 'Simultaneously entering creature',
  typeLine: 'Creature — Test',
  manaCost: '{2}',
  cmc: 2,
  power: '2',
  toughness: '2',
  oracleText: '',
});

it('pr09-look-failed-aura-bottom-remainder — puts a selected Aura among the rest when it cannot enter the battlefield', () => {
  const ctx = setup('pr09-library-aura-no-host');
  const player = playerById(ctx, 'P1');
  const aura = conjure(ctx, 'P1', songbirds, 'library');
  const other = conjure(ctx, 'P1', artifact, 'library');
  const tail = conjure(ctx, 'P1', forest(), 'library');
  player.library = [aura, other, tail];
  const effect: Extract<Effect, { op: 'lookAtTopN' }> = {
    op: 'lookAtTopN',
    count: 2,
    mayPut: { filter: ofType('Enchantment'), destination: { zone: 'battlefield' } },
    rest: 'bottomRandom',
  };
  const ability: Ability = { kind: 'spell', targets: [], effects: [effect] };
  const result = pump(
    executeAbility(
      ctx,
      { cardId: 'look-source', oracleId: 'look-source', name: 'Look source', controllerId: 'P1' },
      ability,
      [],
    ),
    (decision) => {
      const index = decision.options.findIndex((option) => option.description.includes(aura.name));
      return { index, targets: new Map() };
    },
  );
  expect(result.decisions[0]?.options.map((option) => option.description)).toContain(
    `Put ${aura.name} onto the battlefield`,
  );
  expect(ctx.state.battlefield.some((permanent) => permanent.name === aura.name)).toBe(false);
  expect(player.library.slice(-2).map((card) => card.cardId)).toContain(aura.cardId);
  expect(player.library.slice(-2).map((card) => card.cardId)).toContain(other.cardId);
  expect(player.library.at(-1)?.cardId).not.toBe(tail.cardId);
});

it('pr09-batch-aura-cannot-enchant-fellow-entrant — does not let an Aura enchant a creature entering in the same batch', () => {
  const ctx = setup('pr09-library-aura-batch-host');
  const player = playerById(ctx, 'P1');
  const host = conjure(ctx, 'P1', creature, 'library');
  const aura = conjure(ctx, 'P1', songbirds, 'library');
  player.library = [host, aura];
  const result = pump(
    moveObjects(ctx, [host, aura], { zone: 'battlefield', controllerId: 'P1' }),
    () => ({ index: 0, targets: new Map() }),
  );
  expect(result.value[1]).toBeNull();
  expect(ctx.state.battlefield.some((permanent) => permanent.name === aura.name)).toBe(false);
  expect(player.library.some((card) => card.cardId === aura.cardId)).toBe(true);
});
