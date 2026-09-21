import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  costReductionFor,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject, queueCastTriggers, queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  oracle,
  pick,
  plains,
  pump,
  registerDef,
  spawn,
  swamp,
} from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/silverquill-remaining-engine-batch1-oracle.json'),
    'utf8',
  ),
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

function sourceOf(card: OracleCard, cardId = `src-${card.name}`) {
  return {
    cardId,
    name: card.name,
    oracleId: card.oracleId,
    controllerId: 'P1' as const,
  };
}

function attachAura(ctx: GameContext, controllerId: 'P1' | 'P2', card: OracleCard, hostId: string) {
  const aura = spawn(ctx, controllerId, card);
  aura.attachedTo = hostId;
  return aura;
}

function resolvePending(ctx: GameContext): void {
  const pending = ctx.state.pendingTriggers[0];
  if (pending === undefined) return;
  ctx.state.pendingTriggers.shift();
  pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      [],
      pending.triggerObjectCardId,
      pending.scope,
    ),
  );
}

const labAura = (): OracleCard =>
  oracle({
    name: 'Lab Aura',
    typeLine: 'Enchantment — Aura',
    manaCost: '{W}',
    oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
  });

const labEnchantment = (): OracleCard =>
  oracle({
    name: 'Lab Enchantment',
    typeLine: 'Enchantment',
    manaCost: '{2}{W}',
    oracleText: 'At the beginning of your upkeep, you gain 1 life.',
  });

const seraph = (): OracleCard =>
  oracle({
    name: 'Lab Seraph',
    typeLine: 'Creature — Angel',
    manaCost: '{3}{W}',
    power: '3',
    toughness: '3',
    oracleText: 'Flying\n{T}: You gain 1 life.',
  });

describe('Silverquill remaining engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Chains of Custody',
      'Coercive Impetus',
      'Darksteel Mutation',
      'Parasitic Impetus',
      'Shineshadow Snarl',
      'Sram, Senior Edificer',
      'Starfield Mystic',
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

describe('Chains of Custody', () => {
  const card = pinned('Chains of Custody');

  it('chains-exiles-opposing-nonland-until-aura-leaves', () => {
    const ctx = pod('chains-exile');
    const host = spawn(ctx, 'P1', bear());
    const victim = spawn(ctx, 'P2', bear());
    const aura = attachAura(ctx, 'P1', card, host.id);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, aura.cardId), trigger, [victim.id]));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    expect(ctx.state.exiledUntilLeaves[aura.cardId]).toHaveLength(1);
    pump(moveObject(ctx, aura, { zone: 'graveyard' }));
    const returned = ctx.state.battlefield.find((permanent) => permanent.cardId === victim.cardId);
    expect(returned?.controllerId).toBe('P2');
  });

  it('chains-cannot-target-a-land-or-your-permanent', () => {
    const ctx = pod('chains-illegal');
    spawn(ctx, 'P1', bear());
    const yours = spawn(
      ctx,
      'P1',
      oracle({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}' }),
    );
    const land = spawn(ctx, 'P2', forest());
    const theirs = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(
      ctx,
      { kind: 'nonlandPermanent', controller: 'opponent' },
      'P1',
    );
    expect(legal).toContain(theirs.id);
    expect(legal).not.toContain(land.id);
    expect(legal).not.toContain(yours.id);
  });

  it('chains-grants-ward-only-to-the-enchanted-creature', () => {
    const ctx = pod('chains-ward');
    const host = spawn(ctx, 'P1', bear());
    const other = spawn(ctx, 'P1', bear());
    attachAura(ctx, 'P1', card, host.id);
    expect(computeCharacteristics(ctx, host).ward).toEqual(
      expect.objectContaining({ kind: 'mana' }),
    );
    expect(computeCharacteristics(ctx, host).ward).toMatchObject({
      kind: 'mana',
      cost: expect.objectContaining({ generic: 2 }),
    });
    expect(computeCharacteristics(ctx, other).ward).toBeNull();
  });
});

