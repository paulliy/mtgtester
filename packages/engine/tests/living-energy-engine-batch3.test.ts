import { conjure } from './fixtures';
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
import { TREASURE, SOLDIER_1_1 } from '../src/cards/tokens';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { createToken, queueTriggersForObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import { bear, copies, forest, gameConfig, island, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/living-energy-engine-batch3-oracle.json'),
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

function activate(ctx: GameContext, objectId: string) {
  return computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === objectId;
  });
}

function sourceOf(card: OracleCard) {
  return {
    cardId: `${card.name}-card`,
    oracleId: card.oracleId,
    name: card.name,
    controllerId: 'P1' as const,
  };
}

describe('Living Energy engine-evidence batch 3 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Pia Nalaar, Chief Mechanic',
      'Confiscation Coup',
      'Nissa, Worldsoul Speaker',
      'Stridehangar Automaton',
      'Rampaging Aetherhood',
      'Elder Gargaroth',
      'Peema Aether-Seer',
      'One with the Machine',
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

describe('Pia Nalaar, Chief Mechanic', () => {
  const card = pinned('Pia Nalaar, Chief Mechanic');

  it('pia-gains-two-energy-from-artifact-creature-combat-damage-not-a-bear', () => {
    const ctx = pod('pia-damage');
    const pia = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, pia, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').energy).toBe(2);

    const ctx2 = pod('pia-bear');
    spawn(ctx2, 'P1', card);
    const friend = spawn(ctx2, 'P1', bear());
    queueTriggersForObject(ctx2, 'dealsCombatDamageToPlayer', friend);
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });

  it('pia-end-step-pays-energy-for-an-x-x-aetherjet', () => {
    const ctx = pod('pia-jet');
    spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 3;
    queueStepTriggers(ctx, 'endStep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(
      executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []),
      (decision) => pick(decision, 'Pay 3 energy'),
    );
    const jet = ctx.state.battlefield.find((permanent) => permanent.name === 'Nalaar Aetherjet')!;
    expect(computeCharacteristics(ctx, jet).power).toBe(3);
    expect(computeCharacteristics(ctx, jet).toughness).toBe(3);
    expect(playerOf(ctx, 'P1').energy).toBe(0);
  });
});

describe('Confiscation Coup', () => {
  const card = pinned('Confiscation Coup');

  it('coup-steals-only-when-you-pay-the-targets-mana-value', () => {
    const steal = pod('coup-steal');
    const victim = spawn(
      steal,
      'P2',
      oracle({
        name: 'Coup Victim',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
      }),
    );
    playerOf(steal, 'P1').energy = 0;
    pump(
      executeAbility(steal, sourceOf(card), interpretCard(card).spellAbility!, [victim.id]),
      (decision) => pick(decision, /Pay/),
    );
    expect(playerOf(steal, 'P1').energy).toBe(2);
    expect(victim.controllerId).toBe('P1');

    const decline = pod('coup-decline');
    const kept = spawn(
      decline,
      'P2',
      oracle({
        name: 'Coup Kept',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
      }),
    );
    pump(
      executeAbility(decline, sourceOf(card), interpretCard(card).spellAbility!, [kept.id]),
      (decision) => pick(decision, /Decline|Don't|not/),
    );
    expect(kept.controllerId).toBe('P2');
  });

  it('coup-cannot-target-a-land', () => {
    const ctx = pod('coup-land');
    const land = spawn(ctx, 'P2', forest());
    const slot = interpretCard(card).spellAbility!.targets[0]!;
    const legal = computeTargetOptions(ctx, slot, 'P1');
    expect(legal).not.toContain(land.id);
  });
});

describe('Nissa, Worldsoul Speaker', () => {
  const card = pinned('Nissa, Worldsoul Speaker');

  it('nissa-gains-two-energy-for-your-land-not-theirs', () => {
    const ctx = pod('nissa-landfall');
    spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P1', forest());
    queueTriggersForObject(ctx, 'enters', land);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []));
    expect(playerOf(ctx, 'P1').energy).toBe(2);

    ctx.state.pendingTriggers = [];
    const theirs = spawn(ctx, 'P2', forest());
    queueTriggersForObject(ctx, 'enters', theirs);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('nissa-offers-an-eight-energy-alt-cost-for-permanents-not-lands', () => {
    const ctx = pod('nissa-alt');
    spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 8;
    const creature = conjure(ctx, 'P1', bear(), 'hand');
    expect(
      computePriorityOptions(ctx, playerOf(ctx, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return (
          payload.kind === 'castSpell' &&
          payload.objectId === creature.id &&
          payload.alternativeCast === 'energy'
        );
      }),
    ).toBe(true);

    const land = conjure(ctx, 'P1', island(), 'hand');
    expect(
      computePriorityOptions(ctx, playerOf(ctx, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return (
          payload.kind === 'castSpell' &&
          payload.objectId === land.id &&
          payload.alternativeCast === 'energy'
        );
      }),
    ).toBe(false);
  });
});

describe('Stridehangar Automaton', () => {
  const card = pinned('Stridehangar Automaton');

  it('stridehangar-adds-a-thopter-only-when-you-create-an-artifact-token', () => {
    const ctx = pod('stride-thopter');
    spawn(ctx, 'P1', card);
    createToken(ctx, TREASURE, 'P1');
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Treasure')).toBe(true);
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Thopter')).toHaveLength(
      1,
    );

    const none = pod('stride-soldier');
    spawn(none, 'P1', card);
    createToken(none, SOLDIER_1_1, 'P1');
    expect(none.state.battlefield.some((permanent) => permanent.name === 'Soldier')).toBe(true);
    expect(none.state.battlefield.some((permanent) => permanent.name === 'Thopter')).toBe(false);
  });
});

