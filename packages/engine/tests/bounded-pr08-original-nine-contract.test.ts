import { describe, expect, it } from 'vitest';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import {
  BOUNDED_PR08_ORIGINAL_NINE,
  matchesBoundedPr08OriginalNine,
} from '../../../scripts/contracts/bounded-pr08-original-nine';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { playerById } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import { moveObject } from '../src/state/objects';
import { interpretCard } from '../src/cards/interpret';
import { runPrioritySequence } from '../src/turn/priority';
import type { GameContext } from '../src/state/types';
import type { PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup(id: string) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed: `bounded-original-${id}` },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    phase: 'precombatMain',
    step: null,
    turnNumber: 4,
  });
  const entry = BOUNDED_PR08_ORIGINAL_NINE.find((item) => item.id === id)!;
  const d = entry.definition;
  const cost = d.manaCost!;
  const costText = [
    ...(cost.generic ? [`{${cost.generic}}`] : []),
    ...(cost.colorless ? Array.from({ length: cost.colorless }, () => '{C}') : []),
    ...Object.entries(cost.colored).flatMap(([c, n]) => Array.from({ length: n }, () => `{${c}}`)),
  ].join('');
  const card = oracle({
    oracleId: d.oracleId,
    name: d.name,
    typeLine: d.typeLine,
    manaCost: costText,
    colors: [...d.colors],
    colorIdentity: [...d.colorIdentity],
    oracleText: '',
  });
  ctx.defs.set(card.oracleId, structuredClone(d));
  return { ctx, d, card };
}
function pool(ctx: GameContext, cost: NonNullable<ReturnType<typeof setup>['d']['manaCost']>) {
  const units: ('C' | 'W' | 'U' | 'B' | 'R' | 'G')[] = [];
  for (const [color, n] of Object.entries(cost.colored))
    for (let i = 0; i < n; i++) units.push(color as (typeof units)[number]);
  for (let i = 0; i < cost.colorless; i++) units.push('C');
  for (let i = 0; i < cost.generic; i++) units.push('C');
  addMana(
    playerById(ctx, 'P1'),
    units.map((symbol) => ({ symbol })),
  );
}
function settle(ctx: GameContext, druidArtifact?: ReturnType<typeof spawn>, chooseDruid = true) {
  return pump(runPrioritySequence(ctx), (d: PendingDecision) => {
    if (druidArtifact !== undefined) {
      const choice = d.options.findIndex(
        (option) => option.description === 'Destroy Independent Druid target',
      );
      return { index: chooseDruid && choice >= 0 ? choice : 0, targets: new Map() };
    }
    return {
      index: Math.max(
        0,
        d.options.findIndex((o) => o.type === 'pass'),
      ),
      targets: new Map(),
    };
  });
}
function cast(
  ctx: GameContext,
  d: ReturnType<typeof setup>['d'],
  card: ReturnType<typeof setup>['card'],
  chooseDruid = true,
) {
  const druidArtifact = d.triggers.some((trigger) =>
    trigger.effects.some((effect) => effect.op === 'druidPurification'),
  )
    ? spawn(ctx, 'P2', oracle({ name: 'Independent Druid target', typeLine: 'Artifact' }))
    : undefined;
  pool(ctx, d.manaCost!);
  const hand = conjure(ctx, 'P1', card, 'hand');
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((o) => {
    const p = o.payload as PriorityActionPayload;
    return p.kind === 'castSpell' && p.objectId === hand.id;
  });
  expect(option).toBeDefined();
  const targets = new Map<number, string>();
  if (d.spellAbility?.targets.length === 2) {
    targets.set(0, 'P2');
    targets.set(1, 'P3');
  }
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  settle(ctx, druidArtifact, chooseDruid);
  if (druidArtifact !== undefined)
    expect(ctx.state.battlefield.includes(druidArtifact)).toBe(!chooseDruid);
  return hand;
}
function activate(
  ctx: GameContext,
  d: ReturnType<typeof setup>['d'],
  sourceId: string,
  funded: boolean,
) {
  const ability = d.activatedAbilities[0]!;
  const manaCost = ability.costs.find((cost) => cost.kind === 'mana');
  if (funded && manaCost?.kind === 'mana') pool(ctx, manaCost.cost);
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((o) => {
    const p = o.payload as PriorityActionPayload;
    return p.kind === 'activateAbility' && p.objectId === sourceId;
  });
  return option;
}
function runPositive(id: string) {
  const { ctx, d, card } = setup(id);
  const hand = cast(ctx, d, card);
  if (d.activatedAbilities.length) {
    const source = ctx.state.battlefield.find((p) => p.cardId === hand.cardId)!;
    source.summoningSick = false;
    if (id === 'cytoplast-manipulator') {
      const target = spawn(
        ctx,
        'P2',
        oracle({ name: 'Countered target', typeLine: 'Creature — Bear' }),
      );
      target.counters['+1/+1'] = 1;
      pool(ctx, { generic: 0, colorless: 0, colored: { W: 0, U: 1, B: 0, R: 0, G: 0 }, x: 0 });
      const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
        (o) =>
          (o.payload as PriorityActionPayload).kind === 'activateAbility' &&
          (o.payload as { objectId?: string }).objectId === source.id,
      );
      expect(option).toBeDefined();
      pump(
        applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map([[0, target.id]]),
        }),
      );
      settle(ctx);
      expect(target.controllerId).toBe('P1');
    } else {
      const option = activate(ctx, d, source.id, true);
      expect(option).toBeDefined();
      const targets = new Map<number, string>();
      if (id === 'humble-defector') targets.set(0, 'P2');
      pump(
        applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
          index: 0,
          targets,
        }),
      );
      settle(ctx);
      expect(ctx.state.stack.length).toBe(0);
      if (id === 'humble-defector') {
        expect(playerById(ctx, 'P1').hand.length).toBe(2);
        expect(source.controllerId).toBe('P2');
      }
      if (id === 'wishclaw-talisman') {
        expect(source.controllerId).toBe('P2');
        expect(playerById(ctx, 'P1').hand.length).toBeGreaterThan(0);
      }
    }
  }
  if (id === 'akroan-horse') {
    const horse = ctx.state.battlefield.find((p) => p.cardId === hand.cardId)!;
    expect(horse.controllerId).toBe('P2');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    queueStepTriggers(ctx, 'upkeep');
    settle(ctx);
    expect(
      ctx.state.battlefield
        .filter((p) => p.isToken && p.name === 'Soldier')
        .map((p) => p.controllerId)
        .sort(),
    ).toEqual(['P1', 'P3', 'P4']);
  }
  if (id === 'agitator-ant') {
    const ant = ctx.state.battlefield.find((p) => p.cardId === hand.cardId)!;
    const target = spawn(
      ctx,
      'P2',
      oracle({ name: 'Ant trigger recipient', typeLine: 'Creature — Bear' }),
    );
    queueStepTriggers(ctx, 'endStep');
    settle(ctx);
    expect(ant.counters['+1/+1']).toBeGreaterThan(0);
    expect(target.counters['+1/+1']).toBe(2);
  }
  if (id === 'alicia-masters') {
    const witness = oracle({
      oracleId: 'independent-noncreature-witness',
      name: 'Independent noncreature witness',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    });
    ctx.defs.set(witness.oracleId, interpretCard(witness));
    const witnessObject = conjure(ctx, 'P1', witness, 'hand');
    const castOption = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (o) =>
        (o.payload as PriorityActionPayload).kind === 'castSpell' &&
        (o.payload as { objectId?: string }).objectId === witnessObject.id,
    );
    expect(castOption).toBeDefined();
    pump(
      applyPriorityAction(
        ctx,
        playerById(ctx, 'P1'),
        castOption!.payload as PriorityActionPayload,
        { index: 0, targets: new Map() },
      ),
    );
    settle(ctx);
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx);
    expect(ctx.state.battlefield.some((p) => p.isToken && p.name === 'Treasure')).toBe(true);
  }
  return (
    ctx.state.battlefield.some((p) => p.cardId === hand.cardId) ||
    playerById(ctx, 'P1').graveyard.some((o) => o.cardId === hand.cardId)
  );
}
function runUnfunded(id: string) {
  let { ctx, d, card } = setup(id);
  let hand = conjure(ctx, 'P1', card, 'hand');
  expect(
    computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
      (o) =>
        (o.payload as PriorityActionPayload).kind === 'castSpell' &&
        (o.payload as { objectId?: string }).objectId === hand.id,
    ),
  ).toBe(false);
  if (d.activatedAbilities.length) {
    ({ ctx, d, card } = setup(id));
    hand = cast(ctx, d, card);
    const source = ctx.state.battlefield.find((p) => p.cardId === hand.cardId)!;
    source.summoningSick = false;
    if (id === 'cytoplast-manipulator') {
      const target = spawn(
        ctx,
        'P2',
        oracle({ name: 'Unfunded countered target', typeLine: 'Creature — Bear' }),
      );
      target.counters['+1/+1'] = 1;
    }
    if (id === 'humble-defector') source.tapped = true;
    expect(activate(ctx, d, source.id, false)).toBeUndefined();
  }
  return ctx;
}

