import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../../../engine/src/actions/apply';
import {
  computePriorityOptions,
  type PriorityActionPayload,
} from '../../../engine/src/actions/legal';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { executeAbility } from '../../../engine/src/effects/resolve';
import { resolveTopOfStack } from '../../../engine/src/stack/stack';
import { createGame } from '../../../engine/src/state/game';
import type { GameContext } from '../../../engine/src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerDef,
  spawn,
} from '../../../engine/tests/fixtures';
import { loadScryfallBulkOrNull } from './scryfall-bulk-fixture';
import { toOracleCard } from './scryfall';
import { VERIFIED_TOKEN_TRIUMPH_CARDS } from './token-triumph-support';
import type { OracleCard } from '@mtg/shared';

const scryfallCards = loadScryfallBulkOrNull();
// data/scryfall-oracle-cards.json is gitignored and not fetched by CI (see scryfall-bulk-fixture.ts).
const SKIP = scryfallCards === null;

function getOracleCard(name: string): OracleCard {
  const raw = (scryfallCards ?? []).find((c) => c.name === name);
  if (!raw) throw new Error(`Card not found in scryfall data: ${name}`);
  const oracleCard = toOracleCard(raw);
  if (!oracleCard) throw new Error(`Failed to convert scryfall data for: ${name}`);
  return oracleCard;
}

