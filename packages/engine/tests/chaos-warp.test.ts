import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { buildGuardedCandidateDefinition } from '../src/testing/candidate-definition';
import { copies, conjure, gameConfig, oracle, pump, registerCustomDef, spawn } from './fixtures';

const chaosWarp = () =>
  oracle({
    oracleId: '07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8',
    name: 'Chaos Warp',
    manaCost: '{2}{R}',
    typeLine: 'Instant',
    oracleText:
      "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield.",
  });

function setup() {
  const card = chaosWarp();
  const candidate = buildGuardedCandidateDefinition(
    card,
    [
      'unrecognized rules text: "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it\'s a permanent card, they put it onto the battlefield."',
    ],
    {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'permanent' }],
        effects: [{ op: 'chaosWarp', target: 0 }],
        description:
          'Shuffle target permanent, reveal the top card, and put it onto the battlefield if permanent',
      },
    },
  );
  const ctx = createGame(
    gameConfig(
      [
        { id: 'P1', cards: copies(6, () => oracle({ name: 'P1 Card' })) },
        { id: 'P2', cards: copies(6, () => oracle({ name: 'P2 Card' })) },
      ],
      { seed: 'chaos-warp-candidate' },
    ),
  );
  const player = ctx.state.players.find((entry) => entry.id === 'P1')!;
  const spell = conjure(ctx, 'P1', card, 'hand');
  const target = spawn(ctx, 'P2', oracle({ name: 'Warp Target', typeLine: 'Artifact' }));
  const nonpermanent = oracle({ name: 'Warp Revealed Instant', typeLine: 'Instant' });
  conjure(ctx, 'P2', nonpermanent, 'library');
  registerCustomDef(ctx, candidate);
  addMana(player, [{ symbol: 'R' }, { symbol: 'C' }, { symbol: 'C' }]);
  return { ctx, player, spell, target, nonpermanent };
}

describe('Chaos Warp guarded candidate', () => {
  it('pays and casts normally, publicly reveals the owner top card, and leaves a nonpermanent on top', () => {
    const { ctx, player, target, nonpermanent } = setup();
    const cast = computePriorityOptions(ctx, player).find((option) => option.type === 'castSpell');
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, target.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'revealCard' && event.payload['name'] === nonpermanent.name,
      ),
    ).toBe(true);
    const owner = ctx.state.players.find((entry) => entry.id === 'P2')!;
    expect(owner.library.some((card) => card.name === nonpermanent.name)).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === target.cardId)).toBe(
      false,
    );
  });
});
