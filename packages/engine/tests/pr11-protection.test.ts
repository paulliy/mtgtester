import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { computeTargetOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { moveObject } from '../src/state/objects';
import { hasKeyword, hasProtectionFrom } from '../src/state/queries';
import { bear, conjure, oracle, pump, spawn } from './fixtures';
import {
  activate,
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  combat,
  fixture,
  game,
  offeredTargets,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr11-helpers';

const LIGHTHOUSE = pinned('Arcane Lighthouse');
const LIEUTENANT = pinned("Basri's Lieutenant");
const SHANNA = pinned("Shanna, Sisay's Legacy");
const MANTLE = pinned('Spirit Mantle');
const AUTHORITY = pinned('Unquestioned Authority');

const goldCreature = (): OracleCard =>
  oracle({
    name: 'Gold Bruiser',
    typeLine: 'Creature — Test',
    manaCost: '{R}{W}',
    colors: ['R', 'W'],
    power: '3',
    toughness: '3',
  });
const redCreature = (): OracleCard =>
  oracle({
    name: 'Red Bruiser',
    typeLine: 'Creature — Test',
    manaCost: '{R}',
    colors: ['R'],
    power: '3',
    toughness: '3',
  });
const goldBolt = (): OracleCard =>
  oracle({
    name: 'Gold Bolt',
    typeLine: 'Instant',
    manaCost: '{R}{W}',
    colors: ['R', 'W'],
    oracleText: 'Gold Bolt deals 3 damage to any target.',
  });
const redBolt = (): OracleCard =>
  oracle({
    name: 'Red Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Red Bolt deals 3 damage to any target.',
  });
const pingerCreature = (): OracleCard =>
  oracle({
    name: 'Pinger',
    typeLine: 'Creature — Test',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: '{T}: Pinger deals 1 damage to any target.',
    power: '1',
    toughness: '1',
  });
const pingerRod = (): OracleCard =>
  oracle({
    name: 'Rod',
    typeLine: 'Artifact',
    manaCost: '{1}',
    oracleText: '{T}: Rod deals 1 damage to any target.',
  });
const hexproofer = (): OracleCard =>
  oracle({
    name: 'Hex Giver',
    typeLine: 'Instant',
    manaCost: '{G}',
    colors: ['G'],
    oracleText: 'Target creature gains hexproof until end of turn.',
  });

describe('PR11 Oracle pins', () => {
  it('pr11-oracle-pins — pins the 30 assigned Oracle identities and full definitions', () => {
    expect(fixture.cards).toHaveLength(30);
    expect(new Set(fixture.cards.map(({ card }) => card.oracleId)).size).toBe(30);
    for (const { card, sha256 } of fixture.cards) {
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
    }
  });

  it('pr11-protection-modeled — the five protection cards model with every reason cleared', () => {
    for (const card of [LIGHTHOUSE, LIEUTENANT, SHANNA, MANTLE, AUTHORITY]) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, card.name).toEqual([]);
      expect(def.modeled, card.name).toBe(true);
      const alias = interpretCard({
        ...card,
        oracleId: `oracle-${card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      });
      expect(alias.modeled, `${card.name} fixture alias`).toBe(true);
    }
  });
});

describe("Basri's Lieutenant — protection from multicolored", () => {
  it('basri-c01-positive — multicolored spells cannot target it and multicolored damage is prevented', () => {
    const ctx = game('basri-multicolored');
    const lieutenant = spawn(ctx, 'P1', LIEUTENANT);
    expect(computeCharacteristics(ctx, lieutenant).protectionFrom).toEqual(['multicolored']);
    expect(hasKeyword(ctx, lieutenant, 'vigilance')).toBe(true);
    const gold = (payload: PriorityActionPayload) => payload.kind === 'castSpell';
    conjure(ctx, 'P2', goldBolt(), 'hand');
    addMana(player(ctx, 'P2'), [{ symbol: 'R' }, { symbol: 'W' }]);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(offeredTargets(ctx, 'P2', gold)).not.toContain(lieutenant.id);
    const goldSource = spawn(ctx, 'P2', goldCreature());
    expect(hasProtectionFrom(ctx, lieutenant, computeCharacteristics(ctx, goldSource))).toBe(true);
  });

  it('basri-c01-negative — a monocolored spell can still target and damage it', () => {
    const ctx = game('basri-monocolored');
    const lieutenant = spawn(ctx, 'P1', LIEUTENANT);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P2', redBolt(), new Map([[0, lieutenant.id]]), { R: 1 });
    resolve(ctx);
    expect(lieutenant.damageMarked).toBe(3);
  });

  it('basri-c01-blocking — a multicolored creature cannot block it; a monocolored one can', () => {
    const ctx = game('basri-blocking');
    const lieutenant = spawn(ctx, 'P1', LIEUTENANT);
    const gold = spawn(ctx, 'P2', goldCreature());
    const red = spawn(ctx, 'P2', redCreature());
    expect(combat(ctx, lieutenant, 'P2', gold).blockable).not.toContain(lieutenant.id);
    expect(lieutenant.tapped).toBe(false);
    const second = game('basri-blocking-mono');
    const lieutenant2 = spawn(second, 'P1', LIEUTENANT);
    const red2 = spawn(second, 'P2', redCreature());
    expect(combat(second, lieutenant2, 'P2', red2).blockable).toContain(lieutenant2.id);
    expect(red.damageMarked).toBe(0);
  });

  it('basri-c01-damage — combat damage from a multicolored blocker is prevented', () => {
    const ctx = game('basri-damage');
    const gold = spawn(ctx, 'P1', goldCreature());
    const lieutenant = spawn(ctx, 'P2', LIEUTENANT);
    combat(ctx, gold, 'P2', lieutenant);
    expect(lieutenant.damageMarked).toBe(0);
    expect(gold.damageMarked).toBe(3);
  });

  it('basri-c02 — its enters trigger puts a +1/+1 counter on a creature you control, cast normally', () => {
    const ctx = game('basri-enters');
    const ally = spawn(ctx, 'P1', bear());
    const foe = spawn(ctx, 'P2', bear());
    castFromHand(ctx, 'P1', LIEUTENANT, new Map(), { W: 1, C: 3 });
    resolve(ctx);
    const lieutenant = battlefield(ctx, "Basri's Lieutenant")[0]!;
    checkpoint(ctx);
    const stackTop = ctx.state.stack.at(-1);
    expect(stackTop?.kind).toBe('triggeredAbility');
    expect(stackTop?.targets[0]).toBeDefined();
    expect([ally.id, lieutenant.id]).toContain(stackTop!.targets[0]);
    expect(stackTop!.targets[0]).not.toBe(foe.id);
    resolve(ctx);
    const chosen = ctx.state.battlefield.find((p) => p.id === stackTop!.targets[0])!;
    expect(chosen.counters['+1/+1']).toBe(1);
  });

  it('basri-c03-positive — a creature you control dying with a +1/+1 counter makes a Knight', () => {
    const ctx = game('basri-dies');
    spawn(ctx, 'P1', LIEUTENANT);
    const ally = spawn(ctx, 'P1', bear());
    ally.counters['+1/+1'] = 1;
    pump(moveObject(ctx, ally, { zone: 'graveyard' }));
    checkpoint(ctx);
    expect(ctx.state.stack.at(-1)?.kind).toBe('triggeredAbility');
    resolve(ctx);
    const knights = battlefield(ctx, 'Knight');
    expect(knights).toHaveLength(1);
    const chars = computeCharacteristics(ctx, knights[0]!);
    expect([chars.power, chars.toughness, chars.colors, chars.keywords]).toEqual([
      2,
      2,
      ['W'],
      ['vigilance'],
    ]);
  });

  it('basri-c03-self — the Lieutenant itself dying with a counter triggers its own ability', () => {
    const ctx = game('basri-self');
    const lieutenant = spawn(ctx, 'P1', LIEUTENANT);
    lieutenant.counters['+1/+1'] = 2;
    pump(moveObject(ctx, lieutenant, { zone: 'graveyard' }));
    checkpoint(ctx);
    resolve(ctx);
    expect(battlefield(ctx, 'Knight')).toHaveLength(1);
  });

  it('basri-c03-negative — no counter, an opponent creature, or a non-death leave makes no Knight', () => {
    const ctx = game('basri-dies-negative');
    spawn(ctx, 'P1', LIEUTENANT);
    const plain = spawn(ctx, 'P1', bear());
    const foe = spawn(ctx, 'P2', bear());
    foe.counters['+1/+1'] = 1;
    const exiled = spawn(ctx, 'P1', bear());
    exiled.counters['+1/+1'] = 1;
    pump(moveObject(ctx, plain, { zone: 'graveyard' }));
    pump(moveObject(ctx, foe, { zone: 'graveyard' }));
    pump(moveObject(ctx, exiled, { zone: 'exile' }));
    checkpoint(ctx);
    while (ctx.state.stack.length > 0) resolve(ctx);
    expect(battlefield(ctx, 'Knight')).toHaveLength(0);
  });
});

describe('Spirit Mantle and Unquestioned Authority — protection from creatures', () => {
  function enchanted(seed: string, aura: OracleCard, mana: Record<string, number>) {
    const ctx = game(seed);
    const host = spawn(ctx, 'P1', bear());
    castFromHand(ctx, 'P1', aura, new Map([[0, host.id]]), mana);
    resolve(ctx);
    expect(battlefield(ctx, aura.name)[0]?.attachedTo).toBe(host.id);
    return { ctx, host };
  }

  it('spirit-mantle-c02-positive — +1/+1, unblockable by creatures, creature damage prevented', () => {
    const { ctx, host } = enchanted('mantle-positive', MANTLE, { W: 1, C: 1 });
    const chars = computeCharacteristics(ctx, host);
    expect([chars.power, chars.toughness]).toEqual([3, 3]);
    expect(chars.protectionFrom).toEqual(['creatures']);
    const blocker = spawn(ctx, 'P2', redCreature());
    expect(combat(ctx, host, 'P2', blocker).blockable).not.toContain(host.id);
    expect(player(ctx, 'P2').life).toBe(40 - 3);
    const pinger = spawn(ctx, 'P2', pingerCreature());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'precombatMain';
    expect(
      offeredTargets(
        ctx,
        'P2',
        (payload) => payload.kind === 'activateAbility' && payload.objectId === pinger.id,
      ),
    ).not.toContain(host.id);
  });

  it('spirit-mantle-c02-negative — noncreature spells and artifact abilities still target and damage it', () => {
    const { ctx, host } = enchanted('mantle-negative', MANTLE, { W: 1, C: 1 });
    const rod = spawn(ctx, 'P2', pingerRod());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    activate(ctx, 'P2', rod, new Map([[0, host.id]]));
    resolve(ctx);
    expect(host.damageMarked).toBe(1);
    castFromHand(ctx, 'P2', redBolt(), new Map([[0, host.id]]), { R: 1 });
    resolve(ctx);
    expect(host.damageMarked).toBe(4);
    checkpoint(ctx);
    expect(ctx.state.battlefield).not.toContain(host);
  });

  it('spirit-mantle-c02-fight — damage from a creature it fights is prevented', () => {
    const { ctx, host } = enchanted('mantle-fight', MANTLE, { W: 1, C: 1 });
    const foe = spawn(ctx, 'P2', redCreature());
    castFromHand(
      ctx,
      'P1',
      oracle({
        name: 'Biter',
        typeLine: 'Sorcery',
        manaCost: '{G}',
        colors: ['G'],
        oracleText: "Target creature you control fights target creature you don't control.",
      }),
      new Map([
        [0, host.id],
        [1, foe.id],
      ]),
      { G: 1 },
    );
    resolve(ctx);
    expect(host.damageMarked).toBe(0);
    expect(foe.damageMarked).toBe(3);
  });

  it('unquestioned-authority-c02/c03 — its enters trigger draws and the creature gains protection from creatures', () => {
    const ctx = game('authority');
    const host = spawn(ctx, 'P1', bear());
    const before = player(ctx, 'P1').hand.length;
    castFromHand(ctx, 'P1', AUTHORITY, new Map([[0, host.id]]), { W: 1, C: 2 });
    resolve(ctx);
    checkpoint(ctx);
    expect(ctx.state.stack.at(-1)?.kind).toBe('triggeredAbility');
    resolve(ctx);
    expect(player(ctx, 'P1').hand.length).toBe(before + 1);
    const chars = computeCharacteristics(ctx, host);
    expect(chars.protectionFrom).toEqual(['creatures']);
    expect([chars.power, chars.toughness]).toEqual([2, 2]);
    const blocker = spawn(ctx, 'P2', redCreature());
    expect(combat(ctx, host, 'P2', blocker).blockable).not.toContain(host.id);
  });

  it('unquestioned-authority-c03-negative — protection ends when the Aura leaves', () => {
    const ctx = game('authority-leaves');
    const host = spawn(ctx, 'P1', bear());
    castFromHand(ctx, 'P1', AUTHORITY, new Map([[0, host.id]]), { W: 1, C: 2 });
    resolve(ctx);
    checkpoint(ctx);
    resolve(ctx);
    pump(moveObject(ctx, battlefield(ctx, 'Unquestioned Authority')[0]!, { zone: 'graveyard' }));
    expect(computeCharacteristics(ctx, host).protectionFrom).toEqual([]);
    const blocker = spawn(ctx, 'P2', redCreature());
    expect(combat(ctx, host, 'P2', blocker).blockable).toContain(host.id);
  });
});

describe("Shanna, Sisay's Legacy", () => {
  it('shanna-c01-positive — opponents’ activated and triggered abilities cannot target her', () => {
    const ctx = game('shanna-abilities');
    const shanna = spawn(ctx, 'P1', SHANNA);
    const pinger = spawn(ctx, 'P2', pingerCreature());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const targets = offeredTargets(
      ctx,
      'P2',
      (payload) => payload.kind === 'activateAbility' && payload.objectId === pinger.id,
    );
    expect(targets).toContain('P1');
    expect(targets).not.toContain(shanna.id);
    expect(
      computeTargetOptions(ctx, { kind: 'creature' }, 'P2', {
        traits: { colors: [], types: ['Creature'] },
        kind: 'ability',
      }),
    ).not.toContain(shanna.id);
    // A source whose kind is unknown is treated as a possible ability and refused.
    expect(computeTargetOptions(ctx, { kind: 'creature' }, 'P2')).not.toContain(shanna.id);
  });

  it('shanna-c01-negative — opponents’ spells and her controller’s abilities may target her', () => {
    const ctx = game('shanna-spells');
    const shanna = spawn(ctx, 'P1', SHANNA);
    const ownPinger = spawn(ctx, 'P1', pingerCreature());
    expect(
      offeredTargets(
        ctx,
        'P1',
        (payload) => payload.kind === 'activateAbility' && payload.objectId === ownPinger.id,
      ),
    ).toContain(shanna.id);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P2', redBolt(), new Map([[0, shanna.id]]), { R: 1 });
    resolve(ctx);
    expect(shanna.damageMarked).toBe(3);
  });

  it('shanna-c02 — she gets +1/+1 for each creature you control, herself included', () => {
    const ctx = game('shanna-pt');
    const shanna = spawn(ctx, 'P1', SHANNA);
    expect(computeCharacteristics(ctx, shanna).power).toBe(1);
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    const chars = computeCharacteristics(ctx, shanna);
    expect([chars.power, chars.toughness]).toEqual([2, 2]);
  });
});

describe('Arcane Lighthouse', () => {
  function lighthouse(seed: string) {
    const ctx = game(seed);
    const light = spawn(ctx, 'P1', LIGHTHOUSE);
    const hexed = spawn(
      ctx,
      'P2',
      oracle({ name: 'Hexproof Bear', typeLine: 'Creature — Bear', oracleText: 'Hexproof' }),
    );
    const shrouded = spawn(
      ctx,
      'P3',
      oracle({ name: 'Shroud Bear', typeLine: 'Creature — Bear', oracleText: 'Shroud' }),
    );
    const mine = spawn(
      ctx,
      'P1',
      oracle({ name: 'My Hexproof Bear', typeLine: 'Creature — Bear', oracleText: 'Hexproof' }),
    );
    return { ctx, light, hexed, shrouded, mine };
  }

  it('arcane-lighthouse-c02-positive — opposing creatures lose hexproof and shroud and become targetable', () => {
    const { ctx, light, hexed, shrouded, mine } = lighthouse('lighthouse-positive');
    const bolt = conjure(ctx, 'P1', redBolt(), 'hand');
    addMana(player(ctx, 'P1'), [{ symbol: 'R' }]);
    const cast = (payload: PriorityActionPayload) =>
      payload.kind === 'castSpell' && payload.objectId === bolt.id;
    expect(offeredTargets(ctx, 'P1', cast)).not.toContain(hexed.id);
    expect(offeredTargets(ctx, 'P1', cast)).not.toContain(shrouded.id);
    anyMana(ctx, 'P1', 1);
    activate(ctx, 'P1', light);
    expect(light.tapped).toBe(true);
    resolve(ctx);
    expect(hasKeyword(ctx, hexed, 'hexproof')).toBe(false);
    expect(hasKeyword(ctx, shrouded, 'shroud')).toBe(false);
    expect(hasKeyword(ctx, mine, 'hexproof')).toBe(true);
    expect(offeredTargets(ctx, 'P1', cast)).toEqual(
      expect.arrayContaining([hexed.id, shrouded.id]),
    );
  });

  it("arcane-lighthouse-c02-cant-have — a later hexproof grant doesn't restore it this turn", () => {
    const { ctx, light, hexed } = lighthouse('lighthouse-cant-have');
    anyMana(ctx, 'P1', 1);
    activate(ctx, 'P1', light);
    resolve(ctx);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P2', hexproofer(), new Map([[0, hexed.id]]), { G: 1 });
    resolve(ctx);
    expect(hasKeyword(ctx, hexed, 'hexproof')).toBe(false);
    hexed.counters['hexproof'] = 1;
    expect(hasKeyword(ctx, hexed, 'hexproof')).toBe(false);
    endUntilEotEffects(ctx);
    expect(hasKeyword(ctx, hexed, 'hexproof')).toBe(true);
  });

  it('arcane-lighthouse-c02-negative — creatures arriving afterward and your own keep hexproof; it needs {1}', () => {
    const { ctx, light, mine } = lighthouse('lighthouse-negative');
    expect(
      priorityOption(
        ctx,
        'P1',
        (payload) => payload.kind === 'activateAbility' && payload.objectId === light.id,
      ),
    ).toBeUndefined();
    anyMana(ctx, 'P1', 1);
    activate(ctx, 'P1', light);
    resolve(ctx);
    const late = spawn(
      ctx,
      'P2',
      oracle({ name: 'Late Hexproof Bear', typeLine: 'Creature — Bear', oracleText: 'Hexproof' }),
    );
    expect(hasKeyword(ctx, late, 'hexproof')).toBe(true);
    expect(hasKeyword(ctx, mine, 'hexproof')).toBe(true);
  });

  it('arcane-lighthouse-c01 — its {T}: Add {C} mana ability is kept', () => {
    const def = interpretCard(LIGHTHOUSE);
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.activatedAbilities).toHaveLength(1);
  });
});
