import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics, printedManaValue } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { moveObject, spellManaValue } from '../src/state/objects';
import { triggersOf } from '../src/state/queries';
import type { EngineCardObject, EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, declareAttacks, oracle, pump, spawn } from './fixtures';
import { battlefield, game, pinned, player, resolve } from './pr11-helpers';

const ROOM = pinned("Dollmaker's Shop // Porcelain Gallery");
const SHOP = "Dollmaker's Shop";
const GALLERY = 'Porcelain Gallery';

const toy = () =>
  oracle({
    name: 'Test Toy',
    typeLine: 'Artifact Creature — Toy',
    manaCost: '{1}',
    power: '1',
    toughness: '1',
  });
const walker = () =>
  oracle({
    name: 'Test Walker',
    typeLine: 'Legendary Planeswalker — Test',
    manaCost: '{3}',
    oracleText: '',
    loyalty: '3',
  });

function give(ctx: GameContext, white: number, colorless = 0): void {
  addMana(player(ctx, 'P1'), [
    ...Array.from({ length: white }, () => ({ symbol: 'W' as const })),
    ...Array.from({ length: colorless }, () => ({ symbol: 'C' as const })),
  ]);
}

function castOptions(ctx: GameContext, card: EngineCardObject) {
  return computePriorityOptions(ctx, player(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
}

function unlockOptions(ctx: GameContext) {
  return computePriorityOptions(ctx, player(ctx, 'P1')).filter(
    (option) => (option.payload as PriorityActionPayload).kind === 'unlockDoor',
  );
}

/** Cast the Room from P1's hand as `door` and resolve it. */
function castDoor(ctx: GameContext, door: string): EnginePermanent {
  const card = conjure(ctx, 'P1', ROOM, 'hand');
  if (door === SHOP) give(ctx, 1, 1);
  else give(ctx, 2, 4);
  const option = castOptions(ctx, card).find((entry) => entry.description.includes(`as ${door}`));
  expect(option, `cast as ${door}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  resolve(ctx);
  const room = ctx.state.battlefield.find((perm) => perm.cardId === card.cardId);
  expect(room, 'Room on the battlefield').toBeDefined();
  return room!;
}

function unlock(ctx: GameContext, door: string): void {
  const option = unlockOptions(ctx).find((entry) => entry.description.includes(door));
  expect(option, `unlock ${door}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

/** P1 attacks with `attackers` at `defender` until triggers wait on the stack. */
function p1Attacks(ctx: GameContext, attackers: EnginePermanent[], defender: string): void {
  Object.assign(ctx.state, { phase: 'combat' });
  const ids = new Set(attackers.map((perm) => perm.id));
  const gen = runCombatPhase(ctx);
  let step = gen.next();
  while (!step.done) {
    if (step.value.decisionType === 'declareAttackers') {
      step = gen.next(declareAttacks(step.value, (id) => (ids.has(id) ? defender : null)));
      continue;
    }
    if (ctx.state.stack.length > 0) return;
    step = gen.next({ index: 0, targets: new Map() });
  }
}

const ready = (perm: EnginePermanent): EnginePermanent =>
  Object.assign(perm, { summoningSick: false, enteredTurnNumber: 0 });

describe("Dollmaker's Shop // Porcelain Gallery", () => {
  it('room-modeled — both doors are castable faces under the Oracle and fixture ids', () => {
    for (const oracleId of [ROOM.oracleId, fixtureOracleId(ROOM.name)]) {
      const def = interpretCard({ ...ROOM, oracleId } as typeof ROOM);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.roomDoors?.map((door) => door.name)).toEqual([SHOP, GALLERY]);
      expect(def.alternativeCasts?.map((alt) => [alt.kind, alt.name])).toEqual([
        ['split', SHOP],
        ['split', GALLERY],
      ]);
    }
  });

  it('room-combined — off the battlefield it has both names and mana value 8 (CR 709.4b)', () => {
    const def = interpretCard(ROOM);
    expect([def.name, def.colors, spellManaValue(def, undefined)]).toEqual([ROOM.name, ['W'], 8]);
  });

  it("room-c01-cast — cast as Dollmaker's Shop it is a 2-mana spell, and enters with only that door unlocked (CR 709.5d)", () => {
    const ctx = game('room-cast-shop');
    const card = conjure(ctx, 'P1', ROOM, 'hand');
    give(ctx, 1, 1);
    expect(castOptions(ctx, card).map((option) => option.description)).toEqual([
      expect.stringContaining(`as ${SHOP}`),
    ]);
    pump(moveObject(ctx, card, { zone: 'exile' }));
    player(ctx, 'P1').manaEntries = [];
    const room = castDoor(ctx, SHOP);
    expect(room.unlockedDoors).toEqual(['left']);
    expect([room.name, printedManaValue(ctx, room)]).toEqual([SHOP, 2]);
    expect(triggersOf(ctx, room)).toHaveLength(1);
    expect(computeCharacteristics(ctx, room).colors).toEqual(['W']);
  });

  it('room-c01-sorcery-timing — a door is not cast, nor unlocked, outside your main phase with an empty stack', () => {
    const ctx = game('room-timing');
    const room = castDoor(ctx, SHOP);
    expect(room.name).toBe(SHOP);
    give(ctx, 2, 4);
    expect(unlockOptions(ctx)).toHaveLength(1);
    ctx.state.phase = 'combat';
    expect(unlockOptions(ctx)).toHaveLength(0);
    const card = conjure(ctx, 'P1', ROOM, 'hand');
    expect(castOptions(ctx, card)).toHaveLength(0);
  });

  it('room-c02-locked — while Porcelain Gallery is locked, creatures keep their printed power and toughness', () => {
    const ctx = game('room-locked-gallery');
    const creature = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    castDoor(ctx, SHOP);
    const chars = computeCharacteristics(ctx, creature);
    expect([chars.power, chars.toughness]).toEqual([2, 2]);
  });

  it('room-unlock — paying {4}{W}{W} unlocks Porcelain Gallery: the Room has both names and mana value 8, and creatures you control get base P/T equal to their number (CR 709.5e)', () => {
    const ctx = game('room-unlock');
    const creature = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const room = castDoor(ctx, SHOP);
    give(ctx, 2, 4);
    unlock(ctx, GALLERY);
    expect(ctx.state.stack).toHaveLength(0);
    expect(room.unlockedDoors).toEqual(['left', 'right']);
    expect([room.name, printedManaValue(ctx, room)]).toEqual([ROOM.name, 8]);
    expect(unlockOptions(ctx)).toHaveLength(0);
    const chars = computeCharacteristics(ctx, creature);
    expect([chars.power, chars.toughness]).toEqual([3, 3]);
    const other = computeCharacteristics(ctx, theirs);
    expect([other.power, other.toughness]).toEqual([2, 2]);
  });

  it('room-c02-layer-7b — Porcelain Gallery sets base P/T, so a +1/+1 counter still adds to it', () => {
    const ctx = game('room-gallery-counters');
    const creature = spawn(ctx, 'P1', bear());
    creature.counters['+1/+1'] = 1;
    spawn(ctx, 'P1', bear());
    const room = castDoor(ctx, GALLERY);
    expect(room.unlockedDoors).toEqual(['right']);
    expect([room.name, printedManaValue(ctx, room)]).toEqual([GALLERY, 6]);
    expect(triggersOf(ctx, room)).toHaveLength(0);
    const chars = computeCharacteristics(ctx, creature);
    expect([chars.power, chars.toughness]).toEqual([3, 3]);
  });

  it('room-c01-positive — non-Toy creatures attacking a player create one Toy', () => {
    const ctx = game('room-shop-attack');
    castDoor(ctx, SHOP);
    const attackers = [ready(spawn(ctx, 'P1', bear())), ready(spawn(ctx, 'P1', bear()))];
    p1Attacks(ctx, attackers, 'P2');
    expect(ctx.state.stack).toHaveLength(1);
    resolve(ctx);
    const toys = battlefield(ctx, 'Toy');
    expect(toys).toHaveLength(1);
    const chars = computeCharacteristics(ctx, toys[0]!);
    expect([chars.types, chars.subtypes, chars.colors, chars.power, chars.toughness]).toEqual([
      ['Artifact', 'Creature'],
      ['Toy'],
      ['W'],
      1,
      1,
    ]);
  });

  it('room-c01-negative-toy — an attack by Toys alone does not trigger', () => {
    const ctx = game('room-shop-toys');
    castDoor(ctx, SHOP);
    p1Attacks(ctx, [ready(spawn(ctx, 'P1', toy()))], 'P2');
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('room-c01-negative-planeswalker — an attack on a planeswalker is not an attack on a player', () => {
    const ctx = game('room-shop-walker');
    castDoor(ctx, SHOP);
    const target = spawn(ctx, 'P2', walker());
    p1Attacks(ctx, [ready(spawn(ctx, 'P1', bear()))], target.id);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('room-not-cast — a Room put onto the battlefield without being cast has both doors locked: no name, mana value 0, no abilities', () => {
    const ctx = game('room-locked');
    const creature = spawn(ctx, 'P1', bear());
    const room = spawn(ctx, 'P1', ROOM);
    expect(room.unlockedDoors).toBeUndefined();
    expect([room.name, printedManaValue(ctx, room)]).toEqual(['', 0]);
    expect(computeCharacteristics(ctx, room).colors).toEqual([]);
    expect(computeCharacteristics(ctx, room).subtypes).toEqual(['Room']);
    expect(triggersOf(ctx, room)).toHaveLength(0);
    expect(computeCharacteristics(ctx, creature).power).toBe(2);
    give(ctx, 3, 5);
    expect(unlockOptions(ctx).map((option) => option.description)).toEqual([
      expect.stringContaining(SHOP),
      expect.stringContaining(GALLERY),
    ]);
  });

  it('room-leaves — a Room that leaves the battlefield is a whole card again, its doors forgotten', () => {
    const ctx = game('room-leaves');
    const room = castDoor(ctx, SHOP);
    const moved = pump(moveObject(ctx, room, { zone: 'graveyard' })).value;
    expect(moved?.name).toBe(ROOM.name);
    expect(moved?.unlockedDoors).toBeUndefined();
  });
});
