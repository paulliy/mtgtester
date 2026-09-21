import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, copies, declareAttacks, forest, gameConfig, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-engine-batch1-oracle.json'), 'utf8'),
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

function pod(seed: string, seats = 4): GameContext {
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

function resolveDeath(ctx: GameContext, answer?: Parameters<typeof pump>[1]): void {
  pump(runPrioritySequence(ctx), answer);
}

describe('Marchesa engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-10',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Grave Pact',
      'Herald of Secret Streams',
      'Pawn of Ulamog',
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

describe('Grave Pact', () => {
  const gravePact = pinned('Grave Pact');

  it('grave-pact-your-creature-dies-opponents-sacrifice: each other player sacrifices a creature', () => {
    const ctx = pod('grave-pact-positive');
    spawn(ctx, 'P1', gravePact);
    const yours = spawn(ctx, 'P1', bear());
    const p2Keep = spawn(ctx, 'P2', bear());
    const p2Sac = spawn(ctx, 'P2', bear());
    const p3Keep = spawn(ctx, 'P3', bear());
    const p3Sac = spawn(ctx, 'P3', bear());
    const p4Keep = spawn(ctx, 'P4', bear());
    const p4Sac = spawn(ctx, 'P4', bear());
    const asked: string[] = [];

    pump(moveObject(ctx, yours, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      asked.push(decision.player);
      expect(decision.options).toHaveLength(2);
      return { index: 1, targets: new Map() };
    });

    expect(asked).toEqual(['P2', 'P3', 'P4']);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === yours.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p2Keep.cardId)).toBe(
      true,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p2Sac.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p3Keep.cardId)).toBe(
      true,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p3Sac.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p4Keep.cardId)).toBe(
      true,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p4Sac.cardId)).toBe(
      false,
    );
  });

  it('grave-pact-opponent-creature-dies-no-trigger: an opponent dying does not make you sacrifice', () => {
    const ctx = pod('grave-pact-negative-opponent');
    spawn(ctx, 'P1', gravePact);
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const asked: string[] = [];

    pump(moveObject(ctx, theirs, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      asked.push(decision.player);
      return { index: 0, targets: new Map() };
    });

    expect(asked).toEqual([]);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === yours.cardId)).toBe(true);
  });

  it('grave-pact-no-creature-to-sacrifice: a player with no creature is not asked', () => {
    const ctx = pod('grave-pact-empty');
    spawn(ctx, 'P1', gravePact);
    const yours = spawn(ctx, 'P1', bear());
    const p3 = spawn(ctx, 'P3', bear());
    const asked: string[] = [];

    pump(moveObject(ctx, yours, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      asked.push(decision.player);
      return { index: 0, targets: new Map() };
    });

    expect(asked).toEqual([]);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p3.cardId)).toBe(false);
  });
});

describe('Herald of Secret Streams', () => {
  const herald = pinned('Herald of Secret Streams');

  it('herald-plus-one-cant-be-blocked: your +1/+1 creature cannot be blocked', () => {
    const ctx = pod('herald-positive', 2);
    spawn(ctx, 'P1', herald);
    const attacker = spawn(ctx, 'P1', bear());
    attacker.counters['+1/+1'] = 1;
    expect(computeCharacteristics(ctx, attacker).cantBeBlocked).toBe(true);
  });

  it('herald-no-counter-can-be-blocked: a creature without +1/+1 remains blockable', () => {
    const ctx = pod('herald-negative-no-counter', 2);
    spawn(ctx, 'P1', herald);
    const attacker = spawn(ctx, 'P1', bear());
    expect(computeCharacteristics(ctx, attacker).cantBeBlocked).toBe(false);
  });

  it('herald-opponent-plus-one-can-be-blocked: an opponent creature with +1/+1 is not granted unblockable', () => {
    const ctx = pod('herald-negative-opponent', 2);
    spawn(ctx, 'P1', herald);
    const theirs = spawn(ctx, 'P2', bear());
    theirs.counters['+1/+1'] = 1;
    expect(computeCharacteristics(ctx, theirs).cantBeBlocked).toBe(false);
  });

  it('herald-combat-block-menu: the block declaration omits the +1/+1 attacker and still offers the uncountered one', () => {
    const ctx = pod('herald-combat', 2);
    ctx.state.phase = 'combat';
    spawn(ctx, 'P1', herald);
    const unblockable = spawn(ctx, 'P1', bear());
    unblockable.counters['+1/+1'] = 1;
    const blockable = spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    let offered: string[] = [];

    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        return declareAttacks(decision, () => 'P2');
      }
      if (decision.decisionType === 'declareBlockers') {
        const subject = decision.presentationBlockDeclaration?.subjects[0];
        offered = subject?.attackers.map((attacker) => attacker.attackerId) ?? [];
        return { index: 0, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });

    expect(offered).toContain(blockable.id);
    expect(offered).not.toContain(unblockable.id);
  });
});

