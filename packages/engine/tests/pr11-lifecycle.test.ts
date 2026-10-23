import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import { runOpeningHandBattlefieldActions } from '../src/turn/mulligan';
import type { GameContext } from '../src/state/types';
import { drawCards } from '../src/effects/resolve';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import {
  bear,
  conjure,
  copies,
  declareAttacks,
  gameConfig,
  oracle,
  plains,
  pump,
  spawn,
} from './fixtures';
import {
  activate,
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  nextTurnOf,
  offeredTargets,
  pinned,
  player,
  preferring,
  priorityOption,
  resolve,
} from './pr11-helpers';

const VAULT = pinned('Mana Vault');
const REMORA = pinned('Mystic Remora');

const threeDrop = (): OracleCard =>
  oracle({ name: 'Three Drop', typeLine: 'Artifact', manaCost: '{3}', oracleText: '' });
const opponentSorcery = (): OracleCard =>
  oracle({
    name: 'Divination Test',
    typeLine: 'Sorcery',
    manaCost: '{1}',
    oracleText: 'You gain 1 life.',
  });
const opponentCreature = (): OracleCard =>
  oracle({
    name: 'Cheap Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}',
    power: '2',
    toughness: '2',
  });

function turnOf(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
}

function lands(ctx: GameContext, playerId: string, count: number): void {
  for (let index = 0; index < count; index++) spawn(ctx, playerId, plains());
}

describe('PR11 lifecycle cards — modeled', () => {
  it('pr11-lifecycle-modeled — Mana Vault and Mystic Remora model with every reason cleared', () => {
    for (const card of [VAULT, REMORA]) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
    }
  });
});

describe('Mana Vault', () => {
  it('vault-c04 — {T}: Add {C}{C}{C} pays for a three-mana spell by itself', () => {
    const ctx = game('pr11-vault-mana');
    const vault = spawn(ctx, 'P1', VAULT);
    castFromHand(ctx, 'P1', threeDrop());
    expect(vault.tapped).toBe(true);
    resolve(ctx);
    expect(battlefield(ctx, 'Three Drop')).toHaveLength(1);
  });

  it('vault-c01 — it does not untap during your untap step; other permanents do', () => {
    const ctx = game('pr11-vault-untap');
    const vault = spawn(ctx, 'P1', VAULT, { tapped: true });
    const land = spawn(ctx, 'P1', plains(), { tapped: true });
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(land.tapped).toBe(false);
    expect(vault.tapped).toBe(true);
  });

  it('vault-c02-positive — paying {4} at upkeep untaps it, before the draw-step damage', () => {
    const ctx = game('pr11-vault-pay');
    const vault = spawn(ctx, 'P1', VAULT, { tapped: true });
    lands(ctx, 'P1', 4);
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P1', preferring('payMana'));
    expect(vault.tapped).toBe(false);
    expect(player(ctx, 'P1').life).toBe(life);
    expect(battlefield(ctx, 'Plains').every((land) => land.tapped)).toBe(true);
  });

  it('vault-c02-c03 — declining leaves it tapped, and it deals 1 damage at your draw step', () => {
    const ctx = game('pr11-vault-decline');
    const vault = spawn(ctx, 'P1', VAULT, { tapped: true });
    lands(ctx, 'P1', 4);
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(vault.tapped).toBe(true);
    expect(player(ctx, 'P1').life).toBe(life - 1);
  });

  it('vault-c03-negative — untapped at the draw step, or on another player’s turn, no damage', () => {
    const ctx = game('pr11-vault-untapped');
    spawn(ctx, 'P1', VAULT);
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(player(ctx, 'P1').life).toBe(life);

    const other = game('pr11-vault-other-turn');
    spawn(other, 'P1', VAULT, { tapped: true });
    const otherLife = player(other, 'P1').life;
    nextTurnOf(other, 'P2', preferring('decline'));
    expect(player(other, 'P1').life).toBe(otherLife);
  });
});

