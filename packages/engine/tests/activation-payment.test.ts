import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

// Revelsong Horn Oracle text, also reached by the browser-trial-batch-2026-09-05:s1:g1 replay.
const hornCard = () =>
  oracle({
    name: 'Revelsong Horn',
    typeLine: 'Artifact',
    manaCost: '{2}',
    oracleText:
      '{1}, {T}, Tap an untapped creature you control: Target creature gets +1/+1 until end of turn.',
  });
const elfCard = () => oracle({ name: 'Mana Creature', oracleText: '{T}: Add {G}.' });
function setup() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed: 'horn-payment' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const player = ctx.state.players.find((p) => p.id === 'P1')!;
  const horn = spawn(ctx, 'P1', hornCard());
  const elf = spawn(ctx, 'P1', elfCard());
  const activation = () =>
    computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === horn.id;
    });
  return { ctx, player, horn, elf, activation };
}
describe('joint mana and creature tap payment', () => {
  it('does not offer Horn when the only creature must also provide its mana', () => {
    const { activation } = setup();
    expect(activation()).toBeUndefined();
  });
  it('reserves the mana creature while paying Horn and resolves the buff', () => {
    const { ctx, player, horn, elf, activation } = setup();
    const creature = spawn(ctx, 'P1', bear());
    const choice = activation();
    expect(choice).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, choice!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, creature.id]]),
      }),
    );
    expect(horn.tapped).toBe(true);
    expect(elf.tapped).toBe(true);
    expect(creature.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(ctx));
    expect(computeCharacteristics(ctx, creature).power).toBe(3);
  });
  it.each([0, 1])('keeps both payable creature choices available (choice %i)', (chosen) => {
    const { ctx, player, elf, activation } = setup();
    const second = spawn(ctx, 'P1', oracle({ ...elfCard(), name: 'Second Mana Creature' }));
    const choice = activation();
    expect(choice).toBeDefined();
    const seen: string[][] = [];
    pump(
      applyPriorityAction(ctx, player, choice!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, elf.id]]),
      }),
      (decision) => {
        seen.push(decision.options.map((o) => o.description));
        expect(decision.options).toHaveLength(2);
        return { index: chosen, targets: new Map() };
      },
    );
    expect(seen).toHaveLength(1);
    expect(elf.tapped).toBe(true);
    expect(second.tapped).toBe(true);
  });
});
