import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { AbilityCost, TargetSpec } from '../src/cards/ability';
import type { CardDefinition } from '../src/cards/definition';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { interpretCard } from '../src/cards/interpret';
import { parseManaCost } from '../src/mana/cost';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { card: ReturnType<typeof oracle> }[];
}
const killian = ['fixtures/marchesa-batch1-oracle.json', 'fixtures/coverage-pr02-oracle.json']
  .flatMap(
    (file) =>
      (JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')) as PinnedFixture).cards,
  )
  .find((entry) => entry.card.name === 'Killian, Ink Duelist')?.card;
if (killian === undefined)
  throw new Error('missing pinned Oracle fixture for Killian, Ink Duelist');
const killianCard = killian;
const targetCreature = () => oracle({ name: 'Target Creature', typeLine: 'Creature — Bear' });
const targetRelic = () => oracle({ name: 'Target Relic', typeLine: 'Artifact' });

function setup(seed: string, manaSymbols: ('C' | 'R')[] = []) {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 2;
  ctx.state.phase = 'precombatMain';
  spawn(ctx, 'P1', killianCard);
  const player = playerById(ctx, 'P1');
  addMana(
    player,
    manaSymbols.map((symbol) => ({ symbol })),
  );
  return { ctx, player };
}

function makeSpell(
  ctx: GameContext,
  name: string,
  targets: TargetSpec[],
  changes: Partial<CardDefinition> = {},
  manaCost = '{3}',
) {
  const card = oracle({
    name,
    typeLine: 'Instant',
    manaCost,
    oracleText: 'You gain 1 life.',
    power: null,
    toughness: null,
  });
  const object = conjure(ctx, 'P1', card, 'hand');
  const def = interpretCard(card);
  ctx.defs.set(card.oracleId, {
    ...def,
    spellAbility: { ...def.spellAbility!, targets },
    ...changes,
  });
  return object;
}

function castOptions(ctx: GameContext, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}
function payload(option: { payload?: unknown }) {
  return option.payload as PriorityActionPayload & {
    targetReductionSlot?: number;
    targetReductionAmount?: number;
    alternativeCast?:
      'nonMana' | 'adventure' | 'omen' | 'overload' | 'energy' | 'commanderFree' | 'faceDown';
  };
}
function take(
  ctx: GameContext,
  option: { payload?: unknown },
  targets: ReadonlyMap<number, string> = new Map(),
  answer?: (decision: PendingDecision) => DecisionOutcome,
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), payload(option), {
      index: 0,
      targets,
    }),
    answer,
  );
}
const countedPermanent = (
  min: number,
  max: number,
  controller: 'opponent' | 'you' = 'opponent',
): TargetSpec => ({
  kind: 'permanent',
  controller,
  count: { min, max },
});
const mandatoryPermanent = (controller: 'opponent' | 'you' = 'opponent'): TargetSpec => ({
  kind: 'permanent',
  controller,
});