function setupEngineContext(): GameContext {
  const ctx = createGame(
    gameConfig([{ cards: copies(4, forest) }, { cards: copies(4, forest) }], {
      seed: 'l1-l3-test-seed',
    }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe.skipIf(SKIP)('L1: Modeled & Drift Guard Smoke Check', () => {
  for (const cardName of VERIFIED_TOKEN_TRIUMPH_CARDS) {
    it(`${cardName} passes L1 smoke check (modeled: true, unmodeledReasons: [])`, () => {
      const card = getOracleCard(cardName);
      const def = interpretCard(card);
      expect(def.modeled, `Card ${cardName} is not marked as modeled`).toBe(true);
      expect(
        def.unmodeledReasons,
        `Card ${cardName} has unmodeled reasons: ${def.unmodeledReasons.join('; ')}`,
      ).toEqual([]);
    });
  }
});

describe.skipIf(SKIP)('L2: Fixture & Unit Behavioral Tests', () => {
  it('path-engine-optional-search: verifies Path and representative triggered behavior', () => {
    const ctx = setupEngineContext();

    // 1. Emmara, Soul of the Accord triggers
    const emmaraCard = getOracleCard('Emmara, Soul of the Accord');
    const emmara = spawn(ctx, 'P1', emmaraCard);
    const defEmmara = interpretCard(emmaraCard);
    const emmaraTrigger = defEmmara.triggers?.[0];
    expect(emmaraTrigger).toBeDefined();
    if (emmaraTrigger) {
      pump(executeAbility(ctx, emmara, emmaraTrigger, []));
      const soldier = ctx.state.battlefield.find(
        (p) => p.name === 'Soldier' && p.controllerId === 'P1',
      );
      expect(soldier).toBeDefined();
      expect(soldier?.power).toBe(1);
    }

    // 2. Hornet Nest damage trigger
    const nestCard = getOracleCard('Hornet Nest');
    const nest = spawn(ctx, 'P1', nestCard);
    const defNest = interpretCard(nestCard);
    const nestTrigger = defNest.triggers?.[0];
    expect(nestTrigger).toBeDefined();
    if (nestTrigger) {
      pump(executeAbility(ctx, nest, nestTrigger, [], undefined, { damageDealt: 3 }));
      const insects = ctx.state.battlefield.filter(
        (p) => p.name === 'Insect' && p.controllerId === 'P1',
      );
      expect(insects.length).toBe(3);
    }

    // 3. Path to Exile "may search" optional decision (Yes vs No)
    const p2Target = spawn(
      ctx,
      'P2',
      oracle({ name: 'Ogre', typeLine: 'Creature', manaCost: '{2}' }),
    );
    const plainsCard = oracle({
      name: 'Plains',
      typeLine: 'Basic Land — Plains',
      supertypes: ['Basic'],
      types: ['Land'],
    });
    registerDef(ctx, plainsCard);
    conjure(ctx, 'P2', plainsCard, 'library');
    const pathCard = getOracleCard('Path to Exile');
    const pathSpell = spawn(ctx, 'P1', pathCard);
    const defPath = interpretCard(pathCard);
    if (defPath.spellAbility) {
      // Test Yes choice
      pump(executeAbility(ctx, pathSpell, defPath.spellAbility, [p2Target.id]), () => ({
        index: 0,
        targets: new Map(),
      }));
      expect(ctx.state.battlefield.find((p) => p.id === p2Target.id)).toBeUndefined();
      expect(
        ctx.state.battlefield.find((p) => p.name === 'Plains' && p.controllerId === 'P2'),
      ).toBeDefined();
    }

    // 4. Populate multi-token decision
    const token1 = spawn(
      ctx,
      'P1',
      oracle({ name: 'Soldier', typeLine: 'Creature — Soldier', power: '1', toughness: '1' }),
    );
    token1.isToken = true;
    const token2 = spawn(
      ctx,
      'P1',
      oracle({ name: 'Beast', typeLine: 'Creature — Beast', power: '3', toughness: '3' }),
    );
    token2.isToken = true;
    const rootbornCard = getOracleCard('Rootborn Defenses');
    const rootbornSpell = spawn(ctx, 'P1', rootbornCard);
    const defRootborn = interpretCard(rootbornCard);
    if (defRootborn.spellAbility) {
      pump(executeAbility(ctx, rootbornSpell, defRootborn.spellAbility, []), (d) => ({
        index: d.options.findIndex((o) => o.description.includes('Beast')),
        targets: new Map(),
      }));
      const beasts = ctx.state.battlefield.filter(
        (p) => p.name === 'Beast' && p.controllerId === 'P1',
      );
      expect(beasts.length).toBe(2);
    }
  });
});

describe.skipIf(SKIP)('L3: Legality & Priority Engine Tests', () => {
  it('path-engine-normal-cast: executes full engine priority pipeline for Path to Exile', () => {
    const pathCard = getOracleCard('Path to Exile');
    const bearCard = oracle({ name: 'Bear', typeLine: 'Creature', manaCost: '{1}' });
    const plainsCard = oracle({ name: 'Casting Plains', typeLine: 'Basic Land — Plains' });
    const ctx = setupEngineContext();
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const pathObject = conjure(ctx, 'P1', pathCard, 'hand');
    const plains = spawn(ctx, 'P1', plainsCard);
    const target = spawn(ctx, 'P2', bearCard);

    const castOption = computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === pathObject.id;
    });
    expect(castOption).toBeDefined();
    expect(castOption?.targets?.[0]?.options).toContain(target.id);

    pump(
      applyPriorityAction(ctx, player, castOption!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, target.id]]),
      }),
    );
    expect(player.hand.some((card) => card.cardId === pathObject.cardId)).toBe(false);
    expect(plains.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.stack[0]?.sourceCardId).toBe(pathObject.cardId);
    expect(ctx.state.stack[0]?.targets).toEqual([target.id]);

    pump(resolveTopOfStack(ctx), (decision) => {
      const decline = decision.options.findIndex((option) => option.type === 'decline');
      expect(decline).toBeGreaterThanOrEqual(0);
      return { index: decline, targets: new Map() };
    });

    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === target.id)).toBe(false);
    expect(ctx.state.exile.some((card) => card.cardId === target.cardId)).toBe(true);
    expect(player.graveyard.some((card) => card.cardId === pathObject.cardId)).toBe(true);
  });
});
