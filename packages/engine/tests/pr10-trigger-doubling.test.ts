import { describe, expect, it } from 'vitest';
import { computeTargetOptions } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { resolveTopOfStack } from '../src/stack/stack';
import { additionalTypedTriggerCopies } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { oracle, pump, pumpStrict, spawn } from './fixtures';
import {
  bear,
  castFromHand,
  choose,
  p,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

/** A creature whose enter trigger gains its controller 3 life. */
const lifeCreature = (name: string, typeLine: string) =>
  oracle({
    name,
    typeLine,
    manaCost: '{1}',
    cmc: 1,
    power: '1',
    toughness: '1',
    oracleText: 'When this creature enters, you gain 3 life.',
  });

/** Cast `card` for P1 and count its enter triggers as they go on the stack. */
function enterTriggers(ctx: GameContext, card: ReturnType<typeof lifeCreature>): number {
  castFromHand(ctx, 'P1', card);
  pump(resolveTopOfStack(ctx));
  putPendingTriggersOnStack(ctx);
  const count = ctx.state.stack.filter((entry) => entry.kind === 'triggeredAbility').length;
  settle(ctx);
  return count;
}

describe('PR10.18 Roaming Throne', () => {
  /** P1's Roaming Throne enters through the real cast, choosing Elf. */
  function throneChoosingElf(seed: string) {
    const ctx = pod(seed);
    // The creature type choice lists types P1 has cards of.
    spawn(ctx, 'P1', lifeCreature('Throne Scout', 'Creature — Elf Scout'));
    castFromHand(ctx, 'P1', pinned('Roaming Throne'));
    pump(resolveTopOfStack(ctx), choose(/^Elf$/));
    const throne = ctx.state.battlefield.find((permanent) => permanent.name === 'Roaming Throne')!;
    return { ctx, throne };
  }

  it('pr10-roaming-throne-pinned-oracle-supported — every line is modeled', () => {
    const def = pinnedDefinition('Roaming Throne');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.ward).toBeDefined();
    expect(def.entersChoosingOption?.domain).toBe('creatureType');
  });

  it('pr10-roaming-throne-chosen-type — it is the chosen type in addition to Golem', () => {
    const { ctx, throne } = throneChoosingElf('pr10-throne-type');
    expect(throne.chosenOption).toBe('Elf');
    expect(computeCharacteristics(ctx, throne).subtypes).toEqual(
      expect.arrayContaining(['Golem', 'Elf']),
    );
  });

  it('pr10-roaming-throne-doubles-chosen-type — another Elf you control triggers twice', () => {
    const { ctx } = throneChoosingElf('pr10-throne-double');
    expect(enterTriggers(ctx, lifeCreature('Throne Elf', 'Creature — Elf Druid'))).toBe(2);
    expect(p(ctx, 'P1').life).toBe(46);
  });

  it('pr10-roaming-throne-other-type — a creature of another type triggers once', () => {
    const { ctx } = throneChoosingElf('pr10-throne-other');
    expect(enterTriggers(ctx, lifeCreature('Throne Bear', 'Creature — Bear'))).toBe(1);
    expect(p(ctx, 'P1').life).toBe(43);
  });

  it("pr10-roaming-throne-opponents-creature — an opponent's Elf is not doubled", () => {
    const { ctx } = throneChoosingElf('pr10-throne-opponent');
    const rival = spawn(ctx, 'P2', lifeCreature('Rival Elf', 'Creature — Elf'));
    expect(additionalTypedTriggerCopies(ctx, rival)).toBe(0);
  });
});

describe('PR10.24 Annie Joins Up', () => {
  const annie = pinned('Annie Joins Up');

  it('pr10-annie-joins-up-pinned-oracle-supported — both lines are modeled', () => {
    const def = pinnedDefinition('Annie Joins Up');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });

  it("pr10-annie-joins-up-enter-damage — 5 damage to an opponent's creature or planeswalker only", () => {
    const ctx = pod('pr10-annie-damage');
    const mine = spawn(ctx, 'P1', bear('Annie Ally'));
    const theirs = spawn(ctx, 'P2', bear('Annie Foe', { power: '5', toughness: '5' }));
    const spec = pinnedDefinition('Annie Joins Up').triggers[0]!.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', {
      traits: { colors: ['R', 'G', 'W'], types: ['Enchantment'] },
      kind: 'ability',
    });
    expect(legal).toContain(theirs.id);
    expect(legal).not.toContain(mine.id);
    expect(legal).not.toContain('P2');
    castFromHand(ctx, 'P1', annie);
    pump(resolveTopOfStack(ctx));
    putPendingTriggersOnStack(ctx, () => ({ index: 0, targets: new Map([[0, theirs.id]]) }));
    // Annie Joins Up is not a creature, so its own trigger is not doubled.
    expect(ctx.state.stack).toHaveLength(1);
    // The trigger is mandatory: no "use it?" is asked, and exactly 5 damage is marked.
    const { decisions } = pumpStrict(resolveTopOfStack(ctx));
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(theirs.damageMarked).toBe(5);
    settle(ctx);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === theirs.id)).toBe(false);
  });

  it('pr10-annie-joins-up-doubles-legendary — a legendary creature you control triggers twice', () => {
    const ctx = pod('pr10-annie-legend');
    spawn(ctx, 'P1', annie);
    expect(enterTriggers(ctx, lifeCreature('Annie Legend', 'Legendary Creature — Human'))).toBe(2);
    expect(p(ctx, 'P1').life).toBe(46);
  });

  it('pr10-annie-joins-up-nonlegendary — a nonlegendary creature triggers once', () => {
    const ctx = pod('pr10-annie-plain');
    spawn(ctx, 'P1', annie);
    expect(enterTriggers(ctx, lifeCreature('Annie Commoner', 'Creature — Human'))).toBe(1);
  });

  it('pr10-annie-joins-up-stacks-with-throne — each effect adds one more firing', () => {
    const ctx = pod('pr10-annie-throne');
    spawn(ctx, 'P1', annie);
    const throne = spawn(ctx, 'P1', pinned('Roaming Throne'));
    throne.chosenOption = 'Elf';
    expect(enterTriggers(ctx, lifeCreature('Annie Elf Lord', 'Legendary Creature — Elf'))).toBe(3);
    expect(p(ctx, 'P1').life).toBe(49);
  });
});