describe('Coercive Impetus', () => {
  const card = pinned('Coercive Impetus');

  it('coercive-pumps-and-goads-the-host', () => {
    const ctx = pod('coercive-buff');
    const host = spawn(ctx, 'P2', bear());
    const other = spawn(ctx, 'P2', bear());
    attachAura(ctx, 'P1', card, host.id);
    const hostChars = computeCharacteristics(ctx, host);
    expect(hostChars.power).toBe(3);
    expect(hostChars.toughness).toBe(3);
    expect(hostChars.staticGoadedBy).toEqual(['P1']);
    const otherChars = computeCharacteristics(ctx, other);
    expect(otherChars.power).toBe(2);
    expect(otherChars.staticGoadedBy ?? []).toEqual([]);
  });

  it('coercive-attack-you-draw-and-lose-one', () => {
    const ctx = pod('coercive-attack');
    const host = spawn(ctx, 'P2', bear());
    const aura = attachAura(ctx, 'P1', card, host.id);
    const hand = playerOf(ctx, 'P1').hand.length;
    const life = playerOf(ctx, 'P1').life;
    const oppLife = playerOf(ctx, 'P2').life;
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: host, playerId: host.controllerId }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.sourceCardId).toBe(aura.cardId);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 1);
    expect(playerOf(ctx, 'P1').life).toBe(life - 1);
    expect(playerOf(ctx, 'P2').life).toBe(oppLife);
  });

  it('coercive-does-not-fire-for-another-attacker', () => {
    const ctx = pod('coercive-other');
    const host = spawn(ctx, 'P2', bear());
    const stranger = spawn(ctx, 'P2', bear());
    const aura = attachAura(ctx, 'P1', card, host.id);
    queueTriggersForEvent(ctx, 'attacks', [
      { permanent: stranger, playerId: stranger.controllerId },
    ]);
    expect(
      ctx.state.pendingTriggers.filter((trigger) => trigger.sourceCardId === aura.cardId),
    ).toHaveLength(0);
  });
});

describe('Darksteel Mutation', () => {
  const card = pinned('Darksteel Mutation');

  it('darksteel-makes-host-0-1-insect-artifact-indestructible-without-other-abilities', () => {
    const ctx = pod('darksteel-positive');
    const host = spawn(ctx, 'P2', seraph());
    attachAura(ctx, 'P1', card, host.id);
    const chars = computeCharacteristics(ctx, host);
    expect(chars.types.sort()).toEqual(['Artifact', 'Creature']);
    expect(chars.subtypes).toEqual(['Insect']);
    expect(chars.power).toBe(0);
    expect(chars.toughness).toBe(1);
    expect(chars.keywords).toEqual(['indestructible']);
    expect(chars.loseAbilities).toBe(true);
    expect(chars.activatedAbilities ?? []).toEqual([]);
    expect(chars.manaAbilities).toEqual([]);
  });

  it('darksteel-does-not-mutate-an-unenchanted-creature', () => {
    const ctx = pod('darksteel-other');
    const host = spawn(ctx, 'P2', seraph());
    const other = spawn(ctx, 'P2', seraph());
    attachAura(ctx, 'P1', card, host.id);
    const chars = computeCharacteristics(ctx, other);
    expect(chars.types).toContain('Creature');
    expect(chars.types).not.toContain('Artifact');
    expect(chars.subtypes).toContain('Angel');
    expect(chars.power).toBe(3);
    expect(chars.keywords).toContain('flying');
    expect(chars.keywords).not.toContain('indestructible');
  });
});

describe('Parasitic Impetus', () => {
  const card = pinned('Parasitic Impetus');

  it('parasitic-pumps-and-goads-the-host', () => {
    const ctx = pod('parasitic-buff');
    const host = spawn(ctx, 'P2', bear());
    attachAura(ctx, 'P1', card, host.id);
    const chars = computeCharacteristics(ctx, host);
    expect(chars.power).toBe(4);
    expect(chars.toughness).toBe(4);
    expect(chars.staticGoadedBy).toEqual(['P1']);
  });

  it('parasitic-attack-host-controller-loses-two-you-gain-two', () => {
    const ctx = pod('parasitic-drain');
    const host = spawn(ctx, 'P2', bear());
    attachAura(ctx, 'P1', card, host.id);
    const you = playerOf(ctx, 'P1').life;
    const them = playerOf(ctx, 'P2').life;
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: host, playerId: host.controllerId }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P2').life).toBe(them - 2);
    expect(playerOf(ctx, 'P1').life).toBe(you + 2);
  });

  it('parasitic-does-not-fire-for-another-attacker', () => {
    const ctx = pod('parasitic-other');
    const host = spawn(ctx, 'P2', bear());
    const stranger = spawn(ctx, 'P2', bear());
    const aura = attachAura(ctx, 'P1', card, host.id);
    queueTriggersForEvent(ctx, 'attacks', [
      { permanent: stranger, playerId: stranger.controllerId },
    ]);
    expect(
      ctx.state.pendingTriggers.filter((trigger) => trigger.sourceCardId === aura.cardId),
    ).toHaveLength(0);
  });
});

