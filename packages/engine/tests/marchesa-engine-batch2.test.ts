import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { moveObject } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import {
  bear,
  bolt,
  commanderFor,
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  pick,
  pump,
  pumpStrict,
  spawn,
} from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-engine-batch2-oracle.json'), 'utf8'),
) as PinnedFixture;

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pinned(name: string): OracleCard {
  return fixture.cards.find((entry) => entry.card.name === name)!.card;
}

function pod(seed: string, seats = 2): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function playerOf(ctx: GameContext, id: string) {
  return ctx.state.players.find((player) => player.id === id)!;
}

function playFromHand(ctx: GameContext, controllerId: 'P1' | 'P2', card: OracleCard) {
  const obj = conjure(ctx, controllerId, card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId }));
  return obj;
}

function nonbasicLand(): OracleCard {
  return oracle({
    name: 'Command Tower',
    typeLine: 'Land',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
    oracleText: '{T}: Add one mana of any color.',
    isBasicLand: false,
  });
}

describe('Marchesa engine-evidence batch 2 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-10',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Anathemancer',
      'Disciple of Bolas',
      'Fierce Guardianship',
      'Forge of Heroes',
      'Madame Null, Power Broker',
      'Mahadi, Emporium Master',
    ]);
    for (const entry of fixture.cards) {
      expect(entry.card.oracleId).not.toMatch(/^oracle-/);
      expect(entry.card.oracleText.length, entry.card.name).toBeGreaterThan(20);
      expect(
        createHash('sha256').update(canonical(entry.card)).digest('hex'),
        entry.card.name,
      ).toBe(entry.sha256);
    }
  });

  it('models the complete pinned Oracle text for real and fixture IDs', () => {
    for (const { card } of fixture.cards) {
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        expect(def.modeled, `${card.name} (${candidate.oracleId})`).toBe(true);
        expect(def.unmodeledReasons, card.name).toEqual([]);
      }
    }
  });
});

