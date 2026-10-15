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
import { computeCharacteristics } from '../src/effects/continuous';
import {
  dealDamageToCreature,
  executeAbility,
  gainLife,
  permanentSource,
} from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  plains,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/token-triumph-engine-batch2-oracle.json'),
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
  return { cardId, name: card.name, oracleId: card.oracleId, controllerId: 'P1' as const };
}

function resolvePending(ctx: GameContext, chooser?: Parameters<typeof pump>[1]): void {
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
    chooser,
  );
}

function fund(ctx: GameContext, playerId: string): void {
  addMana(playerOf(ctx, playerId), [
    { symbol: 'W' },
    { symbol: 'W' },
    { symbol: 'W' },
    { symbol: 'W' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
  ]);
}

function tokenCreature(name: string, typeLine: string, power: string, toughness: string) {
  return oracle({ name, typeLine, power, toughness, manaCost: '' });
}

describe('Token Triumph engine-evidence batch 2 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Dawn of Hope',
      'Hornet Nest',
      'Slate of Ancestry',
      'Rootborn Defenses',
      'Aura Mutation',
      'Collective Unconscious',
      'Camaraderie',
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

describe('Dawn of Hope', () => {
  const card = pinned('Dawn of Hope');

  it('dawn-may-pay-two-to-draw-when-you-gain-life', () => {
    const ctx = pod('dawn-pay');
    spawn(ctx, 'P1', card);
    fund(ctx, 'P1');
    const hand = playerOf(ctx, 'P1').hand.length;
    gainLife(ctx, playerOf(ctx, 'P1'), 1);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx, (decision) => pick(decision, 'Pay {2}'));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('dawn-does-not-draw-when-you-decline-or-an-opponent-gains-life', () => {
    const ctx = pod('dawn-decline');
    spawn(ctx, 'P1', card);
    fund(ctx, 'P1');
    const hand = playerOf(ctx, 'P1').hand.length;
    gainLife(ctx, playerOf(ctx, 'P1'), 1);
    resolvePending(ctx, (decision) => pick(decision, "Don't pay"));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand);

    const ctx2 = pod('dawn-opp');
    spawn(ctx2, 'P1', card);
    gainLife(ctx2, playerOf(ctx2, 'P2'), 3);
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });

  it('dawn-activation-makes-a-lifelink-soldier', () => {
    const ctx = pod('dawn-soldier');
    const dawn = spawn(ctx, 'P1', card);
    fund(ctx, 'P1');
    const p1 = playerOf(ctx, 'P1');
    const activation = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === dawn.id;
    });
    expect(activation).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, activation!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    const soldier = ctx.state.battlefield.find((permanent) => permanent.name === 'Soldier')!;
    expect(computeCharacteristics(ctx, soldier).keywords).toContain('lifelink');
  });
});

