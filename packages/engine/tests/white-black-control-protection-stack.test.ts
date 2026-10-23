import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { CardDefinition, TargetSpec } from '../src/cards/definition';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlProtectionStackOverrides } from '../src/cards/overrides/white-black-control-protection-stack';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { dealDamageToCreature, endUntilEotEffects } from '../src/effects/resolve';
import { computeCharacteristics } from '../src/effects/continuous';
import { hasProtectionFrom, manaSourcesFor } from '../src/state/queries';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import { buildPlayerBoardState } from '../src/view/spectator';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import {
  bear,
  copies,
  conjure,
  doom,
  gameConfig,
  oracle,
  plains,
  pump,
  swamp,
  spawn,
} from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };

const pins = {
  'Mother of Runes': '9a9f376d70f688a3c9319ffc71697a0a397d659b9e681f89327d93112211dbe1',
  'Rebuff the Wicked': 'e071417dfbbacce2cd007719b51c66433b5cb3fbf85cd829a9f3cc366e9a237e',
  Reprieve: '619a7ea2fb69f1f2c07d5a2e0e1bffc1f5ef08ac77361f57e6483eccf439c443',
  'Sejiri Shelter // Sejiri Glacier':
    '2c459001fbd313a67f4cd39b878d4d1b1a854a24d191dba61fc8011d163cc218',
} as const;

const cards = new Map<keyof typeof pins, PinnedCard>();
for (const [name, sha256] of Object.entries(pins) as [keyof typeof pins, string][]) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  if (entry.sha256 !== sha256) throw new Error(`Oracle hash drift for ${name}`);
  cards.set(name, entry);
}

beforeAll(() => registerWhiteBlackControlProtectionStackOverrides());

function card(name: keyof typeof pins): OracleCard {
  const entry = cards.get(name);
  if (entry === undefined) throw new Error(`Missing pinned card ${name}`);
  return entry.card;
}

