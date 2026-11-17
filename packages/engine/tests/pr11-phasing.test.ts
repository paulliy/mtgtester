import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { gainLife, loseLife } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { moveObject } from '../src/state/objects';
import { playerLifeLocked, playerProtectedFromEverything } from '../src/state/phasing';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, oracle, plains, pump, pumpStrict, spawn } from './fixtures';
import {
  activate,
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  combat,
  game,
  nextTurnOf,
  offeredTargets,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr11-helpers';

const TEFERI = pinned("Teferi's Protection");
const RING = pinned('The One Ring');
const CONCEALMENT = pinned('Clever Concealment');
const GRACE = pinned("Angel's Grace");

const redBolt = (): OracleCard =>
  oracle({
    name: 'Red Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Red Bolt deals 3 damage to any target.',
  });
const bigBolt = (): OracleCard =>
  oracle({
    name: 'Big Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Big Bolt deals 10 damage to any target.',
  });
const pingerRod = (): OracleCard =>
  oracle({
    name: 'Rod',
    typeLine: 'Artifact',
    manaCost: '{1}',
    oracleText: '{T}: Rod deals 1 damage to any target.',
  });
const aura = (): OracleCard =>
  oracle({
    name: 'Test Aura',
    typeLine: 'Enchantment — Aura',
    manaCost: '{W}',
    oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
  });
const trinket = (): OracleCard =>
  oracle({ name: 'Trinket', typeLine: 'Artifact', manaCost: '{1}', oracleText: '' });

const castsBolt = (ctx: GameContext, playerId: string) =>
  priorityOption(ctx, playerId, (payload) => payload.kind === 'castSpell') !== undefined;

/** P2 attacks P1 with a fresh 3/3; returns P1's life afterward. */
function opponentAttacks(ctx: GameContext): number {
  ctx.state.currentTurnPlayer = 'P2';
  ctx.state.activePlayerIndex = 1;
  const attacker = spawn(
    ctx,
    'P2',
    oracle({ name: 'Raider', typeLine: 'Creature — Test', power: '3', toughness: '3' }),
  );
  combat(ctx, attacker, 'P1');
  return player(ctx, 'P1').life;
}

const phasedIds = (ctx: GameContext): string[] =>
  (ctx.state.phasedOut ?? []).map((record) => record.permanent.id);

describe('PR11 phasing and player protection — modeled', () => {
  it('pr11-phasing-modeled — the four cards model with every reason cleared', () => {
    for (const card of [TEFERI, RING, CONCEALMENT, GRACE]) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
    }
    expect(interpretCard(RING).keywords).toContain('indestructible');
    expect(interpretCard(CONCEALMENT).keywords).toContain('convoke');
    expect(interpretCard(GRACE).keywords).toContain('split second');
  });
});

describe("Teferi's Protection", () => {
  function castTeferi(ctx: GameContext): void {
    castFromHand(ctx, 'P1', TEFERI, new Map(), { W: 1, C: 2 });
    resolve(ctx);
  }

  it('teferi-c01 — phases out your permanents and their attachments; others stay', () => {
    const ctx = game('pr11-teferi-phase');
    const mine = spawn(ctx, 'P1', bear());
    const theirAura = spawn(ctx, 'P2', aura());
    theirAura.attachedTo = mine.id;
    const theirs = spawn(ctx, 'P2', bear());
    castTeferi(ctx);
    expect(phasedIds(ctx)).toEqual(expect.arrayContaining([mine.id, theirAura.id]));
    expect(phasedIds(ctx)).not.toContain(theirs.id);
    expect(ctx.state.battlefield.some((perm) => perm.id === theirs.id)).toBe(true);
    // "Exile Teferi's Protection."
    expect(ctx.state.exile.some((card) => card.name === "Teferi's Protection")).toBe(true);
  });

  it('teferi-c02 — your life total cannot change and you have protection from everything', () => {
    const ctx = game('pr11-teferi-lock');
    castTeferi(ctx);
    const life = player(ctx, 'P1').life;
    pumpStrict(gainLife(ctx, player(ctx, 'P1'), 4));
    loseLife(ctx, player(ctx, 'P1'), 4);
    expect(player(ctx, 'P1').life).toBe(life);
    conjure(ctx, 'P2', redBolt(), 'hand');
    anyMana(ctx, 'P2', 1);
    expect(offeredTargets(ctx, 'P2', (payload) => payload.kind === 'castSpell')).not.toContain(
      'P1',
    );
    expect(opponentAttacks(ctx)).toBe(life);
  });

  it('teferi-c03 — the shield ends and the permanents phase in as your next turn begins', () => {
    const ctx = game('pr11-teferi-expiry');
    const mine = spawn(ctx, 'P1', bear(), { tapped: true });
    castTeferi(ctx);
    nextTurnOf(ctx, 'P1');
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(false);
    expect(playerLifeLocked(ctx, 'P1')).toBe(false);
    expect(ctx.state.phasedOut ?? []).toEqual([]);
    expect(battlefield(ctx, 'Test Bear')[0]).toBe(mine);
    expect(mine.tapped).toBe(false);
    nextTurnOf(ctx, 'P2');
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(false);
    expect(playerLifeLocked(ctx, 'P1')).toBe(false);
  });
});

