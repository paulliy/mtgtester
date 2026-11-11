/**
 * "Enchanted/Equipped creature <clause> and has <keywords>" lines.
 *
 * The anthem grammar matches its subject lazily, so on these lines it handed `parseSubject`
 * phrases like "equipped creature can't be blocked and". `parseSubject` used to read any phrase
 * starting with "equipped "/"enchanted " as the attached creature, so the card came out modeled
 * with only the trailing keywords: Whispersilk Cloak lost "can't be blocked", Ethereal Armor its
 * buff, On Serra's Wings its +1/+1 and legendary, and Greater Auramancy's "enchanted creatures you
 * control" pointed at a creature it is never attached to. Found by comparing the interpreter's
 * output with XMage's implementations (scripts/xmage-import/agreement.ts).
 */
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  pumpStrict,
  spawn,
} from './fixtures';

const CLOAK = oracle({
  name: 'Whispersilk Cloak',
  typeLine: 'Artifact — Equipment',
  manaCost: '{3}',
  oracleText:
    "Equipped creature can't be blocked and has shroud. (It can't be the target of spells or abilities.)\nEquip {2}",
});
const ARMOR = oracle({
  name: 'Ethereal Armor',
  typeLine: 'Enchantment — Aura',
  manaCost: '{W}',
  oracleText:
    'Enchant creature\nEnchanted creature gets +1/+1 for each enchantment you control and has first strike.',
});
const CLAWS = oracle({
  name: 'Claws of Valakut',
  typeLine: 'Enchantment — Aura',
  manaCost: '{1}{R}{R}',
  oracleText:
    'Enchant creature\nEnchanted creature gets +1/+0 for each Mountain you control and has first strike.',
});
const MACE = oracle({
  name: 'Mace of the Valiant',
  typeLine: 'Artifact — Equipment',
  manaCost: '{2}{W}',
  oracleText:
    'Equipped creature gets +1/+1 for each charge counter on this Equipment and has vigilance.\nWhenever a creature you control enters, put a charge counter on this Equipment.\nEquip {3}',
});
const WINGS = oracle({
  name: "On Serra's Wings",
  typeLine: 'Legendary Enchantment — Aura',
  manaCost: '{3}{W}',
  oracleText:
    'Enchant creature\nEnchanted creature is legendary, gets +1/+1, and has flying, vigilance, and lifelink.',
});
const AURAMANCY = oracle({
  name: 'Greater Auramancy',
  typeLine: 'Enchantment',
  manaCost: '{1}{W}{W}',
  oracleText:
    'Other enchantments you control have shroud.\nEnchanted creatures you control have shroud.',
});
const PLAIN_AURA = oracle({
  name: 'Lab Plain Aura',
  typeLine: 'Enchantment — Aura',
  manaCost: '{W}',
  oracleText: 'Enchant creature',
});
const bear = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

function pod(seed: string): GameContext {
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

/** P1's priority option on `objectId` whose description matches `pattern`. */
function optionFor(ctx: GameContext, objectId: string, pattern?: RegExp) {
  return computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      'objectId' in payload &&
      payload.objectId === objectId &&
      (pattern === undefined || pattern.test(option.description))
    );
  });
}

/** Take P1's option through the normal legality and payment path, then resolve it. */
function takeAndResolve(
  ctx: GameContext,
  option: NonNullable<ReturnType<typeof optionFor>>,
  targetId: string,
) {
  pumpStrict(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[option.targets![0]!.slot, targetId]]),
    }),
  );
  pumpStrict(resolveTopOfStack(ctx));
}

/** Every P1 creature attacks P2; returns the attackers P2 was offered as blockable. */
function attackP2(ctx: GameContext): string[] {
  const offered: string[] = [];
  pump(
    runCombatAndExtraCombats(ctx),
    (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, () => 'P2');
      if (decision.presentationBlockDeclaration !== undefined) {
        for (const subject of decision.presentationBlockDeclaration.subjects)
          offered.push(...subject.attackers.map((attacker) => attacker.attackerId));
        return declareBlocks(decision, () => null);
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return pass < 0 ? undefined : { index: pass, targets: new Map() };
    },
    { strict: true },
  );
  return offered;
}

