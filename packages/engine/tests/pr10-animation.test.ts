import { describe, expect, it } from 'vitest';
import { computeTargetOptions } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { cleanupStep, queueStepTriggers } from '../src/turn/turn';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, forest, oracle, pump, spawn } from './fixtures';
import {
  activate,
  activateOption,
  asActive,
  bear,
  castFromHand,
  labShock,
  p,
  pinned,
  pinnedDefinition,
  pod,
  settle,
} from './pr10-helpers';

const mana = (...symbols: ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[]) =>
  symbols.map((symbol) => ({ symbol }));

const chars = (ctx: GameContext, permanent: EnginePermanent) =>
  computeCharacteristics(ctx, permanent);

function endTurn(ctx: GameContext) {
  pump(cleanupStep(ctx));
}

describe('PR10.02 Atarka Monument', () => {
  it('pr10-atarka-monument-pinned-oracle-supported — mana and animation are modeled', () => {
    const def = pinnedDefinition('Atarka Monument');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.manaAbilities).toHaveLength(1);
  });

  it('pr10-atarka-monument-animates — a 4/4 red and green Dragon artifact creature with flying', () => {
    const ctx = pod('pr10-atarka-animate');
    const monument = spawn(ctx, 'P1', pinned('Atarka Monument'));
    addMana(p(ctx, 'P1'), mana('C', 'C', 'C', 'C', 'R', 'G'));
    activate(ctx, 'P1', monument);
    settle(ctx);
    const now = chars(ctx, monument);
    expect(now.types).toEqual(expect.arrayContaining(['Artifact', 'Creature']));
    expect(now.subtypes).toContain('Dragon');
    expect([...now.colors].sort()).toEqual(['G', 'R']);
    expect([now.power, now.toughness]).toEqual([4, 4]);
    expect(now.keywords).toContain('flying');
  });

  it('pr10-atarka-monument-until-end-of-turn — a colorless noncreature artifact again after cleanup', () => {
    const ctx = pod('pr10-atarka-eot');
    const monument = spawn(ctx, 'P1', pinned('Atarka Monument'));
    addMana(p(ctx, 'P1'), mana('C', 'C', 'C', 'C', 'R', 'G'));
    activate(ctx, 'P1', monument);
    settle(ctx);
    endTurn(ctx);
    const now = chars(ctx, monument);
    expect(now.types).toEqual(['Artifact']);
    expect(now.colors).toEqual([]);
  });

  it('pr10-atarka-monument-insufficient-cost — needs {4}{R}{G}', () => {
    const ctx = pod('pr10-atarka-cost');
    const monument = spawn(ctx, 'P1', pinned('Atarka Monument'), { tapped: true });
    addMana(p(ctx, 'P1'), mana('C', 'C', 'C', 'C', 'R', 'R'));
    expect(activateOption(ctx, 'P1', monument)).toBeUndefined();
  });
});

