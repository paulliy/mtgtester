import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { triggered } from '../src/cards/templates';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { playerById } from '../src/state/objects';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;
const selectedPin = pins.find((entry) => entry.card.name === 'Tragic Arrogance');
if (selectedPin === undefined) throw new Error('Missing Tragic Arrogance Oracle pin');
const pin = selectedPin;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  ctx.state.turnNumber = 4;
  return ctx;
}

function permanent(
  ctx: GameContext,
  controller: PlayerId,
  name: string,
  typeLine: string,
): EnginePermanent {
  return spawn(
    ctx,
    controller,
    oracle({
      name,
      typeLine,
      ...(typeLine.includes('Creature') ? { power: '2', toughness: '2' } : {}),
      ...(typeLine.includes('Planeswalker') ? { loyalty: '3' } : {}),
    }),
  );
}

function mana(ctx: GameContext, controller: PlayerId, symbols: readonly ('W' | 'C')[]): void {
  addMana(
    playerById(ctx, controller),
    symbols.map((symbol) => ({ symbol })),
  );
}

const printedPayment: readonly ('W' | 'C')[] = ['W', 'W', 'C', 'C', 'C'];

function castOption(ctx: GameContext, cardId: string, player: PlayerId = 'P1') {
  return computePriorityOptions(ctx, playerById(ctx, player)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === cardId;
  });
}

function keepDecision(decision: PendingDecision, name: string): DecisionOutcome {
  const index = decision.options.findIndex((option) => option.description === `Keep ${name}`);
  expect(index, `${decision.player} can keep ${name}`).toBeGreaterThanOrEqual(0);
  return { index, targets: new Map() };
}

type ChoiceAnswer = (decision: PendingDecision, count: number) => DecisionOutcome;

function resolveArrogance(
  ctx: GameContext,
  answer: ChoiceAnswer,
  beforeChoices?: (decision: PendingDecision, count: number) => void,
): PendingDecision[] {
  const card = conjure(ctx, 'P1', pin.card, 'hand');
  mana(ctx, 'P1', printedPayment);
  const option = castOption(ctx, card.id);
  expect(option, 'Tragic Arrogance is offered through the normal cast menu').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);

  const { decisions } = pump(runPrioritySequence(ctx), (decision, count) => {
    if (decision.decisionType === 'priority') {
      const pass = decision.options.findIndex((entry) => entry.type === 'pass');
      return { index: Math.max(0, pass), targets: new Map() };
    }
    beforeChoices?.(decision, count);
    return answer(decision, count);
  });
  return decisions;
}

