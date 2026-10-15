import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { runCombatPhase } from '../src/combat/combat';
import {
  conjure,
  copies,
  declareAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  keywordCreature,
  pick,
  pump,
  spawn,
} from './fixtures';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const expected = {
  Inkshield: '6e33298ebd1167919ed3885c8a15503a3e4d72b25448c44cdfd5ae814d6097ea',
  'Perch Protection': 'e9adf2313e4738116e684727c9ebc9efc4d3a1e85ee65f91f9040d618252c80d',
};
function pin(name: keyof typeof expected) {
  const entry = pins.cards.find(({ card }) => card.name === name)!;
  expect(entry).toBeDefined();
  expect(entry.sha256).toBe(expected[name]);
  return entry.card;
}
function setup(doubleStrike = false) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed: 'prevention-order' },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  const attacker = spawn(
    ctx,
    'P2',
    keywordCreature('Prevention attacker', doubleStrike ? 'Double strike' : '', '{0}', '5/5'),
  );
  attacker.cardId = 'prevention-attacker' as typeof attacker.cardId;
  return { ctx, attacker };
}
function cast(state: ReturnType<typeof setup>, name: keyof typeof expected, gift = false) {
  const { ctx } = state;
  const object = conjure(ctx, 'P1', pin(name), 'hand');
  object.cardId = `prevention-${name}` as typeof object.cardId;
  addMana(ctx.state.players[0]!, [
    ...Array.from({ length: 8 }, () => ({ symbol: 'W' as const })),
    ...Array.from({ length: 8 }, () => ({ symbol: 'B' as const })),
  ]);
  const action = computePriorityOptions(ctx, ctx.state.players[0]!).find(
    (option) => (option.payload as { objectId?: string }).objectId === object.id,
  )!;
  expect(action).toBeDefined();
  pump(
    applyPriorityAction(ctx, ctx.state.players[0]!, action.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
    (decision) => {
      if (decision.options.some((option) => option.type === 'promiseGift'))
        return {
          index: gift
            ? decision.options.findIndex((option) => option.description.includes('Promise P3'))
            : 0,
          targets: new Map(),
        };
      return { index: 0, targets: new Map() };
    },
  );
  pump(resolveTopOfStack(ctx));
  pump(priorityCheckpoint(ctx));
}
function combat(
  state: ReturnType<typeof setup>,
  choice: 'Inkshield' | 'protection',
  expectedPrompts: number,
) {
  const { ctx, attacker } = state;
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P2',
    activePlayerIndex: 1,
    phase: 'combat',
    step: null,
  });
  attacker.summoningSick = false;
  let prompts = 0;
  pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers')
      return declareAttacks(decision, (id) => (id === attacker.id ? 'P1' : null));
    if (decision.decisionType === 'declareBlockers') return declareNoBlocks(decision);
    if (decision.options.some((option) => option.type === 'damageModifier')) {
      prompts++;
      expect(decision.player).toBe('P1');
      expect(ctx.state.players.map((player) => player.life)).toEqual([40, 40, 40, 40]);
      expect(decision.options.map((option) => option.description)).toEqual([
        'Protection from everything: prevent the damage',
        'Prevent all combat damage this turn, creating a token for each 1 damage prevented',
      ]);
      return {
        index: choice === 'Inkshield' ? 1 : 0,
        targets: new Map(),
      };
    }
    return pick(decision, /Pass|does not/);
  });
  expect(prompts).toBe(expectedPrompts);
  expect(ctx.state.players.map((player) => player.life)).toEqual([40, 40, 40, 40]);
  return ctx.state.battlefield.filter((permanent) => permanent.name === 'Inkling');
}
describe('pinned Perch and Inkshield prevention order', () => {
  it.each(['Inkshield', 'protection'] as const)(
    'normal casts allow choosing %s before five combat damage',
    (choice) => {
      const state = setup();
      cast(state, 'Inkshield');
      cast(state, 'Perch Protection', true);
      expect(
        state.ctx.state.phasedOut?.filter((record) => record.permanent.name === 'Bird'),
      ).toHaveLength(4);
      expect(combat(state, choice, 1)).toHaveLength(choice === 'Inkshield' ? 5 : 0);
    },
  );
  it('each double strike step offers a new prevention choice deterministically', () => {
    const run = () => {
      const state = setup(true);
      cast(state, 'Inkshield');
      cast(state, 'Perch Protection', true);
      expect(combat(state, 'Inkshield', 2)).toHaveLength(10);
      return state.ctx.state.eventLog;
    };
    expect(run()).toEqual(run());
  });
  it('Inkshield alone is forced and still creates five Inklings', () => {
    const state = setup();
    cast(state, 'Inkshield');
    expect(combat(state, 'Inkshield', 0)).toHaveLength(5);
  });
  it('Perch alone is forced and prevents damage without Inklings', () => {
    const state = setup();
    cast(state, 'Perch Protection', true);
    expect(combat(state, 'protection', 0)).toHaveLength(0);
  });
});