describe('The One Ring', () => {
  function castRing(ctx: GameContext): EnginePermanent {
    castFromHand(ctx, 'P1', RING, new Map(), { C: 4 });
    resolve(ctx);
    checkpoint(ctx);
    // The enter trigger is mandatory ("you gain protection"): nothing asks "use it?" first.
    const decisions = resolve(ctx);
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    return battlefield(ctx, 'The One Ring')[0]!;
  }

  it('ring-c02-positive — cast, it gives protection from everything but life still changes', () => {
    const ctx = game('pr11-ring-cast');
    castRing(ctx);
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(true);
    expect(playerLifeLocked(ctx, 'P1')).toBe(false);
    const life = player(ctx, 'P1').life;
    loseLife(ctx, player(ctx, 'P1'), 2);
    pumpStrict(gainLife(ctx, player(ctx, 'P1'), 1));
    expect(player(ctx, 'P1').life).toBe(life - 1);
    conjure(ctx, 'P2', redBolt(), 'hand');
    anyMana(ctx, 'P2', 1);
    expect(offeredTargets(ctx, 'P2', (payload) => payload.kind === 'castSpell')).not.toContain(
      'P1',
    );
    expect(opponentAttacks(ctx)).toBe(life - 1);
  });

  it('ring-c02-negative — put onto the battlefield without casting, no protection', () => {
    const ctx = game('pr11-ring-uncast');
    const card = conjure(ctx, 'P1', RING, 'hand');
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    checkpoint(ctx);
    if (ctx.state.stack.length > 0) resolve(ctx);
    expect(battlefield(ctx, 'The One Ring')).toHaveLength(1);
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(false);
  });

  it('ring-c02-expiry — the protection ends as your next turn begins', () => {
    const ctx = game('pr11-ring-expiry');
    castRing(ctx);
    nextTurnOf(ctx, 'P2');
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(true);
    nextTurnOf(ctx, 'P1');
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(false);
    // Gone for good: an opponent's later turn does not bring it back.
    nextTurnOf(ctx, 'P2');
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(false);
  });

  it('ring-c04 — {T} adds a burden counter, then draws one card per burden counter', () => {
    const ctx = game('pr11-ring-tap');
    const ring = castRing(ctx);
    const hand = player(ctx, 'P1').hand.length;
    expect(ring.tapped).toBe(false);
    activate(ctx, 'P1', ring);
    // {T} is a cost: the Ring is tapped as the ability goes on the stack.
    expect(ring.tapped).toBe(true);
    resolve(ctx);
    expect(ring.counters['burden']).toBe(1);
    expect(player(ctx, 'P1').hand.length).toBe(hand + 1);
    ring.tapped = false;
    activate(ctx, 'P1', ring);
    resolve(ctx);
    expect(ring.counters['burden']).toBe(2);
    expect(player(ctx, 'P1').hand.length).toBe(hand + 3);
  });

  it('ring-c03 — at your upkeep you lose 1 life per burden counter; not on others’ upkeeps', () => {
    const ctx = game('pr11-ring-upkeep');
    const ring = castRing(ctx);
    ring.counters['burden'] = 3;
    const life = player(ctx, 'P1').life;
    nextTurnOf(ctx, 'P2');
    expect(player(ctx, 'P1').life).toBe(life);
    const decisions = nextTurnOf(ctx, 'P1');
    expect(player(ctx, 'P1').life).toBe(life - 3);
    // The upkeep trigger is mandatory ("you lose 1 life"): no "use it?" was asked.
    expect(decisions.map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
  });

  it('ring-c01 — indestructible: lethal destruction leaves it on the battlefield', () => {
    const ctx = game('pr11-ring-indestructible');
    const ring = castRing(ctx);
    castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Shatter Test',
        typeLine: 'Instant',
        manaCost: '{R}',
        colors: ['R'],
        oracleText: 'Destroy target artifact.',
      }),
      new Map([[0, ring.id]]),
      { R: 1 },
    );
    resolve(ctx);
    expect(battlefield(ctx, 'The One Ring')).toEqual([ring]);
  });
});