describe('Shineshadow Snarl', () => {
  const card = pinned('Shineshadow Snarl');

  it('snarl-enters-untapped-when-you-reveal-a-plains-or-swamp', () => {
    const ctx = pod('snarl-reveal');
    conjure(ctx, 'P1', plains(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const { value: perm } = pump(moveObject(ctx, land, { zone: 'battlefield' }), (decision) =>
      pick(decision, 'Reveal'),
    );
    expect((perm as { tapped: boolean }).tapped).toBe(false);
  });

  it('snarl-enters-tapped-when-you-decline-or-have-no-qualifying-card', () => {
    const ctx = pod('snarl-decline');
    conjure(ctx, 'P1', swamp(), 'hand');
    const first = conjure(ctx, 'P1', card, 'hand');
    const { value: declined } = pump(moveObject(ctx, first, { zone: 'battlefield' }), (decision) =>
      pick(decision, "Don't reveal"),
    );
    expect((declined as { tapped: boolean }).tapped).toBe(true);

    const ctx2 = pod('snarl-island');
    conjure(ctx2, 'P1', island(), 'hand');
    const second = conjure(ctx2, 'P1', card, 'hand');
    const { value: islandOnly } = pump(moveObject(ctx2, second, { zone: 'battlefield' }));
    expect((islandOnly as { tapped: boolean }).tapped).toBe(true);
  });

  it('snarl-does-not-count-an-opponent-plains-in-their-hand', () => {
    const ctx = pod('snarl-opponent-hand');
    conjure(ctx, 'P2', plains(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const { value: perm } = pump(moveObject(ctx, land, { zone: 'battlefield' }));
    expect((perm as { tapped: boolean }).tapped).toBe(true);
  });

  it('snarl-normal-play-from-hand', () => {
    const ctx = pod('snarl-play');
    conjure(ctx, 'P1', swamp(), 'hand');
    const land = conjure(ctx, 'P1', card, 'hand');
    const play = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === land.id;
    });
    expect(play).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), play!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      (decision) => pick(decision, 'Reveal'),
    );
    const perm = ctx.state.battlefield.find((permanent) => permanent.cardId === land.cardId);
    expect(perm?.tapped).toBe(false);
  });
});

describe('Sram, Senior Edificer', () => {
  const card = pinned('Sram, Senior Edificer');

  it.each([
    ['Enchantment — Aura', 'P1', 1],
    ['Artifact — Equipment', 'P1', 1],
    ['Artifact — Vehicle', 'P1', 1],
    ['Artifact', 'P1', 0],
    ['Enchantment', 'P1', 0],
    ['Enchantment — Aura', 'P2', 0],
  ] as const)('sram-cast-%s-by-%s-queues-%i', (typeLine, controllerId, count) => {
    const ctx = pod(`sram-${typeLine}-${controllerId}`);
    spawn(ctx, 'P1', card);
    const spell = conjure(ctx, controllerId, oracle({ name: 'Sram Test Spell', typeLine }), 'hand');
    queueCastTriggers(ctx, {
      id: 'spell',
      kind: 'spell',
      controllerId,
      sourceId: spell.id,
      sourceCardId: spell.cardId,
      sourceOracleId: spell.oracleId,
      description: spell.name,
      card: spell,
      ability: null,
      targets: [],
      isCommanderCast: false,
    });
    expect(ctx.state.pendingTriggers).toHaveLength(count);
  });

  it('sram-normal-cast-aura-draws', () => {
    const ctx = pod('sram-cast');
    spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', bear());
    const aura = conjure(ctx, 'P1', labAura(), 'hand');
    const hand = playerOf(ctx, 'P1').hand.length;
    const cast = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === aura.id;
    });
    expect(cast).toBeDefined();
    const host = ctx.state.battlefield.find((permanent) => permanent.name === 'Test Bear')!;
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, host.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    pump(runPrioritySequence(ctx));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand - 1 + 1);
  });
});

describe('Starfield Mystic', () => {
  const card = pinned('Starfield Mystic');

  it('starfield-reduces-enchantment-spells-not-creatures', () => {
    const ctx = pod('starfield-reduce');
    spawn(ctx, 'P1', card);
    registerDef(ctx, labEnchantment());
    registerDef(ctx, bear());
    expect(costReductionFor(ctx, 'P1', labEnchantment().oracleId, 'c-enchant').generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', bear().oracleId, 'c-bear').generic).toBe(0);
  });

  it('starfield-does-not-reduce-for-an-opponent', () => {
    const ctx = pod('starfield-opp');
    spawn(ctx, 'P2', card);
    registerDef(ctx, labEnchantment());
    expect(costReductionFor(ctx, 'P1', labEnchantment().oracleId, 'c-enchant').generic).toBe(0);
  });

  it('starfield-your-enchantment-dying-puts-a-counter', () => {
    const ctx = pod('starfield-dies');
    const mystic = spawn(ctx, 'P1', card);
    const charm = spawn(ctx, 'P1', labEnchantment());
    pump(moveObject(ctx, charm, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    expect(mystic.counters['+1/+1']).toBe(1);
  });

  it('starfield-does-not-trigger-for-opponent-enchantment-or-your-creature', () => {
    const ctx = pod('starfield-neg');
    const mystic = spawn(ctx, 'P1', card);
    const theirs = spawn(ctx, 'P2', labEnchantment());
    pump(moveObject(ctx, theirs, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    expect(mystic.counters['+1/+1'] ?? 0).toBe(0);

    const creature = spawn(ctx, 'P1', bear());
    pump(moveObject(ctx, creature, { zone: 'graveyard' }));
    pump(runPrioritySequence(ctx));
    expect(mystic.counters['+1/+1'] ?? 0).toBe(0);
  });
});
