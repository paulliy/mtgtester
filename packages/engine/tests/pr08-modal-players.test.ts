import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { computePriorityOptions } from '../src/actions/legal';
import { abilityModeSelections, legalAbilityModeSelections } from '../src/actions/ability-modes';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { computeCharacteristics } from '../src/effects/continuous';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const shadrixPin = pins.find((entry) => entry.card.name === 'Shadrix Silverquill');
const lichPin = pins.find((entry) => entry.card.name === 'Vindictive Lich');
if (shadrixPin === undefined || lichPin === undefined)
  throw new Error('Missing PR08 modal card pin');

function pod(seed: string, seats = 4, turn: PlayerId = 'P1'): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = turn;
  ctx.state.activePlayerIndex = Number(turn.slice(1)) - 1;
  ctx.state.turnNumber = 5;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function addPool(
  ctx: GameContext,
  player: PlayerId,
  black: number,
  white: number,
  colorless: number,
): void {
  const entries: { symbol: 'B' | 'W' | 'C' }[] = [
    ...Array.from({ length: black }, () => ({ symbol: 'B' as const })),
    ...Array.from({ length: white }, () => ({ symbol: 'W' as const })),
    ...Array.from({ length: colorless }, () => ({ symbol: 'C' as const })),
  ];
  addMana(playerById(ctx, player), entries);
}

function castOption(ctx: GameContext, player: PlayerId, cardId: string) {
  return computePriorityOptions(ctx, playerById(ctx, player)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === cardId;
  });
}

function resolveStack(
  ctx: GameContext,
  answer?: (decision: PendingDecision) => DecisionOutcome,
): PendingDecision[] {
  const { decisions } = pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority') {
      return {
        index: Math.max(
          0,
          decision.options.findIndex((option) => option.type === 'pass'),
        ),
        targets: new Map(),
      };
    }
    return answer?.(decision) ?? { index: 0, targets: new Map() };
  });
  return decisions;
}

function castPermanent(
  ctx: GameContext,
  player: PlayerId,
  card: OracleCard,
  cost: { b?: number; w?: number; c?: number },
): EnginePermanent {
  const cardObject = conjure(ctx, player, card, 'hand');
  addPool(ctx, player, cost.b ?? 0, cost.w ?? 0, cost.c ?? 0);
  const option = castOption(ctx, player, cardObject.id);
  expect(option, `${card.name} has its normal cast action`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, player), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  resolveStack(ctx);
  const permanent = ctx.state.battlefield.find((entry) => entry.cardId === cardObject.cardId);
  expect(permanent, `${card.name} resolves to the battlefield`).toBeDefined();
  return permanent!;
}

function answerForModes(decision: PendingDecision, predicates: string[]): DecisionOutcome {
  const index = decision.options.findIndex((option) => {
    const descriptionModes = option.description.split('; ');
    return (
      descriptionModes.length === predicates.length &&
      predicates.every((predicate) => option.description.includes(predicate))
    );
  });
  expect(index, `mode choice includes ${predicates.join(' + ')}`).toBeGreaterThanOrEqual(0);
  return { index, targets: new Map() };
}

function targetSlot(decision: PendingDecision): { slot: number; options: string[] } {
  expect(decision.decisionType).toBe('chooseTargets');
  const target = decision.options[0]?.targets?.[0];
  expect(target).toBeDefined();
  return target!;
}

function queueShadrixTrigger(ctx: GameContext, shadrix: EnginePermanent): void {
  ctx.state.phase = 'combat';
  ctx.state.step = 'beginCombat';
  queueStepTriggers(ctx, 'beginningOfCombat');
  expect(
    ctx.state.pendingTriggers.filter((trigger) => trigger.sourceCardId === shadrix.cardId),
  ).toHaveLength(ctx.state.currentTurnPlayer === shadrix.controllerId ? 1 : 0);
}

function resolveShadrix(
  ctx: GameContext,
  shadrix: EnginePermanent,
  modes: string[],
  players: PlayerId[],
): PendingDecision[] {
  queueShadrixTrigger(ctx, shadrix);
  const targetHistory: string[][] = [];
  return resolveStack(ctx, (decision) => {
    if (decision.prompt.includes('choose modes')) return answerForModes(decision, modes);
    if (decision.decisionType === 'chooseTargets') {
      const slot = targetSlot(decision);
      targetHistory.push([...slot.options]);
      const player = players[slot.slot === 0 ? 0 : 1]!;
      expect(slot.options).toContain(player);
      if (targetHistory.length > 1) expect(slot.options).not.toContain(players[0]);
      return { index: 0, targets: new Map([[slot.slot, player]]) };
    }
    return { index: 0, targets: new Map() };
  });
}

