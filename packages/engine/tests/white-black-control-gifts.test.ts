import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlGiftOverrides } from '../src/cards/overrides/white-black-control-gifts';
import { computeCharacteristics } from '../src/effects/continuous';
import { activated, TAP } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import type { EnginePermanent, EngineStackObject, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueSpellCopy } from '../src/stack/copy';
import { targetIsLegal } from '../src/targets/legality';
import { conjure, copies, gameConfig, oracle, pump, spawn, swamp } from './fixtures';

interface Pinned {
  sha256: string;
  card: OracleCard;
}
const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: Pinned[] };
const pins = {
  "Bilbo's Gambit": '21f251166fa3895f74a7ffd11f2914f0c02a73564ca5ab87a76680b43633bf48',
  "Dawn's Truce": '9b94a7f24557052e39ba56e4a491a924a83f664f8eea7d2f37ff14dcd488877b',
} as const;
type GiftCardName = keyof typeof pins;
const cards = new Map<GiftCardName, Pinned>(
  Object.keys(pins).map((name) => {
    const entry = fixture.cards.find((candidate) => candidate.card.name === name);
    if (!entry) throw new Error(`Missing pinned Oracle card: ${name}`);
    return [name as GiftCardName, entry];
  }),
);
beforeAll(() => registerWhiteBlackControlGiftOverrides());

