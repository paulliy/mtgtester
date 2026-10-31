/**
 * Bolas's Citadel's "pay life equal to its mana value rather than pay its mana cost" cast from the
 * top of the library (`libraryTopLife`): every cast it offers is one the cast accepts.
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { conjure, copies, forest, gameConfig, oracle, pumpStrict, spawn } from './fixtures';
import { pinned } from './pr11-helpers';
import { pinStore } from './scenario/pin-store';

/**
 * P1's precombat main phase, turn 3, with Bolas's Citadel and `top` on top of P1's library;
 * `setup` adds the rest of the board before the options are computed.
 */
function withTop(
  seed: string,
  top: Parameters<typeof conjure>[2],
  setup: (ctx: GameContext) => void = () => {},
) {
  const ctx: GameContext = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 3,
    phase: 'precombatMain',
    step: null,
  });
  spawn(ctx, 'P1', pinStore.get("Bolas's Citadel"));
  const card = conjure(ctx, 'P1', top, 'library');
  const library = playerById(ctx, 'P1').library;
  library.splice(library.indexOf(card), 1);
  library.unshift(card);
  setup(ctx);
  const options = computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return 'objectId' in payload && payload.objectId === card.id;
  });
  return { ctx, card, options };
}

const toxicDeluge = () =>
  oracle({
    oracleId: 'afaef788-34d1-460b-b884-9d7ae6ddeb18',
    name: 'Toxic Deluge',
    manaCost: '{2}{B}',
    typeLine: 'Sorcery',
    oracleText:
      'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.',
  });

describe('libraryTopLife casts', () => {
  it('bolas-citadel-split-half — a split card is cast as one half for that half’s mana value, never whole (CR 709.3)', () => {
    let relic: ReturnType<typeof spawn> | undefined;
    const { ctx, card, options } = withTop('life-split', pinned('Wear // Tear'), (ctx) => {
      relic = spawn(
        ctx,
        'P2',
        oracle({ name: 'Life Relic', typeLine: 'Artifact', manaCost: '{1}' }),
      );
      spawn(ctx, 'P2', oracle({ name: 'Life Charm', typeLine: 'Enchantment', manaCost: '{1}' }));
    });
    const life = options.filter(
      (option) =>
        (option.payload as { alternativeCast?: string }).alternativeCast === 'libraryTopLife',
    );
    // One option per half, each naming it; none for the combined card.
    expect(life.map((option) => option.description).sort()).toEqual([
      expect.stringMatching(/Tear.* by paying 1 life/),
      expect.stringMatching(/Wear.* by paying 2 life/),
    ]);
    expect(
      life.every((option) => (option.payload as { altIndex?: number }).altIndex !== undefined),
    ).toBe(true);
    const wear = life.find((option) => /Wear/.test(option.description))!;
    pumpStrict(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), wear.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, relic!.id]]),
      }),
    );
    expect(playerById(ctx, 'P1').life).toBe(38);
    // The spell is Wear alone, resolving as a split half.
    expect(ctx.state.stack.map((entry) => [entry.description, entry.alternativeCastKind])).toEqual([
      ['Wear', 'split'],
    ]);
    pumpStrict(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((perm) => perm.id === relic!.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((grave) => grave.cardId)).toContain(card.cardId);
  });

  it('bolas-citadel-adventure — an adventure is cast for its own mana value and goes on an adventure (CR 715.3c, 715.4)', () => {
    let bat: ReturnType<typeof spawn> | undefined;
    const { ctx, card, options } = withTop(
      'life-adventure',
      pinStore.get('Ettercap // Web Shot'),
      (ctx) => {
        bat = spawn(
          ctx,
          'P2',
          oracle({
            name: 'Life Bat',
            typeLine: 'Creature — Bat',
            manaCost: '{1}',
            oracleText: 'Flying',
            power: '1',
            toughness: '1',
          }),
        );
      },
    );
    const descriptions = options.map((option) => option.description);
    // The creature for its five, and Web Shot for its three.
    expect(descriptions).toContainEqual(expect.stringMatching(/Ettercap.* by paying 5 life/));
    const shot = options.find((option) => /Web Shot.* by paying 3 life/.test(option.description))!;
    pumpStrict(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), shot.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, bat!.id]]),
      }),
    );
    expect(playerById(ctx, 'P1').life).toBe(37);
    pumpStrict(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((perm) => perm.id === bat!.id)).toBe(false);
    const exiled = ctx.state.exile.find((exiledCard) => exiledCard.cardId === card.cardId);
    expect(exiled?.onAdventure).toBe(true);
  });

  it('bolas-citadel-announced-x — an X an additional cost announces is still chosen, and each offered X casts (CR 601.2b)', () => {
    const { ctx, options } = withTop('life-announced-x', toxicDeluge());
    const descriptions = options.map((option) => option.description);
    expect(descriptions).toContain(
      'Cast Toxic Deluge ({0}) by paying 3 life with X=2 from the top of your library',
    );
    const x2 = options.find((option) => option.description.includes('with X=2'))!;
    pumpStrict(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), x2.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    // Three life for its mana value and two for X.
    expect(playerById(ctx, 'P1').life).toBe(35);
    expect(ctx.state.stack.map((entry) => entry.card?.name)).toEqual(['Toxic Deluge']);
  });
  it('bolas-citadel-mdfc-land-face — a modal double-faced card on top is played as its land face (CR 712.12)', () => {
    const name = 'Valakut Awakening // Valakut Stoneforge';
    const { ctx, card, options } = withTop('life-mdfc-land', pinStore.get(name));
    const land = options.filter((option) => option.type === 'playLand');
    expect(land.map((option) => option.description)).toEqual(['Play Valakut Stoneforge']);
    // The front face is still cast for life as well.
    expect(options.map((option) => option.description)).toContainEqual(
      expect.stringMatching(/Valakut Awakening.* by paying 3 life/),
    );
    pumpStrict(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), land[0]!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    const played = ctx.state.battlefield.find((perm) => perm.cardId === card.cardId);
    expect([played?.face, playerById(ctx, 'P1').landsPlayedThisTurn]).toEqual(['back', 1]);
  });

  it('bolas-citadel-mdfc-land-drop-used — with the land drop used, the land face is not offered', () => {
    const { options } = withTop(
      'life-mdfc-no-drop',
      pinStore.get('Valakut Awakening // Valakut Stoneforge'),
      (ctx) => {
        playerById(ctx, 'P1').landsPlayedThisTurn = 1;
      },
    );
    expect(options.filter((option) => option.type === 'playLand')).toEqual([]);
  });
});
