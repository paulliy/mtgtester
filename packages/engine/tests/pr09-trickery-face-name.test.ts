import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

const facePins = JSON.parse(
  readFileSync(new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const coveragePins = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const foulmire = facePins.cards.find(({ card }) => card.name.startsWith('Foulmire Knight'))!.card;
const trickery = coveragePins.cards.find(({ card }) => card.name === "Tibalt's Trickery")!.card;
const pad = oracle({
  name: 'Trickery name-check pad',
  typeLine: 'Land',
  manaCost: '',
  cmc: 0,
  oracleText: '',
});

function setup(): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      {
        seed: 'pr09-trickery-adventure-name',
      },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (const player of ctx.state.players) {
    player.hand = [];
    player.library = [];
  }
  return ctx;
}

it('pr09-trickery-adventure-face-name — treats Profane Insight as different from the Foulmire Knight library card', () => {
  const ctx = setup();
  const p1 = playerById(ctx, 'P1');
  const adventureCard = conjure(ctx, 'P1', foulmire, 'hand');
  addMana(p1, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
  const adventureOption = computePriorityOptions(ctx, p1).find((option) => {
    const payload = option.payload as Partial<PriorityActionPayload>;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === adventureCard.id &&
      payload.alternativeCast === 'adventure'
    );
  });
  expect(adventureOption).toBeDefined();
  pump(
    applyPriorityAction(ctx, p1, adventureOption!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  const adventureSpell = ctx.state.stack.at(-1)!;
  expect(adventureSpell.kind).toBe('spell');
  if (adventureSpell.kind !== 'spell') throw new Error('Adventure did not create a spell');
  expect(adventureSpell.description).toBe('Profane Insight');

  const library = [...Array.from({ length: 12 }, () => pad), foulmire].map((definition) =>
    conjure(ctx, 'P1', definition, 'library'),
  );
  p1.library = library;
  const trickeryCard = conjure(ctx, 'P1', trickery, 'hand');
  addMana(p1, [{ symbol: 'R' }, { symbol: 'C' }]);
  const trickeryOption = computePriorityOptions(ctx, p1).find((option) => {
    const payload = option.payload as Partial<PriorityActionPayload>;
    return payload.kind === 'castSpell' && payload.objectId === trickeryCard.id;
  });
  expect(trickeryOption).toBeDefined();
  pump(
    applyPriorityAction(ctx, p1, trickeryOption!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, adventureSpell.id]]),
    }),
  );
  let freeCastWasOffered = false;
  pump(resolveTopOfStack(ctx), (decision) => {
    const index = decision.options.findIndex((option) =>
      /Cast Foulmire Knight/.test(option.description),
    );
    if (index >= 0) {
      freeCastWasOffered = true;
      return { index, targets: new Map() };
    }
    const passIndex = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(0, passIndex), targets: new Map() };
  });
  expect(freeCastWasOffered).toBe(true);
  const freeCast = ctx.state.stack.at(-1)!;
  expect(freeCast.description).toBe('Foulmire Knight // Profane Insight');
  expect(freeCast.card?.name).toBe('Foulmire Knight // Profane Insight');
});
