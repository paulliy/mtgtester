import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeTargetOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent, queueTriggersForObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/w1-remaining-engine-batch1-oracle.json'),
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

function pod(seed: string, seats = 3): GameContext {
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

describe('W1 remaining engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Fumiko the Lowblood',
      'Ghalta and Mavren',
      'Nova Flame',
      "Sage's Reverie",
      'Scriv, the Obligator',
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

describe('Fumiko the Lowblood', () => {
  const card = pinned('Fumiko the Lowblood');

  it('fumiko-bushido-x-when-blocking-or-becoming-blocked', () => {
    for (const event of ['blocks', 'becomesBlocked'] as const) {
      const ctx = pod(`fumiko-${event}`);
      const fumiko = spawn(ctx, 'P1', card);
      const first = spawn(ctx, 'P1', bear());
      const second = spawn(ctx, 'P1', bear());
      const opposing = spawn(ctx, 'P2', bear());
      fumiko.attacking = event === 'becomesBlocked' ? 'P2' : null;
      first.attacking = 'P2';
      second.attacking = 'P3';
      queueTriggersForObject(ctx, event, fumiko);
      pump(runPrioritySequence(ctx));
      const expectedBonus = event === 'becomesBlocked' ? 3 : 2;
      expect(computeCharacteristics(ctx, fumiko).power).toBe(3 + expectedBonus);
      expect(computeCharacteristics(ctx, fumiko).toughness).toBe(2 + expectedBonus);
      expect(computeCharacteristics(ctx, opposing).mustAttackEachCombat).toBe(true);
    }
  });
});

describe('Ghalta and Mavren', () => {
  const card = pinned('Ghalta and Mavren');

  function setup(seed: string) {
    const ctx = pod(seed);
    ctx.state.combat = { defendingPlayers: ['P2'] };
    const ghalta = spawn(ctx, 'P1', card);
    const large = spawn(ctx, 'P1', oracle({ name: 'Large Attacker', power: '5', toughness: '5' }));
    const small = spawn(ctx, 'P1', bear());
    ghalta.attacking = 'P2';
    large.attacking = 'P2';
    small.attacking = 'P2';
    return { ctx, ghalta };
  }

  it('ghalta-dinosaur-mode-uses-greatest-other-attacker-power', () => {
    const { ctx, ghalta } = setup('ghalta-dinosaur');
    pump(executeAbility(ctx, ghalta, interpretCard(card).triggers[0]!, []), () => ({
      index: 0,
      targets: new Map(),
    }));
    const dinosaur = ctx.state.battlefield.find((permanent) => permanent.name === 'Dinosaur')!;
    expect(computeCharacteristics(ctx, dinosaur).power).toBe(5);
    expect(dinosaur.tapped).toBe(true);
    expect(dinosaur.attacking).toBe('P2');
  });

  it('ghalta-vampire-mode-makes-one-per-other-attacker', () => {
    const { ctx, ghalta } = setup('ghalta-vampires');
    pump(executeAbility(ctx, ghalta, interpretCard(card).triggers[0]!, []), () => ({
      index: 1,
      targets: new Map(),
    }));
    const vampires = ctx.state.battlefield.filter((permanent) => permanent.name === 'Vampire');
    expect(vampires).toHaveLength(2);
    expect(
      vampires.every((permanent) =>
        computeCharacteristics(ctx, permanent).keywords.includes('lifelink'),
      ),
    ).toBe(true);
  });
});

describe('Nova Flame', () => {
  const card = pinned('Nova Flame');

  it('nova-puts-x-counters-then-deals-the-new-power-to-others', () => {
    const ctx = pod('nova-flame');
    const sourceCreature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Lifelink Adept', power: '2', toughness: '6', oracleText: 'Lifelink' }),
    );
    const victim = spawn(ctx, 'P2', oracle({ name: 'Nova Victim', power: '1', toughness: '8' }));
    const beforeLife = playerOf(ctx, 'P1').life;
    pump(
      executeAbility(
        ctx,
        { cardId: 'nova-flame', oracleId: card.oracleId, name: card.name, controllerId: 'P1' },
        interpretCard(card).spellAbility!,
        [sourceCreature.id],
        undefined,
        { x: 3 },
      ),
    );
    expect(sourceCreature.counters['+1/+1']).toBe(3);
    expect(sourceCreature.damageMarked).toBe(0);
    expect(victim.damageMarked).toBe(5);
    expect(playerOf(ctx, 'P1').life).toBe(beforeLife + 5);
  });

  it('nova-cannot-target-an-opponent-creature', () => {
    const ctx = pod('nova-illegal');
    const ally = spawn(ctx, 'P1', bear());
    const enemy = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'creature', controller: 'you' }, 'P1');
    expect(legal).toContain(ally.id);
    expect(legal).not.toContain(enemy.id);
  });
});

describe("Sage's Reverie", () => {
  const card = pinned("Sage's Reverie");

  it('reverie-counts-only-your-auras-attached-to-creatures', () => {
    const ctx = pod('sages-reverie');
    const enchanted = spawn(ctx, 'P1', bear());
    const reverie = spawn(ctx, 'P1', card);
    reverie.attachedTo = enchanted.id;
    const ownAura = spawn(
      ctx,
      'P1',
      oracle({ name: 'Own Aura', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' }),
    );
    ownAura.attachedTo = enchanted.id;
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Unattached Aura',
        typeLine: 'Enchantment — Aura',
        oracleText: 'Enchant creature',
      }),
    );
    const opposingAura = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Opposing Aura',
        typeLine: 'Enchantment — Aura',
        oracleText: 'Enchant creature',
      }),
    );
    opposingAura.attachedTo = enchanted.id;
    expect(computeCharacteristics(ctx, enchanted).power).toBe(4);
    const before = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, reverie, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 2);
  });
});

describe('Scriv, the Obligator', () => {
  const card = pinned('Scriv, the Obligator');

  it('scriv-etb-creates-a-contract-on-an-opposing-creature', () => {
    const ctx = pod('scriv-etb');
    const scriv = spawn(ctx, 'P1', card);
    const debtor = spawn(ctx, 'P2', bear());
    const ally = spawn(ctx, 'P1', bear());
    pump(executeAbility(ctx, scriv, interpretCard(card).triggers[0]!, [debtor.id]));
    const contract = ctx.state.battlefield.find((permanent) => permanent.name === 'Contract')!;
    expect(contract.attachedTo).toBe(debtor.id);
    const legal = computeTargetOptions(ctx, { kind: 'creature', controller: 'opponent' }, 'P1');
    expect(legal).toContain(debtor.id);
    expect(legal).not.toContain(ally.id);
  });

  it('scriv-contract-pumps-when-attacking-your-opponent-else-loses-life', () => {
    const ctx = pod('scriv-attack');
    const scriv = spawn(ctx, 'P1', card);
    const debtor = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, scriv, interpretCard(card).triggers[0]!, [debtor.id]));
    debtor.attacking = 'P3';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: debtor, playerId: 'P2' }]);
    pump(runPrioritySequence(ctx));
    expect(computeCharacteristics(ctx, debtor).power).toBe(4);

    const beforeLife = playerOf(ctx, 'P2').life;
    debtor.attacking = 'P1';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: debtor, playerId: 'P2' }]);
    pump(runPrioritySequence(ctx));
    expect(playerOf(ctx, 'P2').life).toBe(beforeLife - 2);
  });
});
