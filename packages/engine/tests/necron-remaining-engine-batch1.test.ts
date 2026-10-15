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
import { dealDamageToPlayer, executeAbility, permanentSource } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject, queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, conjure, copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/necron-remaining-engine-batch1-oracle.json'),
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

function sourceOf(card: OracleCard, cardId: string) {
  return { cardId, name: card.name, oracleId: card.oracleId, controllerId: 'P1' as const };
}

function relic(): OracleCard {
  return oracle({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}' });
}

function playFromHand(ctx: GameContext, card: OracleCard) {
  const obj = conjure(ctx, 'P1', card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }));
  return obj;
}

describe('Necron remaining engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Canoptek Scarab Swarm',
      'Darkness',
      'Lokhust Heavy Destroyer',
      'Necron Monolith',
      'Necron Overlord',
      'Sculpting Steel',
      'Skorpekh Destroyer',
      'Their Name Is Death',
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

describe('Canoptek Scarab Swarm', () => {
  const card = pinned('Canoptek Scarab Swarm');

  it('scarab-exiles-graveyard-and-makes-insects-for-artifacts-and-lands', () => {
    const ctx = pod('scarab-positive');
    const artifact = conjure(ctx, 'P2', relic(), 'graveyard');
    const land = conjure(ctx, 'P2', forest(), 'graveyard');
    const creature = conjure(ctx, 'P2', bear(), 'graveyard');
    const yours = conjure(ctx, 'P1', relic(), 'graveyard');
    const scarab = playFromHand(ctx, card);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, scarab.cardId), trigger, ['P2']));
    expect(ctx.state.exile.some((object) => object.cardId === artifact.cardId)).toBe(true);
    expect(ctx.state.exile.some((object) => object.cardId === land.cardId)).toBe(true);
    expect(ctx.state.exile.some((object) => object.cardId === creature.cardId)).toBe(true);
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(0);
    expect(playerOf(ctx, 'P1').graveyard.some((object) => object.cardId === yours.cardId)).toBe(
      true,
    );
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Insect')).toHaveLength(
      2,
    );
  });

  it('scarab-creature-only-graveyard-makes-no-insects', () => {
    const ctx = pod('scarab-creature-only');
    conjure(ctx, 'P2', bear(), 'graveyard');
    const scarab = playFromHand(ctx, card);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, scarab.cardId), trigger, ['P2']));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Insect')).toHaveLength(
      0,
    );
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(0);
  });
});

describe('Darkness', () => {
  const card = pinned('Darkness');

  it('darkness-prevents-combat-damage-this-turn', () => {
    const ctx = pod('darkness-combat');
    pump(
      executeAbility(
        ctx,
        sourceOf(card, `src-${card.name}`),
        interpretCard(card).spellAbility!,
        [],
      ),
    );
    const attacker = spawn(ctx, 'P2', bear());
    const youLife = playerOf(ctx, 'P1').life;
    const oppLife = playerOf(ctx, 'P2').life;
    pump(
      dealDamageToPlayer(ctx, permanentSource(attacker), playerOf(ctx, 'P1'), 3, {
        combat: true,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    pump(
      dealDamageToPlayer(ctx, permanentSource(attacker), playerOf(ctx, 'P2'), 2, {
        combat: true,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(playerOf(ctx, 'P1').life).toBe(youLife);
    expect(playerOf(ctx, 'P2').life).toBe(oppLife);
  });

  it('darkness-does-not-prevent-noncombat-damage', () => {
    const ctx = pod('darkness-noncombat');
    pump(
      executeAbility(
        ctx,
        sourceOf(card, `src-${card.name}`),
        interpretCard(card).spellAbility!,
        [],
      ),
    );
    const source = spawn(ctx, 'P2', bear());
    const life = playerOf(ctx, 'P1').life;
    pump(
      dealDamageToPlayer(ctx, permanentSource(source), playerOf(ctx, 'P1'), 3, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(playerOf(ctx, 'P1').life).toBe(life - 3);
  });
});

describe('Lokhust Heavy Destroyer', () => {
  const card = pinned('Lokhust Heavy Destroyer');

  it('lokhust-each-player-sacrifices-a-creature', () => {
    const ctx = pod('lokhust-sac');
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const lokhust = playFromHand(ctx, card);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, lokhust.cardId), trigger, []), (decision) => {
      if (decision.prompt?.includes('sacrifice')) {
        const keepLokhust = decision.options.findIndex((option) =>
          option.description.includes('Test Bear'),
        );
        if (keepLokhust >= 0) return { index: keepLokhust, targets: new Map() };
      }
      return pick(decision, 'Test Bear');
    });
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === yours.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === theirs.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === lokhust.cardId)).toBe(
      true,
    );
  });

  it('lokhust-player-with-no-creature-skips', () => {
    const ctx = pod('lokhust-empty');
    const lokhust = playFromHand(ctx, card);
    const trigger = interpretCard(card).triggers[0]!;
    pump(executeAbility(ctx, sourceOf(card, lokhust.cardId), trigger, []));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === lokhust.cardId)).toBe(
      false,
    );
  });
});

describe('Necron Monolith', () => {
  const card = pinned('Necron Monolith');

  it('monolith-attack-mills-and-makes-warriors-for-creatures', () => {
    const ctx = pod('monolith-attack');
    const vehicle = spawn(ctx, 'P1', card);
    conjure(ctx, 'P1', bear(), 'library');
    conjure(ctx, 'P1', bear(), 'library');
    conjure(ctx, 'P1', forest(), 'library');
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: vehicle, playerId: 'P1' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers.shift()!;
    pump(
      executeAbility(
        ctx,
        sourceOf(card, pending.sourceCardId),
        pending.ability,
        [],
        pending.triggerObjectCardId,
        pending.scope,
      ),
    );
    expect(playerOf(ctx, 'P1').graveyard).toHaveLength(3);
    expect(
      ctx.state.battlefield.filter((permanent) => permanent.name === 'Necron Warrior'),
    ).toHaveLength(2);
  });

  it('monolith-does-not-trigger-for-another-attacker', () => {
    const ctx = pod('monolith-other');
    spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: other, playerId: 'P1' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Necron Overlord', () => {
  const card = pinned('Necron Overlord');

  it('overlord-x-tap-artifacts-opponent-loses-x', () => {
    const ctx = pod('overlord-activate');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', relic());
    spawn(ctx, 'P1', relic());
    const overlord = spawn(ctx, 'P1', card);
    overlord.summoningSick = false;
    const life = playerOf(ctx, 'P2').life;
    const activate = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' && payload.objectId === overlord.id && payload.x === 2
      );
    });
    expect(activate).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), activate!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P2']]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(playerOf(ctx, 'P2').life).toBe(life - 2);
    expect(overlord.tapped).toBe(true);
  });

  it('overlord-cannot-target-you', () => {
    const ctx = pod('overlord-self');
    spawn(ctx, 'P1', card);
    const legal = computeTargetOptions(ctx, { kind: 'player', controller: 'opponent' }, 'P1');
    expect(legal).toContain('P2');
    expect(legal).not.toContain('P1');
  });
});