describe('attached-subject clauses', () => {
  it('Whispersilk Cloak: the equipped creature cannot be blocked and has shroud', () => {
    const def = interpretCard(CLOAK);
    expect(def.modeled).toBe(true);
    const ctx = pod('attached-cloak');
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    const other = spawn(ctx, 'P1', bear('Lab Other'));
    spawn(ctx, 'P1', CLOAK).attachedTo = host.id;
    const chars = computeCharacteristics(ctx, host);
    expect(chars.cantBeBlocked).toBe(true);
    expect(chars.keywords).toContain('shroud');
    expect(computeCharacteristics(ctx, other).cantBeBlocked).toBe(false);
  });

  it('Whispersilk Cloak, normal path: equipped through Equip {2}, its creature is never offered to blockers', () => {
    const ctx = pod('attached-cloak-equip');
    const cloak = spawn(ctx, 'P1', CLOAK);
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    const plain = spawn(ctx, 'P1', bear('Lab Plain'));
    spawn(ctx, 'P2', bear('Lab Blocker'));
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
    const equip = optionFor(ctx, cloak.id, /Equip/);
    expect(equip, 'Equip {2} is offered').toBeDefined();
    takeAndResolve(ctx, equip!, host.id);
    expect(cloak.attachedTo).toBe(host.id);
    const blockable = attackP2(ctx);
    expect(blockable).not.toContain(host.id);
    // Negative: the unequipped attacker beside it can still be blocked.
    expect(blockable).toContain(plain.id);
  });

  it('Ethereal Armor, normal path: cast onto a creature, it buffs that creature only', () => {
    const ctx = pod('attached-armor-cast');
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    const other = spawn(ctx, 'P1', bear('Lab Other'));
    const inHand = conjure(ctx, 'P1', ARMOR, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }]);
    const cast = optionFor(ctx, inHand.id);
    expect(cast, 'Ethereal Armor can be cast').toBeDefined();
    takeAndResolve(ctx, cast!, host.id);
    const onHost = computeCharacteristics(ctx, host);
    // Ethereal Armor is the one enchantment P1 controls.
    expect([onHost.power, onHost.toughness]).toEqual([3, 3]);
    expect(onHost.keywords).toContain('first strike');
    const onOther = computeCharacteristics(ctx, other);
    expect([onOther.power, onOther.toughness]).toEqual([2, 2]);
    expect(onOther.keywords).not.toContain('first strike');
  });

  it('Ethereal Armor: +1/+1 per enchantment you control, plus first strike', () => {
    const ctx = pod('attached-armor');
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    spawn(ctx, 'P1', ARMOR).attachedTo = host.id;
    spawn(ctx, 'P1', PLAIN_AURA).attachedTo = host.id;
    spawn(ctx, 'P2', PLAIN_AURA);
    const chars = computeCharacteristics(ctx, host);
    // Two enchantments under P1's control; P2's does not count.
    expect([chars.power, chars.toughness]).toEqual([4, 4]);
    expect(chars.keywords).toContain('first strike');
  });

  it('Claws of Valakut: +1/+0 per Mountain, toughness unchanged', () => {
    const def = interpretCard(CLAWS);
    expect(def.modeled).toBe(true);
    const buff = def.staticEffects.find((s) => s.op.layer === 7);
    expect(buff?.affects).toEqual({ kind: 'attachedToSource' });
    expect(def.staticEffects.some((s) => s.op.layer === 6 && 'addKeyword' in s.op)).toBe(true);
  });

  it('Mace of the Valiant: +1/+1 per charge counter on the Equipment itself', () => {
    const ctx = pod('attached-mace');
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    const mace = spawn(ctx, 'P1', MACE);
    mace.attachedTo = host.id;
    mace.counters = { ...mace.counters, charge: 3 };
    const chars = computeCharacteristics(ctx, host);
    expect([chars.power, chars.toughness]).toEqual([5, 5]);
    expect(chars.keywords).toContain('vigilance');
  });

  it("On Serra's Wings: legendary, +1/+1, and three keywords", () => {
    const ctx = pod('attached-wings');
    const host = spawn(ctx, 'P1', bear('Lab Host'));
    spawn(ctx, 'P1', WINGS).attachedTo = host.id;
    const chars = computeCharacteristics(ctx, host);
    expect(chars.supertypes).toContain('Legendary');
    expect([chars.power, chars.toughness]).toEqual([3, 3]);
    expect(chars.keywords).toEqual(expect.arrayContaining(['flying', 'vigilance', 'lifelink']));
  });

  it('Greater Auramancy: every enchanted creature you control, not an attached creature', () => {
    const ctx = pod('attached-auramancy');
    spawn(ctx, 'P1', AURAMANCY);
    const enchanted = spawn(ctx, 'P1', bear('Lab Enchanted'));
    const bare = spawn(ctx, 'P1', bear('Lab Bare'));
    const theirs = spawn(ctx, 'P2', bear('Lab Theirs'));
    spawn(ctx, 'P1', PLAIN_AURA).attachedTo = enchanted.id;
    spawn(ctx, 'P1', PLAIN_AURA).attachedTo = theirs.id;
    expect(computeCharacteristics(ctx, enchanted).keywords).toContain('shroud');
    expect(computeCharacteristics(ctx, bare).keywords).not.toContain('shroud');
    expect(computeCharacteristics(ctx, theirs).keywords).not.toContain('shroud');
  });

  it('a clause the grammar cannot read leaves the card unmodeled instead of half-modeled', () => {
    // Tenza's conditional buffs and Thran Power Suit's "attached to it" count have no parse yet.
    for (const text of [
      "Equipped creature gets +1/+1. As long as it's legendary, it gets an additional +2/+2. As long as it's red, it has trample.",
      'Equipped creature gets +1/+1 for each Aura and Equipment attached to it and has ward {2}.',
      'Enchanted creature gets +2/+2 for each Aura attached to it and has vigilance.',
    ]) {
      const def = interpretCard(
        oracle({ name: 'Lab Attached', typeLine: 'Artifact — Equipment', oracleText: text }),
      );
      expect(def.modeled, text).toBe(false);
    }
  });
});
