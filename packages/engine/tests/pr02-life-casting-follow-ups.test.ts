import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { CardDefinition } from '../src/cards/definition';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { addMana } from '../src/mana/pool';
import { TurnAbortedSignal } from '../src/signals';
import {
  conjure,
  declareAttacks,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}
const pinnedCards = [
  'fixtures/marchesa-batch1-oracle.json',
  'fixtures/coverage-pr02-oracle.json',
].flatMap(
  (file) =>
    (JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')) as PinnedFixture).cards,
);
const anrakyr = pinnedCards.find((entry) => entry.card.name === 'Anrakyr the Traveller');
if (anrakyr === undefined)
  throw new Error('missing pinned Oracle fixture for Anrakyr the Traveller');
const anrakyrCard = anrakyr.card;

function context(seed: string): GameContext {
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

function priority(ctx: GameContext, who = 'P1') {
  return computePriorityOptions(ctx, playerById(ctx, who));
}
function castOptions(ctx: GameContext, objectId: string) {
  return priority(ctx).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}
function cast(ctx: GameContext, option: ReturnType<typeof castOptions>[number]) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

function attack(ctx: GameContext, self: EnginePermanent, choose: RegExp | null) {
  const offered: string[] = [];
  pump(runCombatAndExtraCombats(ctx), (decision: PendingDecision): DecisionOutcome => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, (id) => (id === self.id ? 'P2' : null));
    if (decision.presentationBlockDeclaration !== undefined)
      return { index: 0, targets: new Map() };
    const choices = decision.options.filter((option) => /^Cast .* life$/.test(option.description));
    if (choices.length) {
      offered.push(...choices.map((option) => option.description));
      const index =
        choose === null
          ? decision.options.findIndex((option) => option.type === 'decline')
          : decision.options.findIndex((option) => choose.test(option.description));
      return { index, targets: new Map() };
    }
    const accept = decision.options.findIndex((option) => option.type === 'acceptTrigger');
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: accept >= 0 ? accept : Math.max(pass, 0), targets: new Map() };
  });
  return offered;
}
function ready(seed: string) {
  const ctx = context(seed);
  const self = spawn(ctx, 'P1', anrakyrCard);
  return { ctx, self };
}
function xArtifact(name: string): OracleCard {
  return oracle({
    name,
    typeLine: 'Artifact',
    manaCost: '{X}{3}',
    cmc: 3,
    oracleText: '',
    power: null,
    toughness: null,
  });
}

describe('Anrakyr life casting follow-ups', () => {
  it('uses pinned Anrakyr Oracle and makes X zero for the life replacement cost', () => {
    expect(anrakyr.sha256).toBe('1f11aa229db25bcdc8cb4b657fc98252b59975ad92a97811bae330033a79dcf9');
    const { ctx, self } = ready('anrakyr-x-trigger');
    const relic = xArtifact('Anrakyr X Relic');
    const obj = conjure(ctx, 'P1', relic, 'hand');
    expect(attack(ctx, self, /Anrakyr X Relic/)).toEqual([
      'Cast Anrakyr X Relic from your hand for 3 life',
    ]);
    expect(playerById(ctx, 'P1').life).toBe(37);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === obj.cardId)).toBe(true);
  });

  it('allows an ordinary mana cast to announce positive X', () => {
    const ctx = context('anrakyr-x-normal');
    const relic = xArtifact('Ordinary X Relic');
    const obj = conjure(ctx, 'P1', relic, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 5 }, () => ({ symbol: 'C' as const })),
    );
    const option = castOptions(ctx, obj.id).find(
      (entry) => (entry.payload as PriorityActionPayload & { x?: number }).x === 2,
    );
    expect(option).toBeDefined();
    cast(ctx, option!);
    expect(ctx.state.stack.at(-1)?.announcedX).toBe(2);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });

  it.each(['hand', 'graveyard'] as const)(
    'charges Anrakyr replacement payment plus a mandatory 2 life once from %s',
    (zone: 'hand' | 'graveyard') => {
      const { ctx, self } = ready(`anrakyr-additional-${zone}`);
      const relic = xArtifact('Anrakyr Extra Cost Relic');
      const obj = conjure(ctx, 'P1', relic, zone);
      const def = ctx.defs.get(relic.oracleId)!;
      ctx.defs.set(relic.oracleId, {
        ...def,
        spellAdditionalCosts: [{ kind: 'payLife', amount: 2 }],
      } as CardDefinition);
      expect(attack(ctx, self, /Anrakyr Extra Cost Relic/)).toEqual([
        `Cast Anrakyr Extra Cost Relic from your ${zone} for 3 life`,
      ]);
      expect(playerById(ctx, 'P1').life).toBe(35);
      expect(playerById(ctx, 'P1').graveyard.some((card) => card.cardId === obj.cardId)).toBe(
        false,
      );
    },
  );

  it('offers the cast when total life exactly equals replacement and additional costs', () => {
    const { ctx, self } = ready('anrakyr-life-exact');
    playerById(ctx, 'P1').life = 5;
    const relic = xArtifact('Anrakyr Exact Life Relic');
    conjure(ctx, 'P1', relic, 'hand');
    const def = ctx.defs.get(relic.oracleId)!;
    ctx.defs.set(relic.oracleId, {
      ...def,
      spellAdditionalCosts: [{ kind: 'payLife', amount: 2 }],
    } as CardDefinition);
    expect(() => attack(ctx, self, /Anrakyr Exact Life Relic/)).toThrow(TurnAbortedSignal);
    expect(playerById(ctx, 'P1').life).toBe(0);
  });

  it('does not offer a cast when combined life costs exceed current life', () => {
    const { ctx, self } = ready('anrakyr-life-short');
    playerById(ctx, 'P1').life = 4;
    const relic = xArtifact('Anrakyr Too Much Life Relic');
    conjure(ctx, 'P1', relic, 'hand');
    const def = ctx.defs.get(relic.oracleId)!;
    ctx.defs.set(relic.oracleId, {
      ...def,
      spellAdditionalCosts: [{ kind: 'payLife', amount: 2 }],
    } as CardDefinition);
    expect(attack(ctx, self, null)).toEqual([]);
    expect(playerById(ctx, 'P1').life).toBe(4);
  });

  it('does not grant permission for a nonartifact or an opponent graveyard card', () => {
    const { ctx, self } = ready('anrakyr-no-permission');
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Anrakyr Nonartifact', typeLine: 'Creature — Bear' }),
      'hand',
    );
    conjure(ctx, 'P2', xArtifact('Opponent X Relic'), 'graveyard');
    expect(attack(ctx, self, null)).toEqual([]);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });
});
