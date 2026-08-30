import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const modalHeader = 'Choose one. If you control a commander as you cast this spell, you may choose both instead.';
const conditionalModal = () =>
  oracle({
    name: 'Commander Conditional Modal',
    typeLine: 'Sorcery',
    manaCost: '{0}',
    cmc: 0,
    oracleText:
      modalHeader +
      String.fromCharCode(10) +
      '• Draw a card.' +
      String.fromCharCode(10) +
      '• You gain 1 life.',
  });

function pod(seed = 'commander-modal'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((player) => player.id === 'P1') as EnginePlayerState;

const castOptions = (ctx: GameContext, player: EnginePlayerState) =>
  computePriorityOptions(ctx, player).filter((option) => option.type === 'castSpell');

describe('commander-conditional modal headers', () => {
  it('parses the header as a conditional maximum rather than a card-specific override', () => {
    const def = interpretCard(conditionalModal());
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.spellAbility?.modes).toMatchObject({
      minChoices: 1,
      maxChoices: 1,
      maxChoicesIf: {
        condition: { kind: 'controlsYourCommander' },
        maxChoices: 2,
      },
    });
  });

  it('offers both modes only while the caster controls a commander', () => {
    const withoutCommander = pod('modal-without-commander');
    const card = conditionalModal();
    conjure(withoutCommander, 'P1', card, 'hand');
    const noCommanderOptions = castOptions(withoutCommander, p1(withoutCommander));
    expect(noCommanderOptions).toHaveLength(2);
    expect(noCommanderOptions.every((option) => {
      const payload = option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return payload.modes?.length === 1;
    })).toBe(true);

    const withCommander = pod('modal-with-commander');
    spawn(
      withCommander,
      'P1',
      oracle({
        name: 'Test Commander',
        typeLine: 'Legendary Creature ' + String.fromCharCode(0x2014) + ' Human',
        manaCost: '{0}',
        cmc: 0,
      }),
      { isCommander: true },
    );
    conjure(withCommander, 'P1', card, 'hand');
    const commanderOptions = castOptions(withCommander, p1(withCommander));
    expect(commanderOptions).toHaveLength(3);
    expect(commanderOptions.some((option) => {
      const payload = option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return payload.modes?.join(',') === '0,1';
    })).toBe(true);
  });

  it('executes both selected modes when the commander condition is true', () => {
    const ctx = pod('modal-runtime');
    const player = p1(ctx);
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Commander',
        typeLine: 'Legendary Creature ' + String.fromCharCode(0x2014) + ' Human',
        manaCost: '{0}',
        cmc: 0,
      }),
      { isCommander: true },
    );
    const card = conditionalModal();
    conjure(ctx, 'P1', card, 'hand');
    conjure(ctx, 'P1', oracle({ name: 'Card Drawn by Modal', typeLine: 'Creature ' + String.fromCharCode(0x2014) + ' Test', manaCost: '{1}' }), 'library');

    const option = castOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return payload.modes?.join(',') === '0,1';
    });
    expect(option).toBeDefined();

    const payload = option!.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
    pump(applyPriorityAction(ctx, player, payload, { index: 0, targets: new Map() }));
    expect(ctx.state.stack.at(-1)?.ability?.effects).toEqual([
      { op: 'draw', count: { kind: 'const', n: 1 } },
      { op: 'gainLife', amount: { kind: 'const', n: 1 } },
    ]);

    const lifeBefore = player.life;
    pump(resolveTopOfStack(ctx));
    expect(player.life).toBe(lifeBefore + 1);
    expect(player.hand.some((cardInHand) => cardInHand.name === 'Card Drawn by Modal')).toBe(true);
  });

  it('rejects a forged two-mode payload when the caster does not control a commander', () => {
    const ctx = pod('modal-forged');
    const player = p1(ctx);
    const card = conditionalModal();
    const object = conjure(ctx, 'P1', card, 'hand');

    expect(() =>
      pump(
        applyPriorityAction(
          ctx,
          player,
          {
            kind: 'castSpell',
            objectId: object.id,
            fromCommand: false,
            modes: [0, 1],
          },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow(/invalid mode count/);
  });
});
