/** PR08.02: public choices and one simultaneous destruction event. */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { allOf, ofType, OTHER, YOURS } from '../src/cards/selector';
import { triggered } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { emit } from '../src/log/log';
import { formatPlayerLog } from '../src/view/spectator';
import { createGame } from '../src/state/game';
import { changeController, moveObject, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { copies, forest, gameConfig, oracle, pump, registerCustomDef, spawn } from './fixtures';

const selected = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards.find((p) => p.card.name === 'Druid of Purification');
if (!selected) throw new Error('Missing Druid Oracle pin');
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
  ctx.state.turnNumber = 4;
  return ctx;
}
const permanent = (ctx: GameContext, player: string, name: string, type = 'Artifact', text = '') =>
  spawn(
    ctx,
    player,
    oracle({
      name,
      typeLine: type,
      oracleText: text,
      ...(type.includes('Creature')
        ? { power: '2', toughness: '2' }
        : { power: null, toughness: null }),
    }),
  );
function snapshot(source: EnginePermanent) {
  return {
    id: source.id,
    cardId: source.cardId,
    oracleId: source.oracleId,
    name: source.name,
    controllerId: source.controllerId,
  };
}
type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;
const decline = () => ({ index: 0, targets: new Map<number, string>() });
function resolveDruid(ctx: GameContext, source: EnginePermanent, answer: Answer = decline) {
  const ability = interpretCard(pin.card).triggers[0]!;
  return pump(executeAbility(ctx, snapshot(source), ability, []), answer);
}
function choose(decision: PendingDecision, name: string) {
  const index = decision.options.findIndex((option) => option.description === `Destroy ${name}`);
  expect(index, `${decision.player} can choose ${name}`).toBeGreaterThan(0);
  return { index, targets: new Map<number, string>() };
}
const destroyed = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'destroy');

