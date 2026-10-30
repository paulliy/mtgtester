import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { loseLife } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { priorityCheckpoint } from '../src/sba/sba';
import { moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { queueStepTriggers } from '../src/turn/turn';
import { bear, oracle, pump, spawn } from './fixtures';
import {
  activate,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr11-helpers';

const CHIROGRAPHY = pinned('Intermediate Chirography');

function classAt(
  seed: string,
  level: 1 | 2 | 3,
): { ctx: GameContext; chirography: EnginePermanent } {
  const ctx = game(seed);
  castFromHand(ctx, 'P1', CHIROGRAPHY, new Map(), { B: 1, C: 1 });
  resolve(ctx);
  checkpoint(ctx);
  // The enters trigger is mandatory: no "use this ability?" yes/no is asked.
  expect(resolve(ctx).map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
  const chirography = battlefield(ctx, 'Intermediate Chirography')[0]!;
  for (let next = 2; next <= level; next++) {
    addMana(player(ctx, 'P1'), [
      { symbol: 'B' },
      ...Array.from({ length: next - 1 }, () => ({ symbol: 'C' as const })),
    ]);
    activate(ctx, 'P1', chirography);
    resolve(ctx);
  }
  expect(chirography.classLevel ?? 1).toBe(level);
  return { ctx, chirography };
}

const triggerDescriptions = (ctx: GameContext, permanent: EnginePermanent) =>
  computeCharacteristics(ctx, permanent).triggers.map((trigger) => trigger.description ?? '');

describe('Intermediate Chirography', () => {
  it('chirography-modeled — every Class line models under the Oracle and fixture ids', () => {
    for (const oracleId of [CHIROGRAPHY.oracleId, fixtureOracleId(CHIROGRAPHY.name)]) {
      const def = interpretCard({ ...CHIROGRAPHY, oracleId } as typeof CHIROGRAPHY);
      expect(def.unmodeledReasons).toEqual([]);
    }
  });

  it('chirography-c01-positive — entering creates a 2/1 white and black flying Inkling', () => {
    const { ctx } = classAt('chirography-enters', 1);
    const inklings = battlefield(ctx, 'Inkling');
    expect(inklings).toHaveLength(1);
    const chars = computeCharacteristics(ctx, inklings[0]!);
    expect([chars.power, chars.toughness, chars.colors, chars.keywords]).toEqual([
      2,
      1,
      ['W', 'B'],
      ['flying'],
    ]);
  });

  it('chirography-c02-positive — level 2 costs {1}{B} at sorcery speed and comes before level 3', () => {
    const { ctx, chirography } = classAt('chirography-level2', 1);
    addMana(player(ctx, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }, { symbol: 'C' }]);
    const options = () =>
      priorityOption(
        ctx,
        'P1',
        (p) => p.kind === 'activateAbility' && p.objectId === chirography.id,
      );
    expect(options()?.description).toContain('Gain Class level 2');
    ctx.state.phase = 'combat';
    expect(options()).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    activate(ctx, 'P1', chirography);
    resolve(ctx);
    expect(chirography.classLevel).toBe(2);
    expect(options()).toBeUndefined(); // {2}{B} needs a third mana it doesn't have
  });

  it('chirography-c02-negative — at level 1 losing life does nothing', () => {
    const { ctx } = classAt('chirography-level1-loss', 1);
    loseLife(ctx, player(ctx, 'P1'), 1);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('chirography-c03-positive — at level 2 the first life loss each turn puts a +1/+1 counter on your creature', () => {
    const { ctx } = classAt('chirography-first-loss', 2);
    expect(triggerDescriptions(ctx, battlefield(ctx, 'Intermediate Chirography')[0]!)).toContain(
      'Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control',
    );
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    loseLife(ctx, player(ctx, 'P1'), 2);
    // "Target creature you control": the targets offered are P1's creatures, never the opponent's.
    const offered: string[] = [];
    pump(priorityCheckpoint(ctx), (decision) => {
      for (const slot of decision.options[0]?.targets ?? []) offered.push(...slot.options);
      return { index: 0, targets: new Map([[0, mine.id]]) };
    });
    expect(offered).toContain(mine.id);
    expect(offered).not.toContain(theirs.id);
    const trigger = ctx.state.stack.at(-1)!;
    expect(trigger.kind).toBe('triggeredAbility');
    expect(trigger.targets).toEqual([mine.id]);
    // The trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(resolve(ctx).map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(mine.counters['+1/+1']).toBe(1);
    expect(theirs.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('chirography-c03-first-only — a second loss the same turn, and opponents losing life, do not trigger', () => {
    const { ctx } = classAt('chirography-second-loss', 2);
    spawn(ctx, 'P1', bear());
    loseLife(ctx, player(ctx, 'P2'), 3);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    loseLife(ctx, player(ctx, 'P1'), 1);
    checkpoint(ctx);
    resolve(ctx);
    loseLife(ctx, player(ctx, 'P1'), 1);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('chirography-c03-damage — combat or noncombat damage is a life loss too', () => {
    const { ctx } = classAt('chirography-damage', 2);
    const mine = spawn(ctx, 'P1', bear());
    const bolt = oracle({
      name: 'Test Bolt',
      typeLine: 'Instant',
      manaCost: '{R}',
      oracleText: 'Test Bolt deals 3 damage to any target.',
    });
    castFromHand(ctx, 'P2', bolt, new Map([[0, 'P1']]), { R: 1 });
    resolve(ctx);
    checkpoint(ctx);
    const trigger = ctx.state.stack.at(-1)!;
    expect(trigger.description).toContain('lose life for the first time');
    trigger.targets = [mine.id];
    resolve(ctx);
    expect(mine.counters['+1/+1']).toBe(1);
  });

  it("chirography-c03-already-lost — reaching level 2 after this turn's first loss waits for the next turn", () => {
    const ctx = game('chirography-late-level');
    castFromHand(ctx, 'P1', CHIROGRAPHY, new Map(), { B: 1, C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    resolve(ctx);
    const chirography = battlefield(ctx, 'Intermediate Chirography')[0]!;
    spawn(ctx, 'P1', bear());
    loseLife(ctx, player(ctx, 'P1'), 1);
    addMana(player(ctx, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
    activate(ctx, 'P1', chirography);
    resolve(ctx);
    loseLife(ctx, player(ctx, 'P1'), 1);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('chirography-c04-positive — level 3 makes an Inkling at each end step after a modified creature of yours died', () => {
    const { ctx } = classAt('chirography-modified-death', 3);
    const inklingsBefore = battlefield(ctx, 'Inkling').length;
    const modified = spawn(ctx, 'P1', bear());
    modified.counters['+1/+1'] = 1;
    pump(moveObject(ctx, modified, { zone: 'graveyard' }));
    ctx.state.step = 'end';
    queueStepTriggers(ctx, 'endStep');
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    // The trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(resolve(ctx).map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(battlefield(ctx, 'Inkling')).toHaveLength(inklingsBefore + 1);
    // "Each end step": an opponent's end step counts too, the same turn or a later one in it.
    Object.assign(ctx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1 });
    queueStepTriggers(ctx, 'endStep');
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    resolve(ctx);
    expect(battlefield(ctx, 'Inkling')).toHaveLength(inklingsBefore + 2);
  });

  it('chirography-c04-equipped — an equipped creature, or one wearing your Aura, is modified', () => {
    const { ctx } = classAt('chirography-equipped', 3);
    const before = battlefield(ctx, 'Inkling').length;
    const equipped = spawn(ctx, 'P1', bear());
    const sword = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Sword',
        typeLine: 'Artifact — Equipment',
        manaCost: '{1}',
        oracleText: '',
      }),
    );
    sword.attachedTo = equipped.id;
    pump(moveObject(ctx, equipped, { zone: 'graveyard' }));
    queueStepTriggers(ctx, 'endStep');
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    resolve(ctx);
    expect(battlefield(ctx, 'Inkling')).toHaveLength(before + 1);
  });

  it("chirography-c04-negative — unmodified deaths, an opponent's Aura, or an opponent's modified creature make nothing", () => {
    const { ctx } = classAt('chirography-unmodified', 3);
    const before = battlefield(ctx, 'Inkling').length;
    const plain = spawn(ctx, 'P1', bear());
    const cursed = spawn(ctx, 'P1', bear());
    const aura = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Aura',
        typeLine: 'Enchantment — Aura',
        manaCost: '{1}',
        oracleText: '',
      }),
    );
    aura.attachedTo = cursed.id;
    const theirs = spawn(ctx, 'P2', bear());
    theirs.counters['+1/+1'] = 2;
    for (const dying of [plain, cursed, theirs])
      pump(moveObject(ctx, dying, { zone: 'graveyard' }));
    queueStepTriggers(ctx, 'endStep');
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(battlefield(ctx, 'Inkling')).toHaveLength(before);
  });

  it('chirography-c04-level2 — at level 2 a modified death makes no Inkling', () => {
    const { ctx } = classAt('chirography-level2-death', 2);
    const modified = spawn(ctx, 'P1', bear());
    modified.counters['+1/+1'] = 1;
    pump(moveObject(ctx, modified, { zone: 'graveyard' }));
    checkpoint(ctx);
    while (ctx.state.stack.length > 0) resolve(ctx);
    queueStepTriggers(ctx, 'endStep');
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
  });
});
