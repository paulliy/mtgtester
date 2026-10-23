/** PR08.06: pinned Graft and exact-source control-lifetime regressions. */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { changeController, moveObject, playerById } from '../src/state/objects';
import { phaseOutControlledPermanents } from '../src/state/phasing';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { addMana } from '../src/mana/pool';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const selected = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { sha256: string; card: OracleCard }[];
  }
).cards.find((pin) => pin.card.name === 'Cytoplast Manipulator');
if (!selected) throw new Error('Missing Cytoplast pin');
const pin = selected;
function pod(seed: string) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  ctx.state.turnNumber = 3;
  return ctx;
}
function settle(ctx: GameContext, graft = false) {
  pump(runPrioritySequence(ctx), (decision) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    const optional = decision.options.findIndex(
      (option) => option.description === (graft ? 'Yes' : 'No'),
    );
    return { index: pass >= 0 ? pass : optional >= 0 ? optional : 0, targets: new Map() };
  });
}
function cast(ctx: GameContext) {
  const card = conjure(ctx, 'P1', pin.card, 'hand');
  addMana(
    playerById(ctx, 'P1'),
    Array.from({ length: 4 }, () => ({ symbol: 'U' as const })),
  );
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
  expect(option, 'normal {2}{U}{U} cast').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  settle(ctx);
  const source = ctx.state.battlefield.find((permanent) => permanent.cardId === card.cardId);
  expect(source).toBeDefined();
  return source!;
}
function ready(ctx: GameContext) {
  const source = cast(ctx);
  source.summoningSick = false;
  return source;
}
const bear = (name: string, text = '') =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2', oracleText: text });
function marked(ctx: GameContext, owner = 'P2', name = 'Counter Bear') {
  const target = spawn(ctx, owner, bear(name));
  target.counters['+1/+1'] = 1;
  return target;
}
function options(ctx: GameContext, source: EnginePermanent) {
  return computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === source.id;
  });
}
function announce(ctx: GameContext, source: EnginePermanent, target: EnginePermanent) {
  addMana(playerById(ctx, 'P1'), [{ symbol: 'U' }]);
  const option = options(ctx, source)[0];
  expect(option, 'normal {U}, tap activation').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, target.id]]),
    }),
  );
  expect(source.tapped).toBe(true);
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  expect(ctx.state.stack).toHaveLength(1);
}