describe('Clever Concealment', () => {
  it('concealment-c02-targets — offers only nonland permanents you control', () => {
    const ctx = game('pr11-concealment-targets');
    const mine = spawn(ctx, 'P1', bear());
    const land = spawn(ctx, 'P1', plains());
    const theirs = spawn(ctx, 'P2', bear());
    // A variable-count slot is chosen in decisions after the cast begins; capture them.
    castFromHand(ctx, 'P1', CONCEALMENT, new Map(), { W: 2, C: 2 }, (decision) => {
      const ids = decision.options.map((entry) => entry.data?.['objectId']);
      if (decision.prompt.startsWith('Choose target')) {
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);
        expect(ids).not.toContain(land.id);
      }
      return { index: 0, targets: new Map() };
    });
  });

  it('concealment-c02 — the chosen permanents phase out with attachments; others stay', () => {
    const ctx = game('pr11-concealment-phase');
    const chosen = spawn(ctx, 'P1', bear());
    const attached = spawn(ctx, 'P2', aura());
    attached.attachedTo = chosen.id;
    const unchosen = spawn(ctx, 'P1', trinket());
    castFromHand(ctx, 'P1', CONCEALMENT, new Map(), { W: 2, C: 2 }, (decision) => {
      if (!decision.prompt.startsWith('Choose target')) return { index: 0, targets: new Map() };
      const pick = decision.options.findIndex((entry) => entry.data?.['objectId'] === chosen.id);
      const stop = decision.options.findIndex((entry) => entry.type === 'decline');
      return { index: pick >= 0 ? pick : stop, targets: new Map() };
    });
    resolve(ctx);
    expect(phasedIds(ctx)).toEqual(expect.arrayContaining([chosen.id, attached.id]));
    expect(phasedIds(ctx)).not.toContain(unchosen.id);
    expect(battlefield(ctx, 'Trinket')).toEqual([unchosen]);
    expect(playerProtectedFromEverything(ctx, 'P1')).toBe(false);
  });

  it('concealment-c02-return — they phase in during your next untap step, unchanged', () => {
    const ctx = game('pr11-concealment-return');
    const chosen = spawn(ctx, 'P1', bear());
    chosen.counters['+1/+1'] = 2;
    castFromHand(ctx, 'P1', CONCEALMENT, new Map(), { W: 2, C: 2 });
    resolve(ctx);
    expect(phasedIds(ctx)).toContain(chosen.id);
    nextTurnOf(ctx, 'P2');
    expect(phasedIds(ctx)).toContain(chosen.id);
    nextTurnOf(ctx, 'P1');
    expect(battlefield(ctx, 'Test Bear')).toEqual([chosen]);
    expect(chosen.counters['+1/+1']).toBe(2);
  });

  it('concealment-c01 — convoke: tapping two creatures pays for part of the cost', () => {
    const ctx = game('pr11-concealment-convoke');
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    for (const land of ctx.state.battlefield) if (land.controllerId === 'P1') land.tapped = true;
    for (const creature of battlefield(ctx, 'Test Bear')) creature.tapped = false;
    // {W}{W} from the pool, {2} from the two Bears.
    castFromHand(ctx, 'P1', CONCEALMENT, new Map(), { W: 2 });
    expect(ctx.state.stack.some((entry) => entry.description.length > 0)).toBe(true);
    expect(battlefield(ctx, 'Test Bear').every((creature) => creature.tapped)).toBe(true);
  });
});

