import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { playerById, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const pinned = fixture.cards.find((entry) => entry.card.name === "New Generation's Technique");
if (pinned === undefined) throw new Error("Missing New Generation's Technique pin");
const technique = pinned.card;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (const player of ctx.state.players) player.hand = [];
  return ctx;
}

const p = (ctx: GameContext, id: string) => playerById(ctx, id);
const actionFor = (ctx: GameContext, playerId: string, objectId: string) =>
  computePriorityOptions(ctx, p(ctx, playerId)).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      option.type === 'castSpell' && payload.kind === 'castSpell' && payload.objectId === objectId
    );
  });

function attackingCreature(
  ctx: GameContext,
  name: string,
  controllerId = 'P1',
  blockedBy: string[] = [],
): EnginePermanent {
  const creature = spawn(ctx, controllerId, oracle({ name, typeLine: 'Creature — Test' }));
  creature.attacking = 'P2';
  creature.blockedByOrdered = [...blockedBy] as EnginePermanent['blockedByOrdered'];
  return creature;
}

function sneakAction(options: ReturnType<typeof actionFor>) {
  return options.find(
    (option) =>
      (option.payload as PriorityActionPayload & { alternativeCast?: string }).alternativeCast ===
      'nonMana',
  );
}

describe("New Generation's Technique Sneak cast", () => {
  it('pr09-sneak-pinned-normal-search — pins the printed card and preserves its normal paid sorcery effect', () => {
    expect(createHash('sha256').update(JSON.stringify(technique)).digest('hex')).toBe(
      pinned.sha256,
    );
    expect(technique.manaCost).toBe('{3}{G}');
    expect(technique.oracleText).toContain('Sneak {2}{G}');
    const def = interpretCard(technique);
    expect(def.modeled).toBe(true);
    expect(def.alternativeCasts?.some((alt) => alt.kind === 'nonMana')).toBe(true);

    const ctx = pod('pr09-sneak-normal');
    const spell = conjure(ctx, 'P1', technique, 'hand');
    const lands = [
      oracle({ name: 'Basic Forest A', typeLine: 'Basic Land — Forest', manaCost: null, cmc: 0 }),
      oracle({ name: 'Basic Island A', typeLine: 'Basic Land — Island', manaCost: null, cmc: 0 }),
      oracle({ name: 'Temple', typeLine: 'Land — Forest', manaCost: null, cmc: 0 }),
    ].map((card) => spawn(ctx, 'P1', card));
    p(ctx, 'P1').library = [];
    const basics = [
      { name: 'Search Forest', typeLine: 'Basic Land — Forest' },
      { name: 'Search Mountain', typeLine: 'Basic Land — Mountain' },
      { name: 'Search Swamp', typeLine: 'Basic Land — Swamp' },
    ].map(({ name, typeLine }) => oracle({ name, typeLine, manaCost: null, cmc: 0 }));
    p(ctx, 'P1').library = basics.map((card) => conjure(ctx, 'P1', card, 'library'));
    addMana(p(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    const normal = actionFor(ctx, 'P1', spell.id).find(
      (option) =>
        (option.payload as PriorityActionPayload & { alternativeCast?: string }).alternativeCast ===
        undefined,
    );
    expect(normal).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), normal!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    const shuffledBefore = ctx.state.eventLog.filter((event) => event.type === 'shuffle').length;
    pump(resolveTopOfStack(ctx));
    expect(p(ctx, 'P1').library).toHaveLength(1);
    expect(p(ctx, 'P1').library[0]?.name).toMatch(/^Search /);
    const battlefieldBasics = ctx.state.battlefield.filter((permanent) =>
      permanent.name.startsWith('Search '),
    );
    expect(battlefieldBasics).toHaveLength(2);
    expect(battlefieldBasics.every((permanent) => permanent.tapped)).toBe(true);
    expect(ctx.state.eventLog.filter((event) => event.type === 'shuffle')).toHaveLength(
      shuffledBefore + 1,
    );
    expect(
      lands.every((land) => ctx.state.battlefield.some((permanent) => permanent.id === land.id)),
    ).toBe(true);
  });

  it('pr09-sneak-blockers-step-return — pays {2}{G}, returns an unblocked attacker to its owner before the spell is stacked', () => {
    const ctx = pod('pr09-sneak-return');
    ctx.state.step = 'declareBlockers';
    const attacker = attackingCreature(ctx, 'Stolen Bear', 'P1');
    const otherAttacker = attackingCreature(ctx, 'Other Bear', 'P1');
    attacker.ownerId = 'P2';
    const spell = conjure(ctx, 'P1', technique, 'hand');
    addMana(p(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    const option = sneakAction(actionFor(ctx, 'P1', spell.id));
    expect(option).toBeDefined();
    const decisions = pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      (decision) => {
        const choice = decision.options.findIndex(
          (candidate) => candidate.description === 'Return to hand Stolen Bear',
        );
        if (choice < 0) throw new Error('Sneak offered no choice for the unblocked attacker');
        return { index: choice, targets: new Map() };
      },
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.id === attacker.id)).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === otherAttacker.id)).toBe(true);
    expect(p(ctx, 'P2').hand.some((card) => card.cardId === attacker.cardId)).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    expect(p(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(decisions.decisions.some((decision) => decision.decisionType === 'general')).toBe(true);
  });

  it('pr09-sneak-main-still-normal — leaves the printed mana-cost cast available during main phase', () => {
    const ctx = pod('pr09-sneak-normal-offer');
    const spell = conjure(ctx, 'P1', technique, 'hand');
    addMana(p(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    const offered = actionFor(ctx, 'P1', spell.id);
    expect(
      offered.some(
        (option) =>
          (option.payload as PriorityActionPayload & { alternativeCast?: string })
            .alternativeCast === undefined,
      ),
    ).toBe(true);
    expect(
      offered.some(
        (option) =>
          (option.payload as PriorityActionPayload & { alternativeCast?: string })
            .alternativeCast === 'nonMana',
      ),
    ).toBe(false);
  });

  it('pr09-sneak-availability-boundaries — requires this player, this step, a current unblocked attacker, and a creature', () => {
    const scenarios: ((ctx: GameContext, creature: EnginePermanent) => void)[] = [
      (ctx) => {
        ctx.state.currentTurnPlayer = 'P2';
      },
      (ctx) => {
        ctx.state.step = 'declareAttackers';
      },
      (_ctx, creature) => {
        creature.attacking = null;
      },
      (_ctx, creature) => {
        creature.blockedByOrdered = ['left-combat-blocker' as EnginePermanent['id']];
      },
      (_ctx, creature) => {
        creature.controllerId = 'P2';
      },
    ];
    for (const [index, alter] of scenarios.entries()) {
      const ctx = pod(`pr09-sneak-boundary-${index}`);
      ctx.state.step = 'declareBlockers';
      const creature = attackingCreature(ctx, `Boundary Bear ${index}`);
      alter(ctx, creature);
      const spell = conjure(ctx, 'P1', technique, 'hand');
      addMana(p(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
      expect(sneakAction(actionFor(ctx, 'P1', spell.id))).toBeUndefined();
    }
    const noncreatureCtx = pod('pr09-sneak-boundary-noncreature');
    noncreatureCtx.state.step = 'declareBlockers';
    const artifactAttacker = spawn(
      noncreatureCtx,
      'P1',
      oracle({ name: 'Animated Statue', typeLine: 'Artifact' }),
    );
    artifactAttacker.attacking = 'P2';
    const noncreatureSpell = conjure(noncreatureCtx, 'P1', technique, 'hand');
    addMana(p(noncreatureCtx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(sneakAction(actionFor(noncreatureCtx, 'P1', noncreatureSpell.id))).toBeUndefined();
  });

  it('pr09-sneak-missing-green — requires both the generic and green parts of {2}{G}', () => {
    for (const [index, mana] of [
      [{ symbol: 'C' as const }, { symbol: 'C' as const }, { symbol: 'C' as const }],
      [{ symbol: 'G' as const }, { symbol: 'C' as const }],
    ].entries()) {
      const ctx = pod(`pr09-sneak-missing-${index}`);
      ctx.state.step = 'declareBlockers';
      attackingCreature(ctx, `Mana Bear ${index}`);
      const spell = conjure(ctx, 'P1', technique, 'hand');
      addMana(p(ctx, 'P1'), mana);
      expect(sneakAction(actionFor(ctx, 'P1', spell.id))).toBeUndefined();
    }
  });

  it('pr09-sneak-vanished-attacker — rechecks the chosen permanent before payment completes', () => {
    const ctx = pod('pr09-sneak-vanished');
    ctx.state.step = 'declareBlockers';
    const attacker = attackingCreature(ctx, 'Vanishing Bear');
    const spell = conjure(ctx, 'P1', technique, 'hand');
    addMana(p(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    const option = sneakAction(actionFor(ctx, 'P1', spell.id));
    expect(option).toBeDefined();
    const generator = applyPriorityAction(
      ctx,
      p(ctx, 'P1'),
      option!.payload as PriorityActionPayload,
      {
        index: 0,
        targets: new Map(),
      },
    );
    const first = generator.next();
    expect(first.done).toBe(false);
    pump(moveObject(ctx, attacker, { zone: 'graveyard' }));
    expect(() => generator.next({ index: 0, targets: new Map() })).toThrow();
    expect(ctx.state.stack).toHaveLength(0);
  });
});
