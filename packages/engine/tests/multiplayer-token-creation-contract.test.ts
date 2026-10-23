import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { spell, triggered, whenEnters } from '../src/cards/templates';
import { ofType } from '../src/cards/selector';
import { constant } from '../src/cards/value';
import { countPermanents } from '../src/cards/condition';
import { SOLDIER_1_1 } from '../src/cards/tokens';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import type { GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';
function pod() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) }))));
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 5,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}
function cast(ctx: GameContext, count: number) {
  const card = oracle({
    name: 'Independent multiplayer token probe',
    typeLine: 'Sorcery',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });
  registerCustomDef(ctx, {
    ...interpretCard(card),
    spellAbility: spell({
      effects: [{ op: 'eachOpponentCreatesTokens', spec: SOLDIER_1_1, count: constant(count) }],
    }),
  });
  const object = conjure(ctx, 'P1', card, 'hand');
  const action = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
    (o) => (o.payload as { objectId?: string }).objectId === object.id,
  )!;
  expect(action).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), action.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  pump(runPrioritySequence(ctx), (d) => ({
    index: Math.max(
      0,
      d.options.findIndex((o) => o.type === 'pass'),
    ),
    targets: new Map(),
  }));
  expect(ctx.state.stack).toEqual([]);
  return ctx.state.battlefield.filter((p) => p.isToken);
}
describe('independent multiplayer token creation contracts', () => {
  it('multiplayer-token-additional-replacement — each creator replacement applies once to their batch', () => {
    const ctx = pod(),
      card = oracle({ name: 'Independent additive token replacement', typeLine: 'Enchantment' });
    registerCustomDef(ctx, { ...interpretCard(card), tokenCreationReplacement: SOLDIER_1_1 });
    spawn(ctx, 'P3', card);
    const tokens = cast(ctx, 2);
    expect(tokens.map((p) => p.controllerId)).toEqual(['P2', 'P2', 'P3', 'P3', 'P4', 'P4', 'P3']);
  });
  it.each([0, 1, 2])(
    'multiplayer-token-count-%i — each living opponent creates the requested number through a normal cast',
    (count) => {
      const ctx = pod();
      const tokens = cast(ctx, count);
      expect(tokens).toHaveLength(3 * count);
      for (const seat of ['P2', 'P3', 'P4'])
        expect(tokens.filter((p) => p.controllerId === seat && p.ownerId === seat)).toHaveLength(
          count,
        );
      expect(tokens.some((p) => p.ownerId === 'P1')).toBe(false);
    },
  );
  it('multiplayer-token-lost-player — eliminated opponents do not create tokens', () => {
    const ctx = pod();
    playerById(ctx, 'P3').hasLost = true;
    expect(cast(ctx, 1).map((p) => p.controllerId)).toEqual(['P2', 'P4']);
  });
  it('multiplayer-token-replacements-belong-to-each-creator — only the recipient own multiplier applies', () => {
    const ctx = pod();
    const card = oracle({ name: 'Independent token multiplier', typeLine: 'Enchantment' });
    registerCustomDef(ctx, {
      ...interpretCard(card),
      ruleStatics: [{ kind: 'tokenCountMultiplier', multiplier: 2 }],
    });
    spawn(ctx, 'P3', card);
    const tokens = cast(ctx, 1);
    expect(tokens.map((p) => p.controllerId)).toEqual(['P2', 'P3', 'P3', 'P4']);
  });
  it('multiplayer-token-entry-is-simultaneous — every entry observer sees the complete three-player batch', () => {
    const ctx = pod();
    const watcher = oracle({ name: 'Independent batch observer', typeLine: 'Artifact' });
    registerCustomDef(ctx, {
      ...interpretCard(watcher),
      triggers: [
        triggered(whenEnters(ofType('Creature')), {
          condition: countPermanents(ofType('Creature'), 'all', '>=', 3),
          effects: [{ op: 'gainLife', amount: constant(1) }],
        }),
      ],
    });
    spawn(ctx, 'P1', watcher);
    const before = playerById(ctx, 'P1').life;
    cast(ctx, 1);
    expect(playerById(ctx, 'P1').life).toBe(before + 3);
  });
});
