import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { payManaCost } from '../src/effects/resolve';
import { parseManaCost } from '../src/mana/cost';
import { keepValues, manaDemand } from '../src/mana/tap-preference';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { EnginePermanent } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  plains,
  pumpStrict,
  spawn,
  swamp,
} from './fixtures';

const spell = (name: string, manaCost: string) =>
  oracle({ name, manaCost, typeLine: 'Sorcery', oracleText: 'Draw a card.' });

const underground = () => oracle({ name: 'Test Sea', typeLine: 'Land — Island Swamp' });

function setup() {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  const pay = (cost: string) => pumpStrict(payManaCost(ctx, player, parseManaCost(cost).cost!));
  const tapped = (perms: EnginePermanent[]) => perms.filter((p) => p.tapped).map((p) => p.name);
  return { ctx, player, pay, tapped };
}

describe('auto-pay leaves untapped what other costs still need', () => {
  it('pays generic with a Swamp, not the Island a blue spell in hand needs', () => {
    const { ctx, player, pay } = setup();
    // The Island comes first on the battlefield, so battlefield order alone would tap it.
    const isl = spawn(ctx, player.id, island());
    const swamps = [0, 1, 2].map(() => spawn(ctx, player.id, swamp()));
    conjure(ctx, player.id, spell('Blue Spell', '{1}{U}'), 'hand');
    pay('{1}{B}');
    expect(isl.tapped).toBe(false);
    expect(swamps.filter((s) => s.tapped)).toHaveLength(2);
  });

  it('pays the blue spell with the Island and a Swamp, keeping Swamps for the black one', () => {
    const { ctx, player, pay } = setup();
    const isl = spawn(ctx, player.id, island());
    const swamps = [0, 1, 2].map(() => spawn(ctx, player.id, swamp()));
    conjure(ctx, player.id, spell('Black Spell', '{1}{B}'), 'hand');
    pay('{1}{U}');
    expect(isl.tapped).toBe(true);
    expect(swamps.filter((s) => s.tapped)).toHaveLength(1);
  });

  it('still taps the Island when nothing else can pay', () => {
    const { ctx, player, pay } = setup();
    const isl = spawn(ctx, player.id, island());
    const swmp = spawn(ctx, player.id, swamp());
    conjure(ctx, player.id, spell('Blue Spell', '{1}{U}'), 'hand');
    pay('{1}{B}');
    expect(isl.tapped).toBe(true);
    expect(swmp.tapped).toBe(true);
  });

  it('scales to five colors: a green payment spends only Forests', () => {
    const { ctx, player, pay, tapped } = setup();
    const perms = [
      spawn(ctx, player.id, plains()),
      spawn(ctx, player.id, island()),
      spawn(ctx, player.id, swamp()),
      spawn(ctx, player.id, mountain()),
      spawn(ctx, player.id, forest()),
      spawn(ctx, player.id, forest()),
      spawn(ctx, player.id, forest()),
    ];
    for (const [name, cost] of [
      ['White Spell', '{W}'],
      ['Blue Spell', '{U}'],
      ['Black Spell', '{B}'],
      ['Red Spell', '{R}'],
    ] as const)
      conjure(ctx, player.id, spell(name, cost), 'hand');
    pay('{2}{G}');
    expect(tapped(perms)).toEqual(['Forest', 'Forest', 'Forest']);
  });

  it('spends the color the hand wants least when it has to spend a needed one', () => {
    const { ctx, player, pay, tapped } = setup();
    const perms = [
      spawn(ctx, player.id, plains()),
      spawn(ctx, player.id, mountain()),
      spawn(ctx, player.id, mountain()),
      spawn(ctx, player.id, forest()),
    ];
    // White is wanted once from a single Plains; red once from two Mountains.
    conjure(ctx, player.id, spell('White Spell', '{W}'), 'hand');
    conjure(ctx, player.id, spell('Red Spell', '{R}'), 'hand');
    pay('{1}{G}');
    expect(tapped(perms)).toEqual(['Mountain', 'Forest']);
  });

  it('keeps a dual land for the color only it and the Island share', () => {
    const { ctx, player, pay, tapped } = setup();
    const perms = [
      spawn(ctx, player.id, underground()),
      spawn(ctx, player.id, swamp()),
      spawn(ctx, player.id, swamp()),
    ];
    conjure(ctx, player.id, spell('Blue Spell', '{U}'), 'hand');
    pay('{1}{B}');
    expect(tapped(perms)).toEqual(['Swamp', 'Swamp']);
  });

  it('spends basics before a dual when nothing in hand tells them apart', () => {
    const { ctx, player, pay, tapped } = setup();
    const perms = [
      spawn(ctx, player.id, underground()),
      spawn(ctx, player.id, swamp()),
      spawn(ctx, player.id, island()),
    ];
    pay('{2}');
    expect(tapped(perms)).toEqual(['Swamp', 'Island']);
  });

  it('counts a commander in the command zone and activated abilities on the battlefield', () => {
    const { ctx, player, pay } = setup();
    const isl = spawn(ctx, player.id, island());
    const mtn = spawn(ctx, player.id, mountain());
    const swamps = [0, 1].map(() => spawn(ctx, player.id, swamp()));
    conjure(ctx, player.id, oracle({ name: 'Blue Commander', manaCost: '{2}{U}' }), 'command', {
      isCommander: true,
    });
    spawn(
      ctx,
      player.id,
      oracle({
        name: 'Red Engine',
        typeLine: 'Artifact',
        manaCost: '{3}',
        oracleText: '{R}, {T}: Red Engine deals 1 damage to any target.',
      }),
    );
    pay('{1}{B}');
    expect(isl.tapped).toBe(false);
    expect(mtn.tapped).toBe(false);
    expect(swamps.every((s) => s.tapped)).toBe(true);
  });

  it('previews the same lands it taps when casting', () => {
    const { ctx, player } = setup();
    ctx.state.phase = 'precombatMain';
    ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(player.id);
    const isl = spawn(ctx, player.id, island());
    const swamps = [0, 1, 2].map(() => spawn(ctx, player.id, swamp()));
    const black = conjure(ctx, player.id, spell('Black Spell', '{1}{B}'), 'hand');
    conjure(ctx, player.id, spell('Blue Spell', '{1}{U}'), 'hand');
    const cast = computePriorityOptions(ctx, player).find(
      (o) =>
        (o.payload as { kind?: string; objectId?: string } | undefined)?.kind === 'castSpell' &&
        (o.payload as { kind?: string; objectId?: string } | undefined)?.objectId === black.id,
    );
    const preview = cast?.data?.['paymentSourceIds'] as string[] | undefined;
    expect(preview).toHaveLength(2);
    expect(preview).not.toContain(isl.id);
    expect(swamps.map((s) => s.id)).toEqual(expect.arrayContaining(preview!));
  });

  it('orders sources without changing what any payment can afford', () => {
    const { ctx, player } = setup();
    spawn(ctx, player.id, island());
    spawn(ctx, player.id, swamp());
    conjure(ctx, player.id, spell('Blue Spell', '{1}{U}'), 'hand');
    expect(manaSourcesFor(ctx, player.id).map((s) => s.units)).toEqual([[['B']], [['U']]]);
  });
});

describe('keep values', () => {
  it('weighs each symbol by its demand over its supply', () => {
    const demand = manaDemand([parseManaCost('{1}{U}{U}').cost!, parseManaCost('{G/W}').cost!]);
    expect(demand).toEqual({ W: 0.5, U: 2, B: 0, R: 0, G: 0.5, C: 0 });
    const values = keepValues(
      [
        { cardId: 'island-a', units: [['U']], costs: [] },
        { cardId: 'island-b', units: [['U']], costs: [] },
        { cardId: 'forest', units: [['G']], costs: [] },
        { cardId: 'swamp', units: [['B']], costs: [] },
      ],
      demand,
    );
    expect(values.get('island-a')).toBeCloseTo(1.001);
    expect(values.get('forest')).toBeCloseTo(0.501);
    expect(values.get('swamp')).toBeCloseTo(0.001);
  });
});
