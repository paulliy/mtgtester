import { describe, expect, it } from 'vitest';
import { computeTargetOptions } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { oracle, pump, spawn } from './fixtures';
import {
  bear,
  castFromHand,
  choose,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

const duplicant = pinned('Duplicant');
const elf = () =>
  bear('Duplicant Elf', { typeLine: 'Creature — Elf Warrior', power: '3', toughness: '4' });

/** P1 casts Duplicant, targets `targetId` with its enter trigger, and answers yes or no. */
function castDuplicant(ctx: GameContext, targetId: string, exile = true): EnginePermanent {
  castFromHand(ctx, 'P1', duplicant);
  pump(resolveTopOfStack(ctx));
  putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, targetId]]) }));
  settle(ctx, choose(exile ? 'Yes' : 'No'));
  return ctx.state.battlefield.find((permanent) => permanent.name === 'Duplicant')!;
}

const stats = (ctx: GameContext, permanent: EnginePermanent) => {
  const chars = computeCharacteristics(ctx, permanent);
  return { power: chars.power, toughness: chars.toughness, subtypes: chars.subtypes };
};

describe('PR10.13 Duplicant', () => {
  it('pr10-duplicant-pinned-oracle-supported — both lines are modeled', () => {
    const def = pinnedDefinition('Duplicant');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers[0]?.optional).toBe(true);
  });

  it('pr10-duplicant-nontoken-target — a creature token is not a legal target', () => {
    const ctx = pod('pr10-duplicant-token');
    const card = spawn(ctx, 'P2', elf());
    const token = spawn(ctx, 'P2', bear('Duplicant Token'));
    token.isToken = true;
    const spec = pinnedDefinition('Duplicant').triggers[0]!.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', {
      traits: { colors: [], types: ['Artifact', 'Creature'] },
      kind: 'ability',
    });
    expect(legal).toContain(card.id);
    expect(legal).not.toContain(token.id);
  });

  it('pr10-duplicant-exile-copies-characteristics — base P/T and creature types of the exiled card', () => {
    const ctx = pod('pr10-duplicant-exile');
    const target = spawn(ctx, 'P2', elf());
    const dup = castDuplicant(ctx, target.id);
    expect(ctx.state.exile.some((card) => card.cardId === target.cardId)).toBe(true);
    expect(stats(ctx, dup)).toEqual({
      power: 3,
      toughness: 4,
      subtypes: ['Elf', 'Warrior', 'Shapeshifter'],
    });
  });

  it('pr10-duplicant-decline — choosing not to exile leaves it a 2/4 Shapeshifter', () => {
    const ctx = pod('pr10-duplicant-decline');
    const target = spawn(ctx, 'P2', elf());
    const dup = castDuplicant(ctx, target.id, false);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === target.id)).toBe(true);
    expect(stats(ctx, dup)).toEqual({ power: 2, toughness: 4, subtypes: ['Shapeshifter'] });
  });

  it('pr10-duplicant-counters-still-apply — counters modify the new base P/T', () => {
    const ctx = pod('pr10-duplicant-counters');
    const target = spawn(ctx, 'P2', elf());
    const dup = castDuplicant(ctx, target.id);
    dup.counters['+1/+1'] = 1;
    expect(stats(ctx, dup)).toMatchObject({ power: 4, toughness: 5 });
  });

  it('pr10-duplicant-card-leaves-exile — a card that left exile is no longer exiled with it', () => {
    const ctx = pod('pr10-duplicant-leaves');
    const target = spawn(ctx, 'P2', elf());
    const dup = castDuplicant(ctx, target.id);
    const exiled = ctx.state.exile.find((card) => card.cardId === target.cardId)!;
    pump(moveObject(ctx, exiled, { zone: 'graveyard' }));
    expect(stats(ctx, dup)).toEqual({ power: 2, toughness: 4, subtypes: ['Shapeshifter'] });
    // Returning to exile makes a new object, still unlinked (CR 400.7, 607.2a).
    const inGraveyard = ctx.state.players
      .flatMap((player) => player.graveyard)
      .find((card) => card.cardId === target.cardId)!;
    pump(moveObject(ctx, inGraveyard, { zone: 'exile' }));
    expect(stats(ctx, dup).power).toBe(2);
  });

  it('pr10-duplicant-new-object — a Duplicant that left and returned has nothing exiled with it', () => {
    const ctx = pod('pr10-duplicant-flicker');
    const target = spawn(ctx, 'P2', elf());
    const dup = castDuplicant(ctx, target.id);
    const owner = ctx.state.players.find((player) => player.id === 'P1')!;
    pump(moveObject(ctx, dup, { zone: 'hand' }));
    const inHand = owner.hand.find((card) => card.cardId === dup.cardId)!;
    pump(moveObject(ctx, inHand, { zone: 'battlefield', controllerId: 'P1' }), choose('No'));
    const returned = ctx.state.battlefield.find((permanent) => permanent.cardId === dup.cardId)!;
    expect(stats(ctx, returned)).toEqual({ power: 2, toughness: 4, subtypes: ['Shapeshifter'] });
  });

  it('pr10-duplicant-last-creature-card — with two cards exiled with it, the last one counts', () => {
    const ctx = pod('pr10-duplicant-last');
    // Roaming Throne naming Shapeshifter makes the enter trigger fire twice.
    const throne = spawn(ctx, 'P1', pinned('Roaming Throne'));
    throne.chosenOption = 'Shapeshifter';
    const first = spawn(ctx, 'P2', elf());
    const second = spawn(
      ctx,
      'P3',
      bear('Duplicant Giant', { typeLine: 'Creature — Giant', power: '6', toughness: '6' }),
    );
    castFromHand(ctx, 'P1', duplicant);
    pump(resolveTopOfStack(ctx));
    const asked: string[] = [];
    // After the order choice, the first trigger targeted goes on the stack first and resolves last.
    putPendingTriggersOnStack(ctx, (decision) => {
      asked.push(decision.decisionType);
      const targeting = asked.filter((type) => type === decision.decisionType).length;
      return {
        index: 0,
        targets: new Map([[0, targeting === 1 ? second.id : first.id]]),
      };
    });
    settle(ctx, choose('Yes'));
    const dup = ctx.state.battlefield.find((permanent) => permanent.name === 'Duplicant')!;
    expect(
      ctx.state.exile.filter(
        (card) => card.cardId === first.cardId || card.cardId === second.cardId,
      ),
    ).toHaveLength(2);
    expect(stats(ctx, dup)).toEqual({
      power: 6,
      toughness: 6,
      subtypes: ['Giant', 'Shapeshifter'],
    });
  });

  it("pr10-duplicant-cda — a * is read from the card's ability in exile, with its owner as you", () => {
    const ctx = pod('pr10-duplicant-cda');
    const crusader = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Duplicant Crusader',
        typeLine: 'Creature — Human Knight',
        power: '*',
        toughness: '*',
        oracleText:
          "Duplicant Crusader's power and toughness are each equal to the number of creatures you control.",
      }),
    );
    spawn(ctx, 'P2', bear('Crusader Squire'));
    spawn(ctx, 'P2', bear('Crusader Page'));
    const dup = castDuplicant(ctx, crusader.id);
    // P2 now controls two creatures; P1 controls only Duplicant.
    expect(stats(ctx, dup)).toEqual({
      power: 2,
      toughness: 2,
      subtypes: ['Human', 'Knight', 'Shapeshifter'],
    });
    spawn(ctx, 'P2', bear('Crusader Herald'));
    expect(stats(ctx, dup)).toMatchObject({ power: 3, toughness: 3 });
  });
});
