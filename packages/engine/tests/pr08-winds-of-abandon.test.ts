import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { computePriorityOptions } from '../src/actions/legal';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { triggered } from '../src/cards/templates';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
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

const pin = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards.find((entry) => entry.card.name === 'Winds of Abandon');
if (pin === undefined) throw new Error('Missing Winds of Abandon Oracle pin');

function pod(seed: string, turn: PlayerId = 'P1'): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
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

function addPool(ctx: GameContext, player: PlayerId, white: number, colorless: number): void {
  addMana(playerById(ctx, player), [
    ...Array.from({ length: white }, () => ({ symbol: 'W' as const })),
    ...Array.from({ length: colorless }, () => ({ symbol: 'C' as const })),
  ]);
}

function creature(name: string, oracleText = ''): OracleCard {
  return oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2', oracleText });
}

function permanent(
  ctx: GameContext,
  controller: PlayerId,
  card: OracleCard,
  isCommander = false,
  isToken = false,
): EnginePermanent {
  return spawn(ctx, controller, card, { isCommander, isToken });
}

function castOption(ctx: GameContext, player: PlayerId, objectId: string, overload: boolean) {
  return computePriorityOptions(ctx, playerById(ctx, player)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === objectId &&
      ((payload as PriorityActionPayload & { alternativeCast?: string }).alternativeCast ===
        'overload') ===
        overload
    );
  });
}

function castWinds(
  ctx: GameContext,
  overload: boolean,
  targets: ReadonlyMap<number, string> = new Map(),
): string {
  const card = conjure(ctx, 'P1', pin!.card, 'hand');
  addPool(ctx, 'P1', overload ? 2 : 1, overload ? 4 : 1);
  const option = castOption(ctx, 'P1', card.id, overload);
  expect(option, `${overload ? 'overload' : 'base'} cast option is offered`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  expect(playerById(ctx, 'P1').hand.some((entry) => entry.cardId === card.cardId)).toBe(false);
  expect(ctx.state.stack).toHaveLength(1);
  return card.cardId;
}

function resolveSpell(
  ctx: GameContext,
  answer?: (decision: PendingDecision) => number,
): PendingDecision[] {
  const { decisions } = pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority') {
      return {
        index: Math.max(
          0,
          decision.options.findIndex((option) => option.type === 'pass'),
        ),
        targets: new Map(),
      } satisfies DecisionOutcome;
    }
    return { index: answer?.(decision) ?? 0, targets: new Map() } satisfies DecisionOutcome;
  });
  return decisions;
}

function basicLand(name: string, subtype: string): OracleCard {
  return oracle({ name, typeLine: `Basic Land — ${subtype}`, manaCost: null });
}

function landShuffleCount(ctx: GameContext, player: PlayerId): number {
  return ctx.state.eventLog.filter(
    (event) => event.type === 'shuffle' && event.payload['player'] === player,
  ).length;
}