describe('PR10.17 Sarkhan, the Dragonspeaker', () => {
  function sarkhan(seed: string) {
    const ctx = pod(seed);
    const walker = spawn(ctx, 'P1', pinned('Sarkhan, the Dragonspeaker'));
    walker.counters['loyalty'] = 4;
    return { ctx, walker };
  }

  it('pr10-sarkhan-the-dragonspeaker-pinned-oracle-supported — all three loyalty abilities', () => {
    const def = pinnedDefinition('Sarkhan, the Dragonspeaker');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.activatedAbilities).toHaveLength(3);
  });

  it('pr10-sarkhan-the-dragonspeaker-plus-one — only a legendary 4/4 red Dragon creature', () => {
    const { ctx, walker } = sarkhan('pr10-sarkhan-plus');
    activate(ctx, 'P1', walker, new Map(), undefined, 0);
    settle(ctx);
    expect(walker.counters['loyalty']).toBe(5);
    const now = chars(ctx, walker);
    expect(now.types).toEqual(['Creature']);
    expect(now.subtypes).toEqual(['Dragon']);
    expect(now.supertypes).toEqual(['Legendary']);
    expect(now.colors).toEqual(['R']);
    expect([now.power, now.toughness]).toEqual([4, 4]);
    expect(now.keywords).toEqual(expect.arrayContaining(['flying', 'indestructible', 'haste']));
  });

  it('pr10-sarkhan-the-dragonspeaker-no-loyalty-loss — damage while a creature does not remove loyalty', () => {
    const { ctx, walker } = sarkhan('pr10-sarkhan-damage');
    activate(ctx, 'P1', walker, new Map(), undefined, 0);
    settle(ctx);
    const restore = asActive(ctx, 'P2');
    castFromHand(ctx, 'P2', labShock(), new Map([[0, walker.id]]));
    restore();
    settle(ctx);
    expect(walker.damageMarked).toBe(2);
    expect(walker.counters['loyalty']).toBe(5);
    expect(ctx.state.battlefield).toContain(walker);
  });

  it('pr10-sarkhan-the-dragonspeaker-reverts — a planeswalker again after the turn', () => {
    const { ctx, walker } = sarkhan('pr10-sarkhan-revert');
    activate(ctx, 'P1', walker, new Map(), undefined, 0);
    settle(ctx);
    endTurn(ctx);
    const now = chars(ctx, walker);
    expect(now.types).toEqual(['Planeswalker']);
    expect(now.subtypes).toEqual(['Sarkhan']);
  });

  it('pr10-sarkhan-the-dragonspeaker-minus-three — 4 damage to target creature', () => {
    const { ctx, walker } = sarkhan('pr10-sarkhan-minus');
    const victim = spawn(ctx, 'P2', bear('Sarkhan Target', { power: '5', toughness: '5' }));
    activate(ctx, 'P1', walker, new Map([[0, victim.id]]), undefined, 1);
    settle(ctx);
    expect(walker.counters['loyalty']).toBe(1);
    expect(victim.damageMarked).toBe(4);
  });

  it('pr10-sarkhan-the-dragonspeaker-emblem — two extra draws, then discard at your end step', () => {
    const { ctx, walker } = sarkhan('pr10-sarkhan-emblem');
    walker.counters['loyalty'] = 6;
    activate(ctx, 'P1', walker, new Map(), undefined, 2);
    settle(ctx);
    expect(p(ctx, 'P1').emblems).toHaveLength(1);
    conjure(ctx, 'P1', forest(), 'hand');
    const before = p(ctx, 'P1').hand.length;
    queueStepTriggers(ctx, 'drawStep');
    settle(ctx);
    expect(p(ctx, 'P1').hand.length).toBe(before + 2);
    // An opponent's draw step does not trigger it.
    const restore = asActive(ctx, 'P2');
    queueStepTriggers(ctx, 'drawStep');
    settle(ctx);
    restore();
    expect(p(ctx, 'P1').hand.length).toBe(before + 2);
    queueStepTriggers(ctx, 'endStep');
    settle(ctx);
    expect(p(ctx, 'P1').hand).toHaveLength(0);
  });
});

describe('PR10.20 Mirage Mirror', () => {
  const ogre = () =>
    oracle({
      name: 'Mirror Ogre',
      typeLine: 'Creature — Ogre',
      manaCost: '{2}{R}',
      cmc: 3,
      colors: ['R'],
      power: '3',
      toughness: '3',
    });

  it('pr10-mirage-mirror-pinned-oracle-supported — the copy ability is modeled', () => {
    const def = pinnedDefinition('Mirage Mirror');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });

  it('pr10-mirage-mirror-becomes-copy — copies the target until end of turn', () => {
    const ctx = pod('pr10-mirror-copy');
    const mirror = spawn(ctx, 'P1', pinned('Mirage Mirror'));
    const original = spawn(ctx, 'P2', ogre());
    addMana(p(ctx, 'P1'), mana('C', 'C'));
    activate(ctx, 'P1', mirror, new Map([[0, original.id]]));
    settle(ctx);
    const now = chars(ctx, mirror);
    expect(mirror.name).toBe('Mirror Ogre');
    expect(now.types).toEqual(['Creature']);
    expect([now.power, now.toughness]).toEqual([3, 3]);
    expect(mirror.controllerId).toBe('P1');
    endTurn(ctx);
    expect(mirror.name).toBe('Mirage Mirror');
    expect(chars(ctx, mirror).types).toEqual(['Artifact']);
  });

  it('pr10-mirage-mirror-target-types — not a planeswalker', () => {
    const ctx = pod('pr10-mirror-targets');
    spawn(ctx, 'P1', pinned('Mirage Mirror'));
    const walker = spawn(ctx, 'P2', pinned('Sarkhan, the Dragonspeaker'));
    const land = spawn(ctx, 'P2', forest());
    const spec = pinnedDefinition('Mirage Mirror').activatedAbilities[0]!.ability.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1');
    expect(legal).toContain(land.id);
    expect(legal).not.toContain(walker.id);
  });

  it('pr10-mirage-mirror-insufficient-cost — needs {2}', () => {
    const ctx = pod('pr10-mirror-cost');
    const mirror = spawn(ctx, 'P1', pinned('Mirage Mirror'));
    spawn(ctx, 'P2', ogre());
    addMana(p(ctx, 'P1'), mana('C'));
    expect(activateOption(ctx, 'P1', mirror)).toBeUndefined();
  });
});

