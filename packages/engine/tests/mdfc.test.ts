import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { interpretCard } from '../src/cards/interpret';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const mdfcCards = [
  oracle({
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
    oracleText: "Return target spell or nonland permanent an opponent controls to its owner's hand.",
    layout: 'modal_dfc',
    backFace: {
      name: 'Soporific Springs',
      typeLine: 'Land',
      oracleText: "As this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {U}.",
      manaCost: null,
      colors: [],
      power: null,
      toughness: null,
    },
  }),
  oracle({
    name: 'Fell the Profane // Fell Mire',
    typeLine: 'Instant',
    types: ['Instant'],
    subtypes: [],
    manaCost: '{2}{B}{B}',
    cmc: 4,
    colors: ['B'],
    colorIdentity: ['B'],
    power: null,
    toughness: null,
    oracleText: 'Destroy target creature or planeswalker.',
    layout: 'modal_dfc',
    backFace: {
      name: 'Fell Mire',
      typeLine: 'Land',
      oracleText: "As this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {B}.",
      manaCost: null,
      colors: [],
      power: null,
      toughness: null,
    },
  }),
  oracle({
    name: 'Revitalizing Repast // Old-Growth Grove',
    typeLine: 'Instant',
    types: ['Instant'],
    subtypes: [],
    manaCost: '{B/G}',
    cmc: 1,
    colors: ['B', 'G'],
    colorIdentity: ['B', 'G'],
    power: null,
    toughness: null,
    oracleText: 'Put a +1/+1 counter on target creature. It gains indestructible until end of turn.',
    layout: 'modal_dfc',
    backFace: {
      name: 'Old-Growth Grove',
      typeLine: 'Land',
      oracleText: 'Old-Growth Grove enters tapped.\n{T}: Add {B} or {G}.',
      manaCost: null,
      colors: [],
      power: null,
      toughness: null,
    },
  }),
] as const;

function pod(card: (typeof mdfcCards)[number]): { ctx: GameContext; objectId: string } {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed: card.name }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
  const object = conjure(ctx, 'P1', card, 'hand');
  return { ctx, objectId: object.id };
}

describe('MDFC spell // land layout', () => {
  it.each(mdfcCards)('models and plays the land face of $name', (card) => {
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    const landFace = def.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace;
    expect(landFace?.name).toBe(card.backFace?.name);
    expect(landFace?.manaAbilities).toHaveLength(1);
    if (card.name.startsWith('Revitalizing Repast')) {
      expect(landFace?.entersTapped).toBe(true);
    } else {
      expect(landFace?.entersTappedUnless).toEqual({ kind: 'mayPayLife', n: 3 });
    }

    const { ctx, objectId } = pod(card);
    const player = ctx.state.players[0]!;
    const options = computePriorityOptions(ctx, player);
    const landOption = options.find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === objectId;
    });
    expect(landOption).toBeDefined();
    expect(landOption?.description).toBe(`Play ${card.backFace?.name}`);
    expect(landOption?.data).toMatchObject(
      card.name.startsWith('Revitalizing Repast')
        ? { castVariant: 'mdfc', entersTapped: true }
        : { castVariant: 'mdfc', payLifeToUntap: 3 },
    );

    const payload = landOption?.payload as PriorityActionPayload | undefined;
    if (payload === undefined || payload.kind !== 'playLand') throw new Error('missing MDFC land action');
    pump(
      applyPriorityAction(ctx, player, payload, { index: 0, targets: new Map() }),
      (decision) => {
        expect(decision.prompt).toContain(card.backFace?.name ?? '');
        return { index: 0, targets: new Map() };
      },
    );

    const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === player.hand[0]?.cardId || candidate.name === card.backFace?.name);
    expect(permanent?.name).toBe(card.backFace?.name);
    expect(permanent?.face).toBe('back');
    expect(computeCharacteristics(ctx, permanent!).types).toContain('Land');
    expect(permanent?.tapped).toBe(card.name.startsWith('Revitalizing Repast'));
    expect(player.life).toBe(card.name.startsWith('Revitalizing Repast') ? 40 : 37);
    expect(computeCharacteristics(ctx, permanent!).manaAbilities.some((ability) => ability.units.some((unit) => unit.includes(card.colors[0]!)))).toBe(true);
    expect(player.hand.some((object) => object.id === objectId)).toBe(false);
    expect(player.landsPlayedThisTurn).toBe(1);

    if (permanent === undefined) throw new Error('missing MDFC permanent');
    pump(moveObject(ctx, permanent, { zone: 'graveyard' }));
    const returned = player.graveyard.find((object) => object.cardId === permanent.cardId);
    expect(returned?.name).toBe(card.name);
    expect(returned?.typeLine).toBe(card.typeLine);
    expect(returned?.oracleText).toBe(card.oracleText);
  });

  it('keeps the front spell cast option alongside the back land option', () => {
    const card = mdfcCards[2];
    const { ctx } = pod(card);
    const player = ctx.state.players[0]!;
    spawn(ctx, 'P1', bear());
    const options = computePriorityOptions(ctx, player);
    expect(options.some((option) => option.type === 'castSpell' && option.description.startsWith('Cast Revitalizing Repast'))).toBe(true);
    expect(options.some((option) => option.type === 'playLand' && option.description === 'Play Old-Growth Grove')).toBe(true);
  });
});