describe('Winds of Abandon (PR08)', () => {
  it('winds-pinned-definition — has the printed base and overload costs', () => {
    expect(pin!.sha256).toBe('62f5a964ae8ac62e5f3f9ee30f5c4ca887a1b438d1af4bcf43ae256998350143');
    expect(pin!.card.manaCost).toBe('{1}{W}');
    const definition = interpretCard(pin!.card);
    expect(definition.modeled).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.spellAbility?.targets).toHaveLength(1);
    expect(definition.spellAbility?.targets[0]).toMatchObject({
      kind: 'creature',
      controller: 'opponent',
    });
    expect(
      definition.alternativeCasts?.find((cast) => cast.kind === 'overload')?.manaCost,
    ).toMatchObject({
      generic: 4,
      colored: { W: 2 },
    });
  });

  it('winds-targets — base target excludes own and hexproof creatures', () => {
    const ctx = pod('winds-targets');
    const card = conjure(ctx, 'P1', pin!.card, 'hand');
    const own = permanent(ctx, 'P1', creature('Own Creature'));
    const hexproof = permanent(ctx, 'P2', creature('Hexproof Creature', 'Hexproof'));
    const legal = permanent(ctx, 'P3', creature('Opposing Creature'));
    addPool(ctx, 'P1', 1, 1);
    const option = castOption(ctx, 'P1', card.id, false);
    expect(option?.targets?.[0]?.options).toContain(legal.id);
    expect(option?.targets?.[0]?.options).not.toContain(own.id);
    expect(option?.targets?.[0]?.options).not.toContain(hexproof.id);
  });

  it('winds-cost-timing — needs each printed cost and is sorcery-speed', () => {
    const baseShort = pod('winds-base-short');
    const baseCard = conjure(baseShort, 'P1', pin!.card, 'hand');
    permanent(baseShort, 'P2', creature('Base Target'));
    addPool(baseShort, 'P1', 1, 0);
    expect(castOption(baseShort, 'P1', baseCard.id, false)).toBeUndefined();

    const overloadShort = pod('winds-overload-short');
    const overloadCard = conjure(overloadShort, 'P1', pin!.card, 'hand');
    addPool(overloadShort, 'P1', 2, 3);
    expect(castOption(overloadShort, 'P1', overloadCard.id, true)).toBeUndefined();

    const offTurn = pod('winds-off-turn', 'P2');
    const offTurnCard = conjure(offTurn, 'P1', pin!.card, 'hand');
    permanent(offTurn, 'P2', creature('Off-turn Target'));
    addPool(offTurn, 'P1', 2, 4);
    expect(castOption(offTurn, 'P1', offTurnCard.id, false)).toBeUndefined();
    expect(castOption(offTurn, 'P1', offTurnCard.id, true)).toBeUndefined();
  });

  it('winds-base-search — exiles the targeted creature and puts a basic land tapped', () => {
    const ctx = pod('winds-base-search');
    const victim = permanent(ctx, 'P2', creature('Victim'));
    const found = conjure(ctx, 'P2', basicLand('Plains', 'Plains'), 'library');
    castWinds(ctx, false, new Map([[0, victim.id]]));
    const decisions = resolveSpell(ctx, (decision) =>
      decision.options.findIndex((option) => option.description.includes(found.name)),
    );
    expect(
      decisions.some(
        (decision) =>
          decision.player === 'P2' && decision.prompt.includes('search for a basic land'),
      ),
    ).toBe(true);
    expect(ctx.state.battlefield).not.toContain(victim);
    expect(ctx.state.exile.some((card) => card.cardId === victim.cardId)).toBe(true);
    const land = ctx.state.battlefield.find((permanent) => permanent.cardId === found.cardId);
    expect(land?.controllerId).toBe('P2');
    expect(land?.tapped).toBe(true);
    expect(landShuffleCount(ctx, 'P2')).toBe(1);
  });

  it('winds-overload-targetless — affects all and only opposing creatures, including hexproof', () => {
    const ctx = pod('winds-overload-targetless');
    const own = permanent(ctx, 'P1', creature('Own Creature'));
    const protectedOpponent = permanent(ctx, 'P2', creature('Hexproof Opponent', 'Hexproof'));
    const opponent = permanent(ctx, 'P3', creature('Other Opponent'));
    const card = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 2, 4);
    const option = castOption(ctx, 'P1', card.id, true);
    expect(option).toBeDefined();
    expect(option?.targets).toBeUndefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    resolveSpell(ctx, (decision) =>
      decision.options.findIndex((candidate) => candidate.type !== 'decline'),
    );
    expect(ctx.state.battlefield).toContain(own);
    expect(ctx.state.battlefield).not.toContain(protectedOpponent);
    expect(ctx.state.battlefield).not.toContain(opponent);
  });

  it('winds-overload-search-batch — token and commander exclusions still produce separate searches before one land entry event', () => {
    const ctx = pod('winds-overload-batch');
    const observerCard = oracle({
      name: 'Land Entry Observer',
      typeLine: 'Enchantment',
      oracleText: 'Whenever one or more lands enter, you gain 1 life.',
    });
    const watcher = permanent(ctx, 'P1', observerCard);
    const base = ctx.defs.get(watcher.oracleId)!;
    const observer: CardDefinition = {
      ...base,
      triggers: [
        triggered(
          {
            when: 'enters',
            subject: { kind: 'permanent', selector: ofType('Land') },
            aggregate: true,
          },
          {
            effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
            description: 'Whenever one or more lands enter, you gain 1 life',
          },
        ),
      ],
    };
    registerCustomDef(ctx, observer);

    const p2Regular = permanent(ctx, 'P2', creature('P2 Regular'));
    const p2Token = permanent(ctx, 'P2', creature('P2 Token'), false, true);
    const p3Commander = permanent(ctx, 'P3', creature('P3 Commander'), true);
    const p4Hexproof = permanent(ctx, 'P4', creature('P4 Hexproof', 'Hexproof'));
    const p2Plains = conjure(ctx, 'P2', basicLand('P2 Plains', 'Plains'), 'library');
    const p2Island = conjure(ctx, 'P2', basicLand('P2 Island', 'Island'), 'library');
    conjure(ctx, 'P2', basicLand('P2 Wastes', 'Wastes'), 'library');
    conjure(ctx, 'P2', creature('Nonland Forest', ''), 'library');
    conjure(
      ctx,
      'P2',
      oracle({ name: 'Nonbasic Forest Dual', typeLine: 'Land — Forest Mountain', manaCost: null }),
      'library',
    );
    const p3Forest = conjure(ctx, 'P3', basicLand('P3 Forest', 'Forest'), 'library');
    const p4Mountain = conjure(ctx, 'P4', basicLand('P4 Mountain', 'Mountain'), 'library');
    castWinds(ctx, true);

    const foundByPlayer = new Map<PlayerId, string[]>();
    let searchPrompts = 0;
    const boardsBeforeSearches: string[][] = [];
    const decisions = resolveSpell(ctx, (decision) => {
      if (decision.prompt.includes('search for a basic land')) {
        searchPrompts++;
        boardsBeforeSearches.push(ctx.state.battlefield.map((permanent) => permanent.id));
        expect(ctx.state.battlefield).not.toEqual(
          expect.arrayContaining([p2Regular, p2Token, p3Commander, p4Hexproof]),
        );
        expect(
          ctx.state.battlefield.some((permanent) =>
            [p2Plains.cardId, p2Island.cardId, p3Forest.cardId, p4Mountain.cardId].includes(
              permanent.cardId,
            ),
          ),
        ).toBe(false);
        if (decision.player === 'P2') {
          expect(
            decision.options.some((candidate) => candidate.description.includes('Wastes')),
          ).toBe(true);
          expect(
            decision.options.some((candidate) => candidate.description.includes('Nonland Forest')),
          ).toBe(false);
          expect(
            decision.options.some((candidate) =>
              candidate.description.includes('Nonbasic Forest Dual'),
            ),
          ).toBe(false);
        }
        const option = decision.options.findIndex((candidate) =>
          decision.player === 'P2'
            ? candidate.description.includes('P2 Plains') ||
              candidate.description.includes('P2 Island')
            : candidate.description.includes('Forest') ||
              candidate.description.includes('Mountain'),
        );
        if (option >= 0) {
          const list = foundByPlayer.get(decision.player) ?? [];
          list.push(decision.options[option]!.description);
          foundByPlayer.set(decision.player, list);
        }
        return option;
      }
      return 0;
    });
    expect(searchPrompts).toBe(4);
    expect(foundByPlayer.get('P2')).toHaveLength(2);
    expect(new Set(foundByPlayer.get('P2')).size).toBe(2);
    expect(foundByPlayer.get('P3')).toHaveLength(1);
    expect(foundByPlayer.get('P4')).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.prompt.includes('search for a basic land')),
    ).toHaveLength(4);
    expect(
      ctx.state.players
        .find((player) => player.id === 'P3')
        ?.commandZone.some((card) => card.cardId === p3Commander.cardId),
    ).toBe(true);
    expect(ctx.state.battlefield).not.toContain(p2Regular);
    expect(ctx.state.battlefield).not.toContain(p2Token);
    expect(ctx.state.battlefield).not.toContain(p4Hexproof);
    const found = [p2Plains, p2Island, p3Forest, p4Mountain];
    const entered = found.map((card) =>
      ctx.state.battlefield.find((permanent) => permanent.cardId === card.cardId),
    );
    expect(entered.every((permanent) => permanent?.tapped === true)).toBe(true);
    expect(landShuffleCount(ctx, 'P2')).toBe(1);
    expect(landShuffleCount(ctx, 'P3')).toBe(1);
    expect(landShuffleCount(ctx, 'P4')).toBe(1);
    expect(playerById(ctx, 'P1').life).toBe(41);
    expect(boardsBeforeSearches).toHaveLength(4);
  });

  it('winds-fail-to-find — search choice may fail to find and still shuffles', () => {
    const ctx = pod('winds-fail-to-find');
    const victim = permanent(ctx, 'P2', creature('Victim'));
    conjure(ctx, 'P2', basicLand('Only Land', 'Plains'), 'library');
    castWinds(ctx, false, new Map([[0, victim.id]]));
    const decisions = resolveSpell(ctx, (decision) => {
      if (decision.prompt.includes('search for a basic land'))
        return decision.options.findIndex((candidate) => candidate.type === 'decline');
      return 0;
    });
    expect(decisions.some((decision) => decision.prompt.includes('search for a basic land'))).toBe(
      true,
    );
    expect(playerById(ctx, 'P2').library.some((card) => card.name === 'Only Land')).toBe(true);
    expect(landShuffleCount(ctx, 'P2')).toBe(1);
  });

  it('winds-fizzle — an invalidated sole target does not offer search', () => {
    const ctx = pod('winds-fizzle');
    const victim = permanent(ctx, 'P2', creature('Victim'));
    conjure(ctx, 'P2', basicLand('Plains', 'Plains'), 'library');
    castWinds(ctx, false, new Map([[0, victim.id]]));
    pump(moveObject(ctx, victim, { zone: 'graveyard' }));
    const decisions = resolveSpell(ctx);
    expect(decisions.some((decision) => decision.prompt.includes('search for a basic land'))).toBe(
      false,
    );
    expect(landShuffleCount(ctx, 'P2')).toBe(0);
  });
});