describe('Rampaging Aetherhood', () => {
  const card = pinned('Rampaging Aetherhood');

  it('aetherhood-gains-energy-equal-to-power-then-may-pay-for-counters', () => {
    const ctx = pod('aetherhood-upkeep');
    const hood = spawn(ctx, 'P1', card);
    const power = computeCharacteristics(ctx, hood).power;
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, hood, ctx.state.pendingTriggers[0]!.ability, []), (decision) =>
      pick(decision, `Pay ${power} energy`),
    );
    expect(hood.counters['+1/+1']).toBe(power);
    expect(playerOf(ctx, 'P1').energy).toBe(0);

    const theirs = pod('aetherhood-opp');
    spawn(theirs, 'P2', card);
    queueStepTriggers(theirs, 'upkeep');
    expect(theirs.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Elder Gargaroth', () => {
  const card = pinned('Elder Gargaroth');

  it('gargaroth-attack-choose-one-does-not-fire-for-another-attacker', () => {
    const ctx = pod('gargaroth-attack');
    const gargaroth = spawn(ctx, 'P1', card);
    const before = playerOf(ctx, 'P1').life;
    pump(executeAbility(ctx, gargaroth, interpretCard(card).triggers[0]!, []), (decision) =>
      pick(decision, /Gain 3 life/),
    );
    expect(playerOf(ctx, 'P1').life).toBe(before + 3);

    const other = pod('gargaroth-other');
    spawn(other, 'P1', card);
    const friend = spawn(other, 'P1', bear());
    queueTriggersForObject(other, 'attacks', friend);
    expect(other.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Peema Aether-Seer', () => {
  const card = pinned('Peema Aether-Seer');

  it('seer-etb-energy-equals-greatest-power-among-your-creatures', () => {
    const ctx = pod('seer-etb');
    spawn(ctx, 'P1', oracle({ name: 'Seer Friend', power: '5', toughness: '5' }));
    spawn(ctx, 'P2', oracle({ name: 'Seer Enemy', power: '9', toughness: '9' }));
    const seer = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, seer, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').energy).toBe(Math.max(5, computeCharacteristics(ctx, seer).power));
  });

  it('seer-pays-three-energy-to-make-a-creature-block-and-cannot-on-two', () => {
    const ctx = pod('seer-block');
    const seer = spawn(ctx, 'P1', card);
    const enemy = spawn(ctx, 'P2', bear());
    playerOf(ctx, 'P1').energy = 2;
    expect(activate(ctx, seer.id)).toBeUndefined();
    playerOf(ctx, 'P1').energy = 3;
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, seer.id)!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map([[0, enemy.id]]),
        },
      ),
    );
    pump(resolveTopOfStack(ctx));
    expect(enemy.mustBlockThisTurn).toBe(true);
  });
});

describe('One with the Machine', () => {
  const card = pinned('One with the Machine');

  it('machine-draws-the-greatest-artifact-mana-value-you-control-not-theirs', () => {
    const ctx = pod('machine-draw');
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Small Cog',
        typeLine: 'Artifact',
        manaCost: '{1}',
        cmc: 1,
        power: null,
        toughness: null,
      }),
    );
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Big Cog',
        typeLine: 'Artifact',
        manaCost: '{4}',
        cmc: 4,
        power: null,
        toughness: null,
      }),
    );
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Their Cog',
        typeLine: 'Artifact',
        manaCost: '{8}',
        cmc: 8,
        power: null,
        toughness: null,
      }),
    );
    const before = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 4);
  });
});
