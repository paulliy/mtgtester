import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { bear, copies, conjure, forest, gameConfig, oracle, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

interface AuditLedger {
  batches: {
    cards: {
      oracleId: string;
      name: string;
      implementationStatus: string;
    }[];
  }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/catalog-reviewed-oracle.json'), 'utf8'),
) as PinnedFixture;
const ledger = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../docs/plans/card-catalog-audit.json'), 'utf8'),
) as AuditLedger;

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

function uniqueReviewedIds(): Map<string, string> {
  const unique = new Map<string, { name: string; status: string }>();
  for (const batch of ledger.batches) {
    for (const card of batch.cards) {
      const prev = unique.get(card.oracleId);
      if (prev === undefined) {
        unique.set(card.oracleId, { name: card.name, status: card.implementationStatus });
        continue;
      }
      if (card.implementationStatus === 'unsupported') {
        unique.set(card.oracleId, { name: card.name, status: card.implementationStatus });
      } else if (prev.status !== 'unsupported') {
        unique.set(card.oracleId, { name: card.name, status: card.implementationStatus });
      }
    }
  }
  return new Map(
    [...unique.entries()]
      .filter(([, card]) => card.status === 'implemented-reviewed')
      .map(([id, card]) => [id, card.name]),
  );
}

function hasExecutableBehavior(def: CardDefinition): boolean {
  return (
    def.spellAbility !== null ||
    def.triggers.length > 0 ||
    def.activatedAbilities.length > 0 ||
    def.manaAbilities.length > 0 ||
    def.staticEffects.length > 0 ||
    def.ruleStatics.length > 0 ||
    def.keywords.length > 0 ||
    def.ward !== undefined ||
    def.protectionFrom !== undefined ||
    def.entersTapped ||
    def.entersTappedUnless !== undefined ||
    def.entersWithCounters !== undefined ||
    def.additionalCountersOnEntry !== undefined ||
    (def.alternativeCasts?.length ?? 0) > 0 ||
    def.commanderFreeCast === true ||
    def.entersAsCopy !== undefined ||
    def.types.includes('Land')
  );
}

function fund(ctx: GameContext, playerId: string): void {
  const player = playerById(ctx, playerId);
  addMana(
    player,
    Array.from({ length: 20 }, () => [
      { symbol: 'W' as const },
      { symbol: 'U' as const },
      { symbol: 'B' as const },
      { symbol: 'R' as const },
      { symbol: 'G' as const },
      { symbol: 'C' as const },
    ]).flat(),
  );
  player.energy = 50;
  player.life = 40;
}

function seedTargets(ctx: GameContext): void {
  const relic = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Relic',
      typeLine: 'Artifact',
      manaCost: '{1}',
      power: null,
      toughness: null,
    });
  const legend = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Legend',
      typeLine: 'Legendary Creature — Human',
      manaCost: '{2}{W}',
      power: '2',
      toughness: '2',
    });
  for (const player of ctx.state.players) {
    spawn(ctx, player.id, bear());
    spawn(ctx, player.id, relic());
    spawn(
      ctx,
      player.id,
      oracle({
        name: 'Test Cog',
        typeLine: 'Artifact Creature — Construct',
        manaCost: '{2}',
        power: '1',
        toughness: '1',
      }),
    );
    spawn(ctx, player.id, legend());
    spawn(
      ctx,
      player.id,
      oracle({
        name: 'Test Hex',
        typeLine: 'Enchantment',
        manaCost: '{1}{W}',
        power: null,
        toughness: null,
      }),
    );
    spawn(ctx, player.id, forest());
  }
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
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

function optionsFor(ctx: GameContext, playerId: string, name: string): string[] {
  return computePriorityOptions(ctx, playerById(ctx, playerId))
    .filter((option) => {
      const data = option.data as { sourceName?: string } | undefined;
      return data?.sourceName === name;
    })
    .map((option) => option.type);
}

