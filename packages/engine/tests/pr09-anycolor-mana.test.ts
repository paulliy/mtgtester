import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { TAP_COST } from '../src/cards/definition';
import type { ManaEntry } from '../src/cards/ability';
import { canPay, parseManaCost, planPayment } from '../src/mana/cost';
import type { ManaSource } from '../src/mana/cost';
import { selectEntriesToSpend } from '../src/mana/pool';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  copies,
  conjure,
  declareAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';
import { addMana } from '../src/mana/pool';

type Sym = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const pool = (...symbols: Sym[]): ManaEntry[] => symbols.map((symbol) => ({ symbol }));
const source = (cardId: string, symbol: Sym): ManaSource => ({
  cardId,
  units: [[symbol]],
  costs: TAP_COST,
});
const convoker = (cardId: string, symbol: Sym): ManaSource => ({
  cardId,
  units: [[symbol]],
  costs: TAP_COST,
  convoke: true,
});

const marchesaCards = JSON.parse(
  readFileSync(new URL('./fixtures/marchesa-batch1-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const pr09Cards = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const pinned = (cards: { card: OracleCard }[], name: string): OracleCard => {
  const entry = cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned card ${name}`);
  return entry.card;
};
const HOUR_OF_RECKONING = pinned(marchesaCards.cards, 'Hour of Reckoning');
const GRENZO = pinned(pr09Cards.cards, 'Grenzo, Havoc Raiser');

function grenzoGame() {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      {
        seed: 'pr09-anycolor-convoke',
      },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (const player of ctx.state.players) {
    player.hand = [];
    player.library = [];
  }
  return ctx;
}

function pass(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex(
    (option) =>
      option.type === 'pass' || (option.payload as { kind?: string } | undefined)?.kind === 'pass',
  );
  if (index < 0) throw new Error(`No pass option for ${decision.prompt}`);
  return { index, targets: new Map() };
}

describe('internal spend-as-any-color mana permission', () => {
  it('lets off-color mana and colorless mana pay colored pips only when flagged', () => {
    const printed = parseManaCost('{R}{R}').cost!;
    const permitted = { ...printed, spendAsAnyColor: true as const };

    expect(canPay(printed, pool('G', 'G'), [])).toBe(false);
    expect(canPay(permitted, pool('G', 'G'), [])).toBe(true);
    expect(canPay(permitted, pool('C', 'C'), [])).toBe(true);
    expect(canPay(printed, pool('C', 'C'), [])).toBe(false);

    // The permission is internal metadata, not part of parsing or the printed cost.
    expect(parseManaCost('{R}{R}').cost).toEqual(printed);
  });

  it('keeps {C} strict even when colored pips can use any mana', () => {
    const cost = { ...parseManaCost('{R}{C}').cost!, spendAsAnyColor: true as const };
    expect(canPay(cost, pool('G', 'C'), [])).toBe(true);
    expect(canPay(cost, pool('G', 'G'), [])).toBe(false);
  });

  it('does not let off-color Convoke cover Hour of Reckoning colored pips', () => {
    const cost = {
      ...parseManaCost(HOUR_OF_RECKONING.manaCost).cost!,
      spendAsAnyColor: true as const,
    };
    const redCreatures = Array.from({ length: 5 }, (_, index) => convoker(`red-${index}`, 'R'));

    expect(planPayment(cost, pool('C', 'C'), redCreatures)).toBeNull();
  });

  it('finds a white Convoke witness after trying off-color creatures first', () => {
    const cost = {
      ...parseManaCost(HOUR_OF_RECKONING.manaCost).cost!,
      spendAsAnyColor: true as const,
    };
    const sources = [
      ...Array.from({ length: 4 }, (_, index) => convoker(`red-${index}`, 'R')),
      convoker('white-last', 'W'),
    ];

    const plan = planPayment(cost, pool('C', 'C'), sources);
    expect(plan?.tapCardIds).toContain('white-last');
    expect(plan?.tapCardIds.filter((id) => id.startsWith('red-'))).toHaveLength(4);
  });

  it('still lets a red convoker pay generic on Conclave Tribunal', () => {
    const tribunal = pinned(marchesaCards.cards, 'Conclave Tribunal');
    const cost = {
      ...parseManaCost(tribunal.manaCost).cost!,
      spendAsAnyColor: true as const,
    };

    expect(planPayment(cost, pool('C', 'C', 'C'), [convoker('red', 'R')])).not.toBeNull();
  });

  it('matches Convoke color and keeps {C} and restricted-entry identity in direct selection', () => {
    const cost = {
      ...parseManaCost('{R}{G}').cost!,
      spendAsAnyColor: true as const,
    };
    const restriction = {
      purposes: ['castSpell'] as const,
      description: 'cast a Dragon spell',
    };
    const restrictedMana: ManaEntry = { symbol: 'C', restriction };
    const matchingConvoke: ManaEntry = { symbol: 'R', convoked: true };
    const selected = selectEntriesToSpend([matchingConvoke, restrictedMana], cost);
    expect(selected).toContain(matchingConvoke);
    expect(selected).toContain(restrictedMana);
    expect(selected?.find((entry) => entry === restrictedMana)?.restriction).toBe(restriction);

    const wrongColorConvoke: ManaEntry = { symbol: 'U', convoked: true };
    expect(selectEntriesToSpend([wrongColorConvoke, restrictedMana], cost)).toBeNull();

    const colorlessCost = {
      ...parseManaCost('{R}{C}').cost!,
      spendAsAnyColor: true as const,
    };
    expect(
      selectEntriesToSpend([{ symbol: 'R' }, { symbol: 'C', convoked: true }], colorlessCost),
    ).toBeNull();
  });

  it('keeps Phyrexian and hybrid Convoke pips color-matched after color selection', () => {
    const phyrexian = {
      ...parseManaCost('{R/P}').cost!,
      spendAsAnyColor: true as const,
    };
    expect(planPayment(phyrexian, [], [convoker('wrong-phyrexian', 'G')], undefined, 0)).toBeNull();
    expect(
      planPayment(phyrexian, [], [convoker('right-phyrexian', 'R')], undefined, 0),
    ).not.toBeNull();

    const hybrid = {
      ...parseManaCost('{R/U}').cost!,
      spendAsAnyColor: true as const,
    };
    expect(planPayment(hybrid, [], [convoker('wrong-hybrid', 'G')])).toBeNull();
    expect(planPayment(hybrid, [], [convoker('right-hybrid', 'U')])).not.toBeNull();
  });

  it('offers and completes Grenzo’s paid Hour of Reckoning cast only with a matching convoker', () => {
    const ctx = grenzoGame();
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const redCreatures = Array.from({ length: 5 }, (_, index) =>
      spawn(ctx, 'P1', oracle({ name: `Grenzo red creature ${index}`, colors: ['R'] })),
    );
    const original = conjure(ctx, 'P2', HOUR_OF_RECKONING, 'library');
    playerById(ctx, 'P2').library = [original];

    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === grenzo.id ? 'P2' : null));
      if (decision.options.some((option) => /Goad|Exile their top card/.test(option.description))) {
        const index = decision.options.findIndex((option) =>
          /Exile their top card/.test(option.description),
        );
        if (index < 0) throw new Error('Grenzo did not offer its exile mode');
        return { index, targets: new Map() };
      }
      if (decision.decisionType === 'declareBlockers') return declareNoBlocks(decision);
      return pass(decision);
    });

    const exiled = ctx.state.exile.find((entry) => entry.cardId === original.cardId)!;
    expect(exiled.playableUntilEotBy).toBe('P1');
    expect(exiled.spendAsAnyColorUntilEot).toBe(true);
    expect(interpretCard(HOUR_OF_RECKONING).ruleStatics).toContainEqual({ kind: 'convoke' });
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
    const castOption = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === exiled.id,
    );
    expect(castOption).toBeUndefined();

    const whiteCreature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Grenzo white creature', colors: ['W'] }),
    );
    const legalOption = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === exiled.id,
    );
    expect(legalOption).toBeDefined();
    pump(
      applyPriorityAction(
        ctx,
        playerById(ctx, 'P1'),
        legalOption!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(redCreatures.filter((creature) => creature.tapped)).toHaveLength(4);
    expect(whiteCreature.tapped).toBe(true);
  });

  it('keeps both Phyrexian mana and life payment alternatives', () => {
    const cost = {
      ...parseManaCost('{R/P}').cost!,
      spendAsAnyColor: true as const,
    };
    const manaPlan = planPayment(cost, pool('G'), [], undefined, 2);
    expect(manaPlan?.lifePaid).toBe(0);
    expect(manaPlan?.fromPool.G).toBe(1);
    expect(manaPlan?.resolvedCost?.colored.R).toBe(1);

    const lifePlan = planPayment(cost, [], [], undefined, 2);
    expect(lifePlan?.lifePaid).toBe(2);
    expect(lifePlan?.resolvedCost?.colored.R).toBe(0);
  });

  it('applies the permission after choosing a hybrid color, including colorless mana', () => {
    const hybrid = { ...parseManaCost('{R/U}').cost!, spendAsAnyColor: true as const };
    expect(canPay(hybrid, pool('C'), [])).toBe(true);
    expect(canPay(parseManaCost('{R/U}').cost!, pool('C'), [])).toBe(false);
  });

  it('continues to enforce mana restrictions', () => {
    const restricted: ManaEntry[] = [
      {
        symbol: 'G',
        restriction: {
          purposes: ['castSpell'],
          filter: { kind: 'subtype', value: 'Dragon' },
          description: 'cast a Dragon spell',
        },
      },
    ];
    const cost = { ...parseManaCost('{R}').cost!, spendAsAnyColor: true as const };
    expect(canPay(cost, restricted, [])).toBe(false);
  });

  it('does not grant the permission to a costly mana source activation cost', () => {
    const costlyOffColor: ManaSource = {
      cardId: 'filter',
      units: [['G'], ['G']],
      costs: TAP_COST,
      manaCost: parseManaCost('{R}').cost!,
    };
    const cost = { ...parseManaCost('{3}{R}{R}').cost!, spendAsAnyColor: true as const };

    // The source is needed to reach four mana, but its own {R} activation cost cannot be
    // paid from the available G mana. Adding a red source pays that activation normally.
    expect(canPay(cost, pool('G', 'G', 'G'), [costlyOffColor])).toBe(false);
    const plan = planPayment(cost, pool('G', 'G', 'G'), [
      costlyOffColor,
      source('red-source', 'R'),
    ]);
    expect(plan?.tapCardIds).toContain('filter');
    expect(plan?.produced.map((mana) => mana.symbol).sort()).toEqual(['G', 'G', 'R']);
  });
});
