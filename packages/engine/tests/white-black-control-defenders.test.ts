import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { registerWhiteBlackControlDefenderOverrides } from '../src/cards/overrides/white-black-control-defenders';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { runCombatPhase } from '../src/combat/combat';
import { changeController, moveObject } from '../src/state/objects';
import { computeCharacteristics } from '../src/effects/continuous';
import type { GameContext } from '../src/state/types';
import { bear, conjure, copies, declareAttacks, declareNoBlocks, forest, gameConfig, oracle, plains, pump, spawn } from './fixtures';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8')) as { cards: { sha256: string; card: OracleCard }[] };
const pins = {
  'Archon of Absolution': '9bd606953d9c7d2b28966ca403927c18bb825ffbfbac485fc051b9528b23014e',
  'Soul Snare': '994bae03a713184fd5257172464dc1836785328517d213136f2f45d5c4e89855',
} as const;
beforeAll(registerWhiteBlackControlDefenderOverrides);
function card(name: keyof typeof pins) { return fixture.cards.find((entry) => entry.card.name === name)!.card; }
function setup() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed: 'defender-cards' }));
  Object.assign(ctx.state, { currentTurnPlayer: 'P1', turnNumber: 4, phase: 'precombatMain', step: null });
  return ctx;
}
function cast(ctx: GameContext, name: keyof typeof pins) {
  for (let index = 0; index < 4; index++) spawn(ctx, 'P1', plains());
  const object = conjure(ctx, 'P1', card(name), 'hand');
  const player = ctx.state.players[0]!;
  const action = computePriorityOptions(ctx, player).find((option) => { const p = option.payload as PriorityActionPayload; return p.kind === 'castSpell' && p.objectId === object.id; });
  expect(action).toBeDefined();
  pump(applyPriorityAction(ctx, player, action!.payload as PriorityActionPayload, { index: 0, targets: new Map() }));
  pump(resolveTopOfStack(ctx));
  return ctx.state.battlefield.find((permanent) => permanent.cardId === object.cardId)!;
}

describe('white black defender cards', () => {
  it('pins complete Oracle definitions including flying and protection from white', () => {
    for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
      expect(fixture.cards.find((entry) => entry.card.name === name)!.sha256).toBe(pins[name]);
      expect(validateCardDefinition(interpretCard(card(name)))).toEqual([]);
    }
    const ctx = setup();
    const archon = cast(ctx, 'Archon of Absolution');
    expect(computeCharacteristics(ctx, archon).keywords).toContain('flying');
    expect(computeCharacteristics(ctx, archon).protectionFrom).toContain('W');
  });

  it('archon-absolution-c02 requires tax against both its controller and their planeswalker, but not another opponent', () => {
    const ctx = setup();
    cast(ctx, 'Archon of Absolution');
    const walker = spawn(ctx, 'P1', oracle({ name: 'Protected Walker', typeLine: 'Planeswalker', loyalty: '8' }));
    spawn(ctx, 'P2', bear());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const options = d.options[0]!.targets![0]!.options;
        expect(options).not.toContain('P1');
        expect(options).not.toContain(walker.id);
        expect(options).toContain('P3');
        return declareAttacks(d, () => 'P3');
      }
      return { index: 0, targets: new Map() };
    });
    expect(ctx.state.players[2]!.life).toBe(38);
  });

  it('archon-absolution-c02 pays the ordinary per-creature planeswalker attack tax', () => {
    const ctx = setup();
    cast(ctx, 'Archon of Absolution');
    const walker = spawn(ctx, 'P1', oracle({ name: 'Paid Walker', typeLine: 'Planeswalker', loyalty: '8' }));
    walker.counters['loyalty'] = 8;
    spawn(ctx, 'P2', bear());
    const land = spawn(ctx, 'P2', forest());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') return declareAttacks(d, () => walker.id);
      if (d.decisionType === 'declareBlockers') return declareNoBlocks(d);
      return { index: 0, targets: new Map() };
    });
    expect(land.tapped).toBe(true);
    expect(walker.counters['loyalty']).toBe(6);
    expect(ctx.state.players[0]!.life).toBe(40);
  });

  for (const defender of ['you', 'walker'] as const) it(`soul-snare-c01 pays W and sacrifices the normally cast enchantment to exile an attacker against ${defender}`, () => {
    const ctx = setup();
    const snare = cast(ctx, 'Soul Snare');
    spawn(ctx, 'P1', plains());
    const walker = spawn(ctx, 'P1', oracle({ name: 'Snare Walker', typeLine: 'Planeswalker', loyalty: '8' }));
    const attacker = spawn(ctx, 'P2', bear());
    attacker.attacking = defender === 'you' ? 'P1' : walker.id;
    attacker.attackingPlayerId = 'P1';
    if (defender === 'walker') attacker.attackingPlaneswalkerControlChanges = 0;
    const unrelated = spawn(ctx, 'P2', bear());
    unrelated.attacking = 'P3';
    const player = ctx.state.players[0]!;
    const action = computePriorityOptions(ctx, player).find((option) => { const p = option.payload as PriorityActionPayload; return p.kind === 'activateAbility' && p.objectId === snare.id; });
    expect(action).toBeDefined();
    expect(action!.targets![0]!.options).toEqual([attacker.id]);
    pump(applyPriorityAction(ctx, player, action!.payload as PriorityActionPayload, { index: 0, targets: new Map([[0, attacker.id]]) }));
    expect(player.graveyard.some((object) => object.cardId === snare.cardId)).toBe(true);
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.exile.some((object) => object.cardId === attacker.cardId)).toBe(true);
    expect(ctx.state.battlefield).toContain(unrelated);
  });

  it('soul-snare-c01 rechecks an attacking planeswalker target when the defender changes control or leaves', () => {
    for (const change of ['control', 'leave', 'type'] as const) {
      const ctx = setup();
      const snare = cast(ctx, 'Soul Snare');
      spawn(ctx, 'P1', plains());
      const walker = spawn(ctx, 'P1', oracle({ name: 'Changing Walker', typeLine: 'Planeswalker', loyalty: '8' }));
      const attacker = spawn(ctx, 'P2', bear());
      attacker.attacking = walker.id;
      attacker.attackingPlayerId = 'P1';
      attacker.attackingPlaneswalkerControlChanges = 0;
      const player = ctx.state.players[0]!;
      const action = computePriorityOptions(ctx, player).find((option) => { const p = option.payload as PriorityActionPayload; return p.kind === 'activateAbility' && p.objectId === snare.id; })!;
      pump(applyPriorityAction(ctx, player, action.payload as PriorityActionPayload, { index: 0, targets: new Map([[0, attacker.id]]) }));
      if (change === 'control') changeController(ctx, walker, 'P3');
      else if (change === 'leave') pump(moveObject(ctx, walker, { zone: 'hand' }));
      else ctx.state.effects.push({ id: 'type-change', sourceId: walker.cardId, description: 'Lose planeswalker type', targetCardIds: [walker.cardId], kind: 'becomeCreature', timestamp: ctx.state.nextTimestamp++, becomeCreature: { replaceTypes: ['Creature'], addSubtypes: [], power: 8, toughness: 8, addKeywords: [] } });
      pump(resolveTopOfStack(ctx));
      expect(ctx.state.battlefield, change).toContain(attacker);
    }
  });
});