function castLichAndDie(ctx: GameContext): EnginePermanent {
  const lich = castPermanent(ctx, 'P1', lichPin!.card, { b: 1, c: 3 });
  pump(moveObject(ctx, lich, { zone: 'graveyard' }));
  expect(ctx.state.pendingTriggers.some((trigger) => trigger.sourceCardId === lich.cardId)).toBe(
    true,
  );
  return lich;
}

function resolveLich(
  ctx: GameContext,
  modes: string[][],
  targets: PlayerId[],
  afterTargets?: () => void,
): PendingDecision[] {
  const chosenTargets: string[] = [];
  let didAfterTargets = false;
  return resolveStack(ctx, (decision) => {
    if (decision.prompt.includes('choose modes')) {
      for (const selected of modes) {
        expect(
          decision.options.some((option) =>
            selected.every((text) => option.description.includes(text)),
          ),
        ).toBe(true);
      }
      return answerForModes(decision, modes[0]!);
    }
    if (decision.decisionType === 'chooseTargets') {
      const target = targetSlot(decision);
      const player = targets[chosenTargets.length]!;
      expect(target.options).toContain(player);
      if (chosenTargets.length > 0) expect(target.options).not.toContain(chosenTargets[0]);
      chosenTargets.push(player);
      if (chosenTargets.length === targets.length && !didAfterTargets) {
        didAfterTargets = true;
        afterTargets?.();
      }
      return { index: 0, targets: new Map([[target.slot, player]]) };
    }
    if (decision.prompt.includes('sacrifice')) return { index: 0, targets: new Map() };
    return { index: 0, targets: new Map() };
  });
}

