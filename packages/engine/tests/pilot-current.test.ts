/**
 * The phase 6 pilot's current-workflow batch (`overrides/pilot-current.ts`): behavior tests per
 * card, through the cost, legality and resolution paths a real game takes.
 */
import { describe, expect, it } from 'vitest';
import {
  computePriorityOptions,
  costReductionFor,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { allOf, ofSubtype, ofType, type Selector } from '../src/cards/selector';
import { spell } from '../src/cards/templates';
import { creatureToken } from '../src/cards/tokens';
import { constant } from '../src/cards/value';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { landPlayLimitFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { pinStore } from './scenario/pin-store';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  registerDef,
  spawn,
  swamp,
} from './fixtures';

/** A two-player game in P1's precombat main phase, turn 3, with empty boards. */
function mainPhase(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
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

const castable = (ctx: GameContext, objectId: string): boolean =>
  computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });

const spellCard = (name: string, manaCost: string, colors: Array<'B' | 'R'>) =>
  oracle({
    name,
    typeLine: 'Sorcery',
    manaCost,
    colors,
    colorIdentity: colors,
    oracleText: 'You gain 1 life.',
  });

describe('Jet Medallion', () => {
  const black = () => spellCard('Pilot Black Sorcery', '{1}{B}', ['B']);
  const red = () => spellCard('Pilot Red Sorcery', '{1}{R}', ['R']);
  const blackRed = () => spellCard('Pilot Black-Red Sorcery', '{1}{B}{R}', ['B', 'R']);
  const onlyBlack = () => spellCard('Pilot Pip Sorcery', '{B}', ['B']);

  it('jet-medallion-reduces-black — black spells you cast cost {1} less, a multicolored black one too', () => {
    const ctx = mainPhase('jet-medallion-black');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    for (const card of [black(), blackRed()]) registerDef(ctx, card);
    expect(costReductionFor(ctx, 'P1', black().oracleId, 'c-black').generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', blackRed().oracleId, 'c-black-red').generic).toBe(1);
  });

  it('jet-medallion-not-other-colors — a nonblack spell and an opponent’s black spell cost the same', () => {
    const ctx = mainPhase('jet-medallion-negative');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    for (const card of [black(), red()]) registerDef(ctx, card);
    expect(costReductionFor(ctx, 'P1', red().oracleId, 'c-red').generic).toBe(0);
    expect(costReductionFor(ctx, 'P2', black().oracleId, 'c-black').generic).toBe(0);
  });

  it('jet-medallion-castable — one Swamp casts a {1}{B} spell, and not a {1}{R} one or a {B}{B}', () => {
    const ctx = mainPhase('jet-medallion-castable');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    spawn(ctx, 'P1', swamp());
    const blackSpell = conjure(ctx, 'P1', black(), 'hand');
    const redSpell = conjure(ctx, 'P1', red(), 'hand');
    const twoPips = conjure(ctx, 'P1', spellCard('Pilot Two Pips', '{B}{B}', ['B']), 'hand');
    expect(castable(ctx, blackSpell.id)).toBe(true);
    expect(castable(ctx, redSpell.id)).toBe(false);
    // Only generic mana is reduced (CR 601.2f): {B}{B} still needs two black.
    expect(castable(ctx, twoPips.id)).toBe(false);
  });

  it('jet-medallion-colored-only — a spell whose cost is all {B} costs the same', () => {
    const ctx = mainPhase('jet-medallion-pip');
    spawn(ctx, 'P1', pinStore.get('Jet Medallion'));
    registerDef(ctx, onlyBlack());
    expect(costReductionFor(ctx, 'P1', onlyBlack().oracleId, 'c-pip').generic).toBe(1);
    const pip = conjure(ctx, 'P1', onlyBlack(), 'hand');
    expect(castable(ctx, pip.id)).toBe(false);
    spawn(ctx, 'P1', swamp());
    expect(castable(ctx, pip.id)).toBe(true);
  });

  it('jet-medallion-without-it — the same {1}{B} spell needs two lands without the Medallion', () => {
    const ctx = mainPhase('jet-medallion-absent');
    spawn(ctx, 'P1', swamp());
    const blackSpell = conjure(ctx, 'P1', black(), 'hand');
    expect(castable(ctx, blackSpell.id)).toBe(false);
  });
});

describe('Explore', () => {
  const landPlayOffered = (ctx: GameContext): boolean =>
    computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
      (option) => (option.payload as PriorityActionPayload).kind === 'playLand',
    );
  /** Resolve Explore for P1, as its spell ability does on resolution. */
  const resolveExplore = (ctx: GameContext): void => {
    const card = pinStore.get('Explore');
    // A source P1 controls stands in for the resolving spell.
    pump(executeAbility(ctx, spawn(ctx, 'P1', card), interpretCard(card).spellAbility!, []));
  };

  it('explore-extra-land-play — after a land this turn, you may play one more, and you draw', () => {
    const ctx = mainPhase('explore-extra');
    conjure(ctx, 'P1', forest(), 'hand');
    const p1 = playerById(ctx, 'P1');
    p1.landsPlayedThisTurn = 1;
    expect(landPlayOffered(ctx)).toBe(false);
    const hand = p1.hand.length;
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P1')).toBe(2);
    expect(landPlayOffered(ctx)).toBe(true);
    expect(p1.hand.length).toBe(hand + 1);
  });

  it('explore-lapses — the extra land play is gone next turn', () => {
    const ctx = mainPhase('explore-lapse');
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P1')).toBe(2);
    ctx.state.turnNumber += 1;
    expect(landPlayLimitFor(ctx, 'P1')).toBe(1);
  });

  it('explore-twice — two Explores this turn give two more land plays', () => {
    const ctx = mainPhase('explore-twice');
    resolveExplore(ctx);
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P1')).toBe(3);
  });

  it('explore-only-you — an opponent gets no extra land play', () => {
    const ctx = mainPhase('explore-only-you');
    resolveExplore(ctx);
    expect(landPlayLimitFor(ctx, 'P2')).toBe(1);
  });
});