describe("Angel's Grace", () => {
  function castGrace(ctx: GameContext): void {
    castFromHand(ctx, 'P1', GRACE, new Map(), { W: 1 });
  }

  it('grace-c01-positive — while it is on the stack nobody may cast spells or activate abilities', () => {
    const ctx = game('pr11-grace-split-second');
    spawn(ctx, 'P2', pingerRod());
    conjure(ctx, 'P2', redBolt(), 'hand');
    addMana(player(ctx, 'P2'), [{ symbol: 'R' }, { symbol: 'C' }]);
    expect(castsBolt(ctx, 'P2')).toBe(true);
    castGrace(ctx);
    const options = computePriorityOptions(ctx, player(ctx, 'P2'));
    expect(options.map((entry) => entry.type)).not.toContain('castSpell');
    expect(options.map((entry) => entry.type)).not.toContain('activateAbility');
    expect(options.map((entry) => entry.type)).toContain('pass');
    expect(
      computePriorityOptions(ctx, player(ctx, 'P1')).some(
        (entry) => entry.type === 'castSpell' || entry.type === 'activateAbility',
      ),
    ).toBe(false);
  });

  it('grace-c01-negative — once it resolves, spells and abilities are available again', () => {
    const ctx = game('pr11-grace-after');
    spawn(ctx, 'P2', pingerRod());
    conjure(ctx, 'P2', redBolt(), 'hand');
    addMana(player(ctx, 'P2'), [{ symbol: 'R' }, { symbol: 'C' }]);
    castGrace(ctx);
    resolve(ctx);
    const types = computePriorityOptions(ctx, player(ctx, 'P2')).map((entry) => entry.type);
    expect(types).toContain('castSpell');
    expect(types).toContain('activateAbility');
  });

  it('grace-c02-positive — you cannot lose this turn: zero life, empty-library draw, poison', () => {
    const ctx = game('pr11-grace-cant-lose');
    castGrace(ctx);
    resolve(ctx);
    const me = player(ctx, 'P1');
    loseLife(ctx, me, me.life + 5);
    me.poisonCounters = 10;
    me.attemptedDrawFromEmptyLibrary = true;
    checkpoint(ctx);
    expect(me.hasLost).toBe(false);
    expect(ctx.state.eliminatedPlayers).not.toContain('P1');
  });

  it('grace-c02-expiry — the protection lasts this turn only; the loss applies next turn', () => {
    const ctx = game('pr11-grace-expiry');
    castGrace(ctx);
    resolve(ctx);
    const me = player(ctx, 'P1');
    loseLife(ctx, me, me.life);
    checkpoint(ctx);
    expect(me.hasLost).toBe(false);
    ctx.state.turnNumber += 1;
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    checkpoint(ctx);
    expect(me.hasLost).toBe(true);
  });

  it('grace-c02-negative — opponents can still lose, and so can you without it', () => {
    const ctx = game('pr11-grace-others');
    castGrace(ctx);
    resolve(ctx);
    loseLife(ctx, player(ctx, 'P2'), 100);
    checkpoint(ctx);
    expect(player(ctx, 'P2').hasLost).toBe(true);

    const plain = game('pr11-grace-none');
    loseLife(plain, player(plain, 'P1'), 100);
    checkpoint(plain);
    expect(player(plain, 'P1').hasLost).toBe(true);
  });

  it('grace-c03-positive — damage that would take you below 1 leaves you at 1', () => {
    const ctx = game('pr11-grace-floor');
    castGrace(ctx);
    resolve(ctx);
    player(ctx, 'P1').life = 5;
    castFromHand(ctx, 'P2', bigBolt(), new Map([[0, 'P1']]), { R: 1 });
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(1);
  });

  it('grace-c03-below-one — damage never raises a total already below 1', () => {
    const ctx = game('pr11-grace-below-one');
    castGrace(ctx);
    resolve(ctx);
    loseLife(ctx, player(ctx, 'P1'), player(ctx, 'P1').life + 1);
    expect(player(ctx, 'P1').life).toBe(-1);
    castFromHand(ctx, 'P2', bigBolt(), new Map([[0, 'P1']]), { R: 1 });
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(-1);
  });

  it('grace-c03-at-one — damage at 1 life leaves the total unchanged and loses no life', () => {
    const ctx = game('pr11-grace-at-one');
    castGrace(ctx);
    resolve(ctx);
    player(ctx, 'P1').life = 1;
    castFromHand(ctx, 'P2', bigBolt(), new Map([[0, 'P1']]), { R: 1 });
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(1);
    expect(ctx.state.lifeLostThisTurn['P1']).not.toBe(true);
  });

  it('grace-c03-negative — life loss is not damage and still goes below 1', () => {
    const ctx = game('pr11-grace-loss');
    castGrace(ctx);
    resolve(ctx);
    player(ctx, 'P1').life = 5;
    loseLife(ctx, player(ctx, 'P1'), 8);
    expect(player(ctx, 'P1').life).toBe(-3);
    checkpoint(ctx);
    expect(player(ctx, 'P1').hasLost).toBe(false);
  });
});