describe('PR10.07 Saheeli, Sublime Artificer', () => {
  const trinket = () =>
    oracle({
      name: 'Saheeli Trinket',
      typeLine: 'Artifact',
      manaCost: '{1}',
      cmc: 1,
      power: null,
      toughness: null,
    });
  const labCreature = () =>
    oracle({
      name: 'Saheeli Bear Spell',
      typeLine: 'Creature — Bear',
      manaCost: '{1}',
      cmc: 1,
      power: '2',
      toughness: '2',
    });
  const servos = (ctx: GameContext) =>
    ctx.state.battlefield.filter(
      (permanent) => permanent.isToken && permanent.controllerId === 'P1',
    );

  function saheeli(seed: string) {
    const ctx = pod(seed);
    const walker = spawn(ctx, 'P1', pinned('Saheeli, Sublime Artificer'));
    walker.counters['loyalty'] = 5;
    return { ctx, walker };
  }

  it('pr10-saheeli-sublime-artificer-pinned-oracle-supported — the Servo trigger and only the −2', () => {
    const def = pinnedDefinition('Saheeli, Sublime Artificer');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers).toHaveLength(1);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]!.costs).toEqual([{ kind: 'loyalty', delta: -2 }]);
  });

  it('pr10-saheeli-sublime-artificer-servo — a Servo for each noncreature spell you cast', () => {
    const { ctx } = saheeli('pr10-saheeli-servo');
    castFromHand(ctx, 'P1', labShock(), new Map([[0, 'P2']]));
    settle(ctx);
    expect(servos(ctx)).toHaveLength(1);
    castFromHand(ctx, 'P1', labCreature());
    settle(ctx);
    expect(servos(ctx)).toHaveLength(1);
  });

  it('pr10-saheeli-sublime-artificer-minus-two — the artifact copies another of yours and stays an artifact', () => {
    const { ctx, walker } = saheeli('pr10-saheeli-copy');
    const art = spawn(ctx, 'P1', trinket());
    const model = spawn(ctx, 'P1', bear('Saheeli Model', { power: '3', toughness: '3' }));
    activate(
      ctx,
      'P1',
      walker,
      new Map([
        [0, art.id],
        [1, model.id],
      ]),
    );
    settle(ctx);
    expect(walker.counters['loyalty']).toBe(3);
    expect(art.name).toBe('Saheeli Model');
    const now = chars(ctx, art);
    expect(now.types).toEqual(expect.arrayContaining(['Artifact', 'Creature']));
    expect([now.power, now.toughness]).toEqual([3, 3]);
    endTurn(ctx);
    expect(art.name).toBe('Saheeli Trinket');
  });

  it('pr10-saheeli-sublime-artificer-another-target — not the same artifact, not an opponent permanent', () => {
    const { ctx } = saheeli('pr10-saheeli-another');
    const art = spawn(ctx, 'P1', trinket());
    const other = spawn(ctx, 'P1', trinket());
    const theirs = spawn(ctx, 'P2', bear('Saheeli Rival'));
    const spec = pinnedDefinition('Saheeli, Sublime Artificer').activatedAbilities[0]!.ability
      .targets[1]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', undefined, undefined, [art.id]);
    expect(legal).toContain(other.id);
    expect(legal).not.toContain(art.id);
    expect(legal).not.toContain(theirs.id);
  });
});