describe('The Great Henge', () => {
  const creature = (name: string, power: number) =>
    oracle({
      name,
      typeLine: 'Creature — Giant',
      manaCost: '{G}',
      power: String(power),
      toughness: String(power),
    });
  const henge = () => pinStore.get('The Great Henge');

  it('great-henge-greatest-power — X is the greatest power among your creatures, not their total', () => {
    const ctx = mainPhase('henge-greatest');
    spawn(ctx, 'P1', creature('Pilot Two', 2));
    spawn(ctx, 'P1', creature('Pilot Four', 4));
    registerDef(ctx, henge());
    expect(costReductionFor(ctx, 'P1', henge().oracleId, 'c-henge').generic).toBe(4);
  });

  it('great-henge-only-yours — an opponent’s bigger creature does not count', () => {
    const ctx = mainPhase('henge-yours');
    spawn(ctx, 'P1', creature('Pilot Two', 2));
    spawn(ctx, 'P2', creature('Pilot Nine', 9));
    registerDef(ctx, henge());
    expect(costReductionFor(ctx, 'P1', henge().oracleId, 'c-henge').generic).toBe(2);
  });

  it('great-henge-castable — a 4-power creature lets five Forests cast it, four do not', () => {
    const ctx = mainPhase('henge-castable');
    spawn(ctx, 'P1', creature('Pilot Four', 4));
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    const card = conjure(ctx, 'P1', henge(), 'hand');
    expect(castable(ctx, card.id)).toBe(false);
    spawn(ctx, 'P1', forest());
    expect(castable(ctx, card.id)).toBe(true);
  });

  it('great-henge-floor — however great the power, {G}{G} is still paid (CR 601.2f)', () => {
    const ctx = mainPhase('henge-floor');
    spawn(ctx, 'P1', creature('Pilot Twelve', 12));
    spawn(ctx, 'P1', forest());
    const card = conjure(ctx, 'P1', henge(), 'hand');
    expect(castable(ctx, card.id)).toBe(false);
    spawn(ctx, 'P1', forest());
    expect(castable(ctx, card.id)).toBe(true);
  });

  it('great-henge-mana-ability — its {G}{G} is a mana ability that pays for a spell', () => {
    // CR 605.1a: it has no target and adds mana, so it does not use the stack and can be
    // activated while paying a cost; the life is gained as the mana is made.
    const ctx = mainPhase('henge-mana');
    spawn(ctx, 'P1', henge());
    const bearCard = conjure(ctx, 'P1', creature('Pilot Two', 2), 'hand');
    expect(castable(ctx, bearCard.id)).toBe(true);
  });

  it('great-henge-no-creatures — with no creature it costs the full {7}{G}{G}', () => {
    const ctx = mainPhase('henge-none');
    registerDef(ctx, henge());
    expect(costReductionFor(ctx, 'P1', henge().oracleId, 'c-henge').generic).toBe(0);
  });
});

