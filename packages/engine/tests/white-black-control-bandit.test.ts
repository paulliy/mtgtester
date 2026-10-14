import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { PendingDecision } from '../src/decisions';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlBanditOverrides } from '../src/cards/overrides/white-black-control-bandit';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import { conjure, copies, gameConfig, oracle, pump, swamp } from './fixtures';

interface Pinned { sha256: string; card: OracleCard }
const fixture = JSON.parse(readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8')) as { cards: Pinned[] };
const pin = 'f806d0ae13bbfb7b4d6b8168dc45fad6a8ad31691ebe1701b48b8d5955dd69e3';
const entry = fixture.cards.find((candidate) => candidate.card.name === "Bandit's Talent");
if (!entry) throw new Error("Missing pinned Oracle card: Bandit's Talent");
const card = entry.card;
beforeAll(() => registerWhiteBlackControlBanditOverrides());

function ctx(seed = 'bandit-class'): GameContext {
  const game = createGame(gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })), { seed }));
  Object.assign(game.state, { currentTurnPlayer: 'P1', activePlayerIndex: 0, turnNumber: 3, phase: 'precombatMain', step: null });
  return game;
}
function player(game: GameContext, id: string) { return game.state.players.find((candidate) => candidate.id === id)!; }
function castBandit(game: GameContext, drainEnter = false): EnginePermanent {
  const object = conjure(game, 'P1', card, 'hand');
  addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
  const option = computePriorityOptions(game, player(game, 'P1')).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, 'Bandit’s Talent is cast normally').toBeDefined();
  pump(applyPriorityAction(game, player(game, 'P1'), option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
  pump(resolveTopOfStack(game));
  if (drainEnter) resolveTriggers(game);
  return game.state.battlefield.find((permanent) => permanent.cardId === object.cardId)!;
}
function handCard(name: string, land = false): OracleCard {
  return oracle({ name, typeLine: land ? 'Basic Land — Test' : 'Sorcery', types: land ? ['Land'] : ['Sorcery'], manaCost: land ? null : '{0}', cmc: land ? 0 : 0, power: null, toughness: null });
}
function addHand(game: GameContext, id: string, ...cards: OracleCard[]) { return cards.map((printed) => conjure(game, id, printed, 'hand')); }
function effectOption(game: GameContext, permanent: EnginePermanent, description: RegExp) {
  return computePriorityOptions(game, player(game, permanent.controllerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === permanent.id && description.test(option.description);
  });
}
function activateLevel(game: GameContext, permanent: EnginePermanent, level: 2 | 3, mana: { symbol: 'B' | 'C' }[]): void {
  addMana(player(game, permanent.controllerId), mana);
  const option = effectOption(game, permanent, new RegExp(`level ${level}`, 'i'));
  expect(option, `level ${level} option available`).toBeDefined();
  pump(applyPriorityAction(game, player(game, permanent.controllerId), option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
  pump(resolveTopOfStack(game));
}
function resolveTriggers(game: GameContext, answer: (decision: PendingDecision) => number = () => 0): void {
  pump(priorityCheckpoint(game));
  while (game.state.stack.length > 0) pump(resolveTopOfStack(game), (decision) => ({ index: answer(decision), targets: new Map() }));
}

describe("Bandit's Talent — pinned Class behavior", () => {
  it('pins the Oracle wrapper and enters through the normal cast with default Class level 1', () => {
    expect(entry.sha256).toBe(pin);
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    const game = ctx('bandit-normal-cast');
    const bandit = castBandit(game, true);
    expect(bandit.classLevel ?? 1).toBe(1);
    expect(game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === bandit.cardId)).toBe(false);
  });

  it('resolves the ETB discard alternative for each opponent, selecting APNAP before any card moves', () => {
    const game = ctx('bandit-discard-apnap');
    addHand(game, 'P2', handCard('P2 nonland'), handCard('P2 land', true));
    addHand(game, 'P3', handCard('P3 nonland A'), handCard('P3 nonland B'));
    addHand(game, 'P4', handCard('P4 land A', true), handCard('P4 land B', true));
    const original = new Map(['P2', 'P3', 'P4'].map((id) => [id, player(game, id).hand.length]));
    const bandit = castBandit(game);
    const choicePlayers: string[] = [];
    pump(priorityCheckpoint(game));
    pump(resolveTopOfStack(game), (decision) => {
      choicePlayers.push(decision.player);
      expect(['P2', 'P3', 'P4'].every((id) => player(game, id).hand.length === original.get(id))).toBe(true);
      if (decision.prompt.includes('Discard a nonland card or discard two cards')) return { index: 0, targets: new Map() };
      if (decision.prompt.includes('Discard a card')) return { index: 0, targets: new Map() };
      return { index: 0, targets: new Map() };
    });
    expect(choicePlayers.slice(0, 3)).toEqual(['P2', 'P3', 'P3']);
    expect(player(game, 'P2').hand).toHaveLength(1);
    expect(player(game, 'P3').hand).toHaveLength(1);
    expect(player(game, 'P4').hand).toHaveLength(0);
    expect(bandit.classLevel ?? 1).toBe(1);
  });

  it('discards only cards actually held when an opponent has fewer than two cards or an empty hand', () => {
    const game = ctx('bandit-short-hands');
    addHand(game, 'P2', handCard('P2 lone land', true));
    const bandit = castBandit(game);
    pump(priorityCheckpoint(game));
    pump(resolveTopOfStack(game), (_decision) => ({ index: 0, targets: new Map() }));
    expect(player(game, 'P2').hand).toHaveLength(0);
    expect(player(game, 'P3').hand).toHaveLength(0);
    expect(player(game, 'P4').hand).toHaveLength(0);
    expect(bandit.classLevel ?? 1).toBe(1);
  });

  it('can only buy sequential levels at exact sorcery-speed costs and retains lower-level abilities', () => {
    const game = ctx('bandit-sequential-levels');
    const bandit = castBandit(game, true);
    const abilityNames = () => (computeCharacteristics(game, bandit).activatedAbilities ?? []).map((ability) => ability.ability.description ?? '');
    expect(abilityNames().some((name) => /level 2/i.test(name))).toBe(true);
    // The higher level remains in the printed ability set, but its condition gates availability.
    expect(abilityNames().some((name) => /level 3/i.test(name))).toBe(true);
    expect(effectOption(game, bandit, /level 3/i)).toBeUndefined();
    expect(effectOption(game, bandit, /level 2/i)).toBeUndefined(); // no black mana

    addMana(player(game, 'P1'), [{ symbol: 'B' }]);
    const level2 = effectOption(game, bandit, /level 2/i)!;
    expect(level2).toBeDefined();
    pump(applyPriorityAction(game, player(game, 'P1'), level2.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    pump(resolveTopOfStack(game));
    expect(bandit.classLevel).toBe(2);
    expect(computeCharacteristics(game, bandit).triggers.some((trigger) => /upkeep/i.test(trigger.description ?? ''))).toBe(true);
    expect(effectOption(game, bandit, /level 2/i)).toBeUndefined();

    const opponent = player(game, 'P2');
    game.state.currentTurnPlayer = 'P2';
    game.state.activePlayerIndex = 1;
    game.state.phase = 'precombatMain';
    addMana(opponent, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
    expect(computePriorityOptions(game, opponent).some((option) => option.description.includes('Gain Class level 3'))).toBe(false);
    game.state.currentTurnPlayer = 'P1';
    game.state.activePlayerIndex = 0;
    game.state.phase = 'combat';
    expect(effectOption(game, bandit, /level 3/i)).toBeUndefined();
    game.state.phase = 'precombatMain';
    addMana(player(game, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(effectOption(game, bandit, /level 3/i)).toBeUndefined(); // the generic three mana cannot replace the required black mana
    addMana(player(game, 'P1'), [{ symbol: 'B' }]);
    const level3 = effectOption(game, bandit, /level 3/i)!;
    expect(level3).toBeDefined();
    pump(applyPriorityAction(game, player(game, 'P1'), level3.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    pump(resolveTopOfStack(game));
    expect(bandit.classLevel).toBe(3);
    const triggers = computeCharacteristics(game, bandit).triggers;
    expect(triggers.some((trigger) => /upkeep/i.test(trigger.description ?? ''))).toBe(true);
    expect(triggers.some((trigger) => trigger.trigger?.when === 'drawStep')).toBe(true);
    expect(computePriorityOptions(game, player(game, 'P1')).some((option) => option.description.includes('Gain Class level'))).toBe(false);
  });

  it('Level 2 upkeep intervening-if checks at queue and resolution, and a queued ability resolves after its Class leaves', () => {
    const game = ctx('bandit-upkeep-intervening');
    const bandit = castBandit(game, true);
    activateLevel(game, bandit, 2, [{ symbol: 'B' }]);
    game.state.currentTurnPlayer = 'P2';
    game.state.activePlayerIndex = 1;
    addHand(game, 'P2', handCard('P2 short hand'));
    queueStepTriggers(game, 'upkeep');
    expect(game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === bandit.cardId)).toBe(true);
    addHand(game, 'P2', handCard('P2 added card'));
    resolveTriggers(game);
    expect(player(game, 'P2').life).toBe(40);

    player(game, 'P2').hand.splice(1);
    queueStepTriggers(game, 'upkeep');
    expect(game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === bandit.cardId)).toBe(true);
    pump(priorityCheckpoint(game));
    const beforeLife = player(game, 'P2').life;
    pump(moveObject(game, bandit, { zone: 'graveyard' }));
    pump(resolveTopOfStack(game));
    expect(player(game, 'P2').life).toBe(beforeLife - 2);
  });

  it('Level 3 draws once per opponent at one card or fewer at resolution and only on its controller’s draw step', () => {
    const game = ctx('bandit-level3-draw');
    const bandit = castBandit(game, true);
    activateLevel(game, bandit, 2, [{ symbol: 'B' }]);
    activateLevel(game, bandit, 3, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
    addHand(game, 'P2', handCard('P2 low'));
    addHand(game, 'P3', handCard('P3 low'));
    addHand(game, 'P4', handCard('P4 high A'), handCard('P4 high B'));
    const before = player(game, 'P1').hand.length;
    queueStepTriggers(game, 'drawStep');
    expect(game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === bandit.cardId)).toBe(true);
    addHand(game, 'P3', handCard('P3 resolution card'));
    resolveTriggers(game);
    expect(player(game, 'P1').hand.length).toBe(before + 1);

    game.state.currentTurnPlayer = 'P2';
    game.state.activePlayerIndex = 1;
    queueStepTriggers(game, 'drawStep');
    expect(game.state.pendingTriggers.some((trigger) => trigger.sourceCardId === bandit.cardId)).toBe(false);
  });

  it('Class level resets for a new battlefield incarnation', () => {
    const game = ctx('bandit-reentry-reset');
    const bandit = castBandit(game, true);
    activateLevel(game, bandit, 2, [{ symbol: 'B' }]);
    pump(moveObject(game, bandit, { zone: 'graveyard' }));
    const cardObject = player(game, 'P1').graveyard.find((candidate) => candidate.cardId === bandit.cardId)!;
    const reincarnated = pump(moveObject(game, cardObject, { zone: 'battlefield', controllerId: 'P1' })).value!;
    const next = game.state.battlefield.find((permanent) => permanent.id === reincarnated.id)!;
    expect(next.classLevel).toBeUndefined();
    expect(computeCharacteristics(game, next).triggers.some((trigger) => /upkeep/i.test(trigger.description ?? ''))).toBe(false);
  });
});
