import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { queueCastTriggers } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { queueStepTriggers } from '../src/turn/turn';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/living-energy-engine-batch5-oracle.json'),
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

describe('Living Energy engine-evidence batch 5 stubs (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Academy Ruins',
      'Pia and Kiran Nalaar',
      'Sai, Master Thopterist',
      'Thopter Spy Network',
      'Whirler Rogue',
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

describe('Academy Ruins', () => {
  const card = pinned('Academy Ruins');

  it('ruins-taps-for-colorless-and-puts-your-graveyard-artifact-on-top', () => {
    const ctx = pod('ruins-mana');
    const ruins = spawn(ctx, 'P1', card);
    const source = manaSourcesFor(ctx, 'P1').find((candidate) => candidate.cardId === ruins.cardId);
    expect(source?.units).toEqual([['C']]);

    const artifact = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Ruins Cog',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
      'graveyard',
    );
    const creature = conjure(ctx, 'P1', bear(), 'graveyard');
    const theirs = conjure(
      ctx,
      'P2',
      oracle({
        name: 'Their Cog',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
      'graveyard',
    );
    const returnAbility = interpretCard(card).activatedAbilities.find(
      (entry) => entry.ability.targets.length > 0,
    )!;
    const slot = returnAbility.ability.targets[0]!;
    const legal = computeTargetOptions(ctx, slot, 'P1');
    expect(legal).toContain(artifact.id);
    expect(legal).not.toContain(creature.id);
    expect(legal).not.toContain(theirs.id);

    addMana(playerOf(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'U' }]);
    expect(activate(ctx, ruins.id)).toBeDefined();

    pump(executeAbility(ctx, ruins, returnAbility.ability, [artifact.id]));
    expect(playerOf(ctx, 'P1').library[0]?.cardId).toBe(artifact.cardId);
    expect(playerOf(ctx, 'P1').graveyard.some((object) => object.cardId === artifact.cardId)).toBe(
      false,
    );

    const empty = pod('ruins-empty');
    const emptyRuins = spawn(empty, 'P1', card);
    addMana(playerOf(empty, 'P1'), [{ symbol: 'C' }, { symbol: 'U' }]);
    expect(activate(empty, emptyRuins.id)).toBeUndefined();
  });
});

describe('Pia and Kiran Nalaar', () => {
  const card = pinned('Pia and Kiran Nalaar');

  it('pia-kiran-etb-makes-two-thopters-and-sacing-an-artifact-deals-two', () => {
    const ctx = pod('pia-kiran-etb');
    const pair = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, pair, interpretCard(card).triggers[0]!, []));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Thopter')).toHaveLength(
      2,
    );

    const damage = interpretCard(card).activatedAbilities[0]!;
    const before = playerOf(ctx, 'P2').life;
    pump(executeAbility(ctx, pair, damage.ability, ['P2']));
    expect(playerOf(ctx, 'P2').life).toBe(before - 2);

    addMana(playerOf(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'R' }]);
    expect(activate(ctx, pair.id)).toBeDefined();

    const none = pod('pia-kiran-no-artifact');
    const lonely = spawn(none, 'P1', card);
    addMana(playerOf(none, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'R' }]);
    expect(activate(none, lonely.id)).toBeUndefined();
  });
});

describe('Sai, Master Thopterist', () => {
  const card = pinned('Sai, Master Thopterist');

  it('sai-makes-a-thopter-when-you-cast-an-artifact-not-a-creature', () => {
    const ctx = pod('sai-cast');
    spawn(ctx, 'P1', card);
    const artifact = oracle({
      name: 'Sai Cog',
      typeLine: 'Artifact',
      manaCost: '{1}',
      oracleText: '',
    });
    ctx.defs.set(artifact.oracleId, interpretCard(artifact));
    const stackObject: EngineStackObject = {
      id: 'sai-spell',
      sourceId: 'sai-spell',
      controllerId: 'P1',
      kind: 'spell',
      description: artifact.name,
      targets: [],
      card: null,
      ability: { kind: 'spell', targets: [], effects: [] },
      sourceOracleId: artifact.oracleId,
      sourceCardId: 'sai-cog-card',
      isCommanderCast: false,
    };
    queueCastTriggers(ctx, stackObject);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Thopter')).toBe(true);

    ctx.state.pendingTriggers = [];
    const creature = oracle({ name: 'Sai Bear', typeLine: 'Creature — Bear', manaCost: '{G}' });
    ctx.defs.set(creature.oracleId, interpretCard(creature));
    stackObject.sourceOracleId = creature.oracleId;
    stackObject.description = creature.name;
    queueCastTriggers(ctx, stackObject);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Thopter Spy Network', () => {
  const card = pinned('Thopter Spy Network');

  it('network-makes-a-thopter-on-upkeep-only-if-you-control-an-artifact', () => {
    const missing = pod('network-missing');
    spawn(missing, 'P1', card);
    queueStepTriggers(missing, 'upkeep');
    expect(missing.state.pendingTriggers).toHaveLength(0);

    const ctx = pod('network-upkeep');
    spawn(ctx, 'P1', card);
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Network Cog',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
    );
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers.length).toBeGreaterThan(0);
    pump(executeAbility(ctx, sourceOf(card), ctx.state.pendingTriggers[0]!.ability, []));
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Thopter')).toBe(true);
  });
});

describe('Whirler Rogue', () => {
  const card = pinned('Whirler Rogue');

  it('rogue-etb-makes-two-thopters-and-tapping-two-artifacts-unblockable', () => {
    const ctx = pod('rogue-etb');
    const rogue = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, rogue, interpretCard(card).triggers[0]!, []));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Thopter')).toHaveLength(
      2,
    );

    const tapAbility = interpretCard(card).activatedAbilities[0]!;
    pump(executeAbility(ctx, rogue, tapAbility.ability, [rogue.id]));
    expect(ctx.state.effects).toContainEqual(
      expect.objectContaining({ kind: 'cantBeBlocked', targetCardIds: [rogue.cardId] }),
    );
    expect(activate(ctx, rogue.id)).toBeDefined();

    const none = pod('rogue-no-artifacts');
    const lonely = spawn(none, 'P1', card);
    expect(activate(none, lonely.id)).toBeUndefined();
  });
});
