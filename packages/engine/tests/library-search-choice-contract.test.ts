import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import type { Selector } from '../src/cards/selector';
import { spell } from '../src/cards/templates';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, registerCustomDef } from './fixtures';

function search(names: string[], filter: Selector, optional = false, count = 1, decline = false) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: 'search-choice-contract' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const p = playerById(ctx, 'P1');
  p.library = [];
  for (const name of names)
    conjure(
      ctx,
      'P1',
      oracle({ name, typeLine: name === 'Forest' ? 'Basic Land — Forest' : 'Artifact' }),
      'library',
    );
  const card = oracle({
    name: 'Library Search Contract',
    typeLine: 'Sorcery',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });
  const effect: Effect = {
    op: 'searchLibrary',
    filter,
    destinations: Array.from({ length: count }, () => ({ zone: 'hand' })),
    ...(optional ? { allowFailToFind: true } : {}),
  };
  registerCustomDef(ctx, {
    ...interpretCard(card),
    spellAbility: spell({ effects: [effect, { op: 'shuffle' }] }),
  });
  const obj = conjure(ctx, 'P1', card, 'hand');
  const action = computePriorityOptions(ctx, p).find((option) => {
    const data = option.payload as PriorityActionPayload;
    return data.kind === 'castSpell' && data.objectId === obj.id;
  });
  expect(action).toBeDefined();
  pump(
    applyPriorityAction(ctx, p, action!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  let menus = 0;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority')
      return { index: decision.options.findIndex((o) => o.type === 'pass'), targets: new Map() };
    menus++;
    const fail = decision.options.findIndex((o) => o.type === 'findNothing');
    expect(fail >= 0).toBe(decline);
    const pick = decision.options.findIndex(
      (option) => names[0] !== undefined && option.description.includes(names[0]),
    );
    return { index: decline ? fail : Math.max(0, pick), targets: new Map() };
  });
  expect(ctx.state.stack).toHaveLength(0);
  expect(ctx.state.eventLog.filter((e) => e.type === 'castSpell')).toHaveLength(1);
  expect(ctx.state.eventLog.filter((e) => e.type === 'shuffle')).toHaveLength(1);
  return { ctx, p, menus };
}

describe('independent library search choice contracts', () => {
  it('unrestricted search must choose a card from a nonempty multi-name library', () => {
    const { p, menus } = search(['First Relic', 'Second Relic'], { kind: 'allOf', of: [] });
    expect(menus).toBe(1);
    expect(p.hand.map((c) => c.name)).toEqual(['First Relic']);
    expect(p.library.map((c) => c.name)).toEqual(['Second Relic']);
  });
  it('unrestricted single-name search finds the required card without a choice', () => {
    const { p, menus } = search(['Only Relic'], { kind: 'allOf', of: [] });
    expect(menus).toBe(0);
    expect(p.hand.map((c) => c.name)).toEqual(['Only Relic']);
  });
  it('unrestricted quantity search finds as many cards as possible', () => {
    const { p } = search(['First Relic', 'Second Relic'], { kind: 'allOf', of: [] }, false, 3);
    expect(p.hand.map((c) => c.name).sort()).toEqual(['First Relic', 'Second Relic']);
    expect(p.library).toEqual([]);
  });
  it('a stated quality permits finding nothing even with one matching name', () => {
    const { p, menus } = search(['Forest'], { kind: 'type', value: 'Land' }, false, 1, true);
    expect(menus).toBe(1);
    expect(p.hand).toEqual([]);
    expect(p.library.map((c) => c.name)).toEqual(['Forest']);
  });
  it('an explicitly optional unrestricted search may find nothing', () => {
    const { p, menus } = search(['Only Relic'], { kind: 'allOf', of: [] }, true, 1, true);
    expect(menus).toBe(1);
    expect(p.hand).toEqual([]);
    expect(p.library.map((c) => c.name)).toEqual(['Only Relic']);
  });
  it('an empty library still completes the following shuffle without a choice', () => {
    const { p, menus } = search([], { kind: 'allOf', of: [] });
    expect(menus).toBe(0);
    expect(p.hand).toEqual([]);
    expect(p.library).toEqual([]);
  });
});