describe('Anathemancer', () => {
  const card = pinned('Anathemancer');

  it('anathemancer-unearth-stays-interpreted — Unearth remains an executable graveyard ability', () => {
    const def = interpretCard(card);
    expect(
      def.activatedAbilities.some(
        (ability) => ability.zone === 'graveyard' && ability.timing === 'sorcery',
      ),
    ).toBe(true);

    // The printed Unearth really activates: it returns this card with haste, marked to be exiled.
    const ctx = pod('anathemancer-unearth');
    const player = playerOf(ctx, 'P1');
    const dead = conjure(ctx, 'P1', card, 'graveyard');
    addMana(player, [
      { symbol: 'B' },
      { symbol: 'R' },
      ...Array.from({ length: 5 }, () => ({ symbol: 'C' as const })),
    ]);
    const option = computePriorityOptions(ctx, player).find((o) =>
      o.description.includes('(graveyard): Unearth'),
    );
    expect(option).toBeDefined();
    pumpStrict(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(player.manaEntries).toHaveLength(0);
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(dead.cardId);
    pump(resolveTopOfStack(ctx));
    const unearthed = ctx.state.battlefield.find((permanent) => permanent.cardId === dead.cardId);
    expect(unearthed).toBeDefined();
    expect(unearthed!.unearthed).toBe(true);
    expect(player.graveyard.some((c) => c.cardId === dead.cardId)).toBe(false);
    expect(
      ctx.state.effects.some(
        (e) =>
          e.kind === 'grantKeyword' &&
          e.keyword === 'haste' &&
          e.targetCardIds?.includes(dead.cardId),
      ),
    ).toBe(true);
    expect(ctx.state.delayedTriggers.some((t) => t.targetId === dead.cardId)).toBe(true);
  });

  it('anathemancer-etb-nonbasic-damage — ETB deals damage equal to the target player’s nonbasic lands', () => {
    const ctx = pod('anathemancer-positive');
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', nonbasicLand());
    spawn(ctx, 'P2', nonbasicLand());
    const source = spawn(ctx, 'P1', card);
    const before = playerOf(ctx, 'P2').life;
    pump(executeAbility(ctx, source, interpretCard(card).triggers![0]!, ['P2']));
    expect(playerOf(ctx, 'P2').life).toBe(before - 2);
  });

  it('anathemancer-basics-deal-zero — basic lands do not count', () => {
    const ctx = pod('anathemancer-basics');
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', forest());
    const source = spawn(ctx, 'P1', card);
    const before = playerOf(ctx, 'P2').life;
    pump(executeAbility(ctx, source, interpretCard(card).triggers![0]!, ['P2']));
    expect(playerOf(ctx, 'P2').life).toBe(before);
  });

  it('anathemancer-normal-etb-targets-player — entering from hand offers a player target', () => {
    const ctx = pod('anathemancer-etb');
    spawn(ctx, 'P2', nonbasicLand());
    const before = playerOf(ctx, 'P2').life;
    playFromHand(ctx, 'P1', card);
    const { decisions } = pump(runPrioritySequence(ctx), () => ({
      index: 0,
      targets: new Map([[0, 'P2']]),
    }));
    // The trigger is mandatory: only the target is chosen, no "use this ability?" first.
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(playerOf(ctx, 'P2').life).toBe(before - 1);
  });
});

describe('Disciple of Bolas', () => {
  const card = pinned('Disciple of Bolas');

  it('disciple-sacrifice-other-draw-life — sacrificing another creature draws and gains life equal to its power', () => {
    const ctx = pod('disciple-positive');
    const victim = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ox', typeLine: 'Creature — Ox', power: '4', toughness: '4' }),
    );
    const source = spawn(ctx, 'P1', card);
    const lifeBefore = playerOf(ctx, 'P1').life;
    const handBefore = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, source, interpretCard(card).triggers![0]!, []));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === source.cardId)).toBe(
      true,
    );
    expect(playerOf(ctx, 'P1').life).toBe(lifeBefore + 4);
    expect(playerOf(ctx, 'P1').hand.length).toBe(handBefore + 4);
  });

  it('disciple-cannot-sacrifice-self — the Disciple is not a legal sacrifice', () => {
    const ctx = pod('disciple-self');
    const source = spawn(ctx, 'P1', card);
    const handBefore = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, source, interpretCard(card).triggers![0]!, []));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === source.cardId)).toBe(
      true,
    );
    expect(playerOf(ctx, 'P1').hand.length).toBe(handBefore);
  });

  it('disciple-normal-etb-sacrifices-other — entering from hand sacrifices another creature', () => {
    const ctx = pod('disciple-etb');
    const victim = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ox', typeLine: 'Creature — Ox', power: '4', toughness: '4' }),
    );
    const lifeBefore = playerOf(ctx, 'P1').life;
    const handBefore = playerOf(ctx, 'P1').hand.length;
    const source = playFromHand(ctx, 'P1', card);
    const { decisions } = pump(runPrioritySequence(ctx));
    // The sacrifice is mandatory: no "use this ability?" yes/no is asked.
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === source.cardId)).toBe(
      true,
    );
    expect(playerOf(ctx, 'P1').life).toBe(lifeBefore + 4);
    expect(playerOf(ctx, 'P1').hand.length).toBe(handBefore + 4);
  });
});