describe('Tragic Arrogance (PR08.18)', () => {
  it('tragic-arrogance-pinned-definition — models the complete pinned sorcery and printed cost', () => {
    expect(pin.card.oracleId).toBe('8a29bd35-33ef-4317-9fe5-8aaff5d7d64d');
    expect(pin.sha256).toBe('a2e733310ed1fbf125e9dc0b96ed73c2eef86583aed89eafe1c0f3c5bce8f213');
    expect(pin.card.manaCost).toBe('{3}{W}{W}');
    expect(pin.card.typeLine).toBe('Sorcery');
    const definition = interpretCard(pin.card);
    expect(definition.modeled).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.manaCost).toMatchObject({ generic: 3, colored: { W: 2 } });
    expect(definition.spellAbility?.effects).toEqual([
      {
        op: 'choosePermanentTypesThenSacrificeOthers',
        types: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker'],
      },
    ]);
  });

  it('tragic-arrogance-cast-timing — needs all printed mana and a main-phase sorcery window', () => {
    const short = pod('tragic-arrogance-short-mana');
    const shortCard = conjure(short, 'P1', pin.card, 'hand');
    mana(short, 'P1', ['W', 'W', 'C', 'C']);
    expect(castOption(short, shortCard.id)).toBeUndefined();

    const offTurn = pod('tragic-arrogance-off-turn');
    offTurn.state.phase = 'combat';
    const offTurnCard = conjure(offTurn, 'P1', pin.card, 'hand');
    mana(offTurn, 'P1', printedPayment);
    expect(castOption(offTurn, offTurnCard.id)).toBeUndefined();
  });

  it('tragic-arrogance-controller-chooses — P1 makes every choice, including choices for P2', () => {
    const ctx = pod('tragic-arrogance-controller-chooses');
    for (const type of ['Artifact', 'Creature — Bear', 'Enchantment', 'Planeswalker — Test']) {
      permanent(ctx, 'P2', `P2 ${type} first`, type);
      permanent(ctx, 'P2', `P2 ${type} second`, type);
    }
    const decisions = resolveArrogance(ctx, (decision) => {
      expect(decision.decisionType).toBe('general');
      expect(decision.player).toBe('P1');
      expect(decision.prompt).toContain("P2's");
      return { index: 0, targets: new Map() };
    });
    const choices = decisions.filter((decision) => decision.decisionType === 'general');
    expect(choices).toHaveLength(4);
    expect(choices.every((decision) => decision.player === 'P1')).toBe(true);
    expect(
      choices.every((decision) => decision.options.every((option) => option.type === 'chooseCard')),
    ).toBe(true);
  });

  it('tragic-arrogance-multitype-kept-once — one artifact creature can satisfy both choices', () => {
    const ctx = pod('tragic-arrogance-multitype');
    const shared = permanent(ctx, 'P2', 'Shared Artifact Creature', 'Artifact Creature — Golem');
    const extraArtifact = permanent(ctx, 'P2', 'Extra Artifact', 'Artifact');
    const extraCreature = permanent(ctx, 'P2', 'Extra Creature', 'Creature — Bear');
    let choiceCount = 0;
    resolveArrogance(
      ctx,
      (decision) => {
        expect(decision.player).toBe('P1');
        expect(decision.options.map((option) => option.description)).toContain(
          `Keep ${shared.name}`,
        );
        choiceCount++;
        return keepDecision(decision, shared.name);
      },
      () => {
        expect(ctx.state.battlefield).toEqual(
          expect.arrayContaining([shared, extraArtifact, extraCreature]),
        );
      },
    );
    expect(choiceCount).toBe(2);
    expect(ctx.state.battlefield).toContain(shared);
    expect(ctx.state.battlefield).not.toContain(extraArtifact);
    expect(ctx.state.battlefield).not.toContain(extraCreature);
  });

  it('tragic-arrogance-skips-empty-types-and-keeps-lands — land types and combat state are unaffected', () => {
    const ctx = pod('tragic-arrogance-empty-types');
    const artifactLand = permanent(ctx, 'P2', 'Artifact Land', 'Artifact Land — Factory');
    const basicLand = permanent(ctx, 'P2', 'Basic Land', 'Basic Land — Plains');
    const spareArtifact = permanent(ctx, 'P2', 'Spare Artifact', 'Artifact');
    const attacker = permanent(ctx, 'P2', 'Chosen Attacker', 'Creature — Bear');
    const nonattacker = permanent(ctx, 'P2', 'Unchosen Nonattacker', 'Creature — Bear');
    attacker.attacking = 'P3';
    attacker.statuses.push('attacking');
    const choices: string[] = [];
    resolveArrogance(
      ctx,
      (decision) => {
        choices.push(decision.prompt);
        return decision.prompt.includes('artifact')
          ? keepDecision(decision, artifactLand.name)
          : keepDecision(decision, attacker.name);
      },
      () => {
        expect(ctx.state.battlefield).toEqual(
          expect.arrayContaining([artifactLand, basicLand, spareArtifact, attacker, nonattacker]),
        );
      },
    );
    expect(choices).toHaveLength(2);
    expect(choices.some((prompt) => prompt.includes('enchantment'))).toBe(false);
    expect(choices.some((prompt) => prompt.includes('planeswalker'))).toBe(false);
    expect(ctx.state.battlefield).toContain(artifactLand);
    expect(ctx.state.battlefield).toContain(basicLand);
    expect(ctx.state.battlefield).toContain(attacker);
    expect(attacker.attacking).toBe('P3');
    expect(attacker.statuses).toContain('attacking');
    expect(ctx.state.battlefield).not.toContain(spareArtifact);
    expect(ctx.state.battlefield).not.toContain(nonattacker);
  });

  it('tragic-arrogance-simultaneous-sacrifices — one aggregate watcher sees both creatures', () => {
    const ctx = pod('tragic-arrogance-simultaneous');
    const watcherCard = oracle({
      name: 'Sacrifice Event Observer',
      typeLine: 'Enchantment',
      oracleText: 'Whenever one or more creatures are sacrificed, you gain 1 life.',
    });
    const watcher = spawn(ctx, 'P1', watcherCard);
    const base = ctx.defs.get(watcher.oracleId)!;
    const observer: CardDefinition = {
      ...base,
      triggers: [
        triggered(
          {
            when: 'sacrificed',
            subject: { kind: 'permanent', selector: ofType('Creature') },
            aggregate: true,
          },
          {
            effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
            description: 'Whenever one or more creatures are sacrificed, you gain 1 life',
          },
        ),
      ],
    };
    registerCustomDef(ctx, observer);
    const p2Kept = permanent(ctx, 'P2', 'P2 Kept Creature', 'Creature — Bear');
    const p2Sacrificed = permanent(ctx, 'P2', 'P2 Sacrificed Creature', 'Creature — Bear');
    const p3Kept = permanent(ctx, 'P3', 'P3 Kept Creature', 'Creature — Bear');
    const p3Sacrificed = permanent(ctx, 'P3', 'P3 Sacrificed Creature', 'Creature — Bear');
    const decisions = resolveArrogance(
      ctx,
      (decision) => {
        expect(decision.player).toBe('P1');
        const p2 = decision.prompt.includes("P2's");
        const p3 = decision.prompt.includes("P3's");
        if (p2 || p3) {
          const pick = p2 ? p2Kept : p3 ? p3Kept : undefined;
          if (pick !== undefined) return keepDecision(decision, pick.name);
        }
        if (decision.prompt.includes("P1's") && decision.prompt.includes('enchantment'))
          return keepDecision(decision, watcher.name);
        return { index: 0, targets: new Map() };
      },
      (_decision) => {
        expect(ctx.state.battlefield).toEqual(
          expect.arrayContaining([p2Kept, p2Sacrificed, p3Kept, p3Sacrificed, watcher]),
        );
      },
    );

    expect(decisions.filter((decision) => decision.decisionType === 'general')).toHaveLength(2);
    expect(ctx.state.battlefield).toEqual(expect.arrayContaining([p2Kept, p3Kept, watcher]));
    expect(ctx.state.battlefield).not.toContain(p2Sacrificed);
    expect(ctx.state.battlefield).not.toContain(p3Sacrificed);
    expect(playerById(ctx, 'P1').life).toBe(41);
  });
});