describe('PR08 modal player targets', () => {
  it('shadrix-definition-and-cast — pinned definition models the normal creature cast and keywords', () => {
    expect(shadrixPin!.sha256).toBe(
      'b3b27d30058d4a228950317e549d90e7bef45703c68c5015257378827bebfd5a',
    );
    const definition = interpretCard(shadrixPin!.card);
    expect(definition.modeled).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.manaCost).toMatchObject({ generic: 3, colored: { W: 1, B: 1 } });
    const ctx = pod('shadrix-cast');
    const shadrix = castPermanent(ctx, 'P1', shadrixPin!.card, { w: 1, b: 1, c: 3 });
    const characteristics = computeCharacteristics(ctx, shadrix);
    expect(characteristics.keywords).toEqual(expect.arrayContaining(['flying', 'double strike']));
  });

  it('shadrix-begincombat-owner-and-no-modes — only your own beginning of combat triggers, and may choose none', () => {
    const ctx = pod('shadrix-own-combat');
    const shadrix = spawn(ctx, 'P1', shadrixPin!.card);
    resolveShadrix(ctx, shadrix, ['Choose no modes'], []);
    expect(ctx.state.battlefield.some((permanent) => permanent.name.includes('Inkling'))).toBe(
      false,
    );

    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    queueStepTriggers(ctx, 'beginningOfCombat');
    expect(
      ctx.state.pendingTriggers.some((trigger) => trigger.sourceCardId === shadrix.cardId),
    ).toBe(false);
  });

  it('shadrix-choose-two-and-distinct-players — announces two modes and targets self or different players', () => {
    const ctx = pod('shadrix-modes');
    const shadrix = spawn(ctx, 'P1', shadrixPin!.card);
    const decisions = resolveShadrix(
      ctx,
      shadrix,
      ['Target player creates an Inkling', 'Target player draws a card and loses 1 life'],
      ['P2', 'P3'],
    );
    const modeDecision = decisions.find((decision) => decision.prompt.includes('choose modes'))!;
    expect(modeDecision.options).toHaveLength(4);
    expect(modeDecision.options.some((option) => option.description === 'Choose no modes')).toBe(
      true,
    );
    expect(
      modeDecision.options
        .filter((option) => option.description !== 'Choose no modes')
        .every((option) => (option.description.match(/Target player/g) ?? []).length === 2),
    ).toBe(true);
    const targetDecisions = decisions.filter(
      (decision) => decision.decisionType === 'chooseTargets',
    );
    expect(targetDecisions).toHaveLength(2);
    expect(targetSlot(targetDecisions[0]!).options).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(targetSlot(targetDecisions[1]!).options).not.toContain('P2');
    expect(
      ctx.state.battlefield.some(
        (permanent) => permanent.name.includes('Inkling') && permanent.controllerId === 'P2',
      ),
    ).toBe(true);
    expect(playerById(ctx, 'P3').life).toBe(39);
  });

  it('shadrix-modes-need-two-distinct-players — with two targetable players only mode pairs remain', () => {
    const ctx = pod('shadrix-limited-players');
    playerById(ctx, 'P3').hasLost = true;
    playerById(ctx, 'P4').hasLost = true;
    const shadrix = spawn(ctx, 'P1', shadrixPin!.card);
    queueShadrixTrigger(ctx, shadrix);
    const decisions = resolveStack(ctx, (decision) => {
      if (decision.prompt.includes('choose modes')) {
        expect(decision.options).toHaveLength(4); // no modes plus any distinct two-mode pair
        expect(
          decision.options.every(
            (option) => (option.description.match(/Target player/g) ?? []).length <= 2,
          ),
        ).toBe(true);
        return answerForModes(decision, [
          'Target player creates an Inkling',
          'Target player draws a card and loses 1 life',
        ]);
      }
      if (decision.decisionType === 'chooseTargets') {
        const target = targetSlot(decision);
        const pick = target.options.includes('P1') ? 'P1' : 'P2';
        return { index: 0, targets: new Map([[target.slot, pick]]) };
      }
      return { index: 0, targets: new Map() };
    });
    expect(decisions.filter((decision) => decision.decisionType === 'chooseTargets')).toHaveLength(
      1,
    );
  });

  it('lich-definition-and-cast — models printed cost and death trigger', () => {
    const definition = interpretCard(lichPin!.card);
    expect(definition.modeled).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.manaCost).toMatchObject({ generic: 3, colored: { B: 1 } });
    expect(
      abilityModeSelections(definition.triggers[0]!.modes!)
        .map((selection) => selection.join(','))
        .sort(),
    ).toEqual(['0', '0,1', '0,1,2', '0,2', '1', '1,2', '2']);
    expect(legalAbilityModeSelections(definition.triggers[0]!, () => ['P2'])).toEqual([
      [0],
      [1],
      [2],
    ]);
    const ctx = pod('lich-cast');
    const lich = castLichAndDie(ctx);
    expect(playerById(ctx, 'P1').graveyard.some((card) => card.cardId === lich.cardId)).toBe(true);
  });

  it('modal-card-cast-cost-timing — both cards need full mana and cannot be cast off-turn', () => {
    const shadrixShort = pod('shadrix-short-mana');
    const shadrixCard = conjure(shadrixShort, 'P1', shadrixPin!.card, 'hand');
    addPool(shadrixShort, 'P1', 1, 1, 2);
    expect(castOption(shadrixShort, 'P1', shadrixCard.id)).toBeUndefined();

    const lichShort = pod('lich-short-mana');
    const lichCard = conjure(lichShort, 'P1', lichPin!.card, 'hand');
    addPool(lichShort, 'P1', 1, 0, 2);
    expect(castOption(lichShort, 'P1', lichCard.id)).toBeUndefined();

    const shadrixOffTurn = pod('shadrix-off-turn', 4, 'P2');
    const shadrixOffCard = conjure(shadrixOffTurn, 'P1', shadrixPin!.card, 'hand');
    addPool(shadrixOffTurn, 'P1', 1, 1, 3);
    expect(castOption(shadrixOffTurn, 'P1', shadrixOffCard.id)).toBeUndefined();

    const lichOffTurn = pod('lich-off-turn', 4, 'P2');
    const lichOffCard = conjure(lichOffTurn, 'P1', lichPin!.card, 'hand');
    addPool(lichOffTurn, 'P1', 1, 0, 3);
    expect(castOption(lichOffTurn, 'P1', lichOffCard.id)).toBeUndefined();
  });

  it('lich-single-opponent — one living opponent permits only one mandatory mode', () => {
    const ctx = pod('lich-one-opponent', 2);
    const victim = spawn(ctx, 'P2', oracle({ name: 'Victim', typeLine: 'Creature — Bear' }));
    castLichAndDie(ctx);
    const decisions = resolveStack(ctx, (decision) => {
      if (decision.prompt.includes('choose modes')) {
        expect(decision.options).toHaveLength(3);
        expect(decision.options.every((option) => !option.description.includes(';'))).toBe(true);
        expect(decision.options.some((option) => option.description === 'Choose no modes')).toBe(
          false,
        );
        return answerForModes(decision, ['Target opponent loses 5 life']);
      }
      if (decision.decisionType === 'chooseTargets') {
        expect(targetSlot(decision).options).toEqual(['P2']);
        return { index: 0, targets: new Map([[0, 'P2']]) };
      }
      return { index: 0, targets: new Map() };
    });
    expect(decisions.filter((decision) => decision.prompt.includes('choose modes'))).toHaveLength(
      1,
    );
    expect(playerById(ctx, 'P2').life).toBe(35);
    expect(ctx.state.battlefield).toContain(victim);
  });

  it('lich-three-distinct-modes — no repeats, distinct opponent targets, and printed effects resolve in order', () => {
    const ctx = pod('lich-three-modes');
    const p2A = spawn(ctx, 'P2', oracle({ name: 'P2 Victim A', typeLine: 'Creature — Bear' }));
    const p2B = spawn(ctx, 'P2', oracle({ name: 'P2 Victim B', typeLine: 'Creature — Bear' }));
    const lich = castLichAndDie(ctx);
    conjure(ctx, 'P3', oracle({ name: 'P3 Card A' }), 'hand');
    conjure(ctx, 'P3', oracle({ name: 'P3 Card B' }), 'hand');
    const p3HandBefore = playerById(ctx, 'P3').hand.length;
    const decisions = resolveStack(ctx, (decision) => {
      if (decision.prompt.includes('choose modes'))
        return answerForModes(decision, [
          'Target opponent sacrifices a creature',
          'Target opponent discards two cards',
          'Target opponent loses 5 life',
        ]);
      if (decision.decisionType === 'chooseTargets') {
        const slot = targetSlot(decision);
        const pick = ['P2', 'P3', 'P4'][slot.slot]!;
        if (slot.slot > 0) expect(slot.options).not.toContain('P2');
        return { index: 0, targets: new Map([[slot.slot, pick]]) };
      }
      if (decision.prompt.toLowerCase().includes('sacrifice')) {
        expect(decision.player).toBe('P2');
        return {
          index: decision.options.findIndex((option) => option.description.includes(p2A.name)),
          targets: new Map(),
        };
      }
      return { index: 0, targets: new Map() };
    });
    const modeDecision = decisions.find((decision) => decision.prompt.includes('choose modes'))!;
    expect(
      modeDecision.options.some(
        (option) =>
          option.description.includes('Target opponent sacrifices') &&
          option.description.includes('discards two') &&
          option.description.includes('loses 5 life'),
      ),
    ).toBe(true);
    expect(decisions.filter((decision) => decision.decisionType === 'chooseTargets')).toHaveLength(
      2,
    );
    expect(ctx.state.battlefield).not.toContain(p2A);
    expect(ctx.state.battlefield).toContain(p2B);
    expect(playerById(ctx, 'P3').hand).toHaveLength(p3HandBefore - 2);
    expect(playerById(ctx, 'P4').life).toBe(35);
    expect(playerById(ctx, 'P1').graveyard.some((card) => card.cardId === lich.cardId)).toBe(true);
  });

  it('lich-illegal-mode-skips-locally-and-all-illegal-targets-fizzle — invalid modes skip individually and all illegal targets fizzle', () => {
    const partial = pod('lich-partial-illegal');
    const keptCreature = spawn(
      partial,
      'P2',
      oracle({ name: 'P2 Creature', typeLine: 'Creature — Bear' }),
    );
    castLichAndDie(partial);
    resolveLich(
      partial,
      [['Target opponent sacrifices a creature', 'Target opponent loses 5 life']],
      ['P2', 'P3'],
      () => {
        partial.state.playerHexproofTurn = { P2: partial.state.turnNumber };
      },
    );
    expect(partial.state.battlefield).toContain(keptCreature);
    expect(playerById(partial, 'P3').life).toBe(35);

    const allIllegal = pod('lich-all-illegal');
    castLichAndDie(allIllegal);
    resolveLich(
      allIllegal,
      [['Target opponent discards two cards', 'Target opponent loses 5 life']],
      ['P2', 'P3'],
      () => {
        allIllegal.state.playerHexproofTurn = {
          P2: allIllegal.state.turnNumber,
          P3: allIllegal.state.turnNumber,
        };
      },
    );
    expect(allIllegal.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(playerById(allIllegal, 'P3').life).toBe(40);
  });
});