describe('Sculpting Steel', () => {
  const card = pinned('Sculpting Steel');

  it('steel-copies-an-artifact', () => {
    const ctx = pod('steel-copy');
    const host = spawn(ctx, 'P2', relic());
    const obj = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }), () => ({
      index: 0,
      targets: new Map(),
    }));
    const copy = ctx.state.battlefield.find((permanent) => permanent.cardId === obj.cardId);
    expect(copy?.name).toBe(host.name);
  });

  it('steel-decline-enters-normally', () => {
    const ctx = pod('steel-decline');
    spawn(ctx, 'P1', relic());
    const obj = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }), (decision) => {
      const decline = decision.options.findIndex(
        (option) =>
          option.presentation?.role === 'decline' || option.description === 'Enter normally',
      );
      return { index: decline >= 0 ? decline : decision.options.length - 1, targets: new Map() };
    });
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Sculpting Steel')).toBe(
      true,
    );
  });

  it('steel-creature-not-offered', () => {
    const ctx = pod('steel-creature');
    spawn(ctx, 'P1', bear());
    const names: string[] = [];
    const obj = conjure(ctx, 'P1', card, 'hand');
    pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }), (decision) => {
      names.push(...decision.options.map((option) => option.description));
      return { index: 0, targets: new Map() };
    });
    expect(names.some((description) => description.includes('Test Bear'))).toBe(false);
  });
});

describe('Skorpekh Destroyer', () => {
  const card = pinned('Skorpekh Destroyer');

  it('skorpekh-gains-first-strike-when-your-artifact-enters-including-self', () => {
    const ctx = pod('skorpekh-self');
    const obj = playFromHand(ctx, card);
    pump(runPrioritySequence(ctx));
    const skorpekh = ctx.state.battlefield.find((permanent) => permanent.cardId === obj.cardId)!;
    expect(computeCharacteristics(ctx, skorpekh).keywords).toEqual(
      expect.arrayContaining(['deathtouch', 'first strike']),
    );
  });

  it('skorpekh-does-not-trigger-for-an-opponent-artifact', () => {
    const ctx = pod('skorpekh-opp');
    const skorpekh = spawn(ctx, 'P1', card);
    const relicObj = conjure(ctx, 'P2', relic(), 'hand');
    pump(moveObject(ctx, relicObj, { zone: 'battlefield', controllerId: 'P2' }));
    pump(runPrioritySequence(ctx));
    expect(computeCharacteristics(ctx, skorpekh).keywords).toContain('deathtouch');
    expect(computeCharacteristics(ctx, skorpekh).keywords).not.toContain('first strike');
  });
});

describe('Their Name Is Death', () => {
  const card = pinned('Their Name Is Death');

  it('death-destroys-nonartifact-creatures-only', () => {
    const ctx = pod('death-sweep');
    const flesh = spawn(ctx, 'P2', bear());
    const yours = spawn(ctx, 'P1', bear());
    const machine = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Servo',
        typeLine: 'Artifact Creature — Servo',
        manaCost: '{1}',
        power: '1',
        toughness: '1',
      }),
    );
    pump(
      executeAbility(
        ctx,
        sourceOf(card, `src-${card.name}`),
        interpretCard(card).spellAbility!,
        [],
      ),
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === flesh.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === yours.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === machine.cardId)).toBe(
      true,
    );
  });
});