describe('Gamble', () => {
  const gambleCard = () => pinStore.get('Gamble');
  const prize = () =>
    oracle({
      name: 'Pilot Prize',
      typeLine: 'Sorcery',
      manaCost: '{U}',
      oracleText: 'Draw a card.',
    });
  /** P1's library holds Pilot Prize among Forests; resolve Gamble, finding Pilot Prize. */
  function gamble(seed: string, handCards: number): GameContext {
    const ctx = mainPhase(seed);
    conjure(ctx, 'P1', prize(), 'library');
    for (let i = 0; i < handCards; i++) conjure(ctx, 'P1', swamp(), 'hand');
    pump(
      executeAbility(
        ctx,
        spawn(ctx, 'P1', gambleCard()),
        interpretCard(gambleCard()).spellAbility!,
        [],
      ),
      (decision) => pick(decision, /Pilot Prize/),
    );
    return ctx;
  }
  const names = (cards: ReadonlyArray<{ name: string }>) => cards.map((card) => card.name);

  it('gamble-tutor-then-random-discard — the found card goes to hand, then one card is discarded at random', () => {
    const before = mainPhase('gamble-count');
    const handBefore = playerById(before, 'P1').hand.length;
    const ctx = gamble('gamble-count', 2);
    const p1 = playerById(ctx, 'P1');
    // Two Swamps and the prize came to hand; one of those three was discarded.
    expect(p1.hand).toHaveLength(handBefore + 2);
    expect(p1.graveyard).toHaveLength(1);
    expect(['Swamp', 'Pilot Prize']).toContain(p1.graveyard[0]!.name);
    expect(
      [...names(p1.hand), ...names(p1.graveyard)].filter((name) => name === 'Pilot Prize'),
    ).toHaveLength(1);
  });

  it('gamble-discards-the-find — with an otherwise empty hand, the found card is the one discarded', () => {
    const ctx = mainPhase('gamble-empty');
    const p1 = playerById(ctx, 'P1');
    p1.hand.splice(0);
    conjure(ctx, 'P1', prize(), 'library');
    pump(
      executeAbility(
        ctx,
        spawn(ctx, 'P1', gambleCard()),
        interpretCard(gambleCard()).spellAbility!,
        [],
      ),
      (decision) => pick(decision, /Pilot Prize/),
    );
    expect(names(p1.graveyard)).toEqual(['Pilot Prize']);
    expect(p1.hand).toHaveLength(0);
  });

  it('gamble-order — search, then the discard, then the shuffle', () => {
    const ctx = gamble('gamble-order', 1);
    const types = ctx.state.eventLog.map((event) => event.type);
    const discard = types.lastIndexOf('discard');
    expect(discard).toBeGreaterThan(-1);
    expect(types.lastIndexOf('shuffle')).toBeGreaterThan(discard);
  });

  it('gamble-seeded — the random discard repeats for the same seed', () => {
    const discarded = (seed: string) => names(playerById(gamble(seed, 3), 'P1').graveyard);
    expect(discarded('gamble-seed')).toEqual(discarded('gamble-seed'));
  });
});