describe('Mystic Remora', () => {
  it('remora-c01-paid — each upkeep adds an age counter and asks {1} per counter', () => {
    const ctx = game('pr11-remora-upkeep');
    const remora = spawn(ctx, 'P1', REMORA);
    lands(ctx, 'P1', 3);
    nextTurnOf(ctx, 'P1', preferring('payCost'));
    expect(remora.counters['age']).toBe(1);
    expect(battlefield(ctx, 'Mystic Remora')).toEqual([remora]);
    expect(battlefield(ctx, 'Plains').filter((land) => land.tapped)).toHaveLength(1);
    nextTurnOf(ctx, 'P1', preferring('payCost'));
    expect(remora.counters['age']).toBe(2);
    expect(battlefield(ctx, 'Plains').filter((land) => land.tapped)).toHaveLength(2);
    expect(battlefield(ctx, 'Mystic Remora')).toEqual([remora]);
  });

  it('remora-c01-unpaid — declining, or being unable to pay, sacrifices it', () => {
    const ctx = game('pr11-remora-decline');
    spawn(ctx, 'P1', REMORA);
    lands(ctx, 'P1', 3);
    nextTurnOf(ctx, 'P1', preferring('decline'));
    expect(battlefield(ctx, 'Mystic Remora')).toEqual([]);
    expect(player(ctx, 'P1').graveyard.some((card) => card.name === 'Mystic Remora')).toBe(true);

    const broke = game('pr11-remora-broke');
    spawn(broke, 'P1', REMORA);
    nextTurnOf(broke, 'P1', preferring('payCost'));
    expect(battlefield(broke, 'Mystic Remora')).toEqual([]);
  });

  it('remora-c02-positive — an opponent’s noncreature spell lets you draw unless they pay {4}', () => {
    const ctx = game('pr11-remora-draw');
    spawn(ctx, 'P1', REMORA);
    const hand = player(ctx, 'P1').hand.length;
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', opponentSorcery(), new Map(), { C: 1 });
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('remora-c02-paid — the opponent paying {4} stops the draw', () => {
    const ctx = game('pr11-remora-tax');
    spawn(ctx, 'P1', REMORA);
    lands(ctx, 'P2', 4);
    const hand = player(ctx, 'P1').hand.length;
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', opponentSorcery(), new Map(), { C: 1 });
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').hand.length).toBe(hand);
    expect(battlefield(ctx, 'Plains').filter((land) => land.tapped)).toHaveLength(4);
  });

  it('remora-c02-negative — creature spells and your own spells do not trigger it', () => {
    const ctx = game('pr11-remora-filter');
    spawn(ctx, 'P1', REMORA);
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', opponentCreature(), new Map(), { C: 1 });
    checkpoint(ctx);
    resolve(ctx);
    turnOf(ctx, 'P1');
    castFromHand(ctx, 'P1', opponentSorcery(), new Map(), { C: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell']);
  });
});

const SMOKESTACK = pinned('Smokestack');

describe('Smokestack', () => {
  it('smokestack-modeled — models with every reason cleared and enters with no soot', () => {
    const def = interpretCard(SMOKESTACK);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const ctx = game('pr11-smokestack-enter');
    castFromHand(ctx, 'P1', SMOKESTACK, new Map(), { C: 4 });
    resolve(ctx);
    expect(battlefield(ctx, 'Smokestack')[0]!.counters['soot'] ?? 0).toBe(0);
  });

  it('smokestack-c01 — at your upkeep you may add a soot counter; declining adds none', () => {
    const ctx = game('pr11-smokestack-soot');
    const stack = spawn(ctx, 'P1', SMOKESTACK);
    lands(ctx, 'P1', 3);
    nextTurnOf(ctx, 'P1', (decision) => {
      const yes = decision.options.findIndex((option) => option.type === 'acceptTrigger');
      return { index: Math.max(0, yes), targets: new Map() };
    });
    expect(stack.counters['soot']).toBe(1);

    const declined = game('pr11-smokestack-no-soot');
    const idle = spawn(declined, 'P1', SMOKESTACK);
    nextTurnOf(declined, 'P1', (decision) => {
      const no = decision.options.findIndex((option) => option.type === 'declineTrigger');
      return { index: Math.max(0, no), targets: new Map() };
    });
    expect(idle.counters['soot'] ?? 0).toBe(0);
  });

  it('smokestack-c02 — the upkeep player sacrifices one permanent per soot counter, of their choice', () => {
    const ctx = game('pr11-smokestack-sacrifice');
    const stack = spawn(ctx, 'P1', SMOKESTACK);
    stack.counters['soot'] = 2;
    const keep = spawn(
      ctx,
      'P2',
      oracle({ name: 'Keeper', typeLine: 'Artifact', manaCost: '{1}' }),
    );
    lands(ctx, 'P2', 2);
    lands(ctx, 'P1', 2);
    const prompts: string[] = [];
    nextTurnOf(ctx, 'P2', (decision) => {
      if (decision.prompt.includes('choose a permanent to sacrifice')) {
        prompts.push(decision.player);
        const land = decision.options.findIndex(
          (option) => option.description === 'Sacrifice Plains',
        );
        return { index: Math.max(0, land), targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });
    expect(prompts.every((who) => who === 'P2')).toBe(true);
    expect(ctx.state.battlefield.filter((perm) => perm.controllerId === 'P2')).toEqual([keep]);
    expect(ctx.state.battlefield.filter((perm) => perm.controllerId === 'P1')).toHaveLength(3);
  });

  it('smokestack-c02-negative — with no soot counters nobody sacrifices', () => {
    const ctx = game('pr11-smokestack-empty');
    spawn(ctx, 'P1', SMOKESTACK);
    lands(ctx, 'P2', 2);
    nextTurnOf(ctx, 'P2');
    expect(ctx.state.battlefield.filter((perm) => perm.controllerId === 'P2')).toHaveLength(2);
  });
});

const TOMBS = pinned('Out of the Tombs');

describe('Out of the Tombs', () => {
  it('tombs-modeled — models with every reason cleared and enters with no eon counters', () => {
    const def = interpretCard(TOMBS);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const ctx = game('pr11-tombs-enter');
    castFromHand(ctx, 'P1', TOMBS, new Map(), { B: 1, C: 2 });
    resolve(ctx);
    expect(battlefield(ctx, 'Out of the Tombs')[0]!.counters['eon'] ?? 0).toBe(0);
  });

  it('tombs-c01 — each upkeep adds two eon counters, then mills one card per counter', () => {
    const ctx = game('pr11-tombs-mill');
    const tombs = spawn(ctx, 'P1', TOMBS);
    const me = player(ctx, 'P1');
    for (let index = 0; index < 10; index++) conjure(ctx, 'P1', plains(), 'library');
    const graveyard = me.graveyard.length;
    nextTurnOf(ctx, 'P1');
    expect(tombs.counters['eon']).toBe(2);
    expect(me.graveyard.length - graveyard).toBe(2);
    nextTurnOf(ctx, 'P1');
    expect(tombs.counters['eon']).toBe(4);
    expect(me.graveyard.length - graveyard).toBe(6);
  });

  it('tombs-c02-positive — drawing from an empty library returns a creature card instead', () => {
    const ctx = game('pr11-tombs-replace');
    spawn(ctx, 'P1', TOMBS);
    const me = player(ctx, 'P1');
    me.library = [];
    conjure(ctx, 'P1', bear(), 'graveyard');
    const decisions = pump(drawCards(ctx, me, 1)).decisions;
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(1);
    expect(me.attemptedDrawFromEmptyLibrary).not.toBe(true);
    checkpoint(ctx);
    expect(me.hasLost).toBe(false);
    // "If you can't, you lose": with a creature card available, losing is not offered.
    for (const decision of decisions)
      expect(decision.options.map((option) => option.type)).not.toContain('loseGame');
  });

  it('tombs-c02-lose — with no creature card in your graveyard, you lose the game', () => {
    const ctx = game('pr11-tombs-lose');
    spawn(ctx, 'P1', TOMBS);
    const me = player(ctx, 'P1');
    me.library = [];
    conjure(ctx, 'P1', plains(), 'graveyard');
    pump(drawCards(ctx, me, 1));
    checkpoint(ctx);
    expect(me.hasLost).toBe(true);
  });

  it('tombs-c02-negative — a library with cards draws normally', () => {
    const ctx = game('pr11-tombs-normal');
    spawn(ctx, 'P1', TOMBS);
    const me = player(ctx, 'P1');
    conjure(ctx, 'P1', bear(), 'graveyard');
    const hand = me.hand.length;
    expect(me.library.length).toBeGreaterThan(0);
    pump(drawCards(ctx, me, 1));
    expect(me.hand.length).toBe(hand + 1);
    expect(battlefield(ctx, 'Test Bear')).toEqual([]);
  });
});

const SUN = pinned('Caged Sun');

describe('Caged Sun', () => {
  function sunChoosing(ctx: GameContext, label: string) {
    castFromHand(ctx, 'P1', SUN, new Map(), { C: 6 });
    pump(resolveTopOfStack(ctx), (decision) => {
      const index = decision.options.findIndex((option) => option.description === label);
      return { index: Math.max(0, index), targets: new Map() };
    });
    return battlefield(ctx, 'Caged Sun')[0]!;
  }
  const spellCosting = (cost: string): OracleCard =>
    oracle({
      name: `Spell ${cost}`,
      typeLine: 'Sorcery',
      manaCost: cost,
      oracleText: 'You gain 1 life.',
    });
  const castable = (ctx: GameContext, playerId: string, cost: string): boolean => {
    const card = conjure(ctx, playerId, spellCosting(cost), 'hand');
    return (
      priorityOption(
        ctx,
        playerId,
        (payload) => payload.kind === 'castSpell' && payload.objectId === card.id,
      ) !== undefined
    );
  };

  it('sun-c01 — as it enters you choose a color, and it is remembered', () => {
    const ctx = game('pr11-sun-choose');
    expect(interpretCard(SUN).modeled).toBe(true);
    expect(sunChoosing(ctx, 'Red').chosenOption).toBe('R');
  });

  it('sun-c02 — creatures you control of the chosen color get +1/+1; others do not', () => {
    const ctx = game('pr11-sun-anthem');
    sunChoosing(ctx, 'Red');
    const red = spawn(
      ctx,
      'P1',
      oracle({ name: 'Red One', colors: ['R'], manaCost: '{R}', power: '2', toughness: '2' }),
    );
    const white = spawn(
      ctx,
      'P1',
      oracle({ name: 'White One', colors: ['W'], manaCost: '{W}', power: '2', toughness: '2' }),
    );
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Their Red', colors: ['R'], manaCost: '{R}', power: '2', toughness: '2' }),
    );
    expect(computeCharacteristics(ctx, red).power).toBe(3);
    expect(computeCharacteristics(ctx, red).toughness).toBe(3);
    expect(computeCharacteristics(ctx, white).power).toBe(2);
    expect(computeCharacteristics(ctx, theirs).power).toBe(2);
  });

  it('sun-c03-positive — a land tapped for the chosen color adds one more of it', () => {
    const ctx = game('pr11-sun-mana');
    sunChoosing(ctx, 'White');
    spawn(ctx, 'P1', plains());
    expect(castable(ctx, 'P1', '{W}{W}')).toBe(true);
    castFromHand(ctx, 'P1', spellCosting('{W}{W}'));
    expect(battlefield(ctx, 'Plains').every((land) => land.tapped)).toBe(true);
  });

  it('sun-c03-choice — a land that makes several colors adds the extra only for the chosen one', () => {
    const ctx = game('pr11-sun-dual');
    sunChoosing(ctx, 'White');
    spawn(
      ctx,
      'P1',
      oracle({ name: 'Test Dual', typeLine: 'Land', oracleText: '{T}: Add {W} or {U}.' }),
    );
    expect(castable(ctx, 'P1', '{W}{W}')).toBe(true);
    expect(castable(ctx, 'P1', '{W}{U}')).toBe(false);
    expect(castable(ctx, 'P1', '{U}{U}')).toBe(false);
    expect(castable(ctx, 'P1', '{U}')).toBe(true);
  });

  it('sun-c03-negative — other colors, nonland sources, and opponents’ lands get nothing', () => {
    const ctx = game('pr11-sun-negative');
    sunChoosing(ctx, 'White');
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Mountain',
        typeLine: 'Basic Land — Mountain',
        oracleText: '({T}: Add {R}.)',
        subtypes: ['Mountain'],
        supertypes: ['Basic'],
      }),
    );
    expect(castable(ctx, 'P1', '{R}{R}')).toBe(false);
    expect(castable(ctx, 'P1', '{R}')).toBe(true);

    const rock = game('pr11-sun-rock');
    sunChoosing(rock, 'White');
    spawn(
      rock,
      'P1',
      oracle({
        name: 'White Rock',
        typeLine: 'Artifact',
        manaCost: '{1}',
        oracleText: '{T}: Add {W}.',
      }),
    );
    expect(castable(rock, 'P1', '{W}{W}')).toBe(false);

    const theirs = game('pr11-sun-theirs');
    sunChoosing(theirs, 'White');
    spawn(theirs, 'P2', plains());
    theirs.state.currentTurnPlayer = 'P2';
    theirs.state.activePlayerIndex = 1;
    expect(castable(theirs, 'P2', '{W}{W}')).toBe(false);
  });
});

const MOX = pinned('Chrome Mox');

describe('Chrome Mox', () => {
  const card = (name: string, extra: Partial<OracleCard>): OracleCard =>
    oracle({
      name,
      typeLine: 'Instant',
      manaCost: '{1}',
      oracleText: 'You gain 1 life.',
      ...extra,
    });
  const spellCosting = (cost: string): OracleCard =>
    oracle({
      name: `Spell ${cost}`,
      typeLine: 'Sorcery',
      manaCost: cost,
      oracleText: 'You gain 1 life.',
    });
  const castable = (ctx: GameContext, cost: string): boolean => {
    const spell = conjure(ctx, 'P1', spellCosting(cost), 'hand');
    const ok =
      priorityOption(
        ctx,
        'P1',
        (payload) => payload.kind === 'castSpell' && payload.objectId === spell.id,
      ) !== undefined;
    player(ctx, 'P1').hand = player(ctx, 'P1').hand.filter((entry) => entry.id !== spell.id);
    return ok;
  };
  /** Cast the Mox and imprint `name` (or nothing); returns the offered card names. */
  function moxImprinting(ctx: GameContext, name: string | null): string[] {
    let offered: string[] = [];
    castFromHand(ctx, 'P1', MOX);
    pump(resolveTopOfStack(ctx));
    checkpoint(ctx);
    pump(resolveTopOfStack(ctx), (decision) => {
      offered = decision.options
        .filter((option) => option.type === 'exile')
        .map((option) => option.description);
      const index = decision.options.findIndex((option) =>
        name === null ? option.type === 'decline' : option.description === `Exile ${name}`,
      );
      return { index: Math.max(0, index), targets: new Map() };
    });
    return offered;
  }

  it('mox-c01 — imprint offers only nonartifact, nonland cards and links the exiled card', () => {
    const ctx = game('pr11-mox-imprint');
    expect(interpretCard(MOX).modeled).toBe(true);
    player(ctx, 'P1').hand = [];
    conjure(ctx, 'P1', card('Red Spell', { colors: ['R'], manaCost: '{R}' }), 'hand');
    conjure(ctx, 'P1', plains(), 'hand');
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Some Artifact', typeLine: 'Artifact', manaCost: '{1}' }),
      'hand',
    );
    const offered = moxImprinting(ctx, 'Red Spell');
    expect(offered).toEqual(['Exile Red Spell']);
    const mox = battlefield(ctx, 'Chrome Mox')[0]!;
    const exiled = ctx.state.exile.find((entry) => entry.name === 'Red Spell');
    expect(exiled).toBeDefined();
    expect(mox.exiledWithIds).toEqual([exiled!.id]);
  });

  it("mox-c02 — {T} adds one mana of any of the exiled card's colors, and only those", () => {
    const ctx = game('pr11-mox-gold');
    player(ctx, 'P1').hand = [];
    conjure(ctx, 'P1', card('Gold Spell', { colors: ['R', 'W'], manaCost: '{R}{W}' }), 'hand');
    moxImprinting(ctx, 'Gold Spell');
    expect(castable(ctx, '{R}')).toBe(true);
    expect(castable(ctx, '{W}')).toBe(true);
    expect(castable(ctx, '{U}')).toBe(false);
    expect(castable(ctx, '{R}{W}')).toBe(false);
  });

  it('mox-c02-negative — nothing imprinted, a colorless card, or a card that left exile: no mana', () => {
    const none = game('pr11-mox-none');
    conjure(none, 'P1', card('Kept Spell', { colors: ['R'], manaCost: '{R}' }), 'hand');
    moxImprinting(none, null);
    expect(battlefield(none, 'Chrome Mox')[0]!.exiledWithIds ?? []).toEqual([]);
    expect(castable(none, '{1}')).toBe(false);

    const colorless = game('pr11-mox-colorless');
    player(colorless, 'P1').hand = [];
    conjure(colorless, 'P1', card('Colorless Spell', { colors: [], manaCost: '{2}' }), 'hand');
    moxImprinting(colorless, 'Colorless Spell');
    expect(castable(colorless, '{1}')).toBe(false);

    const gone = game('pr11-mox-gone');
    player(gone, 'P1').hand = [];
    conjure(gone, 'P1', card('Red Spell', { colors: ['R'], manaCost: '{R}' }), 'hand');
    moxImprinting(gone, 'Red Spell');
    expect(castable(gone, '{R}')).toBe(true);
    const exiled = gone.state.exile.find((entry) => entry.name === 'Red Spell')!;
    pump(moveObject(gone, exiled, { zone: 'graveyard' }));
    expect(castable(gone, '{R}')).toBe(false);
  });
});

const PORTAL = pinned('Negative Zone Portal');

describe('Negative Zone Portal', () => {
  const creatureCard = (name: string): OracleCard =>
    oracle({ name, typeLine: 'Creature — Test', manaCost: '{1}', power: '1', toughness: '1' });
  const sorceryCard = (name: string): OracleCard =>
    oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', oracleText: 'You gain 1 life.' });
  /** Force every coin flip and random pick: 0 wins the flip, 1 loses it. */
  function rig(ctx: GameContext, value: number): void {
    ctx.rng.nextInt = (bound: number) => Math.min(value, bound - 1);
  }
  function portalWith(ctx: GameContext, cards: OracleCard[]) {
    const portal = spawn(ctx, 'P1', PORTAL);
    for (const card of cards) {
      const exiled = conjure(ctx, 'P2', card, 'exile');
      portal.exiledWithIds = [...(portal.exiledWithIds ?? []), exiled.id];
    }
    return portal;
  }

  it('portal-c01-creature — exiles a creature card from an opponent’s graveyard and draws', () => {
    const ctx = game('pr11-portal-creature');
    expect(interpretCard(PORTAL).modeled).toBe(true);
    const portal = spawn(ctx, 'P1', PORTAL);
    const target = conjure(ctx, 'P2', creatureCard('Dead Bear'), 'graveyard');
    const mine = conjure(ctx, 'P1', creatureCard('My Dead Bear'), 'graveyard');
    anyMana(ctx, 'P1', 2);
    const offered = offeredTargets(
      ctx,
      'P1',
      (payload) => payload.kind === 'activateAbility' && payload.objectId === portal.id,
    );
    expect(offered).toContain(target.id);
    expect(offered).not.toContain(mine.id);
    const hand = player(ctx, 'P1').hand.length;
    activate(ctx, 'P1', portal, new Map([[0, target.id]]));
    resolve(ctx);
    expect(ctx.state.exile.some((card) => card.cardId === target.cardId)).toBe(true);
    expect(portal.exiledWithIds).toEqual([
      ctx.state.exile.find((card) => card.cardId === target.cardId)!.id,
    ]);
    expect(player(ctx, 'P1').hand.length).toBe(hand + 1);
  });

  it('portal-c01-noncreature — a noncreature card is exiled without a draw; it costs {2}', () => {
    const ctx = game('pr11-portal-noncreature');
    const portal = spawn(ctx, 'P1', PORTAL);
    const target = conjure(ctx, 'P2', sorceryCard('Old Sorcery'), 'graveyard');
    expect(
      priorityOption(
        ctx,
        'P1',
        (payload) => payload.kind === 'activateAbility' && payload.objectId === portal.id,
      ),
    ).toBeUndefined();
    anyMana(ctx, 'P1', 2);
    const hand = player(ctx, 'P1').hand.length;
    activate(ctx, 'P1', portal, new Map([[0, target.id]]));
    resolve(ctx);
    expect(portal.exiledWithIds).toEqual([
      ctx.state.exile.find((card) => card.cardId === target.cardId)!.id,
    ]);
    expect(player(ctx, 'P1').hand.length).toBe(hand);
  });

  it('portal-c02-negative — fewer than four creature cards exiled with it: no flip', () => {
    const ctx = game('pr11-portal-three');
    portalWith(ctx, [creatureCard('A'), creatureCard('B'), creatureCard('C'), sorceryCard('D')]);
    const before = ctx.state.eventLog.length;
    nextTurnOf(ctx, 'P1');
    expect(ctx.state.eventLog.slice(before).some((event) => event.type === 'coinFlip')).toBe(false);
    expect(battlefield(ctx, 'Negative Zone Portal')).toHaveLength(1);
  });

  it('portal-c02-win — with four creature cards it flips; winning keeps everything', () => {
    const ctx = game('pr11-portal-win');
    const portal = portalWith(ctx, ['A', 'B', 'C', 'D'].map(creatureCard));
    rig(ctx, 0);
    const before = ctx.state.eventLog.length;
    nextTurnOf(ctx, 'P1');
    const flips = ctx.state.eventLog.slice(before).filter((event) => event.type === 'coinFlip');
    expect(flips).toHaveLength(1);
    expect(battlefield(ctx, 'Negative Zone Portal')).toEqual([portal]);
    expect(portal.exiledWithIds).toHaveLength(4);
  });

  it('portal-c02-lose — losing sacrifices it and returns one exiled card to its owner’s hand', () => {
    const ctx = game('pr11-portal-lose');
    portalWith(ctx, ['A', 'B', 'C', 'D'].map(creatureCard));
    rig(ctx, 1);
    const theirHand = player(ctx, 'P2').hand.length;
    nextTurnOf(ctx, 'P1');
    expect(battlefield(ctx, 'Negative Zone Portal')).toEqual([]);
    expect(player(ctx, 'P1').graveyard.some((card) => card.name === 'Negative Zone Portal')).toBe(
      true,
    );
    expect(player(ctx, 'P2').hand.length).toBe(theirHand + 1);
    expect(ctx.state.exile.filter((card) => ['A', 'B', 'C', 'D'].includes(card.name))).toHaveLength(
      3,
    );
  });
});

const CAVERNS = pinned('Gemstone Caverns');

describe('Gemstone Caverns', () => {
  const spellCosting = (cost: string): OracleCard =>
    oracle({
      name: `Spell ${cost}`,
      typeLine: 'Sorcery',
      manaCost: cost,
      oracleText: 'You gain 1 life.',
    });
  const castable = (ctx: GameContext, playerId: string, cost: string): boolean => {
    const spell = conjure(ctx, playerId, spellCosting(cost), 'hand');
    const ok =
      priorityOption(
        ctx,
        playerId,
        (payload) => payload.kind === 'castSpell' && payload.objectId === spell.id,
      ) !== undefined;
    player(ctx, playerId).hand = player(ctx, playerId).hand.filter(
      (entry) => entry.id !== spell.id,
    );
    return ok;
  };
  function openingHand(ctx: GameContext, playerId: string): void {
    player(ctx, playerId).hand = [];
    conjure(ctx, playerId, CAVERNS, 'hand');
    conjure(
      ctx,
      playerId,
      oracle({ name: 'Spare Card', typeLine: 'Sorcery', manaCost: '{1}' }),
      'hand',
    );
    conjure(ctx, playerId, plains(), 'hand');
  }

  it('caverns-c01-positive — not the starting player: begin with it, a luck counter, and exile a card', () => {
    const ctx = game('pr11-caverns-begin');
    expect(interpretCard(CAVERNS).modeled).toBe(true);
    openingHand(ctx, 'P2');
    pump(runOpeningHandBattlefieldActions(ctx), preferring('beginOnBattlefield'));
    const caverns = battlefield(ctx, 'Gemstone Caverns');
    expect(caverns).toHaveLength(1);
    expect(caverns[0]!.controllerId).toBe('P2');
    expect(caverns[0]!.counters['luck']).toBe(1);
    expect(player(ctx, 'P2').hand).toHaveLength(1);
    expect(ctx.state.exile.filter((card) => card.ownerId === 'P2')).toHaveLength(1);
  });

  it('caverns-c01-negative — the starting player is not offered it, and declining keeps it in hand', () => {
    const ctx = game('pr11-caverns-starting');
    openingHand(ctx, 'P1');
    const decisions = pump(
      runOpeningHandBattlefieldActions(ctx),
      preferring('beginOnBattlefield'),
    ).decisions;
    expect(decisions.some((decision) => decision.player === 'P1')).toBe(false);
    expect(battlefield(ctx, 'Gemstone Caverns')).toEqual([]);

    const declined = game('pr11-caverns-decline');
    openingHand(declined, 'P2');
    pump(runOpeningHandBattlefieldActions(declined), preferring('decline'));
    expect(battlefield(declined, 'Gemstone Caverns')).toEqual([]);
    expect(player(declined, 'P2').hand).toHaveLength(3);
  });

  it('caverns-c02 — with a luck counter it taps for any color; without one, only {C}', () => {
    const ctx = game('pr11-caverns-mana');
    const lucky = spawn(ctx, 'P1', CAVERNS);
    lucky.counters['luck'] = 1;
    expect(castable(ctx, 'P1', '{R}')).toBe(true);
    expect(castable(ctx, 'P1', '{U}')).toBe(true);
    expect(castable(ctx, 'P1', '{R}{U}')).toBe(false);

    const plain = game('pr11-caverns-plain');
    spawn(plain, 'P1', CAVERNS);
    expect(castable(plain, 'P1', '{1}')).toBe(true);
    expect(castable(plain, 'P1', '{R}')).toBe(false);
  });
});

const GUT = pinned('Gut, True Soul Zealot');

describe('Gut, True Soul Zealot', () => {
  const thopter = (): OracleCard =>
    oracle({ name: 'Spare Artifact', typeLine: 'Artifact', manaCost: '{1}' });
  /** P1 attacks P2 with `attacker`; `sacrifice` names the permanent to sacrifice, or null to decline. */
  function attack(ctx: GameContext, attacker: string, sacrifice: string | null): string[] {
    ctx.state.phase = 'combat';
    const offered: string[] = [];
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === attacker ? 'P2' : null));
      const accept = decision.options.findIndex((option) => option.type === 'acceptTrigger');
      if (accept >= 0) {
        const decline = decision.options.findIndex((option) => option.type === 'declineTrigger');
        return { index: sacrifice === null ? decline : accept, targets: new Map() };
      }
      if (decision.prompt.includes('choose a permanent to sacrifice')) {
        offered.push(...decision.options.map((option) => option.description));
        const index = decision.options.findIndex(
          (option) => option.description === `Sacrifice ${sacrifice}`,
        );
        return { index: Math.max(0, index), targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });
    return offered;
  }

  it('gut-c01-positive — sacrificing another creature makes a tapped, attacking 4/1 menace Skeleton', () => {
    const ctx = game('pr11-gut-sacrifice');
    expect(interpretCard(GUT).modeled).toBe(true);
    const gut = spawn(ctx, 'P1', GUT);
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', thopter());
    const offered = attack(ctx, gut.id, 'Test Bear');
    expect(offered).toEqual(
      expect.arrayContaining(['Sacrifice Test Bear', 'Sacrifice Spare Artifact']),
    );
    expect(offered).not.toContain(`Sacrifice ${gut.name}`);
    expect(battlefield(ctx, 'Test Bear')).toEqual([]);
    const skeletons = battlefield(ctx, 'Skeleton');
    expect(skeletons).toHaveLength(1);
    const skeleton = skeletons[0]!;
    expect(skeleton.tapped).toBe(true);
    expect(computeCharacteristics(ctx, skeleton).power).toBe(4);
    expect(computeCharacteristics(ctx, skeleton).toughness).toBe(1);
    expect(computeCharacteristics(ctx, skeleton).colors).toEqual(['B']);
    expect(computeCharacteristics(ctx, skeleton).keywords).toContain('menace');
    // It attacked P2 alongside Gut: the 4 combat damage is in P2's life total.
    expect(player(ctx, 'P2').life).toBe(40 - computeCharacteristics(ctx, gut).power - 4);
  });

  it('gut-c01-negative — declining, or having nothing else to sacrifice, makes no Skeleton', () => {
    const ctx = game('pr11-gut-decline');
    const gut = spawn(ctx, 'P1', GUT);
    spawn(ctx, 'P1', bear());
    attack(ctx, gut.id, null);
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(1);
    expect(battlefield(ctx, 'Skeleton')).toEqual([]);

    const alone = game('pr11-gut-alone');
    const lonely = spawn(alone, 'P1', GUT);
    const offered = attack(alone, lonely.id, 'Gut, True Soul Zealot');
    expect(offered).toEqual([]);
    expect(battlefield(alone, 'Gut, True Soul Zealot')).toHaveLength(1);
  });

  it('gut-c02 — Choose a Background: Gut and a Background begin as joint commanders', () => {
    const background = oracle({
      name: 'Test Background',
      typeLine: 'Legendary Enchantment — Background',
      manaCost: '{1}{R}',
      colors: ['R'],
      subtypes: ['Background'],
      supertypes: ['Legendary'],
      oracleText: 'Commander creatures you own have haste.',
    });
    const ctx = createGame(
      gameConfig(
        [
          { cards: copies(10, plains), commanders: [GUT, background] },
          { cards: copies(10, plains) },
          { cards: copies(10, plains) },
          { cards: copies(10, plains) },
        ],
        { seed: 'pr11-gut-background' },
      ),
    );
    expect(player(ctx, 'P1').commanderCardIds).toHaveLength(2);
  });
});
