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
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn, swamp } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/necron-main-engine-batch1-oracle.json'), 'utf8'),
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

function servo(): OracleCard {
  return oracle({
    name: 'Servo',
    typeLine: 'Artifact Creature — Servo',
    manaCost: '{1}',
    power: '1',
    toughness: '1',
  });
}

function playFromHand(ctx: GameContext, card: OracleCard) {
  const obj = conjure(ctx, 'P1', card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }));
  return obj;
}

describe('Necron main engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Cryptothrall',
      'Defile',
      'Flayed One',
      'Gilded Lotus',
      'Go for the Throat',
      'Mutilate',
      'Night Scythe',
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

describe('Cryptothrall', () => {
  const card = pinned('Cryptothrall');

  it('cryptothrall-hexproof-other-artifact-creatures-you-control', () => {
    const ctx = pod('crypto-positive');
    spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', servo());
    const flesh = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', servo());
    const self = ctx.state.battlefield.find((permanent) => permanent.name === 'Cryptothrall')!;
    expect(computeCharacteristics(ctx, ally).keywords).toContain('hexproof');
    expect(computeCharacteristics(ctx, flesh).keywords).not.toContain('hexproof');
    expect(computeCharacteristics(ctx, theirs).keywords).not.toContain('hexproof');
    expect(computeCharacteristics(ctx, self).keywords).not.toContain('hexproof');
  });
});

describe('Defile', () => {
  const card = pinned('Defile');

  it('defile-minus-one-per-your-swamp', () => {
    const ctx = pod('defile-swamps');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P2', swamp());
    const victim = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [victim.id]));
    expect(computeCharacteristics(ctx, victim).power).toBe(0);
    expect(computeCharacteristics(ctx, victim).toughness).toBe(0);
  });

  it('defile-zero-swamps-does-not-shrink', () => {
    const ctx = pod('defile-zero');
    const victim = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [victim.id]));
    expect(computeCharacteristics(ctx, victim).power).toBe(2);
    expect(computeCharacteristics(ctx, victim).toughness).toBe(2);
  });
});

describe('Flayed One', () => {
  const card = pinned('Flayed One');

  it('flayed-etb-mills-three-and-has-lifelink', () => {
    const ctx = pod('flayed-mill');
    conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', forest(), 'library');
    const obj = playFromHand(ctx, card);
    pump(runPrioritySequence(ctx));
    const flayed = ctx.state.battlefield.find((permanent) => permanent.cardId === obj.cardId)!;
    expect(computeCharacteristics(ctx, flayed).keywords).toContain('lifelink');
    expect(playerOf(ctx, 'P1').graveyard).toHaveLength(3);
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(0);
  });
});

describe('Gilded Lotus', () => {
  const card = pinned('Gilded Lotus');

  it('lotus-makes-three-linked-mana-of-one-color', () => {
    const ctx = pod('lotus-mana');
    const lotus = spawn(ctx, 'P1', card);
    lotus.summoningSick = false;
    const source = manaSourcesFor(ctx, 'P1').find((entry) => entry.cardId === lotus.cardId);
    expect(source?.linked).toBe(true);
    expect(source?.units).toHaveLength(3);
    expect(source?.units.every((unit) => [...unit].sort().join('') === 'BGRUW')).toBe(true);
  });
});

describe('Go for the Throat', () => {
  const card = pinned('Go for the Throat');

  it('throat-destroys-a-nonartifact-creature', () => {
    const ctx = pod('throat-destroy');
    const victim = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [victim.id]));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
    expect(playerOf(ctx, 'P2').graveyard.some((object) => object.cardId === victim.cardId)).toBe(
      true,
    );
  });

  it('throat-cannot-target-an-artifact-creature', () => {
    const ctx = pod('throat-artifact');
    const machine = spawn(ctx, 'P2', servo());
    const flesh = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(
      ctx,
      { kind: 'creature', filter: { kind: 'not', of: { kind: 'type', value: 'Artifact' } } },
      'P1',
    );
    expect(legal).toContain(flesh.id);
    expect(legal).not.toContain(machine.id);
  });

  it('throat-normal-cast-from-hand', () => {
    const ctx = pod('throat-cast');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', forest());
    const victim = spawn(ctx, 'P2', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const cast = computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerOf(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, victim.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === victim.cardId)).toBe(
      false,
    );
  });
});

describe('Mutilate', () => {
  const card = pinned('Mutilate');

  it('mutilate-shrinks-all-creatures-by-your-swamps', () => {
    const ctx = pod('mutilate-all');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P2', swamp());
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(computeCharacteristics(ctx, yours).power).toBe(0);
    expect(computeCharacteristics(ctx, theirs).power).toBe(0);
  });

  it('mutilate-zero-swamps-does-not-shrink', () => {
    const ctx = pod('mutilate-zero');
    const victim = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, []));
    expect(computeCharacteristics(ctx, victim).power).toBe(2);
  });
});

describe('Night Scythe', () => {
  const card = pinned('Night Scythe');

  it('scythe-etb-makes-a-necron-warrior', () => {
    const ctx = pod('scythe-etb');
    playFromHand(ctx, card);
    pump(runPrioritySequence(ctx));
    const warrior = ctx.state.battlefield.find((permanent) => permanent.name === 'Necron Warrior');
    expect(warrior?.isToken).toBe(true);
    expect(computeCharacteristics(ctx, warrior!).power).toBe(2);
    expect(computeCharacteristics(ctx, warrior!).toughness).toBe(2);
  });

  it('scythe-has-crew-2', () => {
    const def = interpretCard(card);
    expect(def.activatedAbilities.some((ability) => ability.ability.description === 'Crew 2')).toBe(
      true,
    );
  });
});
