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
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
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
  readFileSync(join(import.meta.dirname, 'fixtures/queen-engine-batch3-oracle.json'), 'utf8'),
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

function relic(): OracleCard {
  return oracle({
    name: 'Test Relic',
    typeLine: 'Artifact',
    manaCost: '{1}',
    power: null,
    toughness: null,
  });
}

function castOptions(ctx: GameContext, player: EnginePlayerState, objectId: string) {
  return computePriorityOptions(ctx, player).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function castMode(
  ctx: GameContext,
  player: EnginePlayerState,
  objectId: string,
  mode: number,
  targets: Map<number, string>,
): void {
  const option = castOptions(ctx, player, objectId).find((candidate) => {
    const payload = candidate.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
    return payload.modes?.length === 1 && payload.modes[0] === mode;
  });
  expect(option, `mode ${mode}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  pump(resolveTopOfStack(ctx));
}

function playLand(ctx: GameContext, card: OracleCard) {
  const obj = conjure(ctx, 'P1', card, 'hand');
  pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }));
  pump(runPrioritySequence(ctx), () => ({ index: 0, targets: new Map() }));
  return obj;
}

describe('Queen engine-evidence batch 3 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Boros Charm',
      'Rakdos Charm',
      'Boros Garrison',
      'Orzhov Basilica',
      'Rakdos Carnarium',
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

describe('Boros Charm', () => {
  const card = pinned('Boros Charm');

  it('boros-charm-is-choose-one: each mode is a separate legal cast, not both', () => {
    const ctx = pod('boros-modes');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const modes = castOptions(ctx, playerOf(ctx, 'P1'), spell.id).map((option) => {
      const payload = option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return payload.modes;
    });
    expect(modes).toEqual([[0], [1], [2]]);
  });

  it('boros-charm-double-strike-needs-a-creature: mode 2 is illegal with no creature', () => {
    const ctx = pod('boros-no-creature');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const modes = castOptions(ctx, playerOf(ctx, 'P1'), spell.id).map((option) => {
      const payload = option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return payload.modes?.[0];
    });
    expect(modes).toEqual([0, 1]);
  });

  it('boros-charm-damage-player: mode 0 deals 4 to the targeted opponent', () => {
    const ctx = pod('boros-damage');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const life = playerOf(ctx, 'P2').life;
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 0, new Map([[0, 'P2']]));
    expect(playerOf(ctx, 'P2').life).toBe(life - 4);
  });

  it('boros-charm-indestructible-yours-only: mode 1 grants your permanents, not an opponent creature', () => {
    const ctx = pod('boros-indestructible');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    const yours = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 1, new Map());
    expect(computeCharacteristics(ctx, yours).keywords).toContain('indestructible');
    expect(computeCharacteristics(ctx, theirs).keywords).not.toContain('indestructible');
  });

  it('boros-charm-double-strike-on-creature: mode 2 grants double strike to the target', () => {
    const ctx = pod('boros-ds');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', plains());
    const ally = spawn(ctx, 'P1', bear());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const legal = computeTargetOptions(ctx, { kind: 'creature' }, 'P1');
    expect(legal).toContain(ally.id);
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 2, new Map([[1, ally.id]]));
    expect(computeCharacteristics(ctx, ally).keywords).toContain('double strike');
  });
});

describe('Rakdos Charm', () => {
  const card = pinned('Rakdos Charm');

  it('rakdos-charm-exiles-target-graveyard', () => {
    const ctx = pod('rakdos-gy');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', mountain());
    const dead = conjure(ctx, 'P2', bear(), 'graveyard');
    const yours = conjure(ctx, 'P1', bear(), 'graveyard');
    const spell = conjure(ctx, 'P1', card, 'hand');
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 0, new Map([[0, 'P2']]));
    expect(ctx.state.exile.some((object) => object.cardId === dead.cardId)).toBe(true);
    expect(playerOf(ctx, 'P1').graveyard.some((object) => object.cardId === yours.cardId)).toBe(
      true,
    );
  });

  it('rakdos-charm-destroys-artifact-not-creature', () => {
    const ctx = pod('rakdos-artifact');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', mountain());
    const artifact = spawn(ctx, 'P2', relic());
    const creature = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'artifact' }, 'P1');
    expect(legal).toContain(artifact.id);
    expect(legal).not.toContain(creature.id);
    const spell = conjure(ctx, 'P1', card, 'hand');
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 1, new Map([[1, artifact.id]]));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === artifact.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === creature.cardId)).toBe(
      true,
    );
  });

  it('rakdos-charm-each-creature-damages-its-controller', () => {
    const ctx = pod('rakdos-ping');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    const youLife = playerOf(ctx, 'P1').life;
    const oppLife = playerOf(ctx, 'P2').life;
    const spell = conjure(ctx, 'P1', card, 'hand');
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 2, new Map());
    expect(playerOf(ctx, 'P1').life).toBe(youLife - 2);
    expect(playerOf(ctx, 'P2').life).toBe(oppLife - 1);
  });

  it('rakdos-charm-each-creature-is-the-damage-source', () => {
    // The creature deals the damage, not the Charm, so its lifelink and infect apply.
    const ctx = pod('rakdos-source');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', mountain());
    const linker = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Charm Lifelinker',
        typeLine: 'Creature — Bat',
        oracleText: 'Lifelink',
        keywords: ['Lifelink'],
        power: '1',
        toughness: '1',
      }),
    );
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Charm Infector',
        typeLine: 'Creature — Phyrexian',
        oracleText: 'Infect',
        keywords: ['Infect'],
        power: '1',
        toughness: '1',
      }),
    );
    const youLife = playerOf(ctx, 'P1').life;
    const oppLife = playerOf(ctx, 'P2').life;
    const spell = conjure(ctx, 'P1', card, 'hand');
    castMode(ctx, playerOf(ctx, 'P1'), spell.id, 2, new Map());
    expect(playerOf(ctx, 'P1').life).toBe(youLife);
    expect(playerOf(ctx, 'P2').life).toBe(oppLife);
    expect(playerOf(ctx, 'P2').poisonCounters).toBe(1);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'damage' && event.payload['sourceCardId'] === linker.cardId,
      ),
    ).toBe(true);
  });
});

describe('Karoo bounce lands', () => {
  for (const name of ['Boros Garrison', 'Orzhov Basilica', 'Rakdos Carnarium'] as const) {
    describe(name, () => {
      const card = pinned(name);

      it(`${name.toLowerCase().replace(/\s+/g, '-')}-enters-tapped-and-can-bounce-another-land`, () => {
        const ctx = pod(`${name}-bounce`);
        const other = spawn(ctx, 'P1', forest());
        const theirs = spawn(ctx, 'P2', forest());
        const bounceIds: unknown[] = [];
        const obj = conjure(ctx, 'P1', card, 'hand');
        pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }));
        pump(runPrioritySequence(ctx), (decision) => {
          if (!/return/i.test(decision.prompt)) {
            return { index: 0, targets: new Map() };
          }
          bounceIds.push(...decision.options.map((option) => option.payload));
          const bounceOther = decision.options.findIndex((option) => option.payload === other.id);
          return { index: bounceOther >= 0 ? bounceOther : 0, targets: new Map() };
        });
        const land = ctx.state.battlefield.find((permanent) => permanent.cardId === obj.cardId);
        expect(land?.tapped).toBe(true);
        expect(ctx.state.battlefield.some((permanent) => permanent.cardId === other.cardId)).toBe(
          false,
        );
        expect(playerOf(ctx, 'P1').hand.some((object) => object.cardId === other.cardId)).toBe(
          true,
        );
        expect(bounceIds).not.toContain(theirs.id);
      });

      it(`${name.toLowerCase().replace(/\s+/g, '-')}-can-bounce-itself`, () => {
        const ctx = pod(`${name}-self`);
        const obj = playLand(ctx, card);
        expect(ctx.state.battlefield.some((permanent) => permanent.cardId === obj.cardId)).toBe(
          false,
        );
        expect(playerOf(ctx, 'P1').hand.some((object) => object.cardId === obj.cardId)).toBe(true);
      });
    });
  }
});
