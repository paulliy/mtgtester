import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlLeylineOverrides } from '../src/cards/overrides/white-black-control-leyline';
import { changeController, discardCard, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { runOpeningHandBattlefieldActions, runOpeningHands } from '../src/turn/mulligan';
import { copies, conjure, gameConfig, oracle, pick, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };

const oracleHash = '5b00b3e4eeb4eeac75b37fd67a7bb074f6cf1b6771d27f30b39cdb4cea7da74d';
const entry = pinned.cards.find((candidate) => candidate.card.name === 'Leyline of the Void');
if (entry === undefined) throw new Error('Missing pinned Oracle card: Leyline of the Void');
if (entry.sha256 !== oracleHash) throw new Error('Oracle hash drift for Leyline of the Void');
const leyline = entry.card;

beforeAll(() => registerWhiteBlackControlLeylineOverrides());

function context(seed = 'white-black-control-leyline'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(16, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 1,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}

function player(game: GameContext, id: string) {
  const found = game.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function castLeyline(game: GameContext): EnginePermanent {
  for (let index = 0; index < 4; index++) spawn(game, 'P1', swamp());
  conjure(game, 'P1', leyline, 'hand');
  let cast = false;
  pump(runPrioritySequence(game), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === 'P1' && !cast) {
      const index = decision.options.findIndex(
        (option) =>
          option.type === 'castSpell' && option.description.includes('Leyline of the Void'),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets: new Map() };
      }
    }
    return pick(decision, /Pass|does not/i);
  });
  expect(cast, 'Leyline of the Void casts from hand through normal priority').toBe(true);
  const permanent = game.state.battlefield.find(
    (candidate) => candidate.name === 'Leyline of the Void',
  );
  if (permanent === undefined)
    throw new Error('Leyline of the Void did not resolve as a permanent');
  return permanent;
}

function cardNamed(name: string, typeLine = 'Sorcery'): OracleCard {
  return oracle({ name, typeLine, manaCost: null, cmc: 1, power: null, toughness: null });
}

