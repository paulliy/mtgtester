import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { EngineCardObject, GameContext } from '../src/state/types';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const capstonePin = fixture.cards.find(({ card }) => card.name === 'Improvisation Capstone');
if (capstonePin === undefined) throw new Error('Missing PR09 Improvisation Capstone pin');
const CAPSTONE = capstonePin.card;

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

function pass(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex(
    (option) =>
      option.type === 'pass' ||
      (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
  );
  return { index: Math.max(0, index), targets: new Map() };
}

function decline(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex(
    (option) => option.type === 'decline' || option.type === 'stopCasting',
  );
  if (index < 0) throw new Error(`no decline choice in ${decision.prompt}`);
  return { index, targets: new Map() };
}

function settle(ctx: GameContext, answer: (decision: PendingDecision) => DecisionOutcome = pass) {
  return pump(runPrioritySequence(ctx), (decision) =>
    decision.decisionType === 'priority' ? pass(decision) : answer(decision),
  );
}

function normalOption(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, p(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload & { alternativeCast?: string };
    return (
      option.type === 'castSpell' &&
      payload.kind === 'castSpell' &&
      payload.objectId === objectId &&
      payload.alternativeCast === undefined
    );
  });
}

function castCapstone(
  ctx: GameContext,
  answer: (decision: PendingDecision) => DecisionOutcome = decline,
) {
  const card = conjure(ctx, 'P1', CAPSTONE, 'hand');
  addMana(
    p(ctx, 'P1'),
    (['R', 'R', 'C', 'C', 'C', 'C', 'C'] as const).map((symbol) => ({ symbol })),
  );
  const option = normalOption(ctx, 'P1', card.id);
  expect(option, 'Capstone is offered through its ordinary paid cast action').toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  settle(ctx, answer);
  return card;
}

function simpleSpell(name: string, manaCost: string, cmc: number, oracleText = 'You gain 1 life.') {
  return oracle({ name, manaCost, cmc, typeLine: 'Sorcery', oracleText });
}

function library(ctx: GameContext, cards: OracleCard[]): EngineCardObject[] {
  const objects = cards.map((card) => conjure(ctx, 'P1', card, 'library'));
  p(ctx, 'P1').library = objects;
  return [...objects];
}

function fireMain(
  ctx: GameContext,
  playerId: string,
  phase: 'precombatMain' | 'postcombatMain',
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
) {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
  ctx.state.phase = phase;
  queueStepTriggers(ctx, phase === 'precombatMain' ? 'precombatMain' : 'secondMainPhase');
  return settle(ctx, answer);
}

function paradigmCopy(ctx: GameContext): EngineCardObject | undefined {
  return ctx.state.exile.find((card) => card.isCardCopy === true);
}