describe('Killian counted-target price follow-ups', () => {
  it('charges full price when a counted target slot is left at zero', () => {
    const { ctx, player } = setup('killian-count-zero', ['C', 'C', 'C']);
    const relic = spawn(ctx, 'P2', targetRelic());
    const spell = makeSpell(ctx, 'Count Zero Probe', [countedPermanent(0, 1)]);
    const full = castOptions(ctx, spell.id).find(
      (option) => payload(option).targetReductionSlot === -1,
    );
    expect(full?.description).toMatch(/\{3\}/);
    take(ctx, full!, new Map(), (decision) => ({
      index: decision.options.findIndex((option: { type: string }) => option.type === 'decline'),
      targets: new Map(),
    }));
    expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual([]);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(3);
    expect(player.manaEntries).toHaveLength(0);
    expect(ctx.state.battlefield.some((perm) => perm.id === relic.id)).toBe(true);
  });

  it('charges full price when the only selected counted target is a noncreature permanent', () => {
    const { ctx, player } = setup('killian-count-noncreature', ['C', 'C', 'C']);
    const relic = spawn(ctx, 'P2', targetRelic());
    const spell = makeSpell(ctx, 'Noncreature Count Probe', [countedPermanent(1, 1)]);
    const full = castOptions(ctx, spell.id);
    expect(full.map((option) => payload(option).targetReductionSlot)).toEqual([-1]);
    expect(full[0]?.description).toMatch(/\{3\}/);
    take(ctx, full[0]!);
    expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual([relic.id]);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(3);
    expect(player.manaEntries).toHaveLength(0);
  });

  it('offers and charges the reduced price when a counted slot chooses one creature', () => {
    const { ctx, player } = setup('killian-count-creature', ['C']);
    const bear = spawn(ctx, 'P2', targetCreature());
    const spell = makeSpell(ctx, 'Creature Count Probe', [countedPermanent(1, 1)]);
    const options = castOptions(ctx, spell.id);
    expect(options.map((option) => payload(option).targetReductionSlot)).toEqual([0]);
    expect(options[0]?.description).toMatch(/\{1\}.*reduced for target slot/);
    expect(payload(options[0]!).targetReductionAmount).toBe(2);
    take(ctx, options[0]!);
    expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual([bear.id]);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(1);
    expect(player.manaEntries).toHaveLength(0);
  });

  it('emits distinct reduced options for multiple counted slots and the mixed mandatory/count case', () => {
    const { ctx, player } = setup('killian-count-slots', ['C']);
    const beast = spawn(ctx, 'P2', targetCreature());
    const spell = makeSpell(ctx, 'Two Count Slots Probe', [
      countedPermanent(1, 1),
      countedPermanent(1, 1),
    ]);
    const options = castOptions(ctx, spell.id);
    expect(options.map((option) => payload(option).targetReductionSlot)).toEqual([0, 1]);
    expect(new Set(options.map((option) => option.description)).size).toBe(2);
    expect(options.map((option) => payload(option).targetReductionAmount)).toEqual([2, 2]);

    const mixed = makeSpell(ctx, 'Mandatory And Count Probe', [
      mandatoryPermanent(),
      countedPermanent(0, 1),
    ]);
    const relic = spawn(ctx, 'P2', targetRelic());
    const creatureChoice = castOptions(ctx, mixed.id).find(
      (option) => payload(option).targetReductionSlot === 1,
    );
    expect(creatureChoice).toBeDefined();
    expect(creatureChoice?.description).toMatch(/reduced for target slot/);
    take(ctx, creatureChoice!, new Map([[0, relic.id]]), (decision) => {
      const beastOption = decision.options.findIndex((option: { description: string }) =>
        option.description.includes('Target Creature'),
      );
      return { index: beastOption >= 0 ? beastOption : 0, targets: new Map() };
    });
    expect(ctx.state.stack[0]?.targets).toEqual([relic.id]);
    expect(ctx.state.stack[0]?.countTargets?.[1]).toEqual([beast.id]);
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(1);
    expect(player.manaEntries).toHaveLength(0);
  });

  it('keeps only the reduced option when only reduced mana is available', () => {
    const { ctx } = setup('killian-count-reduced-only', ['R']);
    const bear = spawn(ctx, 'P2', targetCreature());
    const spell = makeSpell(
      ctx,
      'Reduced Only Probe',
      [{ kind: 'creature', controller: 'opponent' }],
      {},
      '{2}{R}',
    );
    const options = castOptions(ctx, spell.id);
    expect(options).toHaveLength(1);
    expect(payload(options[0]!).targetReductionSlot).toBe(0);
    expect(options[0]?.description).toMatch(/\(\{R\}\).*reduced for target slot/);
    take(ctx, options[0]!, new Map([[0, bear.id]]));
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(1);
  });

  it('reduces the mana component of a nonmana alternative including its mandatory additional mana', () => {
    const { ctx } = setup('killian-alternative-additional-mana', ['C', 'C']);
    const bear = spawn(ctx, 'P2', targetCreature());
    const spell = makeSpell(
      ctx,
      'Alternative Additional Mana Probe',
      [{ kind: 'creature', controller: 'opponent' }],
      {
        spellAdditionalCosts: [{ kind: 'mana', cost: parseManaCost('{1}').cost! } as AbilityCost],
        alternativeCasts: [
          {
            kind: 'nonMana',
            description: 'Test alternative',
            manaCost: parseManaCost('{3}').cost!,
          },
        ],
      },
      '{99}',
    );
    const options = castOptions(ctx, spell.id);
    expect(options).toHaveLength(1);
    expect(payload(options[0]!).alternativeCast).toBe('nonMana');
    expect(payload(options[0]!).targetReductionSlot).toBe(0);
    expect(payload(options[0]!).targetReductionAmount).toBe(2);
    expect(options[0]?.description).toContain('{2}');
    expect(options[0]?.data?.['manaCost']).toBe('{2}');
    take(ctx, options[0]!, new Map([[0, bear.id]]));
    expect(ctx.state.stack[0]?.triggerScope?.manaSpent).toBe(2);
  });
});
