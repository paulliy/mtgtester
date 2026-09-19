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
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, queueTriggersForObject } from '../src/state/objects';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  mountain,
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
    join(import.meta.dirname, 'fixtures/living-energy-engine-batch2-oracle.json'),
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

describe('Living Energy engine-evidence batch 2 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Era of Innovation',
      'Aethersquall Ancient',
      'Reckless Fireweaver',
      'Blasphemous Act',
      'Frostboil Snarl',
      'Vineglimmer Snarl',
      'Loyal Apprentice',
      'Disallow',
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

describe('Era of Innovation', () => {
  const card = pinned('Era of Innovation');

  it('era-pays-one-for-two-energy-on-your-artifact-not-a-plain-creature', () => {
    const ctx = pod('era-pay');
    spawn(ctx, 'P1', card);
    addMana(playerOf(ctx, 'P1'), [{ symbol: 'C' }]);
    const relic = spawn(
      ctx,
      'P1',
      oracle({ name: 'Era Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    queueTriggersForObject(ctx, 'enters', relic);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(
      executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []),
      (decision) => pick(decision, /Pay/),
    );
    expect(playerOf(ctx, 'P1').energy).toBe(2);

    const ctx2 = pod('era-creature');
    spawn(ctx2, 'P1', card);
    const friend = spawn(ctx2, 'P1', bear());
    queueTriggersForObject(ctx2, 'enters', friend);
    expect(ctx2.state.pendingTriggers).toHaveLength(0);
  });

  it('era-cannot-draw-three-without-six-energy', () => {
    const ctx = pod('era-sac');
    const era = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 5;
    expect(activate(ctx, era.id)).toBeUndefined();
    playerOf(ctx, 'P1').energy = 6;
    const before = playerOf(ctx, 'P1').hand.length;
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, era.id)!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield).not.toContain(era);
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 3);
  });
});

describe('Aethersquall Ancient', () => {
  const card = pinned('Aethersquall Ancient');

  it('ancient-gains-three-energy-on-your-upkeep-not-theirs', () => {
    const ctx = pod('ancient-upkeep');
    spawn(ctx, 'P1', card);
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []));
    expect(playerOf(ctx, 'P1').energy).toBe(3);

    const theirs = pod('ancient-opp');
    spawn(theirs, 'P2', card);
    queueStepTriggers(theirs, 'upkeep');
    expect(theirs.state.pendingTriggers).toHaveLength(0);
  });

  it('ancient-pays-eight-to-bounce-other-creatures-and-cannot-on-seven', () => {
    const ctx = pod('ancient-bounce');
    const ancient = spawn(ctx, 'P1', card);
    const friend = spawn(ctx, 'P1', bear());
    const enemy = spawn(ctx, 'P2', bear());
    playerOf(ctx, 'P1').energy = 7;
    expect(activate(ctx, ancient.id)).toBeUndefined();
    playerOf(ctx, 'P1').energy = 8;
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, ancient.id)!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield).toContain(ancient);
    expect(ctx.state.battlefield).not.toContain(friend);
    expect(ctx.state.battlefield).not.toContain(enemy);
    expect(playerOf(ctx, 'P1').energy).toBe(0);
  });
});