describe('catalog reviewed Oracle fixture', () => {
  const reviewed = uniqueReviewedIds();

  it('pins every unique implemented-reviewed catalog ID from coverage-oracle', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-10',
    });
    expect(reviewed.size).toBe(151);
    expect(new Set(fixture.cards.map(({ card }) => card.oracleId))).toEqual(
      new Set(reviewed.keys()),
    );
    for (const entry of fixture.cards) {
      expect(entry.card.oracleId).not.toMatch(/^oracle-/);
      expect(entry.card.oracleText.length, entry.card.name).toBeGreaterThan(0);
      expect(reviewed.get(entry.card.oracleId), entry.card.name).toBe(entry.card.name);
      expect(
        createHash('sha256').update(canonical(entry.card)).digest('hex'),
        entry.card.name,
      ).toBe(entry.sha256);
    }
  });

  it.each(fixture.cards.map(({ card }) => [card.name, card] as const))(
    'models %s for the real ID and fixture alias',
    (_name, card) => {
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        expect(def.modeled, `${card.name} (${candidate.oracleId})`).toBe(true);
        expect(def.unmodeledReasons, card.name).toEqual([]);
        expect(hasExecutableBehavior(def), card.name).toBe(true);
      }
    },
  );
});

describe('catalog reviewed engine paths', () => {
  it.each(fixture.cards.map(({ card }) => [card.name, card] as const))(
    '%s is offered on the normal path and refused from the library',
    (name, card) => {
      const def = interpretCard(card);
      const ctx = pod(`catalog-engine-${card.oracleId}`);
      seedTargets(ctx);
      fund(ctx, 'P1');
      if (def.types.includes('Instant')) {
        const stacked = conjure(
          ctx,
          'P2',
          oracle({
            name: 'Test Lesson',
            typeLine: 'Sorcery',
            manaCost: '{1}{U}',
            power: null,
            toughness: null,
            oracleText: 'Draw a card.',
          }),
          'hand',
        );
        const entry: EngineStackObject = {
          id: stacked.id,
          sourceId: stacked.id,
          controllerId: 'P2',
          kind: 'spell',
          description: stacked.name,
          targets: [],
          card: stacked,
          ability: null,
          sourceOracleId: stacked.oracleId,
          sourceCardId: stacked.cardId,
          isCommanderCast: false,
        };
        ctx.state.stack.push(entry);
      }

      const isSpell = def.types.includes('Instant') || def.types.includes('Sorcery');
      const isLand = def.types.includes('Land');
      if (isSpell || isLand) {
        const inHand = conjure(ctx, 'P1', card, 'hand');
        const fromHand = optionsFor(ctx, 'P1', name);
        const offered = isLand ? fromHand.includes('playLand') : fromHand.includes('castSpell');
        expect(offered, `${name} from hand: ${fromHand.join(',')}`).toBe(true);

        inHand.zone = 'library';
        playerById(ctx, 'P1').hand = playerById(ctx, 'P1').hand.filter(
          (candidate) => candidate.id !== inHand.id,
        );
        playerById(ctx, 'P1').library.unshift(inHand);
        const fromLibrary = optionsFor(ctx, 'P1', name);
        expect(
          fromLibrary.includes('castSpell') || fromLibrary.includes('playLand'),
          `${name} from library must not be cast/played`,
        ).toBe(false);
        return;
      }

      const permanent = spawn(ctx, 'P1', card);
      expect(
        ctx.state.battlefield.some((candidate) => candidate.cardId === permanent.cardId),
        `${name} must enter the battlefield`,
      ).toBe(true);

      const yours = optionsFor(ctx, 'P1', name);
      const battlefieldActivations = def.activatedAbilities.filter(
        (ability) => (ability.zone ?? 'battlefield') === 'battlefield',
      );
      if (battlefieldActivations.length > 0) {
        expect(
          yours.includes('activateAbility'),
          `${name} activate from battlefield: ${yours.join(',')}`,
        ).toBe(true);
        expect(
          optionsFor(ctx, 'P2', name).includes('activateAbility'),
          `${name} opponent must not activate your ability`,
        ).toBe(false);
      }

      const fromLibrary = pod(`catalog-engine-library-${card.oracleId}`);
      fund(fromLibrary, 'P1');
      conjure(fromLibrary, 'P1', card, 'library');
      expect(
        optionsFor(fromLibrary, 'P1', name).includes('castSpell'),
        `${name} must not be cast from the library`,
      ).toBe(false);
    },
  );
});
