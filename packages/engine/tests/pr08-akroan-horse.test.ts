import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { createGame } from '../src/state/game';
import {
  changeController,
  moveObject,
  playerById,
  queueTriggersForObject,
} from '../src/state/objects';
import { addMana } from '../src/mana/pool';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { runCombatPhase } from '../src/combat/combat';
import type { GameContext } from '../src/state/types';
import type { PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, pump, spawn } from './fixtures';
const pin = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards.find((p) => p.card.name === 'Akroan Horse')!;
function pod() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: 'akroan-contract' },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 5,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}
function answer(decision: PendingDecision, recipient = 'P2') {
  const pass = decision.options.findIndex((o) => o.type === 'pass');
  const choose = decision.options.findIndex((o) =>
    o.description.startsWith(`${recipient} gains control of`),
  );
  return { index: choose >= 0 ? choose : Math.max(0, pass), targets: new Map<number, string>() };
}
function settle(ctx: GameContext, recipient = 'P2') {
  return pump(runPrioritySequence(ctx), (d) => answer(d, recipient));
}
const horses = (ctx: GameContext) => ctx.state.battlefield.filter((p) => p.name === 'Akroan Horse');
const soldiers = (ctx: GameContext) =>
  ctx.state.battlefield.filter(
    (p) => p.isToken && computeCharacteristics(ctx, p).subtypes.includes('Soldier'),
  );