describe('Reckless Fireweaver', () => {
  const card = pinned('Reckless Fireweaver');

  it('weaver-pings-each-opponent-when-your-artifact-enters-not-a-creature', () => {
    const ctx = pod('weaver-etb');
    spawn(ctx, 'P1', card);
    const before = playerOf(ctx, 'P2').life;
    const relic = spawn(
      ctx,
      'P1',
      oracle({ name: 'Weaver Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    queueTriggersForObject(ctx, 'enters', relic);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []));
    expect(playerOf(ctx, 'P2').life).toBe(before - 1);
    expect(playerOf(ctx, 'P3').life).toBe(before - 1);
    expect(playerOf(ctx, 'P1').life).toBe(before);

    ctx.state.pendingTriggers = [];
    const friend = spawn(ctx, 'P1', bear());
    queueTriggersForObject(ctx, 'enters', friend);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Blasphemous Act', () => {
  const card = pinned('Blasphemous Act');

  it('act-costs-one-less-per-creature-and-only-for-itself', () => {
    const ctx = pod('act-reduce');
    spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P3', bear());
    ctx.defs.set(card.oracleId, interpretCard(card));
    expect(costReductionFor(ctx, 'P1', card.oracleId, 'act-card').generic).toBe(3);
    const other = oracle({ name: 'Other Red Eight', typeLine: 'Sorcery', manaCost: '{8}{R}' });
    ctx.defs.set(other.oracleId, interpretCard(other));
    expect(costReductionFor(ctx, 'P1', other.oracleId, 'other-card').generic).toBe(0);
  });
});

describe('Frostboil Snarl / Vineglimmer Snarl', () => {
  const frostboil = pinned('Frostboil Snarl');
  const vineglimmer = pinned('Vineglimmer Snarl');

  it('frostboil-enters-untapped-only-if-you-reveal-an-island-or-mountain', () => {
    const none = pod('frostboil-none');
    const obj = conjure(none, 'P1', frostboil, 'hand');
    const { value: tapped } = pump(moveObject(none, obj, { zone: 'battlefield' }));
    expect((tapped as { tapped: boolean }).tapped).toBe(true);

    const reveal = pod('frostboil-reveal');
    conjure(reveal, 'P1', island(), 'hand');
    const land = conjure(reveal, 'P1', frostboil, 'hand');
    const { value: untapped } = pump(
      moveObject(reveal, land, { zone: 'battlefield' }),
      (decision) => pick(decision, 'Reveal'),
    );
    expect((untapped as { tapped: boolean }).tapped).toBe(false);

    const decline = pod('frostboil-decline');
    conjure(decline, 'P1', mountain(), 'hand');
    const declined = conjure(decline, 'P1', frostboil, 'hand');
    const { value: stillTapped } = pump(
      moveObject(decline, declined, { zone: 'battlefield' }),
      (decision) => pick(decision, "Don't reveal"),
    );
    expect((stillTapped as { tapped: boolean }).tapped).toBe(true);
  });

  it('vineglimmer-does-not-reveal-a-plains', () => {
    const ctx = pod('vineglimmer-plains');
    conjure(ctx, 'P1', plains(), 'hand');
    const land = conjure(ctx, 'P1', vineglimmer, 'hand');
    const { value: perm } = pump(moveObject(ctx, land, { zone: 'battlefield' }));
    expect((perm as { tapped: boolean }).tapped).toBe(true);
  });
});

describe('Loyal Apprentice', () => {
  const card = pinned('Loyal Apprentice');

  it('apprentice-makes-a-hasty-thopter-only-if-you-control-your-commander', () => {
    const withCommander = pod('apprentice-lieutenant');
    spawn(withCommander, 'P1', card);
    spawn(
      withCommander,
      'P1',
      oracle({ name: 'Test Commander', typeLine: 'Legendary Creature — Human' }),
      {
        isCommander: true,
      },
    );
    queueStepTriggers(withCommander, 'beginningOfCombat');
    expect(withCommander.state.pendingTriggers).toHaveLength(1);
    pump(
      executeAbility(
        withCommander,
        sourceOf(card),
        withCommander.state.pendingTriggers[0]!.ability,
        [],
      ),
    );
    const thopter = withCommander.state.battlefield.find(
      (permanent) => permanent.name === 'Thopter',
    )!;
    expect(thopter).toBeDefined();

    const missing = pod('apprentice-missing');
    spawn(missing, 'P1', card);
    queueStepTriggers(missing, 'beginningOfCombat');
    expect(missing.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Disallow', () => {
  const card = pinned('Disallow');

  it('disallow-counters-a-spell-on-the-stack-and-cannot-target-a-player', () => {
    const ctx = pod('disallow-counter');
    const spell: EngineStackObject = {
      id: 'stack-spell',
      sourceId: 'stack-spell',
      controllerId: 'P2',
      kind: 'spell',
      description: 'Test Spell',
      targets: [],
      card: null,
      ability: { kind: 'spell', targets: [], effects: [] },
      sourceOracleId: 'oracle-test-spell',
      sourceCardId: 'test-spell-card',
      isCommanderCast: false,
    };
    ctx.state.stack.push(spell);
    ctx.defs.set(
      'oracle-test-spell',
      interpretCard(
        oracle({
          oracleId: 'oracle-test-spell',
          name: 'Test Spell',
          typeLine: 'Instant',
          manaCost: '{U}',
          oracleText: 'Draw a card.',
        }),
      ),
    );
    const slot = interpretCard(card).spellAbility!.targets[0]!;
    const legal = computeTargetOptions(ctx, slot, 'P1');
    expect(legal).toContain(spell.id);
    expect(legal).not.toContain('P2');
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [spell.id]));
    expect(ctx.state.stack.some((entry) => entry.id === spell.id)).toBe(false);
  });

  it('disallow-normal-cast-from-hand', () => {
    const ctx = pod('disallow-cast');
    const player = playerOf(ctx, 'P1');
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', forest());
    const inst = conjure(ctx, 'P1', card, 'hand');
    const dummy: EngineStackObject = {
      id: 'dummy-spell',
      sourceId: 'dummy-spell',
      controllerId: 'P2',
      kind: 'spell',
      description: 'Dummy Spell',
      targets: [],
      card: null,
      ability: { kind: 'spell', targets: [], effects: [] },
      sourceOracleId: 'oracle-dummy',
      sourceCardId: 'dummy-card',
      isCommanderCast: false,
    };
    ctx.state.stack.push(dummy);
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === inst.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, dummy.id]]),
      }),
    );
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(inst.cardId);
  });
});