describe('Secluded Courtyard', () => {
  const courtyard = () => pinStore.get('Secluded Courtyard');
  const creature = (name: string, subtype: string, oracleText = '') =>
    oracle({
      name,
      typeLine: `Creature — ${subtype}`,
      manaCost: '{G}',
      power: '1',
      toughness: '1',
      subtypes: [subtype],
      colors: ['G'],
      oracleText,
    });
  /** A Courtyard on P1's battlefield, its creature type already chosen. */
  const courtyardChoosing = (ctx: GameContext, chosen: string | undefined) => {
    const land = spawn(ctx, 'P1', courtyard());
    if (chosen !== undefined) land.chosenOption = chosen;
    return land;
  };
  const activatable = (ctx: GameContext, objectId: string): boolean =>
    computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === objectId;
    });

  it('secluded-courtyard-chosen-creature — its colored mana casts a creature spell of the chosen type, not another', () => {
    const ctx = mainPhase('courtyard-creature');
    courtyardChoosing(ctx, 'Elf');
    const elf = conjure(ctx, 'P1', creature('Pilot Elf', 'Elf'), 'hand');
    const goblin = conjure(ctx, 'P1', creature('Pilot Goblin', 'Goblin'), 'hand');
    expect(castable(ctx, elf.id)).toBe(true);
    expect(castable(ctx, goblin.id)).toBe(false);
  });

  it('secluded-courtyard-creature-spell-only — its colored mana does not cast a noncreature spell', () => {
    const ctx = mainPhase('courtyard-noncreature');
    courtyardChoosing(ctx, 'Elf');
    const sorcery = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Pilot Green Sorcery',
        typeLine: 'Sorcery',
        manaCost: '{G}',
        colors: ['G'],
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    expect(castable(ctx, sorcery.id)).toBe(false);
  });

  it('secluded-courtyard-activate — it pays for an ability of a creature of the chosen type, not of another', () => {
    const ctx = mainPhase('courtyard-activate');
    courtyardChoosing(ctx, 'Elf');
    const pump = '{G}: This creature gets +1/+1 until end of turn.';
    const elf = spawn(ctx, 'P1', creature('Pilot Elf', 'Elf', pump));
    const goblin = spawn(ctx, 'P1', creature('Pilot Goblin', 'Goblin', pump));
    expect(activatable(ctx, elf.id)).toBe(true);
    expect(activatable(ctx, goblin.id)).toBe(false);
  });

  it('secluded-courtyard-colorless — its {C} pays for anything with a generic cost', () => {
    const ctx = mainPhase('courtyard-colorless');
    courtyardChoosing(ctx, 'Elf');
    const trinket = conjure(
      ctx,
      'P1',
      oracle({ name: 'Pilot Trinket', typeLine: 'Artifact', manaCost: '{1}' }),
      'hand',
    );
    const goblin = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Pilot Grey Goblin',
        typeLine: 'Creature — Goblin',
        manaCost: '{1}',
        power: '1',
        toughness: '1',
        subtypes: ['Goblin'],
      }),
      'hand',
    );
    expect(castable(ctx, trinket.id)).toBe(true);
    expect(castable(ctx, goblin.id)).toBe(true);
  });

  it('secluded-courtyard-choose-on-enter — it asks for a creature type as it enters and keeps the answer', () => {
    const ctx = mainPhase('courtyard-enter');
    // The offered types come from the decklist and the battlefield (see creatureTypeChoicesFor).
    spawn(ctx, 'P1', creature('Pilot Elf', 'Elf'));
    spawn(ctx, 'P1', creature('Pilot Goblin', 'Goblin'));
    const land = conjure(ctx, 'P1', courtyard(), 'hand');
    const asked: string[][] = [];
    pump(moveObject(ctx, land, { zone: 'battlefield' }), (decision) => {
      asked.push(decision.options.map((option) => option.description));
      return pick(decision, 'Elf');
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(expect.arrayContaining(['Elf', 'Goblin']));
    const entered = ctx.state.battlefield.find((perm) => perm.name === 'Secluded Courtyard');
    expect(entered?.chosenOption).toBe('Elf');
  });

  it('secluded-courtyard-unchosen — with no type chosen, its colored mana pays for nothing', () => {
    const ctx = mainPhase('courtyard-unchosen');
    courtyardChoosing(ctx, undefined);
    const elf = conjure(ctx, 'P1', creature('Pilot Elf', 'Elf'), 'hand');
    expect(castable(ctx, elf.id)).toBe(false);
  });
});

const creatureNamed = (name: string, subtype: string) =>
  oracle({
    name,
    typeLine: `Creature — ${subtype}`,
    manaCost: '{1}',
    power: '2',
    toughness: '2',
    subtypes: [subtype],
  });