describe('Leyline of the Void — pinned Oracle opening action and graveyard replacement', () => {
  it('leyline-c01 — pins the exact Oracle hash and models both printed clauses', () => {
    expect(entry.sha256).toBe(oracleHash);
    const definition = interpretCard(leyline);
    expect(definition.modeled, definition.unmodeledReasons.join('; ')).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.ruleStatics).toEqual(
      expect.arrayContaining([
        { kind: 'beginOnBattlefieldFromOpeningHand' },
        { kind: 'graveyardToExile', scope: 'opponents', basis: 'owner', includeTokens: false },
      ]),
    );
  });

  it('leyline-c02 — normal cast resolves and affects opponent-owned cards from hand, library, and stack', () => {
    const game = context('leyline-normal-cast-all-zones');
    castLeyline(game);

    const discarded = conjure(game, 'P2', cardNamed('Opponent Discard'), 'hand');
    pump(discardCard(game, discarded, 'P2'));
    expect(game.state.exile.some((object) => object.cardId === discarded.cardId)).toBe(true);
    expect(player(game, 'P2').graveyard.some((object) => object.cardId === discarded.cardId)).toBe(
      false,
    );
    expect(game.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(1);

    const milled = conjure(game, 'P3', cardNamed('Opponent Library Card'), 'library');
    pump(moveObject(game, milled, { zone: 'graveyard' }));
    expect(game.state.exile.some((object) => object.cardId === milled.cardId)).toBe(true);

    const resolving = conjure(game, 'P4', cardNamed('Opponent Resolving Spell'), 'hand');
    pump(moveObject(game, resolving, { zone: 'stack' }));
    pump(moveObject(game, resolving, { zone: 'graveyard' }));
    expect(game.state.exile.some((object) => object.cardId === resolving.cardId)).toBe(true);
  });

  it('leyline-c03 — replacement follows owner, and leaves its controller’s own cards alone', () => {
    const game = context('leyline-owner-scope');
    castLeyline(game);

    const ownCard = conjure(game, 'P1', cardNamed('Controller Owned'), 'hand');
    pump(moveObject(game, ownCard, { zone: 'graveyard' }));
    expect(player(game, 'P1').graveyard.some((object) => object.cardId === ownCard.cardId)).toBe(
      true,
    );

    const stolen = spawn(game, 'P1', cardNamed('Controller Owned Permanent', 'Creature — Bear'));
    changeController(game, stolen, 'P2');
    pump(moveObject(game, stolen, { zone: 'graveyard' }));
    expect(player(game, 'P1').graveyard.some((object) => object.cardId === stolen.cardId)).toBe(
      true,
    );
    expect(game.state.exile.some((object) => object.cardId === stolen.cardId)).toBe(false);
  });

  it('leyline-c04 — tokens are not exiled by this card’s replacement', () => {
    const game = context('leyline-token-negative');
    castLeyline(game);
    const token = spawn(game, 'P2', cardNamed('Leyline Test Token', 'Creature — Spirit'), {
      isToken: true,
    });
    pump(moveObject(game, token, { zone: 'graveyard' }));
    expect(game.state.exile.some((object) => object.id === token.id)).toBe(false);
    expect(
      game.state.eventLog.some(
        (event) => event.type === 'dies' && event.payload['cardId'] === token.cardId,
      ),
    ).toBe(false);
  });

  it('leyline-c05 — the opening-hand battlefield choice can be accepted or declined after mulligans', () => {
    const accepted = context('leyline-opening-accept');
    const acceptedCard = conjure(accepted, 'P1', leyline, 'hand');
    let acceptedPrompts = 0;
    pump(runOpeningHandBattlefieldActions(accepted), (decision) => {
      if (!decision.prompt.includes('opening hand')) return pick(decision, /Pass|does not/i);
      acceptedPrompts++;
      expect(decision.player).toBe('P1');
      return pick(decision, 'Begin with Leyline of the Void on the battlefield');
    });
    expect(acceptedPrompts).toBe(1);
    expect(gameObjectInZone(accepted, acceptedCard.cardId, 'battlefield')).toBe(true);
    expect(
      player(accepted, 'P1').hand.some((object) => object.cardId === acceptedCard.cardId),
    ).toBe(false);

    const declined = context('leyline-opening-decline');
    const declinedCard = conjure(declined, 'P1', leyline, 'hand');
    pump(runOpeningHandBattlefieldActions(declined), (decision) =>
      decision.prompt.includes('opening hand')
        ? pick(decision, 'Keep the remaining cards in hand')
        : pick(decision, /Pass|does not/i),
    );
    expect(
      player(declined, 'P1').hand.some((object) => object.cardId === declinedCard.cardId),
    ).toBe(true);
    expect(gameObjectInZone(declined, declinedCard.cardId, 'battlefield')).toBe(false);
  });

  it('leyline-c06 — opening-hand actions follow APNAP order and each player decides independently', () => {
    const game = context('leyline-opening-apnap');
    game.state.currentTurnPlayer = 'P3';
    game.state.activePlayerIndex = 2;
    for (const id of ['P1', 'P2', 'P3', 'P4']) conjure(game, id, leyline, 'hand');
    const order: string[] = [];
    pump(runOpeningHandBattlefieldActions(game), (decision) => {
      if (!decision.prompt.includes('opening hand')) return pick(decision, /Pass|does not/i);
      order.push(decision.player);
      return decision.player === 'P3' || decision.player === 'P1'
        ? pick(decision, 'Begin with Leyline of the Void on the battlefield')
        : pick(decision, 'Keep the remaining cards in hand');
    });
    expect(order).toEqual(['P3', 'P4', 'P1', 'P2']);
    for (const id of ['P3', 'P1'])
      expect(
        game.state.battlefield.some(
          (object) => object.controllerId === id && object.name === 'Leyline of the Void',
        ),
      ).toBe(true);
    for (const id of ['P4', 'P2'])
      expect(player(game, id).hand.some((object) => object.name === 'Leyline of the Void')).toBe(
        true,
      );
  });

  it('leyline-c07 — London mulligan keeps the seven-card hand and still offers Leyline afterward', () => {
    const leylineCopies = copies(8, () => leyline);
    const game = createGame(
      gameConfig(
        [
          { cards: leylineCopies },
          { cards: copies(8, swamp) },
          { cards: copies(8, swamp) },
          { cards: copies(8, swamp) },
        ],
        { seed: 'leyline-mulligan-hand-semantics' },
      ),
    );
    game.state.currentTurnPlayer = 'P1';
    game.state.activePlayerIndex = 0;
    let p1Mulligans = 0;
    let openingChoice = 0;
    pump(runOpeningHands(game), (decision) => {
      if (decision.decisionType === 'mulligan' && decision.player === 'P1') {
        p1Mulligans++;
        return p1Mulligans === 1 ? pick(decision, 'Mulligan') : pick(decision, 'Keep');
      }
      if (decision.prompt.includes('opening hand') && decision.player === 'P1') {
        openingChoice++;
        return openingChoice === 1
          ? pick(decision, 'Begin with Leyline of the Void on the battlefield')
          : pick(decision, 'Keep the remaining cards in hand');
      }
      if (decision.prompt.includes('opening hand'))
        return pick(decision, 'Keep the remaining cards in hand');
      return { index: 0, targets: new Map() };
    });
    expect(player(game, 'P1').mulligansTaken).toBe(1);
    expect(player(game, 'P1').hand).toHaveLength(6);
    expect(
      game.state.battlefield.filter(
        (object) => object.controllerId === 'P1' && object.name === 'Leyline of the Void',
      ),
    ).toHaveLength(1);
    const keep = game.state.eventLog.find(
      (event) => event.type === 'keepHand' && event.payload['player'] === 'P1',
    );
    expect(keep?.payload['bottoming']).toBe(0);
  });

  it('leyline-c08 — removing Leyline ends its replacement effect', () => {
    const game = context('leyline-source-gone');
    const permanent = castLeyline(game);
    pump(moveObject(game, permanent, { zone: 'graveyard' }));
    const later = conjure(game, 'P2', cardNamed('After Leyline Leaves'), 'hand');
    pump(moveObject(game, later, { zone: 'graveyard' }));
    expect(player(game, 'P2').graveyard.some((object) => object.cardId === later.cardId)).toBe(
      true,
    );
    expect(game.state.exile.some((object) => object.cardId === later.cardId)).toBe(false);
  });
});

function gameObjectInZone(game: GameContext, cardId: string, zone: 'battlefield'): boolean {
  return game.state.battlefield.some((object) => object.cardId === cardId && object.zone === zone);
}
