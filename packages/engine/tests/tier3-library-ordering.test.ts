import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((player) => player.id === 'P1') as EnginePlayerState;

function resolveSpell(
  ctx: GameContext,
  card: ReturnType<typeof oracle>,
  answer?: Parameters<typeof pump>[1],
): ReturnType<typeof pump> {
  const def = registerDef(ctx, card);
  if (def.spellAbility === null) throw new Error(`${card.name} did not parse as a spell`);
  return pump(executeAbility(ctx, {
    cardId: 'c-source',
    name: card.name,
    oracleId: def.oracleId,
    controllerId: 'P1',
  }, def.spellAbility, []), answer);
}

describe('Tier 3 library and hand ordering', () => {
  it('reorders the top cards, offers a seeded optional shuffle, then draws', () => {
    const run = (): { names: string[]; decisions: string[] } => {
      const ctx = pod('tier3-ponder-seed');
      const player = p1(ctx);
      player.library.length = 0;
      for (let index = 5; index >= 0; index--) {
        conjure(ctx, 'P1', oracle({ name: `Ponder Card ${index}`, typeLine: 'Artifact' }), 'library');
      }
      const result = resolveSpell(ctx, oracle({
        name: 'Test Ponder',
        typeLine: 'Sorcery',
        manaCost: '{U}',
        oracleText: 'Look at the top three cards of your library, then put them back in any order. You may shuffle. Draw a card.',
      }), (decision) => {
        if (decision.prompt.includes('top of your library')) return { index: decision.options.length - 1, targets: new Map() };
        if (decision.prompt.includes('shuffle your library')) return { index: 0, targets: new Map() };
        return { index: 0, targets: new Map() };
      });
      return {
        names: [...player.hand.map((card) => card.name), ...player.library.map((card) => card.name)],
        decisions: result.decisions.map((decision) => decision.prompt),
      };
    };

    const first = run();
    expect(run()).toEqual(first);
    expect(first.decisions.some((prompt) => prompt.includes('shuffle your library'))).toBe(true);
    expect(first.names).toHaveLength(6);
  });

  it('puts chosen hand cards on top in the chosen order', () => {
    const ctx = pod('tier3-hand-top');
    const player = p1(ctx);
    player.hand.length = 0;
    player.library.length = 0;
    conjure(ctx, 'P1', oracle({ name: 'Existing Top', typeLine: 'Artifact' }), 'library');
    conjure(ctx, 'P1', oracle({ name: 'Alpha', typeLine: 'Artifact' }), 'hand');
    conjure(ctx, 'P1', oracle({ name: 'Beta', typeLine: 'Artifact' }), 'hand');

    resolveSpell(ctx, oracle({
      name: 'Test Hand Top',
      typeLine: 'Sorcery',
      manaCost: '{1}',
      oracleText: 'Put two cards from your hand on top of your library in any order.',
    }), (decision) => {
      const beta = decision.options.findIndex((option) => option.description.includes('Beta'));
      const alpha = decision.options.findIndex((option) => option.description.includes('Alpha'));
      return { index: beta >= 0 ? beta : alpha >= 0 ? alpha : 0, targets: new Map() };
    });

    expect(player.hand).toHaveLength(0);
    expect(player.library.slice(0, 2).map((card) => card.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(player.library[2]?.name).toBe('Existing Top');
  });

  it('discards through the seeded engine PRNG', () => {
    const run = (): string[] => {
      const ctx = pod('tier3-random-discard');
      const player = p1(ctx);
      player.hand.length = 0;
      for (let index = 0; index < 6; index++) {
        conjure(ctx, 'P1', oracle({ name: `Discard Card ${index}`, typeLine: 'Artifact' }), 'hand');
      }
      resolveSpell(ctx, oracle({
        name: 'Test Random Discard',
        typeLine: 'Sorcery',
        manaCost: '{B}',
        oracleText: 'Discard a card at random.',
      }));
      return player.graveyard.map((card) => card.name);
    };

    const first = run();
    expect(run()).toEqual(first);
    expect(first).toHaveLength(1);
  });
});