describe('Pawn of Ulamog', () => {
  const pawn = pinned('Pawn of Ulamog');

  it('pawn-nontoken-dies-accept-spawn: a nontoken you control dying may create an Eldrazi Spawn', () => {
    const ctx = pod('pawn-accept', 2);
    spawn(ctx, 'P1', pawn);
    const victim = spawn(ctx, 'P1', bear());
    let asked = false;

    pump(moveObject(ctx, victim, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      if (decision.decisionType === 'optionalTrigger') {
        asked = true;
        return pick(decision, 'Yes');
      }
      return { index: 0, targets: new Map() };
    });

    expect(asked).toBe(true);
    const spawnToken = ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Eldrazi Spawn',
    );
    expect(spawnToken?.isToken).toBe(true);
    expect(spawnToken?.controllerId).toBe('P1');
    expect(computeCharacteristics(ctx, spawnToken!).power).toBe(0);
    expect(computeCharacteristics(ctx, spawnToken!).toughness).toBe(1);
  });

  it('pawn-nontoken-dies-decline: declining the optional trigger creates no token', () => {
    const ctx = pod('pawn-decline', 2);
    spawn(ctx, 'P1', pawn);
    const victim = spawn(ctx, 'P1', bear());

    pump(moveObject(ctx, victim, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      if (decision.decisionType === 'optionalTrigger') return pick(decision, 'No');
      return { index: 0, targets: new Map() };
    });

    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Eldrazi Spawn')).toBe(
      false,
    );
    expect(ctx.state.eventLog.some((event) => event.type === 'triggerDeclined')).toBe(true);
  });

  it('pawn-token-dies-no-trigger: a token death does not offer a Spawn', () => {
    const ctx = pod('pawn-token', 2);
    spawn(ctx, 'P1', pawn);
    const token = spawn(ctx, 'P1', bear(), { isToken: true });
    let asked = false;

    pump(moveObject(ctx, token, { zone: 'graveyard' }));
    resolveDeath(ctx, () => {
      asked = true;
      return { index: 0, targets: new Map() };
    });

    expect(asked).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Eldrazi Spawn')).toBe(
      false,
    );
  });

  it('pawn-opponent-dies-no-trigger: an opponent nontoken death does not trigger', () => {
    const ctx = pod('pawn-opponent', 2);
    spawn(ctx, 'P1', pawn);
    const theirs = spawn(ctx, 'P2', bear());
    let asked = false;

    pump(moveObject(ctx, theirs, { zone: 'graveyard' }));
    resolveDeath(ctx, () => {
      asked = true;
      return { index: 0, targets: new Map() };
    });

    expect(asked).toBe(false);
  });

  it('pawn-self-dies-may-spawn: the Pawn itself dying is a qualifying nontoken death', () => {
    const ctx = pod('pawn-self', 2);
    const source = spawn(ctx, 'P1', pawn);

    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      if (decision.decisionType === 'optionalTrigger') return pick(decision, 'Yes');
      return { index: 0, targets: new Map() };
    });

    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Eldrazi Spawn')).toBe(
      true,
    );
  });

  it('pawn-spawn-sac-for-colorless: the token has Sacrifice this token: Add {C}', () => {
    const ctx = pod('pawn-mana', 2);
    spawn(ctx, 'P1', pawn);
    const victim = spawn(ctx, 'P1', bear());

    pump(moveObject(ctx, victim, { zone: 'graveyard' }));
    resolveDeath(ctx, (decision) => {
      if (decision.decisionType === 'optionalTrigger') return pick(decision, 'Yes');
      return { index: 0, targets: new Map() };
    });

    const spawnToken = ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Eldrazi Spawn',
    );
    expect(spawnToken).toBeDefined();
    const source = manaSourcesFor(ctx, 'P1').find((entry) => entry.cardId === spawnToken!.cardId);
    expect(source?.units).toEqual([['C']]);
    expect(source?.costs).toEqual([{ kind: 'sacrificeSelf' }]);
  });
});