describe('Cytoplast Manipulator (PR08.06)', () => {
  it('cytoplast-departure-observer — a stolen death watcher uses its controller before the control source dies', () => {
    const ctx = pod('cytoplast-departure-observer');
    const source = ready(ctx);
    const watcher = spawn(
      ctx,
      'P2',
      bear('Stolen death watcher', 'Whenever a creature you control dies, you gain 1 life.'),
    );
    watcher.counters['+1/+1'] = 1;
    announce(ctx, source, watcher);
    settle(ctx);
    expect(watcher.controllerId).toBe('P1');
    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    expect(watcher.controllerId).toBe('P2');
    const trigger = ctx.state.pendingTriggers.find(
      (entry) => entry.sourceCardId === watcher.cardId,
    );
    expect(trigger, 'death is observed before the source-bound control effect ends').toBeDefined();
    expect(trigger?.controllerId).toBe('P1');
    settle(ctx);
    expect(ctx.state.players.map((player) => player.life)).toEqual([41, 40, 40, 40]);
  });
  it('cytoplast-pinned-oracle-supported — retains Graft and authors the exact duration and counter target', () => {
    expect(pin.sha256).toBe('faac653c0a227cf33a3c44758770b9fed072d8d1fab969d7def6eb9d8c19f642');
    for (const card of [pin.card, { ...pin.card, oracleId: 'oracle-cytoplast-manipulator' }]) {
      const def = interpretCard(card);
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.entersWithCounters).toEqual({ '+1/+1': 2 });
      expect(def.triggers[0]?.optional).toBe(true);
      expect(def.activatedAbilities[0]?.ability.effects).toEqual([
        { op: 'gainControlTarget', target: 0, duration: 'whileSourceOnBattlefield' },
      ]);
    }
  });
  it('cytoplast-normal-cast-graft — pays four mana, enters with two counters and does not graft onto itself', () => {
    const ctx = pod('cytoplast-cast');
    const source = cast(ctx);
    expect(source.counters['+1/+1']).toBe(2);
    expect(source.summoningSick).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(computeCharacteristics(ctx, source)).toMatchObject({ power: 2, toughness: 2 });
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Cytoplast Manipulator',
      ),
    ).toBe(true);
  });
  it('cytoplast-cast-cost-and-timing — requires two blue mana and a sorcery casting window', () => {
    const ctx = pod('cytoplast-cast-negative');
    const card = conjure(ctx, 'P1', pin.card, 'hand');
    const offered = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === card.id;
      });
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 4 }, () => ({ symbol: 'C' as const })),
    );
    expect(offered()).toBe(false);
    playerById(ctx, 'P1').manaEntries = [];
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'U' },
      { symbol: 'U' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    expect(offered()).toBe(true);
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    expect(offered()).toBe(false);
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    ctx.state.activePlayerIndex = 1;
    ctx.state.currentTurnPlayer = 'P2';
    expect(offered()).toBe(false);
  });
  it.each(['P1', 'P2'])(
    'cytoplast-graft-transfer — another creature controlled by %s receives a counter through the optional trigger',
    (owner) => {
      const ctx = pod(`cytoplast-graft-${owner}`);
      const source = cast(ctx);
      const entrant = conjure(ctx, owner, bear('Graft Receiver'), 'hand');
      pump(moveObject(ctx, entrant, { zone: 'battlefield', controllerId: owner }));
      settle(ctx, true);
      expect(source.counters['+1/+1']).toBe(1);
      expect(
        ctx.state.battlefield.find((permanent) => permanent.cardId === entrant.cardId)?.counters[
          '+1/+1'
        ],
      ).toBe(1);
    },
  );
  it('cytoplast-graft-decline — declining the optional transfer preserves both counters on the source', () => {
    const ctx = pod('cytoplast-decline');
    const source = cast(ctx);
    const entrant = conjure(ctx, 'P2', bear('Declined Receiver'), 'hand');
    pump(moveObject(ctx, entrant, { zone: 'battlefield', controllerId: 'P2' }));
    settle(ctx, false);
    expect(source.counters['+1/+1']).toBe(2);
    expect(
      ctx.state.battlefield.find((permanent) => permanent.cardId === entrant.cardId)?.counters[
        '+1/+1'
      ] ?? 0,
    ).toBe(0);
  });
  it('cytoplast-last-graft-dies — transferring both counters through separate triggers leaves a 0/0 that dies to state-based actions', () => {
    const ctx = pod('cytoplast-last-graft');
    const source = cast(ctx);
    for (const name of ['First Graft Receiver', 'Last Graft Receiver']) {
      const entrant = conjure(ctx, 'P2', bear(name), 'hand');
      pump(moveObject(ctx, entrant, { zone: 'battlefield', controllerId: 'P2' }));
      settle(ctx, true);
      expect(
        ctx.state.battlefield.find((p) => p.cardId === entrant.cardId)?.counters['+1/+1'],
      ).toBe(1);
    }
    expect(ctx.state.battlefield.some((p) => p.id === source.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.some((c) => c.cardId === source.cardId)).toBe(true);
  });
  it('cytoplast-normal-activation — pays blue and taps, steals without untapping or haste, survives cleanup and losing the counter', () => {
    const ctx = pod('cytoplast-activation');
    const source = ready(ctx);
    const target = marked(ctx);
    target.tapped = true;
    announce(ctx, source, target);
    settle(ctx);
    expect(target.controllerId).toBe('P1');
    expect(target.tapped).toBe(true);
    expect(computeCharacteristics(ctx, target).keywords).not.toContain('haste');
    target.counters['+1/+1'] = 0;
    endUntilEotEffects(ctx);
    expect(target.controllerId).toBe('P1');
    changeController(ctx, source, 'P3');
    expect(target.controllerId).toBe('P1');
    pump(moveObject(ctx, source, { zone: 'hand' }));
    expect(target.controllerId).toBe('P2');
  });
  it('cytoplast-target-legality — only targetable creatures with counters qualify, including your own creatures', () => {
    const ctx = pod('cytoplast-targets');
    const source = ready(ctx);
    const enemy = marked(ctx);
    const own = marked(ctx, 'P1', 'Own Counter Bear');
    const bare = spawn(ctx, 'P2', bear('Bare Bear'));
    const protectedTarget = spawn(ctx, 'P2', bear('Hexproof Bear', 'Hexproof'));
    protectedTarget.counters['+1/+1'] = 1;
    const artifact = spawn(ctx, 'P2', oracle({ name: 'Counter Artifact', typeLine: 'Artifact' }));
    artifact.counters['+1/+1'] = 1;
    const spec = interpretCard(pin.card).activatedAbilities[0]!.ability.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', ['U'], undefined, undefined, source.cardId);
    expect(legal).toContain(enemy.id);
    expect(legal).toContain(own.id);
    expect(legal).toContain(source.id);
    for (const invalid of [bare, protectedTarget, artifact])
      expect(legal).not.toContain(invalid.id);
  });
  it('cytoplast-activation-costs — blue, untapped source, and summoning-sickness legality all matter, while an opponent’s turn is allowed', () => {
    const ctx = pod('cytoplast-costs');
    const source = ready(ctx);
    marked(ctx);
    expect(options(ctx, source)).toHaveLength(0);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'U' }]);
    expect(options(ctx, source)).toHaveLength(1);
    source.tapped = true;
    expect(options(ctx, source)).toHaveLength(0);
    source.tapped = false;
    source.summoningSick = true;
    expect(options(ctx, source)).toHaveLength(0);
    source.summoningSick = false;
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(options(ctx, source)).toHaveLength(1);
  });
  it('cytoplast-counter-removed-before-resolution — an illegal creature target fizzles without refunding tap or mana', () => {
    const ctx = pod('cytoplast-counter-gone');
    const source = ready(ctx);
    const target = marked(ctx);
    announce(ctx, source, target);
    target.counters['+1/+1'] = 0;
    settle(ctx);
    expect(target.controllerId).toBe('P2');
    expect(source.tapped).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  });
  it('cytoplast-source-control-changes-pending — the activated ability retains its original controller when its source changes control', () => {
    const ctx = pod('cytoplast-source-controller');
    const source = ready(ctx);
    const target = marked(ctx);
    announce(ctx, source, target);
    changeController(ctx, source, 'P3');
    settle(ctx);
    expect(source.controllerId).toBe('P3');
    expect(target.controllerId).toBe('P1');
    pump(moveObject(ctx, source, { zone: 'hand' }));
    expect(target.controllerId).toBe('P2');
  });
  it.each([false, true])(
    'cytoplast-source-gone-at-resolution — missing source gives no control even when it blinked=%s',
    (blink) => {
      const ctx = pod(`cytoplast-source-gone-${blink}`);
      const source = ready(ctx);
      const target = marked(ctx);
      announce(ctx, source, target);
      pump(moveObject(ctx, source, { zone: 'hand' }));
      if (blink) {
        const card = playerById(ctx, 'P1').hand.find((card) => card.cardId === source.cardId)!;
        pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
      }
      settle(ctx);
      expect(target.controllerId).toBe('P2');
      if (blink)
        expect(
          ctx.state.battlefield.find((permanent) => permanent.cardId === source.cardId)?.id,
        ).not.toBe(source.id);
    },
  );
  it('cytoplast-target-blink — a later incarnation does not inherit the old control effect', () => {
    const ctx = pod('cytoplast-target-blink');
    const source = ready(ctx);
    const target = marked(ctx);
    announce(ctx, source, target);
    settle(ctx);
    expect(target.controllerId).toBe('P1');
    pump(moveObject(ctx, target, { zone: 'hand' }));
    const card = playerById(ctx, 'P2').hand.find((card) => card.cardId === target.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P2' }));
    const next = ctx.state.battlefield.find((permanent) => permanent.cardId === target.cardId)!;
    expect(next.id).not.toBe(target.id);
    expect(next.controllerId).toBe('P2');
  });
  it('cytoplast-source-phases — source and controlled target phasing together ends the duration', () => {
    const ctx = pod('cytoplast-source-phases');
    const source = ready(ctx);
    const target = marked(ctx);
    announce(ctx, source, target);
    settle(ctx);
    phaseOutControlledPermanents(ctx, 'P1');
    expect(
      ctx.state.phasedOut?.find((record) => record.permanent.id === target.id)?.permanent
        .controllerId,
    ).toBe('P2');
  });
});
