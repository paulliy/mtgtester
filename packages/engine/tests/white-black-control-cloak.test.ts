import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlCloakOverrides } from '../src/cards/overrides/white-black-control-cloak';
import { runCombatPhase } from '../src/combat/combat';
import { addMana } from '../src/mana/pool';
import { attachPermanent, changeController, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import {
  bear,
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };
const pin: PinnedCard = (() => {
  const found = fixture.cards.find(({ card }) => card.name === 'Cloak of Confusion');
  if (found === undefined) throw new Error('Missing Cloak of Confusion Oracle pin');
  return found;
})();
const ORACLE_SHA256 = 'ad25a794244abd775a070eff00cdd3a8b80efa826b43b47d1f8d46d6f95849bc';
beforeAll(registerWhiteBlackControlCloakOverrides);

function context(seed: string): GameContext {
  const game = createGame(
    gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })), { seed }),
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
  const found = game.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function castCloak(game: GameContext, host: EnginePermanent): EnginePermanent {
  const object = conjure(game, 'P1', pin.card, 'hand');
  addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
  const option = computePriorityOptions(game, player(game, 'P1')).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, 'Cloak of Confusion is castable from hand').toBeDefined();
  const target = option!.targets?.[0];
  expect(target?.options).toContain(host.id);
  const otherCreature = game.state.battlefield.find(
    (permanent) => permanent.controllerId === 'P2' && permanent.id !== host.id,
  );
  if (otherCreature !== undefined) expect(target?.options).not.toContain(otherCreature.id);
  pump(
    applyPriorityAction(game, player(game, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, host.id]]),
    }),
  );
  pump(resolveTopOfStack(game));
  const aura = game.state.battlefield.find((permanent) => permanent.cardId === object.cardId);
  expect(aura?.attachedTo).toBe(host.id);
  return aura!;
}

function combat(
  game: GameContext,
  attacker: EnginePermanent,
  defender: string,
  options: {
    accept?: boolean;
    blocker?: EnginePermanent;
    afterBlockers?: () => void;
  } = {},
): { optionalChoices: number; decisions: ReturnType<typeof pump>['decisions'] } {
  game.state.currentTurnPlayer = 'P1';
  game.state.activePlayerIndex = 0;
  game.state.phase = 'combat';
  let changedAfterBlockers = false;
  let optionalChoices = 0;
  const result = pump(runCombatPhase(game), (decision) => {
    if (decision.decisionType === 'declareAttackers')
      return declareAttacks(decision, (id) => (id === attacker.id ? defender : null));
    if (decision.decisionType === 'declareBlockers')
      return declareBlocks(decision, (id) => (options.blocker?.id === id ? attacker.id : null));
    if (
      !changedAfterBlockers &&
      decision.decisionType === 'priority' &&
      game.state.step === 'declareBlockers' &&
      options.afterBlockers !== undefined
    ) {
      changedAfterBlockers = true;
      options.afterBlockers();
    }
    if (decision.decisionType === 'optionalTrigger') {
      optionalChoices++;
      return pick(decision, options.accept === false ? /Decline/ : /Assign no combat damage/);
    }
    return pick(decision, /Pass|does not/i);
  });
  return { optionalChoices, decisions: result.decisions };
}

function handCards(game: GameContext, playerId: string): string[] {
  return player(game, playerId).hand.map((object) => object.name);
}

function creature(name: string, keywords: string[] = []): OracleCard {
  return oracle({
    name,
    typeLine: 'Creature — Soldier',
    manaCost: '{1}{W}',
    power: '2',
    toughness: '2',
    oracleText: keywords.join(', '),
  });
}

function setupAttached(seed: string, keywords: string[] = []) {
  const game = context(seed);
  const attacker = spawn(game, 'P1', creature('Cloaked Attacker', keywords));
  const opposingCreature = spawn(game, 'P2', bear());
  const aura = castCloak(game, attacker);
  spawn(game, 'P1', forest());
  for (const card of [forest(), island(), mountain()]) conjure(game, 'P2', card, 'hand');
  return { game, attacker, opposingCreature, aura };
}