function context(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, plains) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function player(ctx: GameContext, playerId: string): EnginePlayerState {
  const found = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

function ensureMana(ctx: GameContext, playerId: string, white = 5, black = 0): void {
  for (let index = 0; index < white; index++) spawn(ctx, playerId, plains());
  for (let index = 0; index < black; index++) spawn(ctx, playerId, swamp());
}

function castToStack(
  ctx: GameContext,
  playerId: string,
  spell: OracleCard,
  targets: ReadonlyMap<number, string> = new Map(),
  chooseCountTarget?: string,
): string {
  const object = conjure(ctx, playerId, spell, 'hand');
  const controller = player(ctx, playerId);
  const option = computePriorityOptions(ctx, controller).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, `cast ${spell.name} from hand`).toBeDefined();
  pump(
    applyPriorityAction(ctx, controller, option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    (decision) => {
      const targetIndex =
        chooseCountTarget === undefined
          ? -1
          : decision.options.findIndex((candidate) =>
              candidate.description.includes(chooseCountTarget),
            );
      if (targetIndex >= 0) return { index: targetIndex, targets: new Map() };
      const decline = decision.options.findIndex((candidate) => candidate.type === 'decline');
      return { index: decline >= 0 ? decline : 0, targets: new Map() };
    },
  );
  const stackObject = ctx.state.stack.find((entry) => entry.sourceCardId === object.cardId);
  if (stackObject === undefined) throw new Error(`${spell.name} did not reach the stack`);
  return stackObject.id;
}

function castPinnedToStack(
  ctx: GameContext,
  playerId: string,
  name: keyof typeof pins,
  targets: ReadonlyMap<number, string> = new Map(),
): string {
  return castToStack(ctx, playerId, card(name), targets);
}

function resolveTop(ctx: GameContext, color?: string): string[] {
  let colorOptions: string[] = [];
  pump(resolveTopOfStack(ctx), (decision) => {
    if (color !== undefined && decision.prompt.startsWith('Choose a color for ')) {
      for (const option of decision.options) {
        expect(option.interaction).toEqual({ kind: 'choice' });
      }
      colorOptions = decision.options.map((option) => option.description);
      const index = decision.options.findIndex(
        (option) => option.description === `Protection from ${color}`,
      );
      if (index < 0) throw new Error(`No protection choice for ${color}`);
      return { index, targets: new Map() };
    }
    return { index: 0, targets: new Map() };
  });
  return colorOptions;
}

describe('white-black-control protection and stack cards — pinned Oracle', () => {
  it('pins all four Oracle hashes and fully models the local overrides', () => {
    for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
      expect(cards.get(name)?.sha256).toBe(pins[name]);
      const definition = interpretCard(card(name));
      expect(definition.modeled, name).toBe(true);
      expect(definition.unmodeledReasons, name).toEqual([]);
    }
  });

  it('mother-of-runes-c01/c02-positive — cast, summoning sickness, own/self targeting, tap cost, and resolution-time color choice', () => {
    const ctx = context('mother-runes-activation');
    ensureMana(ctx, 'P1', 3);
    const motherStackId = castPinnedToStack(ctx, 'P1', 'Mother of Runes');
    expect(ctx.state.stack.find((entry) => entry.id === motherStackId)).toBeDefined();
    resolveTop(ctx);
    const mother = ctx.state.battlefield.find((permanent) => permanent.name === 'Mother of Runes');
    if (mother === undefined) throw new Error('Mother of Runes did not resolve');
    const ownTarget = spawn(ctx, 'P1', bear());
    const opponentTarget = spawn(ctx, 'P2', bear());
    const activated = interpretCard(card('Mother of Runes')).activatedAbilities[0];
    if (activated === undefined) throw new Error('Mother activation missing');
    expect(computeTargetOptions(ctx, activated.ability.targets[0]!, 'P1')).toEqual(
      expect.arrayContaining([mother.id, ownTarget.id]),
    );
    expect(computeTargetOptions(ctx, activated.ability.targets[0]!, 'P1')).not.toContain(
      opponentTarget.id,
    );
    const p1 = player(ctx, 'P1');
    const option = computePriorityOptions(ctx, p1).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === mother.id;
    });
    expect(option).toBeUndefined(); // newly cast Mother is summoning sick
    mother.summoningSick = false;
    const readyOption = computePriorityOptions(ctx, p1).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === mother.id;
    });
    expect(readyOption).toBeDefined();
    let colorPromptedOnActivation = false;
    pump(
      applyPriorityAction(ctx, p1, readyOption!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, mother.id]]),
      }),
      (decision) => {
        colorPromptedOnActivation ||= decision.prompt.startsWith('Choose a color for ');
        return { index: 0, targets: new Map() };
      },
    );
    expect(colorPromptedOnActivation).toBe(false);
    expect(mother.tapped).toBe(true);
    const choice = ctx.state.stack.at(-1);
    expect(choice?.targets).toEqual([mother.id]);
    const colors = resolveTop(ctx, 'W');
    expect(colors).toHaveLength(5);
    expect(colors).toEqual(
      expect.arrayContaining([
        'Protection from W',
        'Protection from U',
        'Protection from B',
        'Protection from R',
        'Protection from G',
      ]),
    );
    expect(colors).not.toContain('Protection from C');
    expect(computeCharacteristics(ctx, mother).protectionFrom).toEqual(['W']);
    expect(hasProtectionFrom(ctx, mother, { colors: ['W'], types: [] })).toBe(true);
  });

  it('mother-of-runes-c03/c04-positive — protection prevents white damage/targeting, survives source departure, blinks away, and expires at cleanup', () => {
    const ctx = context('mother-runes-protection-consequences');
    ensureMana(ctx, 'P1', 3);
    const motherId = castPinnedToStack(ctx, 'P1', 'Mother of Runes');
    resolveTop(ctx);
    const mother = ctx.state.battlefield.find(
      (permanent) => permanent.id !== undefined && permanent.name === 'Mother of Runes',
    )!;
    mother.summoningSick = false;
    const target = spawn(ctx, 'P1', bear());
    const p1 = player(ctx, 'P1');
    const activate = computePriorityOptions(ctx, p1).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === mother.id;
    });
    expect(activate).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, activate!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, target.id]]),
      }),
    );
    pump(moveObject(ctx, mother, { zone: 'graveyard' }));
    resolveTop(ctx, 'W');
    expect(ctx.state.battlefield.some((permanent) => permanent.id === mother.id)).toBe(false);
    expect(computeCharacteristics(ctx, target).protectionFrom).toEqual(['W']);
    const whiteSource = spawn(
      ctx,
      'P2',
      oracle({
        name: 'White Damage Source',
        typeLine: 'Creature — Test',
        colors: ['W'],
        power: '2',
        toughness: '2',
      }),
    );
    dealDamageToCreature(
      ctx,
      {
        id: whiteSource.id,
        cardId: whiteSource.cardId,
        name: whiteSource.name,
        oracleId: whiteSource.oracleId,
        controllerId: 'P2',
      },
      target,
      2,
      {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
        sourceTraits: { colors: ['W'], types: ['Creature'] },
      },
    );
    expect(target.damageMarked).toBe(0);
    const whiteTargetSpec: TargetSpec = { kind: 'creature' };
    expect(
      computeTargetOptions(ctx, whiteTargetSpec, 'P2', {
        traits: { colors: ['W'], types: [] },
        kind: 'spell',
      }),
    ).not.toContain(target.id);
    expect(
      computeTargetOptions(ctx, whiteTargetSpec, 'P2', {
        traits: { colors: ['B'], types: [] },
        kind: 'spell',
      }),
    ).toContain(target.id);
    const returned = pump(moveObject(ctx, target, { zone: 'exile' })).value;
    if (returned === null || returned === undefined || returned.zone !== 'exile')
      throw new Error('Target did not leave');
    const blinked = pump(
      moveObject(ctx, returned, { zone: 'battlefield', controllerId: 'P1' }),
    ).value;
    if (blinked === null || blinked.zone !== 'battlefield' || !('controllerId' in blinked))
      throw new Error('Target did not return');
    expect(computeCharacteristics(ctx, blinked).protectionFrom).toEqual([]);
    const targetAgain = spawn(ctx, 'P1', bear());
    const source = ctx.state.battlefield.find((permanent) => permanent.id === motherId);
    expect(source).toBeUndefined();
    ctx.state.effects.push({
      id: 'eff-protection-expiry-test',
      sourceId: targetAgain.cardId,
      description: 'temporary protection',
      targetCardIds: [targetAgain.cardId],
      kind: 'grantProtection',
      protectionFrom: ['W'],
      timestamp: ctx.state.nextTimestamp++,
    });
    expect(computeCharacteristics(ctx, targetAgain).protectionFrom).toEqual(['W']);
    expect(
      buildPlayerBoardState(ctx, 'P1').battlefield.find(
        (permanent) => permanent.id === targetAgain.id,
      )?.keywords,
    ).toContain('protection from white');
    endUntilEotEffects(ctx);
    expect(computeCharacteristics(ctx, targetAgain).protectionFrom).toEqual([]);
    expect(
      buildPlayerBoardState(ctx, 'P1').battlefield.find(
        (permanent) => permanent.id === targetAgain.id,
      )?.keywords,
    ).not.toContain('protection from white');
  });

  it('sejiri-shelter-c01-positive — the normal spell targets only your creature and chooses color on resolution', () => {
    const ctx = context('sejiri-shelter-spell');
    ensureMana(ctx, 'P1', 3);
    const ally = spawn(ctx, 'P1', bear());
    const opponent = spawn(ctx, 'P2', bear());
    const protectionTarget = interpretCard(card('Sejiri Shelter // Sejiri Glacier')).spellAbility
      ?.targets[0];
    if (protectionTarget === undefined) throw new Error('Sejiri protection target missing');
    expect(computeTargetOptions(ctx, protectionTarget, 'P1')).toContain(ally.id);
    expect(computeTargetOptions(ctx, protectionTarget, 'P1')).not.toContain(opponent.id);
    const stackId = castPinnedToStack(
      ctx,
      'P1',
      'Sejiri Shelter // Sejiri Glacier',
      new Map([[0, ally.id]]),
    );
    const entry = ctx.state.stack.find((candidate) => candidate.id === stackId);
    expect(entry?.targets).toEqual([ally.id]);
    expect(computeCharacteristics(ctx, ally).protectionFrom).toEqual([]);
    resolveTop(ctx, 'U');
    expect(computeCharacteristics(ctx, ally).protectionFrom).toEqual(['U']);
    expect(computeCharacteristics(ctx, opponent).protectionFrom).toEqual([]);
    endUntilEotEffects(ctx);
    expect(computeCharacteristics(ctx, ally).protectionFrom).toEqual([]);
  });

  it('sejiri-shelter-c02-positive — plays the tapped Glacier face without exceeding the land-play limit', () => {
    const ctx = context('sejiri-glacier-land');
    const p1 = player(ctx, 'P1');
    const shelter = conjure(ctx, 'P1', card('Sejiri Shelter // Sejiri Glacier'), 'hand');
    const extraLand = conjure(ctx, 'P1', plains(), 'hand');
    const firstAction = computePriorityOptions(ctx, p1).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === shelter.id;
    });
    expect(firstAction?.description).toBe('Play Sejiri Glacier');
    pump(
      applyPriorityAction(ctx, p1, firstAction!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    const glacier = ctx.state.battlefield.find((permanent) => permanent.cardId === shelter.cardId);
    if (glacier === undefined) throw new Error('Sejiri Glacier did not enter');
    expect(glacier.name).toBe('Sejiri Glacier');
    expect(glacier.face).toBe('back');
    expect(glacier.tapped).toBe(true);
    expect(p1.landsPlayedThisTurn).toBe(1);
    expect(
      computePriorityOptions(ctx, p1).some((entry) => {
        const payload = entry.payload as PriorityActionPayload;
        return payload.kind === 'playLand' && payload.objectId === extraLand.id;
      }),
    ).toBe(false);
    glacier.tapped = false;
    expect(
      manaSourcesFor(ctx, 'P1').some(
        (source) =>
          source.cardId === glacier.cardId && source.units.some((unit) => unit.includes('W')),
      ),
    ).toBe(true);
  });

  it('reprieve-c01/c02-positive — returns its owner’s own spell, draws one, and removes a copy without making a card', () => {
    const ctx = context('reprieve-own-spell-and-copy');
    ensureMana(ctx, 'P1', 8, 1);
    const ownTarget = spawn(ctx, 'P1', bear());
    const originalId = castToStack(ctx, 'P1', doom(), new Map([[0, ownTarget.id]]));
    const original = ctx.state.stack.find((entry) => entry.id === originalId)!;
    const copy = {
      ...original,
      id: `copy-${original.id}`,
      sourceId: `copy-source-${original.id}`,
      card: null,
    };
    ctx.state.stack.push(copy);
    player(ctx, 'P1').library = [];
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Reprieve Draw', typeLine: 'Basic Land — Test', manaCost: null, cmc: 0 }),
      'library',
    );
    const reprieveId = castPinnedToStack(ctx, 'P1', 'Reprieve', new Map([[0, copy.id]]));
    expect(ctx.state.stack.at(-1)?.id).toBe(reprieveId);
    resolveTop(ctx);
    expect(ctx.state.stack.some((entry) => entry.id === originalId)).toBe(true);
    expect(ctx.state.stack.some((entry) => entry.id === copy.id)).toBe(false);
    expect(ctx.state.exile.some((object) => object.name === 'Doom')).toBe(false);
    expect(player(ctx, 'P1').hand.map((object) => object.name)).toContain('Reprieve Draw');
    expect(player(ctx, 'P1').cardsDrawnThisTurn).toBe(1);
    resolveTop(ctx);
    expect(player(ctx, 'P1').graveyard.some((object) => object.name === 'Test Doom')).toBe(true);

    const opponentOwnsSpell = context('reprieve-owner-not-controller');
    ensureMana(opponentOwnsSpell, 'P1', 3);
    ensureMana(opponentOwnsSpell, 'P2', 0, 1);
    const p1Creature = spawn(opponentOwnsSpell, 'P1', bear());
    const opponentSpell = castToStack(
      opponentOwnsSpell,
      'P2',
      doom(),
      new Map([[0, p1Creature.id]]),
    );
    castPinnedToStack(opponentOwnsSpell, 'P1', 'Reprieve', new Map([[0, opponentSpell]]));
    resolveTop(opponentOwnsSpell);
    expect(player(opponentOwnsSpell, 'P2').hand.some((object) => object.name === 'Test Doom')).toBe(
      true,
    );
    expect(player(opponentOwnsSpell, 'P1').hand.some((object) => object.name === 'Test Doom')).toBe(
      false,
    );
  });

  it('reprieve-c03/c04-negative — a gone target fizzles without drawing, but an uncounterable own spell is still returnable', () => {
    const gone = context('reprieve-target-gone');
    ensureMana(gone, 'P1', 7, 1);
    const target = castToStack(gone, 'P1', doom(), new Map([[0, spawn(gone, 'P1', bear()).id]]));
    const original = gone.state.stack.find((entry) => entry.id === target)!;
    player(gone, 'P1').library = [];
    conjure(gone, 'P1', plains(), 'library');
    const reprieveId = castPinnedToStack(gone, 'P1', 'Reprieve', new Map([[0, target]]));
    const stackIndex = gone.state.stack.findIndex((entry) => entry.id === target);
    gone.state.stack.splice(stackIndex, 1);
    if (original.card === null) throw new Error('Original spell card missing');
    pump(moveObject(gone, original.card, { zone: 'graveyard' }));
    resolveTop(gone);
    expect(gone.state.stack.some((entry) => entry.id === reprieveId)).toBe(false);
    expect(player(gone, 'P1').cardsDrawnThisTurn).toBe(0);
    expect(player(gone, 'P1').hand.some((object) => object.name === 'Plains')).toBe(false);

    const uncounterable = context('reprieve-uncounterable-own-spell');
    ensureMana(uncounterable, 'P1', 7);
    const card = oracle({
      name: 'Cannot Be Countered',
      typeLine: 'Instant',
      manaCost: '{0}',
      oracleText: "This spell can't be countered.",
    });
    const definition: CardDefinition = {
      ...interpretCard(card),
      modeled: true,
      unmodeledReasons: [],
      spellCantBeCountered: true,
      spellAbility: { kind: 'spell', targets: [], effects: [], cantBeCountered: true },
    };
    uncounterable.defs.set(card.oracleId, definition);
    const targetId = castToStack(uncounterable, 'P1', card);
    player(uncounterable, 'P1').library = [];
    conjure(uncounterable, 'P1', plains(), 'library');
    castPinnedToStack(uncounterable, 'P1', 'Reprieve', new Map([[0, targetId]]));
    resolveTop(uncounterable);
    expect(uncounterable.state.stack.some((entry) => entry.id === targetId)).toBe(false);
    expect(
      player(uncounterable, 'P1').hand.some((object) => object.name === 'Cannot Be Countered'),
    ).toBe(true);
    expect(player(uncounterable, 'P1').cardsDrawnThisTurn).toBe(1);
  });

  it('rebuff-the-wicked-c01/c02-positive — targets spells aimed at an ordinary or counted permanent you control', () => {
    const ordinary = context('rebuff-ordinary-target');
    ensureMana(ordinary, 'P1', 4);
    ensureMana(ordinary, 'P2', 0, 2);
    const ally = spawn(ordinary, 'P1', bear());
    const doomedSpell = castToStack(ordinary, 'P2', doom(), new Map([[0, ally.id]]));
    const counter = castPinnedToStack(
      ordinary,
      'P1',
      'Rebuff the Wicked',
      new Map([[0, doomedSpell]]),
    );
    resolveTop(ordinary);
    expect(ordinary.state.stack.some((entry) => entry.id === doomedSpell)).toBe(false);
    expect(ordinary.state.eventLog.some((event) => event.type === 'counterSpell')).toBe(true);
    expect(ordinary.state.stack.some((entry) => entry.id === counter)).toBe(false);

    const counted = context('rebuff-counted-target');
    ensureMana(counted, 'P1', 4);
    ensureMana(counted, 'P2', 1);
    const first = spawn(counted, 'P1', bear());
    const selected = oracle({ name: 'Counted Target Probe', typeLine: 'Instant', manaCost: '{0}' });
    const definition: CardDefinition = {
      ...interpretCard(selected),
      modeled: true,
      unmodeledReasons: [],
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', count: { min: 1, max: 2 } }],
        effects: [],
        description: 'Choose up to two target creatures',
      },
    };
    const object = conjure(counted, 'P2', selected, 'hand');
    counted.defs.set(selected.oracleId, definition);
    const action = computePriorityOptions(counted, player(counted, 'P2')).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === object.id;
    });
    expect(action).toBeDefined();
    pump(
      applyPriorityAction(
        counted,
        player(counted, 'P2'),
        action!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
      (decision) => {
        const index = decision.options.findIndex((candidate) =>
          candidate.description.includes(first.name),
        );
        return { index: index >= 0 ? index : 0, targets: new Map() };
      },
    );
    const countedSpell = counted.state.stack.at(-1)!;
    expect(countedSpell.countTargets?.[0]).toContain(first.id);
    const rebuff = castPinnedToStack(
      counted,
      'P1',
      'Rebuff the Wicked',
      new Map([[0, countedSpell.id]]),
    );
    resolveTop(counted);
    expect(counted.state.stack.some((entry) => entry.id === countedSpell.id)).toBe(false);
    expect(counted.state.stack.some((entry) => entry.id === rebuff)).toBe(false);
  });

  it('rebuff-the-wicked-c03/c04-negative — ignores player/opponent-permanent/targetless spells and fizzles after control changes', () => {
    const ctx = context('rebuff-invalid-targets');
    ensureMana(ctx, 'P1', 4);
    ensureMana(ctx, 'P2', 0, 3);
    const opponentCreature = spawn(ctx, 'P2', bear());
    const ownCreature = spawn(ctx, 'P1', bear());
    const ownSpell = castToStack(ctx, 'P2', doom(), new Map([[0, opponentCreature.id]]));
    const spec: TargetSpec = { kind: 'spell', spellTargetsPermanentYouControl: true };
    expect(
      computeTargetOptions(ctx, spec, 'P1', {
        traits: { colors: ['W'], types: [] },
        kind: 'spell',
      }),
    ).not.toContain(ownSpell);
    const mother = spawn(ctx, 'P1', card('Mother of Runes'));
    mother.summoningSick = false;
    const activateMother = computePriorityOptions(ctx, player(ctx, 'P1')).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === mother.id;
    });
    expect(activateMother).toBeDefined();
    pump(
      applyPriorityAction(
        ctx,
        player(ctx, 'P1'),
        activateMother!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map([[0, ownCreature.id]]),
        },
      ),
    );
    const activatedAbility = ctx.state.stack.at(-1)!;
    expect(activatedAbility.kind).toBe('activatedAbility');
    expect(
      computeTargetOptions(ctx, spec, 'P1', {
        traits: { colors: ['W'], types: [] },
        kind: 'spell',
      }),
    ).not.toContain(activatedAbility.id);
    const playerTargetSpell = oracle({
      name: 'Player Target Probe',
      typeLine: 'Instant',
      manaCost: '{0}',
    });
    const playerDefinition: CardDefinition = {
      ...interpretCard(playerTargetSpell),
      modeled: true,
      unmodeledReasons: [],
      spellAbility: { kind: 'spell', targets: [{ kind: 'player' }], effects: [] },
    };
    const playerObject = conjure(ctx, 'P2', playerTargetSpell, 'hand');
    ctx.defs.set(playerTargetSpell.oracleId, playerDefinition);
    const playerCast = computePriorityOptions(ctx, player(ctx, 'P2')).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === playerObject.id;
    });
    expect(playerCast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player(ctx, 'P2'), playerCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P1']]),
      }),
    );
    const spellOnPlayer = ctx.state.stack.at(-1)!;
    expect(
      computeTargetOptions(ctx, spec, 'P1', {
        traits: { colors: ['W'], types: [] },
        kind: 'spell',
      }),
    ).not.toContain(spellOnPlayer.id);
    const targetlessCard = oracle({
      name: 'Targetless Probe',
      typeLine: 'Instant',
      manaCost: '{0}',
    });
    ctx.defs.set(targetlessCard.oracleId, {
      ...interpretCard(targetlessCard),
      modeled: true,
      unmodeledReasons: [],
      spellAbility: { kind: 'spell', targets: [], effects: [] },
    });
    const targetless = castToStack(ctx, 'P2', targetlessCard);
    expect(
      computeTargetOptions(ctx, spec, 'P1', {
        traits: { colors: ['W'], types: [] },
        kind: 'spell',
      }),
    ).not.toContain(targetless);

    const changed = context('rebuff-control-change');
    ensureMana(changed, 'P1', 4);
    ensureMana(changed, 'P2', 0, 2);
    const changedCreature = spawn(changed, 'P1', bear());
    const spellId = castToStack(changed, 'P2', doom(), new Map([[0, changedCreature.id]]));
    const rebuffId = castPinnedToStack(changed, 'P1', 'Rebuff the Wicked', new Map([[0, spellId]]));
    changedCreature.controllerId = 'P2';
    resolveTop(changed);
    expect(changed.state.stack.some((entry) => entry.id === spellId)).toBe(true);
    expect(changed.state.stack.some((entry) => entry.id === rebuffId)).toBe(false);
  });

  it('rebuff-the-wicked-c05-positive — uncounterable spells remain legal targets but cannot be countered', () => {
    const ctx = context('rebuff-uncounterable');
    ensureMana(ctx, 'P1', 4);
    const ally = spawn(ctx, 'P1', bear());
    const uncounterable = oracle({
      name: 'Targeted Uncounterable',
      typeLine: 'Instant',
      manaCost: '{0}',
      oracleText: "This spell can't be countered.",
    });
    const definition: CardDefinition = {
      ...interpretCard(uncounterable),
      modeled: true,
      unmodeledReasons: [],
      spellCantBeCountered: true,
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [],
        description: 'Target own creature',
        cantBeCountered: true,
      },
    };
    ctx.defs.set(uncounterable.oracleId, definition);
    const spellId = castToStack(ctx, 'P1', uncounterable, new Map([[0, ally.id]]));
    expect(ctx.state.stack.find((entry) => entry.id === spellId)?.ability).toMatchObject({
      kind: 'spell',
      cantBeCountered: true,
    });
    const rebuffId = castPinnedToStack(ctx, 'P1', 'Rebuff the Wicked', new Map([[0, spellId]]));
    expect(
      computeTargetOptions(ctx, { kind: 'spell', spellTargetsPermanentYouControl: true }, 'P1', {
        traits: { colors: ['W'], types: [] },
        kind: 'spell',
      }),
    ).toContain(spellId);
    resolveTop(ctx);
    expect(ctx.state.stack.some((entry) => entry.id === spellId)).toBe(true);
    expect(ctx.state.stack.some((entry) => entry.id === rebuffId)).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterPrevented')).toBe(true);
  });

  it('rejects the permanent-target flag outside spell targets and effects with a wrong reference domain', () => {
    const rebuff = interpretCard(card('Rebuff the Wicked'));
    const invalidTarget = {
      ...rebuff,
      spellAbility: {
        ...rebuff.spellAbility!,
        targets: [{ kind: 'creature', spellTargetsPermanentYouControl: true }],
      },
    };
    expect(
      validateCardDefinition(invalidTarget as unknown as CardDefinition).length,
    ).toBeGreaterThan(0);
    const invalidReference = {
      ...rebuff,
      spellAbility: {
        ...rebuff.spellAbility!,
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'returnSpellToOwnerHand', target: 0 }],
      },
    };
    expect(
      validateCardDefinition(invalidReference as unknown as CardDefinition).length,
    ).toBeGreaterThan(0);
  });
});