describe('Fierce Guardianship', () => {
  const card = pinned('Fierce Guardianship');

  it('fierce-models-any-noncreature-and-commander-free-cast', () => {
    const def = interpretCard(card);
    expect(def.commanderFreeCast).toBe(true);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'noncreatureSpell' }]);
  });

  it('fierce-counters-noncreature-including-own — own and opponent instants are legal; creatures are not', () => {
    const ctx = pod('fierce-targets');
    for (const land of [island(), island(), island(), mountain()]) spawn(ctx, 'P1', land);
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', mountain());
    const ownBolt = conjure(ctx, 'P1', bolt(), 'hand');
    const oppBolt = conjure(ctx, 'P2', bolt(), 'hand');
    const creature = conjure(ctx, 'P2', bear(), 'hand');

    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const p2 = playerOf(ctx, 'P2');
    const creatureCast = computePriorityOptions(ctx, p2).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === creature.id;
    });
    pump(
      applyPriorityAction(ctx, p2, creatureCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    const oppCast = computePriorityOptions(ctx, p2).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === oppBolt.id;
    });
    pump(
      applyPriorityAction(ctx, p2, oppCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P1']]),
      }),
    );

    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    const p1 = playerOf(ctx, 'P1');
    const ownCast = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === ownBolt.id;
    });
    pump(
      applyPriorityAction(ctx, p1, ownCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P2']]),
      }),
    );

    const legal = computeTargetOptions(ctx, { kind: 'noncreatureSpell' }, 'P1');
    const boltIds = ctx.state.stack
      .filter((entry) => entry.card?.name === 'Test Bolt')
      .map((entry) => entry.id);
    const bearId = ctx.state.stack.find((entry) => entry.card?.name === 'Test Bear')?.id;
    expect(boltIds).toHaveLength(2);
    expect(legal).toEqual(expect.arrayContaining(boltIds));
    expect(bearId).toBeDefined();
    expect(legal).not.toContain(bearId);
  });

  it('fierce-normal-cast-counters-stack-spell', () => {
    const ctx = pod('fierce-cast');
    for (const land of [island(), island(), island()]) spawn(ctx, 'P1', land);
    spawn(ctx, 'P2', mountain());
    const oppBolt = conjure(ctx, 'P2', bolt(), 'hand');
    const fierce = conjure(ctx, 'P1', card, 'hand');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const p2 = playerOf(ctx, 'P2');
    const oppCast = computePriorityOptions(ctx, p2).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === oppBolt.id;
    });
    pump(
      applyPriorityAction(ctx, p2, oppCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P1']]),
      }),
    );
    const boltId = ctx.state.stack[ctx.state.stack.length - 1]!.id;
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    const p1 = playerOf(ctx, 'P1');
    const cast = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === fierce.id;
    });
    expect(cast?.targets?.[0]?.options).toContain(boltId);
    pump(
      applyPriorityAction(ctx, p1, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, boltId]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack.some((entry) => entry.id === boltId)).toBe(false);
  });

  it('fierce-free-cast-requires-controlling-a-commander', () => {
    const ctx = pod('fierce-free');
    const fierce = conjure(ctx, 'P1', card, 'hand');
    const p1 = playerOf(ctx, 'P1');
    const isFree = (option: { description: string; payload?: unknown }): boolean => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'castSpell' &&
        payload.objectId === fierce.id &&
        option.description.includes('without paying')
      );
    };
    expect(computePriorityOptions(ctx, p1).some(isFree)).toBe(false);
    spawn(ctx, 'P1', commanderFor('U', 'Test Admiral'), { isCommander: true });
    spawn(ctx, 'P2', mountain());
    const oppBolt = conjure(ctx, 'P2', bolt(), 'hand');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const oppCast = computePriorityOptions(ctx, playerOf(ctx, 'P2')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === oppBolt.id;
    });
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P2'), oppCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P1']]),
      }),
    );
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    expect(computePriorityOptions(ctx, p1).some(isFree)).toBe(true);
  });
});

describe('Forge of Heroes', () => {
  const card = pinned('Forge of Heroes');

  it('forge-mana-ability-kept — {T} add {C} survives the activated-ability override', () => {
    const ctx = pod('forge-mana');
    const land = spawn(ctx, 'P1', card);
    const source = manaSourcesFor(ctx, 'P1').find((entry) => entry.cardId === land.cardId);
    expect(source?.units).toEqual([['C']]);
  });

  it('forge-counters-commander-entered-this-turn', () => {
    const ctx = pod('forge-positive');
    const land = spawn(ctx, 'P1', card);
    const commander = spawn(ctx, 'P1', commanderFor('W', 'Test Hero'), { isCommander: true });
    const p1 = playerOf(ctx, 'P1');
    const activation = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' &&
        payload.objectId === land.id &&
        option.description.includes('commander')
      );
    });
    expect(activation?.targets?.[0]?.options).toEqual([commander.id]);
    pump(
      applyPriorityAction(ctx, p1, activation!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, commander.id]]),
      }),
    );
    pumpStrict(resolveTopOfStack(ctx));
    expect(commander.counters['+1/+1']).toBe(1);
    expect(land.tapped).toBe(true);
  });

  it('forge-rejects-stale-commander-and-noncommander — previous-turn commanders and noncommanders are illegal', () => {
    const ctx = pod('forge-negative');
    const land = spawn(ctx, 'P1', card);
    const stale = spawn(ctx, 'P1', commanderFor('W', 'Yesterday Hero'), { isCommander: true });
    stale.enteredTurnNumber = ctx.state.turnNumber - 1;
    spawn(ctx, 'P1', bear());
    const p1 = playerOf(ctx, 'P1');
    const activation = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' &&
        payload.objectId === land.id &&
        option.description.includes('commander')
      );
    });
    expect(activation).toBeUndefined();
  });
});

