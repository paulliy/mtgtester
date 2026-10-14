import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { PendingDecision } from '../src/decisions';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlTergridOverrides } from '../src/cards/overrides/white-black-control-tergrid';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { discardCard, moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { priorityCheckpoint } from '../src/sba/sba';
import { queueSpellCopy } from '../src/stack/copy';
import { resolveTopOfStack } from '../src/stack/stack';
import { conjure, copies, gameConfig, oracle, pump, spawn, swamp } from './fixtures';

interface Pinned { sha256: string; card: OracleCard }
const fixture = JSON.parse(readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8')) as { cards: Pinned[] };
const pin = '390005effb7682d435bd1fffe5b17fd1603da3e0bac9a3fcb43d7c3f04d1d9f4';
const entry = fixture.cards.find((candidate) => candidate.card.name === 'Tergrid, God of Fright // Tergrid\'s Lantern');
if (!entry) throw new Error('Missing pinned Oracle card: Tergrid, God of Fright // Tergrid\'s Lantern');
const card = entry.card;
beforeAll(() => registerWhiteBlackControlTergridOverrides());

function ctx(seed = 'tergrid'): GameContext {
  const game = createGame(gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })), { seed }));
  Object.assign(game.state, { currentTurnPlayer: 'P1', activePlayerIndex: 0, turnNumber: 3, phase: 'precombatMain', step: null });
  return game;
}
function player(game: GameContext, id: string) { return game.state.players.find((candidate) => candidate.id === id)!; }
function cast(game: GameContext, face: 'front' | 'back' = 'front'): EnginePermanent {
  const object = conjure(game, 'P1', card, 'hand');
  addMana(player(game, 'P1'), face === 'front'
    ? [{ symbol: 'B' }, { symbol: 'B' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]
    : [{ symbol: 'B' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
  const option = computePriorityOptions(game, player(game, 'P1')).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id &&
      (face === 'front' ? payload.alternativeCast === undefined : payload.alternativeCast === 'mdfc');
  });
  expect(option, `${face} face is offered as a normal cast`).toBeDefined();
  pump(applyPriorityAction(game, player(game, 'P1'), option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
  pump(resolveTopOfStack(game));
  return game.state.battlefield.find((permanent) => permanent.cardId === object.cardId)!;
}
function resolveTriggers(game: GameContext, choose: (decision: PendingDecision) => number = () => 0): void {
  pump(priorityCheckpoint(game));
  while (game.state.stack.length > 0) pump(resolveTopOfStack(game), (decision) => ({ index: choose(decision), targets: new Map() }));
}
function lanternOption(game: GameContext, lantern: EnginePermanent, index: number) {
  return computePriorityOptions(game, player(game, lantern.controllerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === lantern.id && payload.index === index;
  });
}
function activateLantern(game: GameContext, lantern: EnginePermanent, abilityIndex: number, targetId?: string): void {
  if (abilityIndex === 1) addMana(player(game, lantern.controllerId), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
  const option = lanternOption(game, lantern, abilityIndex);
  expect(option, `Lantern ability ${abilityIndex} is available`).toBeDefined();
  const targets = new Map<number, string>();
  if (targetId !== undefined) targets.set(0, targetId);
  pump(applyPriorityAction(game, player(game, lantern.controllerId), option!.payload as PriorityActionPayload, { index: 0, targets }));
}
function sample(name: string, typeLine: string, types: string[]): OracleCard {
  return oracle({ name, typeLine, types, manaCost: '{0}', cmc: 0, power: types.includes('Creature') ? '2' : null, toughness: types.includes('Creature') ? '2' : null });
}
describe('Tergrid, God of Fright // Tergrid\'s Lantern — pinned MDFC', () => {
  it('pins both faces and casts the front normally with menace and a 4/5 body', () => {
    expect(entry.sha256).toBe(pin);
    expect(card.backFace?.name).toBe("Tergrid's Lantern");
    const def = interpretCard(card);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const game = ctx('tergrid-front-cast');
    const tergrid = cast(game);
    const characteristics = computeCharacteristics(game, tergrid);
    expect(tergrid.name).toBe('Tergrid, God of Fright');
    expect(tergrid.power).toBe(4);
    expect(tergrid.toughness).toBe(5);
    expect(characteristics.keywords).toContain('menace');
  });

  it('uses the chosen artifact face for opposing creature entry replacements', () => {
    const game = ctx('lantern-entry-characteristics');
    const authority = fixture.cards.find(entry => entry.card.name === 'Authority of the Consuls')!.card;
    spawn(game, 'P2', authority);
    const lantern = cast(game, 'back');
    expect(lantern.tapped).toBe(false);
    const tergrid = cast(game, 'front');
    expect(tergrid.tapped).toBe(true);
  });

  it('casts the back face for {3}{B} as the legendary artifact with only Lantern abilities', () => {
    const game = ctx('tergrid-back-cast');
    const lantern = cast(game, 'back');
    const characteristics = computeCharacteristics(game, lantern);
    expect(lantern.name).toBe("Tergrid's Lantern");
    expect(characteristics.types).toContain('Artifact');
    expect(characteristics.types).not.toContain('Creature');
    expect(lantern.oracleId).toBe(card.oracleId);
    expect(interpretCard(card).triggers.length).toBe(2);
    expect(characteristics.activatedAbilities ?? []).toHaveLength(2);
    expect((characteristics.activatedAbilities ?? []).some((ability) => /discarded permanent card/i.test(ability.ability.description ?? ''))).toBe(false);
    pump(moveObject(game, lantern, { zone: 'graveyard' }));
    const grave = player(game, 'P1').graveyard.find((object) => object.cardId === lantern.cardId)!;
    const front = pump(moveObject(game, grave, { zone: 'battlefield', controllerId: 'P1' })).value!;
    expect(game.state.battlefield.find((permanent) => permanent.id === front.id)?.name).toBe('Tergrid, God of Fright');
  });

  it('a copy of the back-face permanent spell copies only Tergrid\'s Lantern', () => {
    const game = ctx('tergrid-back-copy');
    const object = conjure(game, 'P1', card, 'hand');
    addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    const option = computePriorityOptions(game, player(game, 'P1')).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === object.id && payload.alternativeCast === 'mdfc';
    });
    expect(option).toBeDefined();
    pump(applyPriorityAction(game, player(game, 'P1'), option!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    const originalSpell = game.state.stack.at(-1)!;
    expect(originalSpell.description).toBe("Tergrid's Lantern");
    const copy = queueSpellCopy(game, originalSpell, 'P2');
    expect(copy.description).toBe("Copy of Tergrid's Lantern");
    expect(copy.spellDefinition?.name).toBe("Tergrid's Lantern");
    expect(copy.spellDefinition?.types).toContain('Artifact');
    expect(copy.spellDefinition?.types).not.toContain('Creature');
    pump(resolveTopOfStack(game));
    const copiedLantern = game.state.battlefield.find((permanent) => permanent.cardId === copy.sourceCardId);
    expect(copiedLantern?.isToken).toBe(true);
    expect(copiedLantern?.name).toBe("Tergrid's Lantern");
    const copiedCharacteristics = computeCharacteristics(game, copiedLantern!);
    expect(copiedCharacteristics.types).toContain('Artifact');
    expect(copiedCharacteristics.types).not.toContain('Creature');
    expect(copiedCharacteristics.activatedAbilities ?? []).toHaveLength(2);
    expect(copiedCharacteristics.triggers).toHaveLength(0);
    expect(copiedCharacteristics.activatedAbilities?.some((ability) => /discarded permanent card/i.test(ability.ability.description ?? ''))).toBe(false);
  });

  it('returns an opponent permanent card discarded by an actual effect, binding its graveyard incarnation', () => {
    const game = ctx('tergrid-discard-trigger');
    const tergrid = cast(game);
    const victim = conjure(game, 'P2', sample('Discarded Bear', 'Creature — Bear', ['Creature']), 'hand');
    pump(discardCard(game, victim, 'P2'));
    const graveIncarnation = player(game, 'P2').graveyard.find((object) => object.cardId === victim.cardId)!;
    expect(graveIncarnation).toBeDefined();
    expect(graveIncarnation.id).not.toBe(victim.id);
    resolveTriggers(game, () => 0);
    const recovered = game.state.battlefield.find((permanent) => permanent.cardId === victim.cardId);
    expect(recovered?.controllerId).toBe('P1');
    expect(recovered?.id).not.toBe(victim.id);
    expect(tergrid.zone).toBe('battlefield');
  });

  it('returns an opponent permanent sacrificed to a real sacrifice move, but not own or token permanents', () => {
    const game = ctx('tergrid-sacrifice');
    const tergrid = cast(game);
    const opponent = spawn(game, 'P2', sample('Sacrificed Bear', 'Creature — Bear', ['Creature']));
    pump(moveObject(game, opponent, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(game.state.pendingTriggers).toHaveLength(1);
    resolveTriggers(game);
    const recovered = game.state.battlefield.find((permanent) => permanent.cardId === opponent.cardId);
    expect(recovered?.controllerId).toBe('P1');
    expect(recovered?.id).not.toBe(opponent.id);
    expect(tergrid.zone).toBe('battlefield');

    const own = spawn(game, 'P1', sample('Own Sacrifice', 'Creature — Bear', ['Creature']));
    pump(moveObject(game, own, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(game.state.pendingTriggers).toHaveLength(0);
    const token = spawn(game, 'P2', sample('Token Sacrifice', 'Creature — Spirit', ['Creature']), { isToken: true });
    pump(moveObject(game, token, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(game.state.pendingTriggers).toHaveLength(0);
  });

  it('does not return discarded nonpermanent cards or cards that never entered a graveyard from hand', () => {
    const game = ctx('tergrid-nonpermanent');
    cast(game);
    const instant = conjure(game, 'P2', sample('Discarded Instant', 'Instant', ['Instant']), 'hand');
    pump(discardCard(game, instant, 'P2'));
    expect(game.state.pendingTriggers).toHaveLength(0);
    const sorcery = conjure(game, 'P2', sample('Discarded Sorcery', 'Sorcery', ['Sorcery']), 'hand');
    pump(discardCard(game, sorcery, 'P2'));
    expect(game.state.pendingTriggers).toHaveLength(0);
    const hiddenTop = conjure(game, 'P3', sample('Hidden Top Permanent', 'Creature — Bear', ['Creature']), 'library');
    pump(moveObject(game, hiddenTop, { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(0);

    const peace = fixture.cards.find((candidate) => candidate.card.name === 'Rest in Peace')?.card;
    if (!peace) throw new Error('Missing pinned Rest in Peace fixture');
    conjure(game, 'P1', peace, 'hand');
    addMana(player(game, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }]);
    const peaceOption = computePriorityOptions(game, player(game, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === player(game, 'P1').hand.find((object) => object.name === 'Rest in Peace')?.id;
    });
    expect(peaceOption).toBeDefined();
    pump(applyPriorityAction(game, player(game, 'P1'), peaceOption!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    pump(resolveTopOfStack(game));
    resolveTriggers(game);
    const exiled = conjure(game, 'P2', sample('Exiled Discarded Permanent', 'Creature — Bear', ['Creature']), 'hand');
    pump(discardCard(game, exiled, 'P2'));
    expect(game.state.pendingTriggers).toHaveLength(1); // discard event triggers, but its card is no longer in a graveyard
    resolveTriggers(game);
    expect(game.state.exile.some((object) => object.cardId === exiled.cardId)).toBe(true);
    expect(game.state.battlefield.some((permanent) => permanent.cardId === exiled.cardId)).toBe(false);
  });

  it('binds the original graveyard incarnation and skips it after it leaves and returns', () => {
    const game = ctx('tergrid-incarnation');
    cast(game);
    const victim = conjure(game, 'P2', sample('Returning Card', 'Creature — Bear', ['Creature']), 'hand');
    pump(discardCard(game, victim, 'P2'));
    const originalGraveObject = player(game, 'P2').graveyard.find((object) => object.cardId === victim.cardId)!;
    const reincarnated = pump(moveObject(game, originalGraveObject, { zone: 'battlefield', controllerId: 'P2' })).value!;
    resolveTriggers(game);
    expect(game.state.battlefield.some((permanent) => permanent.id === reincarnated.id && permanent.controllerId === 'P2')).toBe(true);
  });

  it('Lantern lets the target choose life loss even when sacrifice or discard is available', () => {
    const game = ctx('tergrid-lantern-life-choice');
    const lantern = cast(game, 'back');
    const land = spawn(game, 'P2', sample('Target Land', 'Basic Land — Swamp', ['Land']));
    const creature = spawn(game, 'P2', sample('Target Creature', 'Creature — Bear', ['Creature']));
    const cardInHand = conjure(game, 'P2', sample('Target Card', 'Sorcery', ['Sorcery']), 'hand');
    const life = player(game, 'P2').life;
    activateLantern(game, lantern, 0, 'P2');
    pump(resolveTopOfStack(game), (decision) => ({ index: decision.options.findIndex((option: { description: string }) => /lose 3 life/i.test(option.description)), targets: new Map() }));
    expect(player(game, 'P2').life).toBe(life - 3);
    expect(game.state.battlefield.some((permanent) => permanent.id === land.id)).toBe(true);
    expect(game.state.battlefield.some((permanent) => permanent.id === creature.id)).toBe(true);
    expect(player(game, 'P2').hand.some((object) => object.cardId === cardInHand.cardId)).toBe(true);
  });

  it('Lantern sacrifice excludes lands, discards when chosen, and loses life when neither alternative exists', () => {
    const sacrificeGame = ctx('tergrid-lantern-sacrifice');
    const lantern = cast(sacrificeGame, 'back');
    const land = spawn(sacrificeGame, 'P2', sample('Only Land', 'Basic Land — Swamp', ['Land']));
    const creature = spawn(sacrificeGame, 'P2', sample('Sacrificed Creature', 'Creature — Bear', ['Creature']));
    activateLantern(sacrificeGame, lantern, 0, 'P2');
    pump(resolveTopOfStack(sacrificeGame), (decision) => ({
      index: decision.options.findIndex((option: { description: string }) => /sacrifice a nonland/i.test(option.description)),
      targets: new Map(),
    }));
    expect(sacrificeGame.state.battlefield.some((permanent) => permanent.id === creature.id)).toBe(false);
    expect(sacrificeGame.state.battlefield.some((permanent) => permanent.id === land.id)).toBe(true);

    const tokenGame = ctx('tergrid-lantern-token-sacrifice');
    const tokenLantern = cast(tokenGame, 'back');
    const token = spawn(tokenGame, 'P2', sample('Sacrificed Token', 'Creature — Spirit', ['Creature']), { isToken: true });
    activateLantern(tokenGame, tokenLantern, 0, 'P2');
    pump(resolveTopOfStack(tokenGame), (decision) => ({
      index: decision.options.findIndex((option: { description: string }) => /sacrifice a nonland/i.test(option.description)),
      targets: new Map(),
    }));
    expect(tokenGame.state.battlefield.some((permanent) => permanent.id === token.id)).toBe(false);
    expect(tokenGame.state.exile.some((object) => object.cardId === token.cardId)).toBe(false);

    const discardGame = ctx('tergrid-lantern-discard');
    const discardLantern = cast(discardGame, 'back');
    const discarded = conjure(discardGame, 'P2', sample('Discard Choice', 'Sorcery', ['Sorcery']), 'hand');
    const discardLife = player(discardGame, 'P2').life;
    activateLantern(discardGame, discardLantern, 0, 'P2');
    pump(resolveTopOfStack(discardGame), (decision) => ({
      index: decision.options.findIndex((option: { description: string }) => /^discard a card$/i.test(option.description)),
      targets: new Map(),
    }));
    expect(player(discardGame, 'P2').life).toBe(discardLife);
    expect(player(discardGame, 'P2').graveyard.some((object) => object.cardId === discarded.cardId)).toBe(true);

    const emptyGame = ctx('tergrid-lantern-empty');
    const emptyLantern = cast(emptyGame, 'back');
    const emptyLife = player(emptyGame, 'P2').life;
    activateLantern(emptyGame, emptyLantern, 0, 'P2');
    pump(resolveTopOfStack(emptyGame));
    expect(player(emptyGame, 'P2').life).toBe(emptyLife - 3);
  });

  it('Lantern discard still counts when Rest in Peace replaces its graveyard destination; {3}{B} untaps for repeat use', () => {
    const game = ctx('tergrid-lantern-replacement-untap');
    const lantern = cast(game, 'back');
    const peace = fixture.cards.find((candidate) => candidate.card.name === 'Rest in Peace')?.card;
    if (!peace) throw new Error('Missing pinned Rest in Peace fixture');
    conjure(game, 'P1', peace, 'hand');
    addMana(player(game, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }]);
    const restOption = computePriorityOptions(game, player(game, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === player(game, 'P1').hand.find((object) => object.name === 'Rest in Peace')?.id;
    });
    expect(restOption).toBeDefined();
    pump(applyPriorityAction(game, player(game, 'P1'), restOption!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
    pump(resolveTopOfStack(game));
    const discarded = conjure(game, 'P2', sample('Replaced Discard', 'Sorcery', ['Sorcery']), 'hand');
    activateLantern(game, lantern, 0, 'P2');
    pump(resolveTopOfStack(game), (decision) => ({
      index: decision.options.findIndex((option: { description: string }) => /^discard a card$/i.test(option.description)),
      targets: new Map(),
    }));
    expect(game.state.exile.some((object) => object.cardId === discarded.cardId)).toBe(true);
    expect(player(game, 'P2').life).toBe(40);

    expect(lantern.tapped).toBe(true);
    activateLantern(game, lantern, 1);
    pump(resolveTopOfStack(game));
    expect(lantern.tapped).toBe(false);
    activateLantern(game, lantern, 0, 'P2');
    pump(resolveTopOfStack(game));
    expect(lantern.tapped).toBe(true);
  });
});
