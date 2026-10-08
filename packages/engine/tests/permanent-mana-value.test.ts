import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { manaValueAtLeast, manaValueAtMost } from '../src/cards/selector';
import { permanentManaValue } from '../src/actions/legal';
import { selectPermanents } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { applyCopy, moveObject, transformPermanent } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const dash = String.fromCharCode(0x2014);

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/** A nonmodal transforming DFC whose front costs {2}{G}{G} (mana value 4) and whose back has none. */
function transformingCard() {
  return oracle({
    name: 'Test Mystic // Test Wildbeast',
    typeLine: `Creature ${dash} Human`,
    types: ['Creature'],
    subtypes: ['Human'],
    manaCost: '{2}{G}{G}',
    colors: ['G'],
    colorIdentity: ['G'],
    power: '1',
    toughness: '1',
    layout: 'transform',
    oracleText: '{1}{G}: Transform Test Mystic.',
    backFace: {
      name: 'Test Wildbeast',
      typeLine: `Creature ${dash} Werewolf`,
      oracleText: 'Trample',
      manaCost: null,
      colors: ['G'],
      power: '5',
      toughness: '5',
      loyalty: null,
      defense: null,
    },
  });
}

/** A modal DFC spell // land: front mana value 3, land back face with no mana cost. */
function mdfcCard() {
  return oracle({
    name: 'Sink into Stupor // Soporific Springs',
    typeLine: 'Instant',
    types: ['Instant'],
    subtypes: [],
    manaCost: '{1}{U}{U}',
    cmc: 3,
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText:
      "Return target spell or nonland permanent an opponent controls to its owner's hand.",
    layout: 'modal_dfc',
    backFace: {
      name: 'Soporific Springs',
      typeLine: 'Land',
      oracleText:
        "As this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {U}.",
      manaCost: null,
      colors: [],
      power: null,
      toughness: null,
    },
  });
}

function selects(
  ctx: GameContext,
  perm: EnginePermanent,
  selector: Parameters<typeof selectPermanents>[1],
) {
  return selectPermanents(ctx, selector, { cardId: 'none', controllerId: 'P1' }).some(
    (candidate) => candidate.id === perm.id,
  );
}

const sacrificeGreatestManaValue: Ability = {
  kind: 'spell',
  targets: [],
  effects: [
    {
      op: 'sacrificeGreatestEachOpponent',
      selector: 'creature',
      metric: 'manaValue',
      action: 'sacrifice',
    },
  ],
};

function castSacrifice(ctx: GameContext): void {
  pump(
    executeAbility(
      ctx,
      { cardId: 'test-source', oracleId: 'test-source', name: 'Test Edict', controllerId: 'P1' },
      sacrificeGreatestManaValue,
      [],
    ),
    () => ({ index: 0, targets: new Map() }),
  );
}

describe('permanent mana value across double faces (CR 202.3b, 712.8e, 712.8f)', () => {
  it('keeps the front face mana value on a transformed nonmodal DFC', () => {
    const ctx = pod('mana-value-transformed-dfc');
    const perm = spawn(ctx, 'P2', transformingCard());
    expect(transformPermanent(ctx, perm)).toBe(true);
    expect(perm.transformed).toBe(true);
    expect(perm.name).toBe('Test Wildbeast');

    expect(permanentManaValue(ctx, perm)).toBe(4);
    expect(selects(ctx, perm, manaValueAtLeast(4))).toBe(true);
    expect(selects(ctx, perm, manaValueAtMost(3))).toBe(false);
    expect(selects(ctx, perm, manaValueAtMost(0))).toBe(false);
  });

  it('sacrifices a transformed DFC by its front face mana value', () => {
    const ctx = pod('mana-value-transformed-sacrifice');
    const transformed = spawn(ctx, 'P2', transformingCard());
    transformPermanent(ctx, transformed);
    const smaller = spawn(ctx, 'P2', bear());

    castSacrifice(ctx);

    expect(ctx.state.battlefield.some((perm) => perm.id === transformed.id)).toBe(false);
    expect(ctx.state.battlefield.some((perm) => perm.id === smaller.id)).toBe(true);
  });

  it('gives a copy of a transformed DFC mana value 0, and a copy of its front face 4', () => {
    const ctx = pod('mana-value-copy-of-back-face');
    const transformed = spawn(ctx, 'P2', transformingCard());
    transformPermanent(ctx, transformed);
    const untransformed = spawn(ctx, 'P2', transformingCard());
    const backCopy = spawn(ctx, 'P1', bear());
    const frontCopy = spawn(ctx, 'P1', bear());

    applyCopy(ctx, backCopy, transformed);
    applyCopy(ctx, frontCopy, untransformed);

    // CR 712.8e: a permanent copying the back face of a nonmodal DFC has mana value 0.
    expect(permanentManaValue(ctx, backCopy)).toBe(0);
    expect(selects(ctx, backCopy, manaValueAtMost(0))).toBe(true);
    expect(selects(ctx, backCopy, manaValueAtLeast(1))).toBe(false);
    // The transformed original still reads its front face.
    expect(permanentManaValue(ctx, transformed)).toBe(4);
    expect(permanentManaValue(ctx, frontCopy)).toBe(4);
  });

  it('gives a modal DFC played as its land face mana value 0', () => {
    const ctx = pod('mana-value-mdfc-land');
    const card = conjure(ctx, 'P1', mdfcCard(), 'hand');
    const land = pump(moveObject(ctx, card, { zone: 'battlefield', face: 'back' }), () => ({
      index: 0,
      targets: new Map(),
    })).value as EnginePermanent;
    expect(land.face).toBe('back');
    expect(land.name).toBe('Soporific Springs');

    expect(permanentManaValue(ctx, land)).toBe(0);
    expect(selects(ctx, land, manaValueAtMost(0))).toBe(true);
    expect(selects(ctx, land, manaValueAtLeast(1))).toBe(false);
  });

  it('measures a face-down creature as mana value 0 when choosing what to sacrifice', () => {
    const ctx = pod('mana-value-face-down-sacrifice');
    const hidden = conjure(ctx, 'P2', transformingCard(), 'hand');
    const faceDown = pump(
      moveObject(ctx, hidden, { zone: 'battlefield', controllerId: 'P2', faceDown: true }),
    ).value as EnginePermanent;
    const greater = spawn(ctx, 'P2', bear());
    expect(permanentManaValue(ctx, faceDown)).toBe(0);

    castSacrifice(ctx);

    expect(ctx.state.battlefield.some((perm) => perm.id === faceDown.id)).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.id === greater.id)).toBe(false);
  });
});
