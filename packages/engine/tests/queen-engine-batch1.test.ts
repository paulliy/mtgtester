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
import {
  dealDamageToCreature,
  dealDamageToPlayer,
  executeAbility,
  permanentSource,
} from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  mountain,
  oracle,
  plains,
  pump,
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
  readFileSync(join(import.meta.dirname, 'fixtures/queen-engine-batch1-oracle.json'), 'utf8'),
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

function sourceOf(controllerId: 'P1' | 'P2', card: OracleCard, cardId = `src-${card.name}`) {
  return { cardId, name: card.name, oracleId: card.oracleId, controllerId };
}

function resolveSpell(ctx: GameContext, card: OracleCard, targets: string[] = []): void {
  pump(executeAbility(ctx, sourceOf('P1', card), interpretCard(card).spellAbility!, targets));
}

describe('Queen engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-10',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Crackling Doom',
      'Flumph',
      'Gisela, Blade of Goldnight',
      'Inkshield',
      'Master of Ceremonies',
      'Secret Rendezvous',
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

describe('Crackling Doom', () => {
  const card = pinned('Crackling Doom');

  it('crackling-opponents-damage-and-greatest-sacrifice: each opponent takes 2 and sacrifices their greatest-power creature', () => {
    const ctx = pod('crackling-positive', 3);
    const p2Keep = spawn(
      ctx,
      'P2',
      oracle({ name: 'Small', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
    );
    const p2Sac = spawn(
      ctx,
      'P2',
      oracle({ name: 'Big', typeLine: 'Creature — Ox', power: '4', toughness: '4' }),
    );
    const yours = spawn(ctx, 'P1', bear());
    const p3Only = spawn(ctx, 'P3', bear());
    const p2Life = playerOf(ctx, 'P2').life;
    const p3Life = playerOf(ctx, 'P3').life;
    const p1Life = playerOf(ctx, 'P1').life;
    resolveSpell(ctx, card);
    expect(playerOf(ctx, 'P2').life).toBe(p2Life - 2);
    expect(playerOf(ctx, 'P3').life).toBe(p3Life - 2);
    expect(playerOf(ctx, 'P1').life).toBe(p1Life);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p2Sac.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p2Keep.cardId)).toBe(
      true,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === p3Only.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === yours.cardId)).toBe(true);
  });

  it('crackling-no-creature-still-damages: an opponent with no creature still takes 2', () => {
    const ctx = pod('crackling-empty');
    const p2Life = playerOf(ctx, 'P2').life;
    resolveSpell(ctx, card);
    expect(playerOf(ctx, 'P2').life).toBe(p2Life - 2);
  });

  it('crackling-normal-cast-from-hand', () => {
    const ctx = pod('crackling-cast');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', swamp());
    const victim = spawn(ctx, 'P2', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const p1 = playerOf(ctx, 'P1');
    const cast = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
  });
});

describe('Flumph', () => {
  const card = pinned('Flumph');

  it('flumph-damage-draws-you-and-opponent: damage makes you and the targeted opponent draw', () => {
    const ctx = pod('flumph-damage', 3);
    const flumph = spawn(ctx, 'P1', card);
    const youHand = playerOf(ctx, 'P1').hand.length;
    const p2Hand = playerOf(ctx, 'P2').hand.length;
    const p3Hand = playerOf(ctx, 'P3').hand.length;
    pump(
      dealDamageToCreature(ctx, permanentSource(spawn(ctx, 'P2', bear())), flumph, 1, {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    pump(runPrioritySequence(ctx), (decision) => {
      const p2 = decision.options.findIndex((option) => option.description.includes('P2'));
      return { index: p2 >= 0 ? p2 : 0, targets: new Map() };
    });
    expect(playerOf(ctx, 'P1').hand.length).toBe(youHand + 1);
    expect(playerOf(ctx, 'P2').hand.length).toBe(p2Hand + 1);
    expect(playerOf(ctx, 'P3').hand.length).toBe(p3Hand);
  });

  it('flumph-other-creature-damage-no-trigger: damaging another creature does not draw', () => {
    const ctx = pod('flumph-other');
    spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    const youHand = playerOf(ctx, 'P1').hand.length;
    pump(
      dealDamageToCreature(ctx, permanentSource(other), other, 1, {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    pump(runPrioritySequence(ctx));
    expect(playerOf(ctx, 'P1').hand.length).toBe(youHand);
  });
});

describe('Gisela, Blade of Goldnight', () => {
  const card = pinned('Gisela, Blade of Goldnight');

  it('gisela-doubles-opponent-and-halves-you: 3 damage becomes 6 to them and 1 to you', () => {
    const ctx = pod('gisela-replace');
    spawn(ctx, 'P1', card);
    const source = spawn(ctx, 'P2', bear());
    const yours = spawn(
      ctx,
      'P1',
      oracle({ name: 'Wall', typeLine: 'Creature — Wall', power: '0', toughness: '9' }),
    );
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Ox', typeLine: 'Creature — Ox', power: '0', toughness: '9' }),
    );
    pump(
      dealDamageToCreature(ctx, permanentSource(source), yours, 3, {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    pump(
      dealDamageToCreature(ctx, permanentSource(source), theirs, 3, {
        combat: false,
        sourceHasDeathtouch: false,
        sourceHasLifelink: false,
      }),
    );
    expect(yours.damageMarked).toBe(1);
    expect(theirs.damageMarked).toBe(6);
  });

  it('gisela-does-not-double-damage-to-you: player damage to you is halved, not doubled', () => {
    const ctx = pod('gisela-you');
    spawn(ctx, 'P1', card);
    const source = spawn(ctx, 'P2', bear());
    const youLife = playerOf(ctx, 'P1').life;
    const oppLife = playerOf(ctx, 'P2').life;
    pump(
      dealDamageToPlayer(ctx, permanentSource(source), playerOf(ctx, 'P1'), 3, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    pump(
      dealDamageToPlayer(ctx, permanentSource(source), playerOf(ctx, 'P2'), 3, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(playerOf(ctx, 'P1').life).toBe(youLife - 1);
    expect(playerOf(ctx, 'P2').life).toBe(oppLife - 6);
  });
});

describe('Inkshield', () => {
  const card = pinned('Inkshield');

  it('inkshield-prevents-combat-and-makes-inklings: each prevented combat damage to you makes an Inkling', () => {
    const ctx = pod('inkshield-prevent');
    resolveSpell(ctx, card);
    const attacker = spawn(ctx, 'P2', bear());
    const life = playerOf(ctx, 'P1').life;
    pump(
      dealDamageToPlayer(ctx, permanentSource(attacker), playerOf(ctx, 'P1'), 3, {
        combat: true,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(playerOf(ctx, 'P1').life).toBe(life);
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Inkling')).toHaveLength(
      3,
    );
  });

  it('inkshield-does-not-prevent-noncombat-or-to-others', () => {
    const ctx = pod('inkshield-scope', 3);
    resolveSpell(ctx, card);
    const source = spawn(ctx, 'P2', bear());
    const youLife = playerOf(ctx, 'P1').life;
    const oppLife = playerOf(ctx, 'P2').life;
    pump(
      dealDamageToPlayer(ctx, permanentSource(source), playerOf(ctx, 'P1'), 2, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    pump(
      dealDamageToPlayer(ctx, permanentSource(source), playerOf(ctx, 'P2'), 2, {
        combat: true,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    expect(playerOf(ctx, 'P1').life).toBe(youLife - 2);
    expect(playerOf(ctx, 'P2').life).toBe(oppLife - 2);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Inkling')).toBe(false);
  });
});

describe('Master of Ceremonies', () => {
  const card = pinned('Master of Ceremonies');

  it('master-money-makes-treasures-for-both: opponent money choice creates Treasures for each of you', () => {
    const ctx = pod('master-money');
    spawn(ctx, 'P1', card);
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx), () => ({ index: 0, targets: new Map() }));
    const treasures = ctx.state.battlefield.filter((permanent) => permanent.name === 'Treasure');
    expect(treasures).toHaveLength(2);
    expect(treasures.some((permanent) => permanent.controllerId === 'P1')).toBe(true);
    expect(treasures.some((permanent) => permanent.controllerId === 'P2')).toBe(true);
  });

  it('master-secrets-draws-both: opponent secrets choice draws you and them', () => {
    const ctx = pod('master-secrets');
    spawn(ctx, 'P1', card);
    const youHand = playerOf(ctx, 'P1').hand.length;
    const oppHand = playerOf(ctx, 'P2').hand.length;
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx), (decision) => {
      const secrets = decision.options.findIndex((option) => option.description === 'Secrets');
      return { index: secrets >= 0 ? secrets : 0, targets: new Map() };
    });
    expect(playerOf(ctx, 'P1').hand.length).toBe(youHand + 1);
    expect(playerOf(ctx, 'P2').hand.length).toBe(oppHand + 1);
  });

  it('master-not-on-opponent-upkeep', () => {
    const ctx = pod('master-timing');
    spawn(ctx, 'P1', card);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Treasure')).toBe(false);
  });
});

describe('Secret Rendezvous', () => {
  const card = pinned('Secret Rendezvous');

  it('rendezvous-you-and-target-opponent-draw-three', () => {
    const ctx = pod('rendezvous-draw', 3);
    const youHand = playerOf(ctx, 'P1').hand.length;
    const p2Hand = playerOf(ctx, 'P2').hand.length;
    const p3Hand = playerOf(ctx, 'P3').hand.length;
    resolveSpell(ctx, card, ['P2']);
    expect(playerOf(ctx, 'P1').hand.length).toBe(youHand + 3);
    expect(playerOf(ctx, 'P2').hand.length).toBe(p2Hand + 3);
    expect(playerOf(ctx, 'P3').hand.length).toBe(p3Hand);
  });

  it('rendezvous-cannot-target-yourself', () => {
    const ctx = pod('rendezvous-targets');
    const legal = computeTargetOptions(ctx, { kind: 'player', controller: 'opponent' }, 'P1');
    expect(legal).toEqual(['P2']);
    expect(legal).not.toContain('P1');
  });

  it('rendezvous-normal-cast-from-hand', () => {
    const ctx = pod('rendezvous-cast');
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', swamp());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const youHand = playerOf(ctx, 'P1').hand.length - 1;
    const oppHand = playerOf(ctx, 'P2').hand.length;
    const p1 = playerOf(ctx, 'P1');
    const cast = computePriorityOptions(ctx, p1).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P2']]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(playerOf(ctx, 'P1').hand.length).toBe(youHand + 3);
    expect(playerOf(ctx, 'P2').hand.length).toBe(oppHand + 3);
  });
});