describe('bounded original PR08 composition support', () => {
  for (const entry of BOUNDED_PR08_ORIGINAL_NINE) {
    it(`${entry.id}: independent exact definition is supported`, () =>
      expect(matchesBoundedPr08OriginalNine(entry.definition, entry.id)).toBe(true));
    it(`${entry.id}: extra executable effect is out of scope`, () => {
      const changed = structuredClone(entry.definition);
      if (changed.spellAbility)
        changed.spellAbility.effects.push({ op: 'gainLife', amount: { kind: 'const', n: 1 } });
      else if (changed.activatedAbilities.length)
        changed.activatedAbilities[0]!.ability.effects.push({
          op: 'gainLife',
          amount: { kind: 'const', n: 1 },
        });
      else changed.triggers[0]!.effects.push({ op: 'gainLife', amount: { kind: 'const', n: 1 } });
      expect(matchesBoundedPr08OriginalNine(changed, entry.id)).toBe(false);
    });
  }
});
describe('bounded original PR08 paid composition behavior', () => {
  for (const entry of BOUNDED_PR08_ORIGINAL_NINE) {
    for (const capability of deriveCardCapabilities(entry.definition)) {
      it(`${capability} / ${entry.id}: funded cast and activation resolves`, () =>
        expect(runPositive(entry.id)).toBe(true));
      it(`${capability} / ${entry.id}: unfunded normal cast or activation is absent`, () =>
        expect(runUnfunded(entry.id).state.stack).toHaveLength(0));
    }
  }
  it('Effect.druidPurification / druid-of-purification: choosing a permanent destroys it after all choices', () => {
    const { ctx, d, card } = setup('druid-of-purification');
    cast(ctx, d, card, true);
    expect(
      playerById(ctx, 'P2').graveyard.some((object) => object.name === 'Independent Druid target'),
    ).toBe(true);
  });
  it('Effect.druidPurification / druid-of-purification: declining preserves the candidate', () => {
    const { ctx, d, card } = setup('druid-of-purification');
    cast(ctx, d, card, false);
    expect(
      ctx.state.battlefield.some((permanent) => permanent.name === 'Independent Druid target'),
    ).toBe(true);
  });
});
describe('bounded original PR08 independent Graft behavior', () => {
  for (const capability of ['Effect.moveCounters', 'Condition.sourceHasCounters'])
    for (const accept of [true, false]) {
      it(`${capability} / cytoplast-graft-${accept ? 'positive' : 'negative'} — ${accept ? 'paid independent composition moves a counter on creature entry' : 'declining the optional trigger moves no counter'}`, () => {
        const { ctx, card } = setup('cytoplast-manipulator');
        const source = spawn(ctx, 'P1', card);
        const recipient = oracle({
          name: 'Independent Graft recipient',
          typeLine: 'Creature — Bear',
          power: '2',
          toughness: '2',
        });
        const targetObject = conjure(ctx, 'P2', recipient, 'hand');
        pump(moveObject(ctx, targetObject, { zone: 'battlefield', controllerId: 'P2' }));
        pump(runPrioritySequence(ctx), (decision: PendingDecision) => ({
          index: Math.max(
            0,
            decision.options.findIndex((option) => option.description === (accept ? 'Yes' : 'No')),
          ),
          targets: new Map(),
        }));
        const target = ctx.state.battlefield.find(
          (permanent) => permanent.cardId === targetObject.cardId,
        )!;
        expect(target.counters['+1/+1'] ?? 0).toBe(accept ? 1 : 0);
        expect(source.counters['+1/+1']).toBe(accept ? 1 : 2);
      });
    }
});
