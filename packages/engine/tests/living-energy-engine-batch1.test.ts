import { conjure } from './fixtures';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { queueTriggersForObject } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, island, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/living-energy-engine-batch1-oracle.json'),
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

function sourceOf(card: OracleCard, cardId = `${card.name}-card`) {
  return { cardId, oracleId: card.oracleId, name: card.name, controllerId: 'P1' as const };
}

describe('Living Energy engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Glimmer of Genius',
      'Aethertide Whale',
      'Rogue Refiner',
      'Decoction Module',
      'Architect of the Untamed',
      'Whirler Virtuoso',
      'Servant of the Conduit',
      'Aetherwind Basker',
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

describe('Glimmer of Genius', () => {
  const card = pinned('Glimmer of Genius');

  it('glimmer-scries-draws-two-and-gains-two-energy', () => {
    const ctx = pod('glimmer-resolve');
    const player = playerOf(ctx, 'P1');
    const before = player.hand.length;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []), (decision) =>
      pick(decision, /Keep|bottom/),
    );
    expect(player.hand.length).toBe(before + 2);
    expect(player.energy).toBe(2);
  });

  it('glimmer-normal-cast-from-hand', () => {
    const ctx = pod('glimmer-cast');
    const player = playerOf(ctx, 'P1');
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(spell.cardId);
  });
});

describe('Aethertide Whale', () => {
  const card = pinned('Aethertide Whale');

  it('whale-etb-gains-six-energy-and-pays-four-to-bounce', () => {
    const ctx = pod('whale-bounce');
    const whale = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, whale, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').energy).toBe(6);
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, whale.id)!.payload as PriorityActionPayload,
        { index: 0, targets: new Map() },
      ),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield).not.toContain(whale);
    expect(playerOf(ctx, 'P1').hand.some((object) => object.cardId === whale.cardId)).toBe(true);
    expect(playerOf(ctx, 'P1').energy).toBe(2);
  });

  it('whale-cannot-bounce-on-three-energy', () => {
    const ctx = pod('whale-short');
    const whale = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 3;
    expect(activate(ctx, whale.id)).toBeUndefined();
  });
});

describe('Rogue Refiner', () => {
  const card = pinned('Rogue Refiner');

  it('refiner-etb-draws-and-gains-two-energy', () => {
    const ctx = pod('refiner-etb');
    const refiner = spawn(ctx, 'P1', card);
    const before = playerOf(ctx, 'P1').hand.length;
    pump(executeAbility(ctx, refiner, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').hand.length).toBe(before + 1);
    expect(playerOf(ctx, 'P1').energy).toBe(2);
  });
});

describe('Decoction Module', () => {
  const card = pinned('Decoction Module');

  it('module-gains-energy-for-your-creature-not-an-enchantment-or-theirs', () => {
    const ctx = pod('module-etb');
    spawn(ctx, 'P1', card);
    const creature = spawn(ctx, 'P1', bear());
    queueTriggersForObject(ctx, 'enters', creature);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []));
    expect(playerOf(ctx, 'P1').energy).toBe(1);

    ctx.state.pendingTriggers = [];
    const hex = spawn(
      ctx,
      'P1',
      oracle({ name: 'Module Hex', typeLine: 'Enchantment', power: null, toughness: null }),
    );
    queueTriggersForObject(ctx, 'enters', hex);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const theirs = spawn(ctx, 'P2', bear());
    queueTriggersForObject(ctx, 'enters', theirs);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Architect of the Untamed', () => {
  const card = pinned('Architect of the Untamed');

  it('architect-gains-energy-for-your-land-not-theirs-and-pays-eight-for-a-beast', () => {
    const ctx = pod('architect-landfall');
    const architect = spawn(ctx, 'P1', card);
    const land = spawn(ctx, 'P1', forest());
    queueTriggersForObject(ctx, 'enters', land);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, architect, ctx.state.pendingTriggers[0]!.ability, []));
    expect(playerOf(ctx, 'P1').energy).toBe(1);

    ctx.state.pendingTriggers = [];
    const theirs = spawn(ctx, 'P2', forest());
    queueTriggersForObject(ctx, 'enters', theirs);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    playerOf(ctx, 'P1').energy = 7;
    expect(activate(ctx, architect.id)).toBeUndefined();
    playerOf(ctx, 'P1').energy = 8;
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, architect.id)!.payload as PriorityActionPayload,
        { index: 0, targets: new Map() },
      ),
    );
    pump(resolveTopOfStack(ctx));
    const beast = ctx.state.battlefield.find((permanent) => permanent.name === 'Beast')!;
    expect(computeCharacteristics(ctx, beast).power).toBe(6);
    expect(computeCharacteristics(ctx, beast).toughness).toBe(6);
    expect(playerOf(ctx, 'P1').energy).toBe(0);
  });
});

describe('Whirler Virtuoso', () => {
  const card = pinned('Whirler Virtuoso');

  it('virtuoso-etb-gains-three-energy-and-pays-three-for-a-thopter', () => {
    const ctx = pod('virtuoso-thopter');
    const virtuoso = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, virtuoso, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').energy).toBe(3);
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, virtuoso.id)!.payload as PriorityActionPayload,
        { index: 0, targets: new Map() },
      ),
    );
    pump(resolveTopOfStack(ctx));
    const thopter = ctx.state.battlefield.find((permanent) => permanent.name === 'Thopter')!;
    expect(computeCharacteristics(ctx, thopter).keywords).toContain('flying');
    expect(playerOf(ctx, 'P1').energy).toBe(0);
  });

  it('virtuoso-cannot-make-a-thopter-on-two-energy', () => {
    const ctx = pod('virtuoso-short');
    const virtuoso = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 2;
    expect(activate(ctx, virtuoso.id)).toBeUndefined();
  });
});

describe('Servant of the Conduit', () => {
  const card = pinned('Servant of the Conduit');

  it('servant-etb-gains-two-energy-and-taps-for-any-color-by-paying-energy', () => {
    const ctx = pod('servant-mana');
    const servant = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, servant, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').energy).toBe(2);
    const source = manaSourcesFor(ctx, 'P1').find(
      (candidate) => candidate.cardId === servant.cardId,
    );
    expect(source?.units).toEqual([['W', 'U', 'B', 'R', 'G']]);
  });

  it('servant-cannot-tap-for-mana-without-energy', () => {
    const ctx = pod('servant-empty');
    const servant = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 0;
    expect(manaSourcesFor(ctx, 'P1').some((candidate) => candidate.cardId === servant.cardId)).toBe(
      false,
    );
  });
});

describe('Aetherwind Basker', () => {
  const card = pinned('Aetherwind Basker');

  it('basker-gains-energy-equal-to-your-creatures-including-itself', () => {
    const ctx = pod('basker-etb');
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    const basker = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, basker, interpretCard(card).triggers[0]!, []));
    expect(playerOf(ctx, 'P1').energy).toBe(2);
  });

  it('basker-pays-one-energy-to-pump-until-eot', () => {
    const ctx = pod('basker-pump');
    const basker = spawn(ctx, 'P1', card);
    playerOf(ctx, 'P1').energy = 1;
    const before = computeCharacteristics(ctx, basker).power;
    pump(
      applyPriorityAction(
        ctx,
        playerOf(ctx, 'P1'),
        activate(ctx, basker.id)!.payload as PriorityActionPayload,
        { index: 0, targets: new Map() },
      ),
    );
    pump(resolveTopOfStack(ctx));
    expect(computeCharacteristics(ctx, basker).power).toBe(before + 1);
    expect(playerOf(ctx, 'P1').energy).toBe(0);
  });
});
