import { describe, expect, it } from 'vitest';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { manaCost, spell } from '../src/cards/templates';
import { createGame } from '../src/state/game';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup() {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const card = conjure(
    ctx,
    player.id,
    oracle({
      name: 'Command permission probe',
      typeLine: 'Creature',
      manaCost: '{0}',
      power: '2',
      toughness: '2',
    }),
    'command',
    { isCommander: true },
  );
  player.commanderCardIds.push(card.cardId);
  const payload: Extract<PriorityActionPayload, { kind: 'castSpell' }> = {
    kind: 'castSpell',
    objectId: card.id,
    fromCommand: true,
  };
  const options = () =>
    computePriorityOptions(ctx, player).filter(
      (option) =>
        (option.payload as PriorityActionPayload).kind === 'castSpell' &&
        (option.payload as typeof payload).objectId === card.id,
    );
  const cast = (action = payload) =>
    pump(applyPriorityAction(ctx, player, action, { index: 0, targets: new Map() }));
  return { ctx, player, card, payload, options, cast };
}

describe('ordinary command-zone casting permission', () => {
  it('offers and applies the owner’s designated commander through the normal path', () => {
    const state = setup();
    expect(state.options()).toHaveLength(1);
    state.cast(state.options()[0]!.payload as typeof state.payload);
    expect(state.player.commandZone).not.toContain(state.card);
    expect(state.ctx.state.stack[0]?.isCommanderCast).toBe(true);
    expect(state.player.commanderCastCount[state.card.cardId]).toBe(1);
  });

  it.each(['not commander', 'wrong owner', 'not designated', 'wrong zone'] as const)(
    'rejects %s in preview and application without side effects',
    (invalid) => {
      const state = setup();
      if (invalid === 'not commander') state.card.isCommander = false;
      if (invalid === 'wrong owner') state.card.ownerId = 'P2';
      if (invalid === 'not designated') state.player.commanderCardIds = [];
      if (invalid === 'wrong zone') state.card.zone = 'hand';
      const before = cloneContractContext(state.ctx);
      expect(state.options()).toHaveLength(0);
      expect(() => state.cast()).toThrow('command-zone casting permission');
      expect(state.ctx.state).toEqual(before.state);
      expect(state.ctx.debugLog).toEqual(before.debugLog);
    },
  );

  it('does not treat a hand-restricted alternative as command-zone permission', () => {
    const state = setup();
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      alternativeCasts: [
        { kind: 'nonMana', from: 'hand', description: 'Hand only', manaCost: manaCost('{0}') },
      ],
    });
    expect(
      state
        .options()
        .every((option) => (option.payload as typeof state.payload).alternativeCast === undefined),
    ).toBe(true);
    const before = cloneContractContext(state.ctx);
    expect(() => state.cast({ ...state.payload, alternativeCast: 'nonMana', altIndex: 0 })).toThrow(
      'not supported from this zone',
    );
    expect(state.ctx.state).toEqual(before.state);
  });

  it.each(['adventure', 'omen'] as const)(
    'rejects a malformed %s command-zone face without executable characteristics',
    (kind) => {
      const state = setup();
      state.ctx.defs.set(state.card.oracleId, {
        ...state.ctx.defs.get(state.card.oracleId)!,
        alternativeCasts: [
          {
            kind,
            description: 'Alternative face',
            manaCost: manaCost('{0}'),
            typeLine: 'Sorcery',
            ability: spell({ effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }] }),
          },
        ],
      });
      const before = cloneContractContext(state.ctx);
      expect(() => state.options()).toThrow('spell face');
      expect(() => state.cast({ ...state.payload, alternativeCast: kind, altIndex: 0 })).toThrow(
        'spell face',
      );
      expect(state.ctx.state).toEqual(before.state);
    },
  );
});