function castHorse(ctx: GameContext) {
  const card = conjure(ctx, 'P1', pin.card, 'hand');
  addMana(
    playerById(ctx, 'P1'),
    Array.from({ length: 4 }, () => ({ symbol: 'C' as const })),
  );
  const cast = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
    (o) =>
      (o.payload as PriorityActionPayload).kind === 'castSpell' &&
      (o.payload as { objectId?: string }).objectId === card.id,
  );
  expect(cast).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  settle(ctx);
  return horses(ctx)[0]!;
}
function upkeep(ctx: GameContext, player: string) {
  ctx.state.currentTurnPlayer = player;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(player);
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  queueStepTriggers(ctx, 'upkeep');
}
describe('Akroan Horse (PR08.20)', () => {
  it('akroan-pinned-oracle-and-alias — printed defender and both exact triggers are supported', () => {
    expect(pin.sha256).toBe('83e907f8af52ee2b8de87ca43905d79928e624e451b4dce7b9ae752f7fb1954f');
    for (const card of [pin.card, { ...pin.card, oracleId: 'oracle-akroan-horse' }]) {
      const def = interpretCard(card);
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.keywords).toEqual(['defender']);
      expect(def.triggers).toHaveLength(2);
      expect(def.triggers[0]!.targets).toEqual([]);
      expect(def.triggers[0]!.effects).toEqual([
        { op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } },
      ]);
      expect(def.triggers[1]!.trigger?.when).toBe('upkeep');
    }
  });
  it('akroan-normal-cast-pays-four-then-gifts — real payment stack and ETB permanently give the exact Horse away', () => {
    const ctx = pod();
    const horse = castHorse(ctx);
    expect(horse.controllerId).toBe('P2');
    expect(horse.ownerId).toBe('P1');
    expect(horse.controlChanges?.at(-1)?.duration.kind).toBe('permanent');
    expect(horse.tapped).toBe(false);
    expect(horse.summoningSick).toBe(true);
    expect(ctx.state.eventLog.filter((e) => e.type === 'castSpell')).toHaveLength(1);
    expect(ctx.state.stack).toEqual([]);
  });
  it('akroan-cast-needs-four-and-sorcery-timing — three mana and an opponent turn cannot cast the Horse', () => {
    const ctx = pod();
    const card = conjure(ctx, 'P1', pin.card, 'hand');
    const offered = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (o) => (o.payload as { objectId?: string }).objectId === card.id,
      );
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 3 }, () => ({ symbol: 'C' as const })),
    );
    expect(offered()).toBe(false);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
    expect(offered()).toBe(true);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(offered()).toBe(false);
  });
  it('akroan-defender-prevents-attacking — an untapped nonsick Horse is excluded from actual combat declarations', () => {
    const ctx = pod();
    const horse = spawn(ctx, 'P1', pin.card);
    horse.summoningSick = false;
    ctx.state.phase = 'combat';
    const { decisions } = pump(runCombatPhase(ctx), (d) => answer(d));
    expect(decisions.filter((d) => d.decisionType === 'declareAttackers')).toEqual([]);
    expect(
      ctx.state.eventLog.some(
        (e) => e.type === 'attack' && e.payload['attacker'] === 'Akroan Horse',
      ),
    ).toBe(false);
  });
  it('akroan-recipient-is-not-a-target — a hexproof opponent remains eligible and the caster is absent', () => {
    const ctx = pod();
    ctx.state.playerHexproofTurn = { P3: ctx.state.turnNumber };
    const horse = spawn(ctx, 'P1', pin.card);
    queueTriggersForObject(ctx, 'enters', horse);
    const { decisions } = settle(ctx, 'P3');
    const choice = decisions.find((d) => d.options.some((o) => o.type === 'choosePlayer'))!;
    expect(choice.player).toBe('P1');
    expect(choice.options.map((o) => o.description)).toEqual([
      'P2 gains control of Akroan Horse',
      'P3 gains control of Akroan Horse',
      'P4 gains control of Akroan Horse',
    ]);
    expect(horse.controllerId).toBe('P3');
  });
  it('akroan-original-caster-upkeep-does-not-trigger — upkeep belongs to the current controller', () => {
    const ctx = pod();
    castHorse(ctx);
    upkeep(ctx, 'P1');
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    expect(soldiers(ctx)).toEqual([]);
  });
  it('akroan-new-controller-upkeep-gives-each-opponent-a-soldier — original caster is among the recipients', () => {
    const ctx = pod();
    castHorse(ctx);
    upkeep(ctx, 'P2');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    settle(ctx);
    expect(
      soldiers(ctx)
        .map((p) => p.controllerId)
        .sort(),
    ).toEqual(['P1', 'P3', 'P4']);
    for (const soldier of soldiers(ctx)) {
      expect(soldier.ownerId).toBe(soldier.controllerId);
      expect(computeCharacteristics(ctx, soldier)).toMatchObject({
        colors: ['W'],
        power: 1,
        toughness: 1,
        subtypes: ['Soldier'],
      });
      expect(soldier.tapped).toBe(false);
    }
  });
  it('akroan-living-opponents-only — an eliminated seat receives no Soldier', () => {
    const ctx = pod();
    castHorse(ctx);
    playerById(ctx, 'P4').hasLost = true;
    upkeep(ctx, 'P2');
    settle(ctx);
    expect(
      soldiers(ctx)
        .map((p) => p.controllerId)
        .sort(),
    ).toEqual(['P1', 'P3']);
  });
  it('akroan-upkeep-ability-keeps-its-controller — later control changes do not change whose opponents receive tokens', () => {
    const ctx = pod();
    const horse = castHorse(ctx);
    upkeep(ctx, 'P2');
    changeController(ctx, horse, 'P3');
    settle(ctx);
    expect(
      soldiers(ctx)
        .map((p) => p.controllerId)
        .sort(),
    ).toEqual(['P1', 'P3', 'P4']);
    expect(horse.controllerId).toBe('P3');
  });
  it('akroan-upkeep-survives-source-departure — the queued trigger still gives tokens to its controller opponents', () => {
    const ctx = pod();
    const horse = castHorse(ctx);
    upkeep(ctx, 'P2');
    pump(moveObject(ctx, horse, { zone: 'graveyard' }));
    settle(ctx);
    expect(
      soldiers(ctx)
        .map((p) => p.controllerId)
        .sort(),
    ).toEqual(['P1', 'P3', 'P4']);
  });
  it('akroan-departed-etb-source-is-not-replaced — only the new incarnation own ETB can gift it', () => {
    const ctx = pod();
    const horse = spawn(ctx, 'P1', pin.card);
    queueTriggersForObject(ctx, 'enters', horse);
    const exiled = pump(moveObject(ctx, horse, { zone: 'exile' })).value!;
    pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    const { decisions } = settle(ctx, 'P3');
    expect(horses(ctx)[0]!.id).not.toBe(horse.id);
    expect(horses(ctx)[0]!.controllerId).toBe('P3');
    expect(decisions.filter((d) => d.options.some((o) => o.type === 'choosePlayer'))).toHaveLength(
      1,
    );
    expect(horses(ctx)[0]!.controlChanges).toHaveLength(1);
  });
  it('akroan-gift-masks-an-older-temporary-grant — an already-recipient permanent gift remains after cleanup', () => {
    const ctx = pod();
    const horse = spawn(ctx, 'P1', pin.card);
    queueTriggersForObject(ctx, 'enters', horse);
    changeController(ctx, horse, 'P2', { kind: 'untilEndOfTurn' });
    settle(ctx, 'P2');
    expect(horse.controlChanges?.at(-1)?.duration.kind).toBe('permanent');
    endUntilEotEffects(ctx);
    expect(horse.controllerId).toBe('P2');
  });
});
