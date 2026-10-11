/**
 * "Enchanted creature ..." on an Aura means THE creature that Aura is attached to — not any
 * creature that happens to be enchanted by something.
 *
 * Nine authored Aura overrides used the `isEnchanted` selector, which matches every enchanted
 * creature on the battlefield regardless of whose Aura enchants it and regardless of who
 * controls it. The right selector is `attachedToSource` (`ATTACHED`). The difference is
 * invisible in a one-Aura fixture and decides the card in any real board, so each case here
 * pairs a positive with a different-controller negative.
 *
 * Parasitic Impetus additionally has to make the ENCHANTED CREATURE'S controller lose the life.
 * It is a goad Aura you put on an opponent's creature; resolving the life loss against the
 * ability's controller instead made it "you lose 2 and gain 2" — a no-op on its own card.
 */

import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import { interpretCard } from '../src/cards/interpret';
import { queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { gameConfig, oracle, spawn } from './fixtures';

const parasiticImpetus = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: 'ff3de07d-86c3-49e1-9de0-97c85301ff93',
    name: 'Parasitic Impetus',
    typeLine: 'Enchantment — Aura',
    manaCost: '{2}{B}',
    power: null,
    toughness: null,
    oracleText:
      'Enchant creature\nEnchanted creature gets +2/+2 and is goaded.\nWhenever enchanted creature attacks, its controller loses 2 life and you gain 2 life.',
  });

const martialImpetus = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: 'c8decfdf-1421-4649-acde-5215e7f08bb9',
    name: 'Martial Impetus',
    typeLine: 'Enchantment — Aura',
    manaCost: '{2}{W}',
    power: null,
    toughness: null,
    oracleText:
      "Enchant creature\nEnchanted creature gets +1/+1 and is goaded.\nWhenever enchanted creature attacks, each other creature that's attacking one of your opponents gets +1/+1 until end of turn.",
  });

const angelicDestiny = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '8ba36878-0816-44c7-b543-8ebfc28c2ecd',
    name: 'Angelic Destiny',
    typeLine: 'Enchantment — Aura',
    manaCost: '{2}{W}{W}',
    power: null,
    toughness: null,
    oracleText:
      "Enchant creature\nEnchanted creature gets +4/+4, has flying and first strike, and is an Angel in addition to its other types.\nWhen enchanted creature dies, return this card to its owner's hand.",
  });

const beast = (name: string): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Creature — Beast', manaCost: '{1}{G}', power: '2', toughness: '2' });

function ctxWithSeats(seats: number, seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: [] })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Aura "enchanted creature" triggers are scoped to their own host', () => {
  it("Parasitic Impetus fires for its own host and drains that host's controller", () => {
    const ctx = ctxWithSeats(2, 'parasitic-positive');
    const victim = spawn(ctx, 'P2', beast('Goaded Beast'));
    const aura = spawn(ctx, 'P1', parasiticImpetus());
    aura.attachedTo = victim.id;

    queueTriggersForEvent(ctx, 'attacks', [{ permanent: victim, playerId: victim.controllerId }]);

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.sourceCardId).toBe(aura.cardId);
  });

  it("Parasitic Impetus does NOT fire for a creature enchanted by somebody else's Aura", () => {
    const ctx = ctxWithSeats(2, 'parasitic-negative');
    const myHost = spawn(ctx, 'P2', beast('My Goaded Beast'));
    const aura = spawn(ctx, 'P1', parasiticImpetus());
    aura.attachedTo = myHost.id;

    // A second creature, enchanted by an unrelated Aura someone else controls. Under the old
    // `isEnchanted` selector this attacker fired MY Parasitic Impetus.
    const stranger = spawn(ctx, 'P2', beast('Stranger'));
    const otherAura = spawn(ctx, 'P2', angelicDestiny());
    otherAura.attachedTo = stranger.id;

    queueTriggersForEvent(ctx, 'attacks', [
      { permanent: stranger, playerId: stranger.controllerId },
    ]);

    expect(ctx.state.pendingTriggers.filter((t) => t.sourceCardId === aura.cardId)).toHaveLength(0);
  });

  it('Martial Impetus does not fire for an unrelated enchanted attacker', () => {
    const ctx = ctxWithSeats(2, 'martial-negative');
    const myHost = spawn(ctx, 'P1', beast('My Beast'));
    const aura = spawn(ctx, 'P1', martialImpetus());
    aura.attachedTo = myHost.id;

    const stranger = spawn(ctx, 'P2', beast('Stranger'));
    const otherAura = spawn(ctx, 'P2', angelicDestiny());
    otherAura.attachedTo = stranger.id;

    queueTriggersForEvent(ctx, 'attacks', [
      { permanent: stranger, playerId: stranger.controllerId },
    ]);

    expect(ctx.state.pendingTriggers.filter((t) => t.sourceCardId === aura.cardId)).toHaveLength(0);
  });

  it('models Angelic Destiny: the Angel type is a layer 4 addition and the Aura returns when its creature dies', () => {
    const def = interpretCard(angelicDestiny());
    // Restored in coverage PR05: the Angel type is added in layer 4, and the dies trigger returns
    // the Aura card from the graveyard to its owner's hand.
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.modeled).toBe(true);
    expect(def.staticEffects[0]).toEqual({
      affects: { kind: 'attachedToSource' },
      op: { layer: 4, addSubtypes: ['Angel'] },
    });
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'returnDepartedSourceToHand', fromGraveyard: true },
    ]);
  });

  it('models Hateful Eidolon: any enchanted creature dying draws per Aura you controlled on it', () => {
    const def = interpretCard(
      oracle({
        oracleId: 'a3b39590-34b7-4fd0-877f-748e6df30e88',
        name: 'Hateful Eidolon',
        typeLine: 'Enchantment Creature — Spirit',
        manaCost: '{B}',
        power: '1',
        toughness: '1',
        oracleText:
          'Lifelink\nWhenever an enchanted creature dies, draw a card for each Aura you controlled that was attached to it.',
      }),
    );
    // Restored in coverage PR05: the draw count is the dying creature's last-known Auras that the
    // trigger's controller controlled, not a flat one card.
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'draw', count: { kind: 'aurasYouControlledAttachedToTriggerObject' } },
    ]);
  });
});