describe('Morbid Opportunist', () => {
  const opportunist = () => pinStore.get('Morbid Opportunist');
  const wrath = (selector: Selector) =>
    spell({ effects: [{ op: 'destroyEach', selector }], description: 'Destroy each' });
  const bears = allOf(ofType('Creature'), ofSubtype('Bear'));
  const sorceryCaster = (ctx: GameContext) =>
    spawn(ctx, 'P1', oracle({ name: 'Pilot Caster', typeLine: 'Artifact', manaCost: '{1}' }));
  const morbidTriggers = (ctx: GameContext) =>
    ctx.state.pendingTriggers.filter((trigger) => trigger.sourceName === 'Morbid Opportunist');
  const destroy = (ctx: GameContext, selector: Selector) =>
    pump(executeAbility(ctx, sorceryCaster(ctx), wrath(selector), []), () => {
      throw new Error('destroying asks nothing');
    });

  it("morbid-opportunist-another-dies — an opponent's creature dying triggers it, and it draws a card", () => {
    const ctx = mainPhase('morbid-another');
    spawn(ctx, 'P1', opportunist());
    spawn(ctx, 'P2', bear());
    destroy(ctx, bears);
    const [trigger] = morbidTriggers(ctx);
    expect(morbidTriggers(ctx)).toHaveLength(1);
    expect(trigger!.controllerId).toBe('P1');
    expect(trigger!.ability.effects).toEqual([{ op: 'draw', count: constant(1) }]);
  });

  it('morbid-opportunist-simultaneous — creatures dying at once make one trigger, not one each', () => {
    const ctx = mainPhase('morbid-simultaneous');
    spawn(ctx, 'P1', opportunist());
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    destroy(ctx, bears);
    expect(morbidTriggers(ctx)).toHaveLength(1);
  });

  it('morbid-opportunist-once-each-turn — a second death later in the turn does not trigger it', () => {
    const ctx = mainPhase('morbid-once');
    spawn(ctx, 'P1', opportunist());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', creatureNamed('Pilot Wolf', 'Wolf'));
    destroy(ctx, bears);
    expect(morbidTriggers(ctx)).toHaveLength(1);
    ctx.state.pendingTriggers.length = 0;
    destroy(ctx, ofSubtype('Wolf'));
    expect(morbidTriggers(ctx)).toHaveLength(0);
  });

  it('morbid-opportunist-not-itself — its own death alone does not trigger it', () => {
    const ctx = mainPhase('morbid-self');
    spawn(ctx, 'P1', opportunist());
    destroy(ctx, ofType('Creature'));
    expect(morbidTriggers(ctx)).toHaveLength(0);
  });

  it('morbid-opportunist-dies-with-others — dying alongside another creature, it still triggers (CR 603.10a)', () => {
    const ctx = mainPhase('morbid-wrath');
    spawn(ctx, 'P1', opportunist());
    spawn(ctx, 'P2', bear());
    destroy(ctx, ofType('Creature'));
    expect(morbidTriggers(ctx)).toHaveLength(1);
  });

  it('morbid-opportunist-creatures-only — a noncreature permanent put into the graveyard does not trigger it', () => {
    const ctx = mainPhase('morbid-noncreature');
    spawn(ctx, 'P1', opportunist());
    spawn(ctx, 'P2', oracle({ name: 'Pilot Relic', typeLine: 'Artifact', manaCost: '{1}' }));
    destroy(ctx, ofType('Artifact'));
    expect(morbidTriggers(ctx)).toHaveLength(0);
  });
});