describe('PR09 Improvisation Capstone and Paradigm', () => {
  it('pr09-paradigm-pinned-real-and-definition-alias — checks the exact fixture and both production definition IDs', () => {
    expect(createHash('sha256').update(JSON.stringify(CAPSTONE)).digest('hex')).toBe(
      capstonePin.sha256,
    );
    expect(CAPSTONE.oracleId).toBe('fd4f0315-567a-4cc5-bc7e-88a9d2cee910');
    expect(interpretCard(CAPSTONE).modeled).toBe(true);
    const alias = oracle({ ...CAPSTONE, oracleId: 'oracle-improvisation-capstone' });
    expect(interpretCard(alias).modeled).toBe(true);
    expect(interpretCard(alias).spellAbility?.effects).toEqual([
      { op: 'capstoneParadigm', minimumManaValue: 4 },
    ]);
  });

  it('pr09-paradigm-normal-paid-cast-and-stack-timing — requires seven mana and uses the ordinary sorcery stack', () => {
    const ctx = pod('pr09-paradigm-paid');
    const card = conjure(ctx, 'P1', CAPSTONE, 'hand');
    addMana(
      p(ctx, 'P1'),
      (['R', 'R', 'C', 'C', 'C', 'C'] as const).map((symbol) => ({ symbol })),
    );
    expect(normalOption(ctx, 'P1', card.id)).toBeUndefined();
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }]);
    const option = normalOption(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(p(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(ctx.state.exile.some((item) => item.id === card.id)).toBe(false);
    settle(ctx, decline);
    expect(ctx.state.exile.some((item) => item.cardId === card.cardId)).toBe(true);
  });

  it('pr09-paradigm-reveals-through-land-to-total-mana-value-four — counts a land as zero and stops at the threshold card', () => {
    const ctx = pod('pr09-paradigm-reveal-threshold');
    const land = oracle({
      name: 'Capstone Reveal Land',
      typeLine: 'Land — Mountain',
      manaCost: null,
      cmc: 0,
    });
    const low = simpleSpell('Capstone Two', '{2}', 2);
    const reaches = simpleSpell('Capstone Two More', '{2}', 2);
    const stays = simpleSpell('Beyond Capstone Reveal', '{8}', 8);
    const revealed = library(ctx, [land, low, reaches, stays]);
    const capstone = castCapstone(ctx);
    expect(ctx.state.exile.map((card) => card.cardId).sort()).toEqual(
      [...revealed.slice(0, 3).map((card) => card.cardId), capstone.cardId].sort(),
    );
    expect(p(ctx, 'P1').library.map((card) => card.cardId)).toEqual([revealed[3]!.cardId]);
  });

  it('pr09-paradigm-can-cast-any-number-in-any-order-and-decline-the-rest — choices use only the cards exiled by the effect', () => {
    const ctx = pod('pr09-paradigm-any-number');
    const first = simpleSpell('First Capstone Spell', '{2}', 2);
    const second = simpleSpell('Second Capstone Spell', '{2}', 2);
    const unrelated = simpleSpell('Unrelated Exile Spell', '{1}', 1);
    const spare = oracle({
      name: 'Capstone Draw Buffer',
      typeLine: 'Land — Mountain',
      manaCost: null,
      cmc: 0,
    });
    const revealed = library(ctx, [first, second, spare]);
    const outside = conjure(ctx, 'P1', unrelated, 'exile');
    const castOrder: string[] = [];
    castCapstone(ctx, (decision) => {
      if (decision.decisionType === 'chooseTargets') return { index: 0, targets: new Map() };
      const prompt = decision.options.findIndex((option) =>
        option.description.includes('Second Capstone Spell'),
      );
      if (decision.decisionType === 'general' && prompt >= 0) {
        castOrder.push('Second Capstone Spell');
        return { index: prompt, targets: new Map() };
      }
      if (decision.decisionType === 'general') {
        const next = decision.options.findIndex((option) =>
          option.description.includes('First Capstone Spell'),
        );
        if (next >= 0) {
          castOrder.push('First Capstone Spell');
          return { index: next, targets: new Map() };
        }
      }
      return decline(decision);
    });
    expect(castOrder).toEqual(['Second Capstone Spell', 'First Capstone Spell']);
    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.exile.some((card) => card.id === outside.id)).toBe(true);
    expect(
      revealed.every((card) => !ctx.state.exile.some((current) => current.cardId === card.cardId)),
    ).toBe(true);
    expect(
      p(ctx, 'P1').resolvedSpellNames?.filter((name) => name.includes('Capstone Spell')),
    ).toHaveLength(2);
  });

  it('pr09-paradigm-free-cast-keeps-targets-and-additional-costs — free spells still announce targets and pay printed nonmana costs', () => {
    const ctx = pod('pr09-paradigm-costs-targets');
    const target = spawn(
      ctx,
      'P2',
      oracle({ name: 'Capstone Target', typeLine: 'Creature — Test' }),
    );
    const artifact = spawn(
      ctx,
      'P1',
      oracle({ name: 'Capstone Additional Cost Artifact', typeLine: 'Artifact' }),
    );
    const costsTarget = oracle({
      name: 'Capstone Bolt',
      manaCost: '{4}{R}',
      cmc: 5,
      typeLine: 'Sorcery',
      oracleText:
        'As an additional cost to cast this spell, sacrifice an artifact.\nCapstone Bolt deals 2 damage to any target.',
    });
    library(ctx, [costsTarget]);
    const configure = (decision: PendingDecision): DecisionOutcome => {
      if (decision.decisionType === 'general') {
        const choice = decision.options.findIndex((option) =>
          option.description.includes('Capstone Bolt'),
        );
        if (choice >= 0) return { index: choice, targets: new Map() };
      }
      if (decision.decisionType === 'chooseTargets') {
        const choice = decision.options.findIndex((option) =>
          option.targets?.some((slot) => slot.options.includes(target.id)),
        );
        if (choice >= 0) {
          const option = decision.options[choice]!;
          const slot = (option.targets ?? []).find((candidate) =>
            candidate.options.includes(target.id),
          )!;
          return { index: choice, targets: new Map([[slot.slot, target.id]]) };
        }
        return { index: 0, targets: new Map() };
      }
      const optionIndex = decision.options.findIndex((option) =>
        option.targets?.some((slot) => slot.options.includes(target.id)),
      );
      if (optionIndex >= 0) {
        const option = decision.options[optionIndex]!;
        const slot = (option.targets ?? []).find((candidate) =>
          candidate.options.includes(target.id),
        )!;
        return { index: optionIndex, targets: new Map([[slot.slot, target.id]]) };
      }
      return decline(decision);
    };
    castCapstone(ctx, configure);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === artifact.id)).toBe(false);
    expect(p(ctx, 'P1').graveyard.some((card) => card.cardId === artifact.cardId)).toBe(true);
    expect(target.damageMarked).toBe(2);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('pr09-paradigm-exiles-original-and-persists-after-source-moves — the resolved card is exiled and the delayed trigger is source-independent', () => {
    const ctx = pod('pr09-paradigm-source-independent');
    const card = castCapstone(ctx);
    expect(ctx.state.exile.some((item) => item.cardId === card.cardId)).toBe(true);
    expect(
      ctx.state.delayedTriggers.filter((trigger) => trigger.when === 'precombatMain'),
    ).toHaveLength(1);
    const exiled = ctx.state.exile.find((item) => item.cardId === card.cardId)!;
    pump(moveObject(ctx, exiled, { zone: 'graveyard' }));
    fireMain(ctx, 'P1', 'precombatMain', decline);
    expect(ctx.state.eventLog.some((event) => event.type === 'cardCopied')).toBe(true);
    expect(
      ctx.state.exile.some((item) => item.name === CAPSTONE.name && item.isCardCopy === true),
    ).toBe(false);
  });

  it('pr09-paradigm-only-your-precombat-main — does not trigger in an opponent main or your postcombat main', () => {
    const ctx = pod('pr09-paradigm-timing');
    castCapstone(ctx);
    fireMain(ctx, 'P2', 'precombatMain');
    fireMain(ctx, 'P1', 'postcombatMain');
    expect(paradigmCopy(ctx)).toBeUndefined();
    fireMain(ctx, 'P1', 'precombatMain', decline);
    expect(paradigmCopy(ctx)).toBeUndefined();
  });

  it('pr09-paradigm-creates-copy-in-exile-and-may-cast-it-through-stack — free copy casts resolve normally and do not create another Paradigm trigger', () => {
    const ctx = pod('pr09-paradigm-copy-cast');
    castCapstone(ctx);
    const before = ctx.state.delayedTriggers.length;
    const cast = (decision: PendingDecision): DecisionOutcome => {
      if (decision.decisionType === 'chooseTargets') return { index: 0, targets: new Map() };
      const free = decision.options.findIndex((option) => option.type === 'castFree');
      return free >= 0 ? { index: free, targets: new Map() } : pass(decision);
    };
    fireMain(ctx, 'P1', 'precombatMain', cast);
    expect(ctx.state.delayedTriggers).toHaveLength(before);
    expect(ctx.state.exile.some((card) => card.isCardCopy === true)).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'cardCopied')).toBe(true);
    expect(p(ctx, 'P1').resolvedSpellNames?.filter((name) => name === CAPSTONE.name)).toHaveLength(
      2,
    );
  });

  it('pr09-paradigm-declined-copy-ceases-at-sba — a declined spell copy does not enter another zone', () => {
    const ctx = pod('pr09-paradigm-copy-decline');
    castCapstone(ctx);
    fireMain(ctx, 'P1', 'precombatMain', decline);
    expect(ctx.state.exile.some((card) => card.isCardCopy === true)).toBe(false);
    expect(
      p(ctx, 'P1').graveyard.some(
        (card) => card.name === CAPSTONE.name && card.cardId.startsWith('card-copy-'),
      ),
    ).toBe(false);
    fireMain(ctx, 'P1', 'precombatMain', decline);
    expect(ctx.state.eventLog.filter((event) => event.type === 'cardCopied')).toHaveLength(2);
  });

  it('pr09-paradigm-first-resolved-name-is-per-controller — a second same-named resolution does not create a second delayed trigger', () => {
    const ctx = pod('pr09-paradigm-once-per-player');
    castCapstone(ctx);
    expect(
      ctx.state.delayedTriggers.filter((trigger) => trigger.when === 'precombatMain'),
    ).toHaveLength(1);
    const second = conjure(ctx, 'P1', CAPSTONE, 'hand');
    addMana(
      p(ctx, 'P1'),
      (['R', 'R', 'C', 'C', 'C', 'C', 'C'] as const).map((symbol) => ({ symbol })),
    );
    const option = normalOption(ctx, 'P1', second.id);
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx, decline);
    expect(
      ctx.state.delayedTriggers.filter((trigger) => trigger.when === 'precombatMain'),
    ).toHaveLength(1);
  });

  it('pr09-paradigm-unresolved-spell-does-not-record-a-resolved-name — a card moved before resolving does not schedule Paradigm', () => {
    const ctx = pod('pr09-paradigm-unresolved');
    const failed = conjure(ctx, 'P1', CAPSTONE, 'hand');
    addMana(
      p(ctx, 'P1'),
      (['R', 'R', 'C', 'C', 'C', 'C', 'C'] as const).map((symbol) => ({ symbol })),
    );
    const option = normalOption(ctx, 'P1', failed.id);
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    const countered = ctx.state.stack.pop();
    expect(countered?.kind).toBe('spell');
    expect(countered?.card?.zone).toBe('stack');
    if (countered?.card !== null && countered?.card !== undefined)
      pump(moveObject(ctx, countered.card, { zone: 'graveyard' }));
    const definition = interpretCard(CAPSTONE);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    expect(p(ctx, 'P1').resolvedSpellNames ?? []).not.toContain(definition.name);
  });

  it('pr09-paradigm-template-is-frozen-at-first-resolution — later copies retain the captured spell definition', () => {
    const ctx = pod('pr09-paradigm-template');
    castCapstone(ctx);
    const trigger = ctx.state.delayedTriggers.find((entry) => entry.when === 'precombatMain')!;
    const original = ctx.defs.get(CAPSTONE.oracleId)!;
    ctx.defs.set(CAPSTONE.oracleId, { ...original, name: 'Changed After Resolution' });
    fireMain(ctx, 'P1', 'precombatMain', decline);
    expect(ctx.state.eventLog.some((event) => event.type === 'cardCopied')).toBe(true);
    expect(trigger.ability.effects[0]?.op).toBe('castParadigmCopy');
  });
});