function ctx(seed = 'white-black-gifts'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}
function player(game: GameContext, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!;
}
function castCard(
  game: GameContext,
  card: OracleCard,
  controllerId = 'P1',
  options: {
    target?: string;
    giftRecipient?: string | null;
    mana?: Array<'W' | 'C'>;
  } = {},
): EngineStackObject {
  const object = conjure(game, controllerId, card, 'hand');
  addMana(
    player(game, controllerId),
    (options.mana ?? ['W', 'C']).map((symbol) => ({ symbol })),
  );
  const action = computePriorityOptions(game, player(game, controllerId)).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(action, `normal cast offered for ${card.name}`).toBeDefined();
  const targets = new Map<number, string>();
  if (options.target !== undefined) targets.set(0, options.target);
  let giftOptions: string[] = [];
  pump(
    applyPriorityAction(
      game,
      player(game, controllerId),
      action!.payload as PriorityActionPayload,
      { index: 0, targets },
    ),
    (decision) => {
      if (decision.prompt.startsWith('Promise an opponent a gift')) {
        giftOptions = decision.options.map((option) => option.description);
        if (options.giftRecipient == null) return { index: 0, targets: new Map() };
        const index = decision.options.findIndex((option) =>
          option.description.includes(`Promise ${options.giftRecipient} a gift`),
        );
        expect(index).toBeGreaterThan(0);
        return { index, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    },
  );
  const stackSpell = game.state.stack.find((entry) => entry.sourceCardId === object.cardId)!;
  if (card.name.startsWith('Bilbo')) expect(giftOptions.length).toBeGreaterThan(0);
  return stackSpell;
}
function castGift(
  game: GameContext,
  name: GiftCardName,
  options: Parameters<typeof castCard>[3] = {},
) {
  const entry = cards.get(name)!;
  expect(entry.sha256).toBe(pins[name]);
  const definition = interpretCard(entry.card);
  expect(definition.modeled, definition.unmodeledReasons.join('; ')).toBe(true);
  return castCard(game, entry.card, 'P1', options);
}
function castPlainInstant(
  game: GameContext,
  controllerId = 'P1',
  name = 'Target Instant',
): EngineStackObject {
  const printed = oracle({
    name,
    typeLine: 'Instant',
    types: ['Instant'],
    manaCost: '{0}',
    cmc: 0,
    power: null,
    toughness: null,
  });
  const object = conjure(game, controllerId, printed, 'hand');
  const old = game.defs.get(object.oracleId)!;
  game.defs.set(object.oracleId, {
    ...old,
    modeled: true,
    unmodeledReasons: [],
    spellAbility: { kind: 'spell', targets: [], effects: [], description: 'Test instant' },
  });
  const option = computePriorityOptions(game, player(game, controllerId)).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, `normal cast offered for ${name}`).toBeDefined();
  pump(
    applyPriorityAction(
      game,
      player(game, controllerId),
      option!.payload as PriorityActionPayload,
      { index: 0, targets: new Map() },
    ),
  );
  return game.state.stack.find((entry) => entry.sourceCardId === object.cardId)!;
}
function tokenCount(game: GameContext, ownerId: string, name: string) {
  return game.state.battlefield.filter(
    (permanent) =>
      permanent.controllerId === ownerId && permanent.name === name && permanent.isToken,
  ).length;
}
function addTestPermanent(game: GameContext, controllerId: string, name: string): EnginePermanent {
  return spawn(
    game,
    controllerId,
    oracle({
      name,
      typeLine: 'Artifact',
      types: ['Artifact'],
      manaCost: '{0}',
      cmc: 0,
      power: null,
      toughness: null,
    }),
  );
}

describe("Bilbo's Gambit and Dawn's Truce — pinned gift spells", () => {
  it('pins both Oracle texts and makes Gift an opponent choice while casting normally', () => {
    const game = ctx('gift-prompt');
    const target = castPlainInstant(game);
    const spell = castGift(game, "Bilbo's Gambit", { target: target.id, giftRecipient: 'P2' });
    expect(spell.giftRecipientId).toBe('P2');
    expect(tokenCount(game, 'P2', 'Treasure')).toBe(0); // fulfillment waits for resolution

    const declineGame = ctx('gift-decline-prompt');
    const declineTarget = castPlainInstant(declineGame);
    const declined = castGift(declineGame, "Bilbo's Gambit", {
      target: declineTarget.id,
      giftRecipient: null,
    });
    expect(declined.giftRecipientId).toBeUndefined();
  });

  it('fulfills promised Treasure before returning the target, then locks every player out of spells for this turn', () => {
    const game = ctx('gift-treasure-lock');
    const target = castPlainInstant(game, 'P1', 'Uncounterable Target');
    target.ability = { ...target.ability!, cantBeCountered: true };
    const bilbo = castGift(game, "Bilbo's Gambit", { target: target.id, giftRecipient: 'P2' });
    const before = tokenCount(game, 'P2', 'Treasure');
    pump(resolveTopOfStack(game));
    expect(tokenCount(game, 'P2', 'Treasure')).toBe(before + 1);
    expect(player(game, 'P1').hand.some((object) => object.cardId === target.card?.cardId)).toBe(
      true,
    );
    expect(game.state.spellsProhibitedTurn).toBe(game.state.turnNumber);
    const giftAt = game.state.eventLog.findIndex(
      (event) => event.type === 'giftFulfilled' && event.actorSeat === 'P1',
    );
    const returnAt = game.state.eventLog.findIndex((event) => event.type === 'returnSpell');
    expect(giftAt).toBeGreaterThanOrEqual(0);
    expect(returnAt).toBeGreaterThan(giftAt);
    expect(
      player(game, 'P1').graveyard.some((object) => object.cardId === bilbo.sourceCardId),
    ).toBe(true);

    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      const candidate = conjure(
        game,
        id,
        oracle({
          name: `Locked Instant ${id}`,
          typeLine: 'Instant',
          types: ['Instant'],
          manaCost: '{0}',
          cmc: 0,
          power: null,
          toughness: null,
        }),
        'hand',
      );
      const def = game.defs.get(candidate.oracleId)!;
      game.defs.set(candidate.oracleId, {
        ...def,
        modeled: true,
        unmodeledReasons: [],
        spellAbility: { kind: 'spell', targets: [], effects: [], description: 'Test instant' },
      });
      const options = computePriorityOptions(game, player(game, id));
      expect(
        options.some(
          (option) =>
            (option.payload as PriorityActionPayload).kind === 'castSpell' &&
            (option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId ===
              candidate.id,
        ),
      ).toBe(false);
    }
    const activatable = spawn(
      game,
      'P3',
      oracle({
        name: 'Activation Under Lock',
        typeLine: 'Artifact',
        types: ['Artifact'],
        manaCost: '{0}',
        cmc: 0,
        power: null,
        toughness: null,
      }),
    );
    const definition = game.defs.get(activatable.oracleId)!;
    game.defs.set(activatable.oracleId, {
      ...definition,
      activatedAbilities: [
        activated({
          costs: [TAP],
          effects: [{ op: 'gainLife', amount: constant(1) }],
          description: 'Gain 1 life',
        }),
      ],
    });
    expect(
      computePriorityOptions(game, player(game, 'P3')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === activatable.id;
      }),
    ).toBe(true); // prohibiting casts does not prohibit activation
    game.state.turnNumber += 1;
    const unlocked = player(game, 'P3').hand[0]!;
    expect(
      computePriorityOptions(game, player(game, 'P3')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === unlocked.id;
      }),
    ).toBe(true);
  });

  it('declining the gift bounces the spell but never creates Treasure or applies the spell lock', () => {
    const game = ctx('gift-declined-effects');
    const target = castPlainInstant(game);
    const bilbo = castGift(game, "Bilbo's Gambit", { target: target.id, giftRecipient: null });
    pump(resolveTopOfStack(game));
    expect(tokenCount(game, 'P2', 'Treasure')).toBe(0);
    expect(game.state.spellsProhibitedTurn).toBeUndefined();
    expect(game.state.stack.some((entry) => entry.id === target.id)).toBe(false);
    expect(player(game, 'P1').hand.some((object) => object.cardId === target.card?.cardId)).toBe(
      true,
    );
    expect(
      player(game, 'P1').graveyard.some((object) => object.cardId === bilbo.sourceCardId),
    ).toBe(true);
  });

  it('an all-illegal target fizzles before gift fulfillment and before the lock effect', () => {
    const game = ctx('gift-fizzle-no-promise-fulfillment');
    const target = castPlainInstant(game);
    castGift(game, "Bilbo's Gambit", { target: target.id, giftRecipient: 'P2' });
    game.state.stack.splice(
      game.state.stack.findIndex((entry) => entry.id === target.id),
      1,
    );
    pump(resolveTopOfStack(game));
    expect(game.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(tokenCount(game, 'P2', 'Treasure')).toBe(0);
    expect(game.state.spellsProhibitedTurn).toBeUndefined();
  });

  it('returns a targeted spell copy by removing it from the stack without returning a physical card', () => {
    const game = ctx('gift-return-copy');
    const original = castPlainInstant(game, 'P1', 'Copied Target Spell');
    const copy = queueSpellCopy(game, original, 'P3');
    const bilbo = castGift(game, "Bilbo's Gambit", { target: copy.id, giftRecipient: 'P2' });
    pump(resolveTopOfStack(game));
    expect(game.state.stack.some((entry) => entry.id === copy.id)).toBe(false);
    expect(game.state.stack.some((entry) => entry.id === original.id)).toBe(true);
    expect(
      game.state.eventLog.some(
        (event) => event.type === 'returnSpell' && event.payload['name'] === copy.description,
      ),
    ).toBe(true);
    expect(tokenCount(game, 'P2', 'Treasure')).toBe(1);
    expect(game.state.spellsProhibitedTurn).toBe(game.state.turnNumber);
    expect(bilbo.giftRecipientId).toBe('P2');
  });

  it('Dawn draws for the promised recipient before granting hexproof and gifted indestructible to a fixed set', () => {
    const game = ctx('dawn-gift-set');
    const ownerPermanent = addTestPermanent(game, 'P1', 'Original Owner Artifact');
    const opponentPermanent = addTestPermanent(game, 'P2', 'Gift Recipient Artifact');
    const beforeHand = player(game, 'P2').hand.length;
    const dawn = castGift(game, "Dawn's Truce", { giftRecipient: 'P2' });
    expect(player(game, 'P2').hand.length).toBe(beforeHand);
    pump(resolveTopOfStack(game));
    expect(player(game, 'P2').hand.length).toBe(beforeHand + 1);
    expect(game.state.eventLog.findIndex((event) => event.type === 'giftFulfilled')).toBeLessThan(
      game.state.eventLog.findIndex((event) => event.type === 'grantKeyword'),
    );
    const ownerKeywords = computeCharacteristics(game, ownerPermanent).keywords;
    const opponentKeywords = computeCharacteristics(game, opponentPermanent).keywords;
    expect(ownerKeywords).toContain('hexproof');
    expect(ownerKeywords).toContain('indestructible');
    expect(opponentKeywords).not.toContain('hexproof');
    expect(opponentKeywords).not.toContain('indestructible');
    const later = addTestPermanent(game, 'P1', 'Later Artifact');
    expect(computeCharacteristics(game, later).keywords).not.toContain('indestructible');
    expect(computeCharacteristics(game, later).keywords).not.toContain('hexproof');
    expect(dawn.giftRecipientId).toBe('P2');
  });

  it('Dawn still grants own hexproof when Gift is declined, without indestructible', () => {
    const game = ctx('dawn-declined');
    const permanent = addTestPermanent(game, 'P1', 'Protected Without Gift');
    castGift(game, "Dawn's Truce", { giftRecipient: null });
    pump(resolveTopOfStack(game));
    const keywords = computeCharacteristics(game, permanent).keywords;
    expect(keywords).toContain('hexproof');
    expect(keywords).not.toContain('indestructible');
  });

  it('gifted Dawn copy gives the original opponent the card and grants protection to the copy controller', () => {
    const game = ctx('dawn-copy-controller');
    const originalOwnerPermanent = addTestPermanent(game, 'P1', 'Original Cast Controller');
    const copyControllerPermanent = addTestPermanent(game, 'P3', 'Copy Controller Permanent');
    const recipientHand = player(game, 'P2').hand.length;
    const original = castGift(game, "Dawn's Truce", { giftRecipient: 'P2' });
    const copy = queueSpellCopy(game, original, 'P3');
    expect(copy.giftRecipientId).toBe('P2');
    pump(resolveTopOfStack(game));
    expect(player(game, 'P2').hand.length).toBe(recipientHand + 1);
    expect(game.state.playerHexproofTurn?.['P3']).toBe(game.state.turnNumber);
    expect(game.state.playerHexproofTurn?.['P1']).toBeUndefined();
    expect(computeCharacteristics(game, copyControllerPermanent).keywords).toContain(
      'indestructible',
    );
    expect(computeCharacteristics(game, originalOwnerPermanent).keywords).not.toContain(
      'indestructible',
    );
    expect(targetIsLegal(game, 'player', 'P3', { controllerId: 'P2' })).toBe(false);
    expect(targetIsLegal(game, 'player', 'P3', { controllerId: 'P3' })).toBe(true);
    expect(targetIsLegal(game, 'player', 'P1', { controllerId: 'P2' })).toBe(true);
    game.state.turnNumber += 1;
    expect(targetIsLegal(game, 'player', 'P3', { controllerId: 'P2' })).toBe(true);
  });
});