describe('Druid of Purification (PR08.02)', () => {
  it('druid-pinned-oracle-supported — both registrations author the complete pinned enter trigger', () => {
    expect(pin.sha256).toBe('ad0aec5a820bd47f7731dc2f6350d35f77a1277ebb5a26936dd47d863df62633');
    for (const card of [pin.card, { ...pin.card, oracleId: fixtureOracleId(pin.card.name) }]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.modeled).toBe(true);
      expect(def.triggers).toHaveLength(1);
      expect(def.triggers[0]).toMatchObject({
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: [],
        effects: [{ op: 'druidPurification' }],
      });
    }
  });
  it('druid-all-menus-and-decline — every chooser excludes the ability controller and may choose none', () => {
    const ctx = pod('druid-menus'),
      source = spawn(ctx, 'P1', pin.card);
    const own = permanent(ctx, 'P1', 'Own Artifact'),
      ownEnchantment = permanent(ctx, 'P1', 'Own Enchantment', 'Enchantment');
    const a = permanent(ctx, 'P2', 'Opponent Artifact'),
      e = permanent(ctx, 'P3', 'Opponent Enchantment', 'Enchantment');
    const shroud = permanent(ctx, 'P2', 'Shrouded Artifact', 'Artifact', 'Shroud');
    const hexproof = permanent(ctx, 'P2', 'Hexproof Artifact', 'Artifact', 'Hexproof');
    const creature = permanent(ctx, 'P2', 'Ordinary Creature', 'Creature — Bear');
    const expected = [a, e, shroud, hexproof].map((p) => `Destroy ${p.name}`).sort();
    const { decisions } = resolveDruid(ctx, source, (decision) => {
      expect(decision.decisionType).toBe('general');
      expect(decision.options[0]?.description).toBe('Choose none');
      expect(
        decision.options
          .slice(1)
          .map((o) => o.description)
          .sort(),
      ).toEqual(expected);
      expect(decision.options.every((o) => o.targets === undefined)).toBe(true);
      return decline();
    });
    expect(decisions.map((d) => d.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(ctx.state.battlefield).toEqual(
      expect.arrayContaining([own, ownEnchantment, a, e, shroud, hexproof, creature]),
    );
    expect(destroyed(ctx)).toHaveLength(0);
  });
  it('druid-no-eligible-permanents — all four forced declines publish choices and destroy nothing', () => {
    const ctx = pod('druid-empty-pool'),
      source = spawn(ctx, 'P1', pin.card);
    const own = permanent(ctx, 'P1', 'Own Artifact');
    const creature = permanent(ctx, 'P2', 'Ordinary Creature', 'Creature — Bear');
    const { decisions } = resolveDruid(ctx, source, () => {
      throw new Error('Only decline is legal, so no interactive choice is needed');
    });
    expect(decisions).toEqual([]);
    expect(ctx.state.battlefield).toEqual(expect.arrayContaining([source, own, creature]));
    expect(destroyed(ctx)).toEqual([]);
    const choices = ctx.state.eventLog.filter((event) => event.type === 'permanentChoice');
    expect(choices.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(
      choices.every(
        (event) => event.payload['name'] === null && event.payload['objectId'] === null,
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    'druid-turn-order — a nonactive controller starts the choices, departed P4=%s',
    (departed) => {
      const ctx = pod(`druid-order-${departed}`),
        source = spawn(ctx, 'P3', pin.card);
      permanent(ctx, 'P2', 'Order Choice Artifact');
      playerById(ctx, 'P4').hasLost = departed;
      const { decisions } = resolveDruid(ctx, source);
      expect(decisions.map((d) => d.player)).toEqual(
        departed ? ['P3', 'P1', 'P2'] : ['P3', 'P4', 'P1', 'P2'],
      );
    },
  );
  it('druid-duplicate-choice-once — all choices finish before a permanent chosen four times is destroyed once', () => {
    const ctx = pod('druid-duplicate'),
      source = spawn(ctx, 'P1', pin.card),
      target = permanent(ctx, 'P2', 'Shared Artifact');
    let choices = 0;
    resolveDruid(ctx, source, (decision) => {
      expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(true);
      expect(destroyed(ctx)).toHaveLength(0);
      choices++;
      return choose(decision, target.name);
    });
    expect(choices).toBe(4);
    expect(destroyed(ctx)).toHaveLength(1);
    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(false);
    expect(playerById(ctx, 'P2').graveyard.filter((c) => c.cardId === target.cardId)).toHaveLength(
      1,
    );
  });
  it('druid-public-choices — later choosers see earlier picks while private general choices remain hidden', () => {
    const ctx = pod('druid-public-choices'),
      source = spawn(ctx, 'P1', pin.card),
      target = permanent(ctx, 'P2', 'Public Choice Artifact');
    resolveDruid(ctx, source, (decision, count) => {
      const prior = formatPlayerLog(ctx.state.eventLog, decision.player).filter(
        (line) => line.text === `${source.name}: chooses ${target.name}`,
      );
      expect(prior).toHaveLength(count - 1);
      expect(destroyed(ctx)).toHaveLength(0);
      return choose(decision, target.name);
    });
    const choices = ctx.state.eventLog.filter((event) => event.type === 'permanentChoice');
    expect(choices.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(choices.every((event) => event.payload['objectId'] === target.id)).toBe(true);
    emit(ctx, 'decision', { decisionType: 'general', description: 'Hidden Test Card' }, 'P1');
    expect(
      formatPlayerLog(ctx.state.eventLog, 'P2').some((line) => line.text === 'Hidden Test Card'),
    ).toBe(false);
    expect(
      formatPlayerLog(ctx.state.eventLog, 'P1').some((line) => line.text === 'Hidden Test Card'),
    ).toBe(true);
  });
  it.each(['Shroud', 'Hexproof'])(
    'druid-nontargeting — %s does not prevent choosing and destroying the permanent',
    (keyword) => {
      const ctx = pod(`druid-${keyword}`),
        source = spawn(ctx, 'P1', pin.card),
        target = permanent(ctx, 'P2', 'Protected Artifact', 'Artifact', keyword);
      resolveDruid(ctx, source, (decision) => choose(decision, target.name));
      expect(destroyed(ctx)).toHaveLength(1);
      expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(false);
    },
  );
  it('druid-indestructible — a legal choice can be indestructible, and duplicate choices cause one prevention', () => {
    const ctx = pod('druid-indestructible'),
      source = spawn(ctx, 'P1', pin.card),
      target = permanent(ctx, 'P2', 'Indestructible Artifact', 'Artifact', 'Indestructible');
    resolveDruid(ctx, source, (decision) => choose(decision, target.name));
    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(true);
    expect(destroyed(ctx)).toHaveLength(0);
    expect(ctx.state.eventLog.filter((e) => e.type === 'destroyPrevented')).toHaveLength(1);
  });
  it('druid-regeneration — one shield survives duplicate choices because destruction is attempted once', () => {
    const ctx = pod('druid-regeneration'),
      source = spawn(ctx, 'P1', pin.card),
      target = permanent(ctx, 'P2', 'Regenerating Artifact', 'Artifact Creature — Golem');
    target.regenerationShields = 1;
    resolveDruid(ctx, source, (decision) => choose(decision, target.name));
    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(true);
    expect(target.regenerationShields).toBe(0);
    expect(target.tapped).toBe(true);
    expect(destroyed(ctx)).toHaveLength(0);
  });
  it('druid-protection-before-departure — a simultaneous protection granter leaving does not expose the protected artifact to that event', () => {
    const ctx = pod('druid-static'),
      source = spawn(ctx, 'P1', pin.card);
    const grantCard = oracle({ name: 'Protection Granter', typeLine: 'Artifact' });
    registerCustomDef(ctx, {
      ...interpretCard(grantCard),
      staticEffects: [
        {
          affects: allOf(ofType('Artifact'), YOURS, OTHER),
          op: { layer: 6, addKeyword: 'indestructible' },
        },
      ],
    });
    const granter = spawn(ctx, 'P2', grantCard),
      target = permanent(ctx, 'P2', 'Protected Companion');
    expect(computeCharacteristics(ctx, target).keywords).toContain('indestructible');
    resolveDruid(ctx, source, (decision, count) =>
      count === 1
        ? choose(decision, granter.name)
        : count === 2
          ? choose(decision, target.name)
          : decline(),
    );
    expect(ctx.state.battlefield.some((p) => p.id === granter.id)).toBe(false);
    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(true);
    expect(computeCharacteristics(ctx, target).keywords).not.toContain('indestructible');
    expect(destroyed(ctx)).toHaveLength(1);
    expect(ctx.state.eventLog.filter((e) => e.type === 'destroyPrevented')).toHaveLength(1);
  });
  it('druid-simultaneous-death-watchers — a chosen watcher leaving with another chosen artifact creature sees that death', () => {
    const ctx = pod('druid-watchers'),
      source = spawn(ctx, 'P1', pin.card);
    const watcherCard = oracle({
      name: 'Artifact Death Watcher',
      typeLine: 'Artifact Creature — Golem',
      power: '2',
      toughness: '2',
    });
    registerCustomDef(ctx, {
      ...interpretCard(watcherCard),
      triggers: [
        triggered(
          {
            when: 'dies',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, OTHER) },
          },
          { effects: [{ op: 'draw', count: constant(1) }] },
        ),
      ],
    });
    const watcher = spawn(ctx, 'P2', watcherCard),
      other = permanent(ctx, 'P2', 'Other Artifact Creature', 'Artifact Creature — Golem');
    const hand = playerById(ctx, 'P2').hand.length;
    resolveDruid(ctx, source, (decision, count) =>
      count === 1
        ? choose(decision, watcher.name)
        : count === 2
          ? choose(decision, other.name)
          : decline(),
    );
    expect(ctx.state.battlefield.some((p) => p.id === watcher.id || p.id === other.id)).toBe(false);
    expect(destroyed(ctx)).toHaveLength(2);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx), (decision) => ({
      index: Math.max(
        0,
        decision.options.findIndex((o) => o.type === 'pass'),
      ),
      targets: new Map(),
    }));
    expect(playerById(ctx, 'P2').hand).toHaveLength(hand + 1);
  });
  it('druid-original-controller-and-source-leaves — the enter ability excludes its original controller after the creature changes control and leaves', () => {
    const ctx = pod('druid-source-leaves'),
      source = spawn(ctx, 'P1', pin.card),
      meta = snapshot(source);
    const own = permanent(ctx, 'P1', 'Original Controller Artifact'),
      target = permanent(ctx, 'P3', 'New Controller Artifact');
    changeController(ctx, source, 'P3');
    pump(moveObject(ctx, source, { zone: 'hand' }));
    const { decisions } = pump(
      executeAbility(ctx, meta, interpretCard(pin.card).triggers[0]!, []),
      (decision) => {
        expect(decision.options.some((o) => o.description === `Destroy ${own.name}`)).toBe(false);
        return choose(decision, target.name);
      },
    );
    expect(decisions.map((d) => d.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(ctx.state.battlefield.some((p) => p.id === own.id)).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.id === target.id)).toBe(false);
    expect(destroyed(ctx)).toHaveLength(1);
  });
});