describe('Hornet Nest', () => {
  const card = pinned('Hornet Nest');

  it('nest-makes-insects-equal-to-damage-dealt', () => {
    const ctx = pod('nest-damage');
    const nest = spawn(ctx, 'P1', card);
    pump(
      dealDamageToCreature(ctx, permanentSource(spawn(ctx, 'P2', bear())), nest, 2, {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    const insects = ctx.state.battlefield.filter(
      (permanent) => permanent.name === 'Insect' && permanent.controllerId === 'P1',
    );
    expect(insects).toHaveLength(2);
    expect(
      insects.every((permanent) => {
        const chars = computeCharacteristics(ctx, permanent);
        return chars.keywords.includes('flying') && chars.keywords.includes('deathtouch');
      }),
    ).toBe(true);
  });

  it('nest-does-not-trigger-when-another-creature-is-damaged', () => {
    const ctx = pod('nest-other');
    spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    pump(
      dealDamageToCreature(ctx, permanentSource(other), other, 1, {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Insect')).toBe(false);
  });
});

describe('Slate of Ancestry', () => {
  const card = pinned('Slate of Ancestry');

  it('slate-discards-hand-and-draws-for-creatures-you-control', () => {
    const ctx = pod('slate-draw');
    const slate = spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    conjure(ctx, 'P1', forest(), 'hand');
    conjure(ctx, 'P1', forest(), 'hand');
    conjure(ctx, 'P1', forest(), 'hand');
    fund(ctx, 'P1');
    const p1 = playerOf(ctx, 'P1');
    expect(p1.hand.length).toBe(3);
    const activation = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === slate.id;
    });
    expect(activation).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, activation!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(playerOf(ctx, 'P1').hand.length).toBe(2);
    expect(playerOf(ctx, 'P1').graveyard.length).toBe(3);
    expect(slate.tapped).toBe(true);
  });

  it('slate-draws-zero-without-creatures-you-control', () => {
    const ctx = pod('slate-zero');
    const slate = spawn(ctx, 'P1', card);
    spawn(ctx, 'P2', bear());
    fund(ctx, 'P1');
    const p1 = playerOf(ctx, 'P1');
    const activation = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === slate.id;
    });
    expect(activation).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, activation!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(playerOf(ctx, 'P1').hand.length).toBe(0);
  });
});

describe('Rootborn Defenses', () => {
  const card = pinned('Rootborn Defenses');

  it('rootborn-populates-your-token-and-grants-indestructible', () => {
    const ctx = pod('rootborn-populate');
    const token = spawn(ctx, 'P1', tokenCreature('Cat Beast', 'Creature — Cat Beast', '2', '2'));
    token.isToken = true;
    const nontoken = spawn(ctx, 'P1', bear());
    const enemyToken = spawn(ctx, 'P2', tokenCreature('Soldier', 'Creature — Soldier', '1', '1'));
    enemyToken.isToken = true;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    const copiesOnBoard = ctx.state.battlefield.filter(
      (permanent) => permanent.name === 'Cat Beast' && permanent.controllerId === 'P1',
    );
    expect(copiesOnBoard).toHaveLength(2);
    expect(computeCharacteristics(ctx, nontoken).keywords).toContain('indestructible');
    expect(computeCharacteristics(ctx, copiesOnBoard[0]!).keywords).toContain('indestructible');
    expect(computeCharacteristics(ctx, enemyToken).keywords).not.toContain('indestructible');
  });

  it('rootborn-does-not-copy-an-opponent-token-and-still-grants-indestructible', () => {
    const ctx = pod('rootborn-no-token');
    const ally = spawn(ctx, 'P1', bear());
    const enemyToken = spawn(ctx, 'P2', tokenCreature('Soldier', 'Creature — Soldier', '1', '1'));
    enemyToken.isToken = true;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Soldier')).toHaveLength(
      1,
    );
    expect(computeCharacteristics(ctx, ally).keywords).toContain('indestructible');
  });
});

describe('Aura Mutation', () => {
  const card = pinned('Aura Mutation');

  it('mutation-destroys-an-enchantment-and-makes-saprolings-equal-to-mana-value', () => {
    const ctx = pod('mutation-destroy');
    const enchantment = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Aura',
        typeLine: 'Enchantment — Aura',
        manaCost: '{2}{W}',
        cmc: 3,
        oracleText: 'Enchant creature',
      }),
    );
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [enchantment.id]));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === enchantment.cardId)).toBe(
      false,
    );
    expect(
      ctx.state.battlefield.filter((permanent) => permanent.name === 'Saproling'),
    ).toHaveLength(3);
  });

  it('mutation-cannot-target-a-creature', () => {
    const ctx = pod('mutation-illegal');
    const aura = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Aura',
        typeLine: 'Enchantment',
        manaCost: '{W}',
        cmc: 1,
      }),
    );
    const creature = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'enchantment' }, 'P1');
    expect(legal).toContain(aura.id);
    expect(legal).not.toContain(creature.id);
  });
});

describe('Collective Unconscious', () => {
  const card = pinned('Collective Unconscious');

  it('unconscious-draws-for-creatures-you-control', () => {
    const ctx = pod('unconscious-draw');
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    const hand = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 2);
  });

  it('unconscious-draws-zero-without-creatures-you-control', () => {
    const ctx = pod('unconscious-zero');
    spawn(ctx, 'P2', bear());
    const hand = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand);
  });
});

describe('Camaraderie', () => {
  const card = pinned('Camaraderie');

  it('camaraderie-gains-life-draws-and-pumps-equal-to-your-creatures', () => {
    const ctx = pod('camaraderie-yes');
    const yours = spawn(ctx, 'P1', bear());
    const other = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const life = playerOf(ctx, 'P1').life;
    const hand = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').life).toBe(life + 2);
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 2);
    expect(computeCharacteristics(ctx, yours).power).toBe(3);
    expect(computeCharacteristics(ctx, other).power).toBe(3);
    expect(computeCharacteristics(ctx, theirs).power).toBe(2);
  });

  it('camaraderie-does-nothing-without-creatures-you-control', () => {
    const ctx = pod('camaraderie-zero');
    const theirs = spawn(ctx, 'P2', bear());
    const life = playerOf(ctx, 'P1').life;
    const hand = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').life).toBe(life);
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand);
    expect(computeCharacteristics(ctx, theirs).power).toBe(2);
  });

  it('camaraderie-normal-cast-from-hand', () => {
    const ctx = pod('camaraderie-cast');
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const life = playerOf(ctx, 'P1').life;
    const cast = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(playerOf(ctx, 'P1').life).toBe(life + 1);
  });
});