describe('Syr Konrad, the Grim', () => {
  const konrad = () => pinStore.get('Syr Konrad, the Grim');
  const activatable = (ctx: GameContext, objectId: string): boolean =>
    computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === objectId;
    });
  /** Put `card` on top of `seat`'s library. */
  const onTop = (ctx: GameContext, seat: string, card: ReturnType<typeof bear>) => {
    const placed = conjure(ctx, seat as 'P1', card, 'library');
    const library = playerById(ctx, seat as 'P1').library;
    library.splice(library.indexOf(placed), 1);
    library.unshift(placed);
  };
  const mill = (ctx: GameContext, source: ReturnType<typeof spawn>) =>
    pump(
      executeAbility(
        ctx,
        source,
        ctx.defs.get(source.oracleId)!.activatedAbilities[0]!.ability,
        [],
      ),
      () => {
        throw new Error('milling asks nothing');
      },
    );
  const konradTriggers = (ctx: GameContext) =>
    ctx.state.pendingTriggers.filter((trigger) => trigger.sourceName === 'Syr Konrad, the Grim');

  it('syr-konrad-each-player-mills — each player, you included, mills one card', () => {
    const ctx = mainPhase('konrad-mill');
    const source = spawn(ctx, 'P1', konrad());
    const before = ctx.state.players.map((player) => player.library.length);
    const tops = ctx.state.players.map((player) => player.library[0]!.name);
    mill(ctx, source);
    expect(ctx.state.players.map((player) => player.library.length)).toEqual(
      before.map((count) => count - 1),
    );
    expect(ctx.state.players.map((player) => player.graveyard.map((card) => card.name))).toEqual(
      tops.map((name) => [name]),
    );
  });

  it('syr-konrad-milled-creature — each creature card milled triggers its damage, from any library', () => {
    const ctx = mainPhase('konrad-creatures');
    const source = spawn(ctx, 'P1', konrad());
    onTop(ctx, 'P1', bear());
    onTop(ctx, 'P2', bear());
    mill(ctx, source);
    const triggers = konradTriggers(ctx);
    expect(triggers).toHaveLength(2);
    expect(triggers.every((trigger) => trigger.controllerId === 'P1')).toBe(true);
  });

  it('syr-konrad-milled-land — milling only lands does not trigger it', () => {
    const ctx = mainPhase('konrad-lands');
    const source = spawn(ctx, 'P1', konrad());
    mill(ctx, source);
    expect(
      ctx.state.players.flatMap((player) => player.graveyard.map((card) => card.name)),
    ).toEqual(['Forest', 'Forest']);
    expect(konradTriggers(ctx)).toHaveLength(0);
  });

  const destroyEach = (ctx: GameContext, source: ReturnType<typeof spawn>, selector: Selector) =>
    pump(
      executeAbility(
        ctx,
        source,
        spell({ effects: [{ op: 'destroyEach', selector }], description: 'Destroy each' }),
        [],
      ),
      () => {
        throw new Error('destroying asks nothing');
      },
    );
  const exileFromGraveyard = (ctx: GameContext, card: ReturnType<typeof conjure>) =>
    pump(moveObject(ctx, card, { zone: 'exile' }), () => {
      throw new Error('exiling asks nothing');
    });

  it("syr-konrad-other-creature-dies — another creature dying triggers it; its own death or a noncreature's does not", () => {
    const ctx = mainPhase('konrad-dies');
    const source = spawn(ctx, 'P1', konrad());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', oracle({ name: 'Pilot Relic', typeLine: 'Artifact', manaCost: '{1}' }));
    destroyEach(ctx, source, ofType('Artifact'));
    expect(konradTriggers(ctx)).toHaveLength(0);
    destroyEach(ctx, source, ofSubtype('Bear'));
    expect(konradTriggers(ctx)).toHaveLength(1);
    expect(konradTriggers(ctx)[0]!.ability.optional).not.toBe(true);

    const alone = mainPhase('konrad-dies-alone');
    const lone = spawn(alone, 'P1', konrad());
    destroyEach(alone, lone, ofType('Creature'));
    expect(konradTriggers(alone)).toHaveLength(0);
  });

  it('syr-konrad-token-dies — a creature token dying triggers it once, as a death only', () => {
    const ctx = mainPhase('konrad-token');
    const source = spawn(ctx, 'P1', konrad());
    pump(
      executeAbility(
        ctx,
        source,
        spell({
          effects: [
            {
              op: 'createToken',
              spec: creatureToken({
                name: 'Pilot Spirit',
                subtypes: ['Spirit'],
                colors: ['W'],
                power: 1,
                toughness: 1,
              }),
              count: constant(1),
            },
          ],
          description: 'Create a Spirit',
        }),
        [],
      ),
      () => {
        throw new Error('creating asks nothing');
      },
    );
    destroyEach(ctx, source, ofSubtype('Spirit'));
    expect(konradTriggers(ctx).map((trigger) => trigger.ability.trigger?.when)).toEqual(['dies']);
  });

  it('syr-konrad-leaves-graveyard — a creature card leaving your graveyard triggers it, nothing else does', () => {
    const ctx = mainPhase('konrad-leaves');
    spawn(ctx, 'P1', konrad());
    const relic = conjure(
      ctx,
      'P1',
      oracle({ name: 'Pilot Relic', typeLine: 'Artifact', manaCost: '{1}' }),
      'graveyard',
    );
    const theirs = conjure(ctx, 'P2', bear(), 'graveyard');
    exileFromGraveyard(ctx, relic);
    exileFromGraveyard(ctx, theirs);
    expect(konradTriggers(ctx)).toHaveLength(0);
    const mine = conjure(ctx, 'P1', bear(), 'graveyard');
    exileFromGraveyard(ctx, mine);
    const triggers = konradTriggers(ctx);
    expect(triggers.map((trigger) => trigger.ability.trigger?.when)).toEqual(['leavesGraveyard']);
    expect(triggers[0]!.ability.optional).not.toBe(true);
  });

  it('syr-konrad-cost — it costs {1}{B}: two Swamps activate it, one does not', () => {
    const ctx = mainPhase('konrad-cost');
    const source = spawn(ctx, 'P1', konrad());
    spawn(ctx, 'P1', swamp());
    expect(activatable(ctx, source.id)).toBe(false);
    spawn(ctx, 'P1', forest());
    expect(activatable(ctx, source.id)).toBe(true);
  });
});