describe('Madame Null, Power Broker', () => {
  const card = pinned('Madame Null, Power Broker');

  it('madame-null-pay-life-for-counters — paying life equal to power puts that many +1/+1 counters', () => {
    const ctx = pod('madame-pay');
    spawn(ctx, 'P1', card);
    const ox = oracle({ name: 'Ox', typeLine: 'Creature — Ox', power: '3', toughness: '3' });
    playFromHand(ctx, 'P1', ox);
    const lifeBefore = playerOf(ctx, 'P1').life;
    pump(runPrioritySequence(ctx), (decision) => pick(decision, 'Pay 3 life'));
    const entered = ctx.state.battlefield.find((permanent) => permanent.name === 'Ox')!;
    expect(entered.counters['+1/+1']).toBe(3);
    expect(playerOf(ctx, 'P1').life).toBe(lifeBefore - 3);
  });

  it('madame-null-decline — declining pays no life and adds no counters', () => {
    const ctx = pod('madame-decline');
    spawn(ctx, 'P1', card);
    playFromHand(ctx, 'P1', bear());
    const lifeBefore = playerOf(ctx, 'P1').life;
    pump(runPrioritySequence(ctx), (decision) => pick(decision, 'Decline'));
    const entered = ctx.state.battlefield.find((permanent) => permanent.name === 'Test Bear')!;
    expect(entered.counters['+1/+1'] ?? 0).toBe(0);
    expect(playerOf(ctx, 'P1').life).toBe(lifeBefore);
  });

  it('madame-null-not-self-or-opponent — own ETB and opponent creatures do not trigger', () => {
    const ctx = pod('madame-scope');
    playFromHand(ctx, 'P1', card);
    let asked = false;
    pump(runPrioritySequence(ctx), () => {
      asked = true;
      return { index: 0, targets: new Map() };
    });
    expect(asked).toBe(false);
    playFromHand(ctx, 'P2', bear());
    pump(runPrioritySequence(ctx), () => {
      asked = true;
      return { index: 0, targets: new Map() };
    });
    expect(asked).toBe(false);
  });
});

describe('Mahadi, Emporium Master', () => {
  const card = pinned('Mahadi, Emporium Master');

  it('mahadi-end-step-treasures-for-deaths — your end step creates a Treasure per creature that died this turn', () => {
    const ctx = pod('mahadi-positive');
    spawn(ctx, 'P1', card);
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    pump(moveObject(ctx, yours, { zone: 'graveyard' }));
    pump(moveObject(ctx, theirs, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    queueStepTriggers(ctx, 'endStep');
    const { decisions } = pump(runPrioritySequence(ctx));
    // The trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Treasure')).toHaveLength(
      2,
    );
  });

  it('mahadi-no-deaths-no-treasures — zero deaths create no tokens', () => {
    const ctx = pod('mahadi-zero');
    spawn(ctx, 'P1', card);
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Treasure')).toBe(false);
  });

  it('mahadi-not-on-opponent-end-step', () => {
    const ctx = pod('mahadi-timing');
    spawn(ctx, 'P1', card);
    const victim = spawn(ctx, 'P2', bear());
    pump(moveObject(ctx, victim, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    queueStepTriggers(ctx, 'endStep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Treasure')).toBe(false);
  });
});