describe('Cloak of Confusion — pinned Oracle combat behavior', () => {
  it('pins Oracle, casts the Aura normally, and restricts its target to a creature you control', () => {
    expect(pin.sha256).toBe(ORACLE_SHA256);
    const definition = interpretCard(pin.card);
    expect(definition.modeled, definition.unmodeledReasons.join('; ')).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);

    const game = context('cloak-target-restriction');
    const own = spawn(game, 'P1', creature('Own legal host'));
    spawn(game, 'P2', creature('Opposing illegal host'));
    const aura = castCloak(game, own);
    expect(aura.attachedTo).toBe(own.id);
  });

  it('cloak-confusion-c02 offers the unblocked attacker a choice; accepting makes it assign no damage and discards one random card', () => {
    const { game, attacker } = setupAttached('cloak-accept-random-discard');
    const before = handCards(game, 'P2');
    const result = combat(game, attacker, 'P2', { accept: true });
    expect(result.optionalChoices).toBe(1);
    expect(game.state.players.find((candidate) => candidate.id === 'P2')!.life).toBe(40);
    expect(handCards(game, 'P2')).toHaveLength(before.length - 1);
    expect(player(game, 'P2').graveyard.filter((object) => before.includes(object.name))).toHaveLength(1);
    expect(attacker.assignsNoCombatDamageTurn).toBe(game.state.turnNumber);
  });

  it('uses the seeded game random stream for the defender discard', () => {
    const discardForSeed = (seed: string): string[] => {
      const { game, attacker } = setupAttached(seed);
      const available = handCards(game, 'P2');
      combat(game, attacker, 'P2', { accept: true });
      return player(game, 'P2').graveyard
        .filter((object) => available.includes(object.name))
        .map((object) => object.name);
    };
    expect(discardForSeed('cloak-random-replay')).toEqual(discardForSeed('cloak-random-replay'));
  });

  it('cloak-confusion-c02 is optional: declining deals combat damage and leaves the defender hand unchanged', () => {
    const { game, attacker } = setupAttached('cloak-decline-no-discard');
    const before = handCards(game, 'P2');
    const result = combat(game, attacker, 'P2', { accept: false });
    expect(result.optionalChoices).toBe(1);
    expect(player(game, 'P2').life).toBe(38);
    expect(handCards(game, 'P2')).toEqual(before);
    expect(attacker.assignsNoCombatDamageTurn).toBeUndefined();
  });

  it('a creature that was blocked does not trigger even if its blocker leaves before damage', () => {
    const { game, attacker } = setupAttached('cloak-blocked-then-blocker-leaves');
    const blocker = spawn(game, 'P2', creature('Blocking Creature'));
    const before = handCards(game, 'P2');
    const result = combat(game, attacker, 'P2', {
      accept: true,
      blocker,
      afterBlockers: () => pump(moveObject(game, blocker, { zone: 'graveyard' })),
    });
    expect(result.optionalChoices).toBe(0);
    expect(handCards(game, 'P2')).toEqual(before);
    expect(game.state.battlefield).not.toContain(blocker);
    expect(attacker.assignsNoCombatDamageTurn).toBeUndefined();
  });

  it('accepting the choice suppresses both double-strike damage steps and lasts through another combat this turn only', () => {
    const { game, attacker } = setupAttached('cloak-double-strike-turn-duration', ['double strike']);
    expect(combat(game, attacker, 'P2', { accept: true }).optionalChoices).toBe(1);
    expect(player(game, 'P2').life).toBe(40);

    attacker.tapped = false;
    expect(combat(game, attacker, 'P2', { accept: false }).optionalChoices).toBe(1);
    expect(player(game, 'P2').life).toBe(40);

    game.state.turnNumber++;
    attacker.tapped = false;
    expect(combat(game, attacker, 'P2', { accept: false }).optionalChoices).toBe(1);
    expect(player(game, 'P2').life).toBe(36);
  });

  it('uses the actual controller of a planeswalker defender in a multiplayer combat', () => {
    const game = context('cloak-planeswalker-defender-player');
    const attacker = spawn(game, 'P1', creature('Walker Attacker'));
    const walker = spawn(game, 'P2', oracle({ name: 'Borrowed Walker', typeLine: 'Planeswalker', loyalty: '8' }));
    changeController(game, walker, 'P3');
    const aura = castCloak(game, attacker);
    for (const id of ['P2', 'P3']) conjure(game, id, forest(), 'hand');
    const p2Before = handCards(game, 'P2');
    const p3Before = handCards(game, 'P3');
    const result = combat(game, attacker, walker.id, { accept: true });
    expect(result.optionalChoices).toBe(1);
    expect(aura.attachedTo).toBe(attacker.id);
    expect(handCards(game, 'P2')).toEqual(p2Before);
    expect(handCards(game, 'P3')).toHaveLength(p3Before.length - 1);
    expect(walker.counters['loyalty']).toBe(8);
  });

  it('keeps the queued attack event bound to its original creature if the Aura is reattached before resolution', () => {
    const game = context('cloak-attachment-changes-after-trigger');
    const attacker = spawn(game, 'P1', creature('Original Enchanted Attacker'));
    const laterHost = spawn(game, 'P1', creature('Later Enchanted Host'));
    const aura = castCloak(game, attacker);
    spawn(game, 'P1', forest());
    conjure(game, 'P1', oracle({ name: 'Priority Window Witness', typeLine: 'Instant', manaCost: '{0}', cmc: 0, oracleText: 'Target creature gets +1/+1 until end of turn.', power: null, toughness: null }), 'hand');
    conjure(game, 'P2', forest(), 'hand');
    conjure(game, 'P2', forest(), 'hand');
    let moved = false;
    const result = combat(game, attacker, 'P2', {
      accept: true,
      afterBlockers: () => {
        expect(game.state.stack.some((item) => item.controllerId === 'P1')).toBe(true);
        expect(attachPermanent(game, aura, laterHost)).toBe(true);
        moved = true;
      },
    });
    expect(moved).toBe(true);
    expect(aura.attachedTo).toBe(laterHost.id);
    expect(result.optionalChoices).toBe(1);
    expect(attacker.assignsNoCombatDamageTurn).toBe(game.state.turnNumber);
    expect(laterHost.assignsNoCombatDamageTurn).toBeUndefined();
    expect(player(game, 'P2').life).toBe(40);
  });

  it('does nothing when the original attacking creature leaves before the queued trigger resolves', () => {
    const { game, attacker } = setupAttached('cloak-original-attacker-leaves');
    conjure(game, 'P1', oracle({ name: 'Target Departure Witness', typeLine: 'Instant', manaCost: '{0}', cmc: 0, oracleText: 'Target creature gets +1/+1 until end of turn.', power: null, toughness: null }), 'hand');
    const before = handCards(game, 'P2');
    let removed = false;
    const result = combat(game, attacker, 'P2', {
      accept: true,
      afterBlockers: () => {
        pump(moveObject(game, attacker, { zone: 'graveyard' }));
        removed = true;
      },
    });
    expect(removed).toBe(true);
    expect(result.optionalChoices).toBe(0);
    expect(handCards(game, 'P2')).toEqual(before);
    expect(player(game, 'P1').graveyard.some((object) => object.cardId === attacker.cardId)).toBe(true);
  });
});
