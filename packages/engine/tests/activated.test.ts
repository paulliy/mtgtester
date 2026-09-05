/**
 * Activated abilities with non-mana costs (ADR 0010, Inc 5) — "`<costs>`: `<effect>`" (CR 602).
 *
 * The cost is what makes these different from a spell, and it is where the rules are easy to
 * get wrong. What these tests pin:
 *
 * - a `{T}` cost respects tapped-ness and summoning sickness (CR 302.6); other costs do not;
 * - costs are paid at announcement, as one indivisible act (CR 601.2h) — so sacrificing the
 *   source does NOT stop the ability resolving (CR 608.2f);
 * - a "sacrifice this" mana ability is a payment source while tapped and summoning-sick, which
 *   is the whole reason `ManaSource` carries its cost;
 * - sorcery-timed abilities are absent at instant speed;
 * - the engine never offers an ability it cannot charge for.
 */

import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { executeAbility, payAbilityCosts } from '../src/effects/resolve';
import { computeCharacteristics } from '../src/effects/continuous';
import { effectivePT, isCreaturePermanent, manaSourcesFor } from '../src/state/queries';
import { parseManaCost, planPayment } from '../src/mana/cost';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, mountain, oracle, pump, spawn } from './fixtures';

function pod(seed = 'activated'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const p of ctx.state.players) conjure(ctx, p.id, forest(), 'library');
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

/** Dragon's Hoard, verbatim: a trigger, a counter-costed draw, and a mana ability. */
const dragonsHoard = (): ReturnType<typeof oracle> =>
  oracle({
    name: "Test Hoard",
    typeLine: 'Artifact',
    manaCost: '{3}',
    power: null,
    toughness: null,
    oracleText:
      'Whenever a Dragon you control enters, put a gold counter on this artifact.\n{T}, Remove a gold counter from this artifact: Draw a card.\n{T}: Add one mana of any color.',
  });

/** Reckless Barbarian, verbatim: a mana ability whose cost is a sacrifice, not a tap. */
const recklessBarbarian = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Barbarian',
    typeLine: 'Creature — Dragon Barbarian',
    manaCost: '{1}{R}',
    power: '2',
    toughness: '2',
    oracleText: 'Sacrifice this creature: Add {R}{R}.',
  });

const dragon = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Whelp', typeLine: 'Creature — Dragon', manaCost: '{4}{R}', power: '5', toughness: '5' });

const optionsFor = (ctx: GameContext): string[] =>
  computePriorityOptions(ctx, p1(ctx)).map((o) => o.description);

const sourceOf = (perm: ReturnType<typeof spawn>) => ({
  cardId: perm.cardId,
  name: perm.name,
  oracleId: perm.oracleId,
  controllerId: perm.controllerId,
});

describe('parsing costs', () => {
  it("reads Dragon's Hoard as a trigger, a counter-costed ability, and a mana ability", () => {
    const hoard = interpretCard(dragonsHoard());

    expect(hoard.modeled).toBe(true);
    expect(hoard.triggers).toHaveLength(1);
    expect(hoard.manaAbilities).toHaveLength(1);
    expect(hoard.activatedAbilities).toHaveLength(1);
    expect(hoard.activatedAbilities[0]?.costs).toEqual([
      { kind: 'tap' },
      { kind: 'removeCounters', counter: 'gold', count: 1 },
    ]);
    expect(hoard.activatedAbilities[0]?.ability.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
  });

  it('parses a controlled-creature tap as an additional activation cost', () => {
    const def = interpretCard(oracle({
      name: 'Test Drum', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null,
      oracleText: '{T}, Tap an untapped creature you control: Add one mana of any color.',
    }));
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities[0]?.costs).toEqual([
      { kind: 'tap' },
      { kind: 'tapOther', selector: { kind: 'allOf', of: [{ kind: 'type', value: 'Creature' }, { kind: 'controller', who: 'you' }] } },
    ]);
  });
  it('requires distinct controlled permanents for a fixed-count tap cost', () => {
    const def = interpretCard(oracle({
      name: 'Test Clock', typeLine: 'Artifact', manaCost: '{4}', power: null, toughness: null,
      oracleText: 'Tap two untapped artifacts you control: Untap target artifact.',
    }));
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities[0]?.costs).toEqual([{ kind: 'tapOthers', count: 2, selector: { kind: 'allOf', of: [{ kind: 'type', value: 'Artifact' }, { kind: 'controller', who: 'you' }] } }]);
    expect(def.activatedAbilities[0]?.ability.targets).toEqual([{ kind: 'artifact' }]);
    expect(def.activatedAbilities[0]?.ability.effects).toEqual([{ op: 'untapTarget', target: 0 }]);
    expect(interpretCard(oracle({
      name: 'Test Key', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null,
      oracleText: '{1}, {T}: Untap another target artifact.\n{3}, {T}: Target creature can\'t be blocked this turn.',
    })).modeled).toBe(true);

    const ctx = pod('multi-tap-cost');
    const clock = spawn(ctx, 'P1', oracle({ name: 'Test Clock Source', typeLine: 'Artifact', manaCost: '{4}', power: null, toughness: null }));
    const first = spawn(ctx, 'P1', oracle({ name: 'Test Battery A', typeLine: 'Artifact', manaCost: '{0}', power: null, toughness: null }));
    const second = spawn(ctx, 'P1', oracle({ name: 'Test Battery B', typeLine: 'Artifact', manaCost: '{0}', power: null, toughness: null }));
    pump(payAbilityCosts(ctx, p1(ctx), clock, [{ kind: 'tapOthers', count: 2, selector: { kind: 'type', value: 'Artifact' } }], 'tap'));
    expect(first.tapped).toBe(true);
    expect(second.tapped).toBe(true);
  });
  it('records a sacrifice cost on the mana ability rather than assuming {T}', () => {
    const def = interpretCard(recklessBarbarian());

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities[0]?.costs).toEqual([{ kind: 'sacrificeSelf' }]);
    expect(def.manaAbilities[0]?.units).toEqual([['R'], ['R']]);
  });

  it('reads a mana-costed "add mana" line as a mana ability that charges its own cost', () => {
    // CR 605.1a says nothing about what a mana ability's cost may be: a filter land's
    // `{1}, {T}: Add {W}{U}` is a mana ability, it does not use the stack, and it cannot be
    // responded to. The engine refused this shape for as long as `planPayment` could not pay
    // for its own sources; now that it can, the {1} is charged out of the same payment.
    const def = interpretCard(
      oracle({
        name: 'Test Filter',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{1}, {T}: Add {W}{U}.',
      }),
    );

    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities).toHaveLength(0);
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.manaAbilities[0]?.costs).toEqual([
      { kind: 'mana', cost: parseManaCost('{1}').cost },
      { kind: 'tap' },
    ]);
    expect(def.manaAbilities[0]?.units).toEqual([['W'], ['U']]);
  });
});

describe('combat-restricted targets', () => {
  it('allows exile only for an attacking or blocking creature', () => {
    const light = oracle({ name: 'Test Light', typeLine: 'Instant', manaCost: '{1}{W}{W}', power: null, toughness: null, oracleText: 'Exile target attacking or blocking creature.' });
    const def = interpretCard(light);
    expect(def.modeled).toBe(true);
    const ctx = pod('combat-target');
    const source = spawn(ctx, 'P1', oracle({ name: 'Test Source', typeLine: 'Creature — Cleric', manaCost: '{1}', power: '1', toughness: '1' }));
    const attacker = spawn(ctx, 'P2', oracle({ name: 'Test Attacker', typeLine: 'Creature — Human', manaCost: '{1}', power: '2', toughness: '2' }));
    attacker.attacking = 'P1';
    pump(executeAbility(ctx, source, def.spellAbility!, [attacker.id]));
    expect(ctx.state.exile.some((card) => card.cardId === attacker.cardId)).toBe(true);
  });
});
describe('graveyard-to-library activation', () => {
  it('puts a targeted artifact card from its controller’s graveyard on top of the library', () => {
    const ruins = oracle({ name: 'Test Ruins', typeLine: 'Land', manaCost: null, power: null, toughness: null, oracleText: '{1}{U}, {T}: Put target artifact card from your graveyard on top of your library.' });
    const def = interpretCard(ruins);
    expect(def.modeled).toBe(true);
    const ctx = pod('academy-ruins');
    const source = spawn(ctx, 'P1', ruins);
    const artifact = conjure(ctx, 'P1', oracle({ name: 'Test Relic', typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null }), 'graveyard');
    pump(executeAbility(ctx, source, def.activatedAbilities[0]!.ability, [artifact.id]));
    expect(p1(ctx).library[0]?.cardId).toBe(artifact.cardId);
    expect(p1(ctx).graveyard.some((card) => card.cardId === artifact.cardId)).toBe(false);
  });
});
describe('temporary combat restrictions', () => {
  it("models a target creature that can't be blocked this turn", () => {
    const card = oracle({
      name: 'Test Grid', typeLine: 'Artifact', manaCost: '{2}', power: null, toughness: null,
      oracleText: '{3}: Target creature can\'t be blocked this turn.',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities[0]?.ability.effects).toEqual([{ op: 'cantBeBlockedUntilEot', target: 0 }]);

    const ctx = pod('unblockable');
    const source = spawn(ctx, 'P1', card);
    const target = spawn(ctx, 'P1', oracle({ name: 'Test Attacker', typeLine: 'Creature — Human', manaCost: '{1}', power: '2', toughness: '2' }));
    pump(executeAbility(ctx, source, def.activatedAbilities[0]!.ability, [target.id]));
    expect(ctx.state.effects).toContainEqual(expect.objectContaining({ kind: 'cantBeBlocked', targetCardIds: [target.cardId] }));
  });
});
describe('attachment-aware activated effects', () => {
  const pemminsAura = () => oracle({
    name: "Pemmin's Aura",
    typeLine: 'Enchantment — Aura',
    manaCost: '{2}{U}',
    power: null,
    toughness: null,
    oracleText: 'Enchant creature\n{U}: Untap enchanted creature.\n{U}: Enchanted creature gains flying until end of turn.\n{U}: Enchanted creature gains shroud until end of turn.\n{1}: Enchanted creature gets +1/-1 or -1/+1 until end of turn.',
  });

  it('resolves Aura effects against the current attached creature and asks for its stat mode', () => {
    const ctx = pod('pemmins-aura');
    const aura = spawn(ctx, 'P1', pemminsAura());
    const creature = spawn(ctx, 'P1', oracle({ name: 'Test Host', typeLine: 'Creature — Human', manaCost: '{1}', power: '2', toughness: '2' }), { tapped: true });
    aura.attachedTo = creature.id;
    const def = interpretCard(pemminsAura());

    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities).toHaveLength(4);
    expect(def.activatedAbilities[0]?.ability.effects).toEqual([{ op: 'untapTarget', target: 'attachedToSource' }]);
    expect(interpretCard(oracle({
      name: 'Freed from the Real', typeLine: 'Enchantment — Aura', manaCost: '{2}{U}', power: null, toughness: null,
      oracleText: 'Enchant creature\n{U}: Tap enchanted creature.\n{U}: Untap enchanted creature.',
    })).modeled).toBe(true);

    pump(executeAbility(ctx, aura, def.activatedAbilities[3]!.ability, []), (decision) => {
      expect(decision.decisionType).toBe('general');
      expect(decision.options.map((option) => option.description)).toEqual([
        'Enchanted creature gets +1/-1 until end of turn',
        'Enchanted creature gets -1/+1 until end of turn',
      ]);
      return { index: 1, targets: new Map() };
    });
    expect(effectivePT(ctx, creature)).toEqual({ power: 1, toughness: 3 });

    pump(executeAbility(ctx, aura, def.activatedAbilities[0]!.ability, []));
    expect(creature.tapped).toBe(false);
  });
});
describe('cost availability', () => {
  it('publishes structured activation costs for the direct player UI', () => {
    const ctx = pod('activation-presentation');
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    hoard.counters['gold'] = 1;

    const option = computePriorityOptions(ctx, p1(ctx)).find(
      (candidate) => candidate.type === 'activateAbility' && candidate.description.includes('Draw a card'),
    );

    expect(option?.data).toMatchObject({
      sourceName: 'Test Hoard',
      sourceZone: 'battlefield',
      manaCost: '{0}',
      abilityCosts: [
        { kind: 'tap' },
        { kind: 'removeCounters', counter: 'gold', count: 1 },
      ],
    });
  });

  it('offers the ability only once its counter cost can be paid', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());

    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(false);

    hoard.counters['gold'] = 1;
    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(true);
  });

  it('withdraws a {T} ability once the source is tapped', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    hoard.counters['gold'] = 2;
    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(true);

    hoard.tapped = true;
    expect(optionsFor(ctx).some((d) => d.includes('Draw a card'))).toBe(false);
  });

  it('a sacrifice-costed mana ability is available while tapped AND summoning-sick', () => {
    const ctx = pod();
    const barb = spawn(ctx, 'P1', recklessBarbarian(), { tapped: true, summoningSick: true });

    const source = manaSourcesFor(ctx, 'P1').find((s) => s.cardId === barb.cardId);
    expect(source?.units).toEqual([['R'], ['R']]);
    expect(source?.costs).toEqual([{ kind: 'sacrificeSelf' }]);
  });

  it('a {T} mana ability is NOT available while summoning-sick', () => {
    const ctx = pod();
    const tapper = oracle({
      name: 'Test Elf',
      typeLine: 'Creature — Elf Druid',
      manaCost: '{G}',
      power: '1',
      toughness: '1',
      oracleText: '{T}: Add {G}.',
    });
    const perm = spawn(ctx, 'P1', tapper, { summoningSick: true });

    expect(manaSourcesFor(ctx, 'P1').some((s) => s.cardId === perm.cardId)).toBe(false);
  });
});

describe('crewing a vehicle', () => {
  const vehicle = (): ReturnType<typeof oracle> =>
    oracle({
      name: 'Test Chariot',
      typeLine: 'Artifact — Vehicle',
      manaCost: '{4}',
      power: '5',
      toughness: '5',
      oracleText: 'Crew 1',
    });

  it('is unpayable, and stays unpayable, with no untapped creature power available', () => {
    const ctx = pod('crew-unpayable');
    const chariot = spawn(ctx, 'P1', vehicle());
    const def = interpretCard(vehicle());
    const ability = def.activatedAbilities[0]!;

    expect(optionsFor(ctx).some((d) => d.includes('Crew 1'))).toBe(false);
    // Activating it anyway (bypassing the legality gate) must not silently succeed for free —
    // this is the exact shape of the infinite-crew bug: an uncosted, no-op activation that a
    // player or bot can select forever without ever changing game state.
    expect(() =>
      pump(payAbilityCosts(ctx, p1(ctx), chariot, ability.costs, 'tap')),
    ).toThrow(/unpayable/);
  });

  it('taps enough creature power and turns the vehicle into a creature until end of turn', () => {
    const ctx = pod('crew-payable');
    const chariot = spawn(ctx, 'P1', vehicle());
    const crewer = spawn(ctx, 'P1', oracle({
      name: 'Test Crewman', typeLine: 'Creature — Human', manaCost: '{1}', power: '1', toughness: '1',
    }));
    const def = interpretCard(vehicle());
    const ability = def.activatedAbilities[0]!;

    expect(isCreaturePermanent(ctx, chariot)).toBe(false);
    expect(optionsFor(ctx).some((d) => d.includes('Crew 1'))).toBe(true);

    pump(payAbilityCosts(ctx, p1(ctx), chariot, ability.costs, 'tap'));
    expect(crewer.tapped).toBe(true);

    pump(executeAbility(ctx, sourceOf(chariot), ability.ability, []));
    expect(isCreaturePermanent(ctx, chariot)).toBe(true);
    expect(computeCharacteristics(ctx, chariot)).toMatchObject({ power: 5, toughness: 5 });

    // Paid for and resolved — the ability is no longer on offer for free, closing the loop.
    expect(optionsFor(ctx).some((d) => d.includes('Crew 1'))).toBe(false);
  });
});

describe('paying and resolving', () => {
  it('charges the cost and resolves the effect', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    hoard.counters['gold'] = 2;
    const before = p1(ctx).hand.length;

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Draw a card'));
      return { index: i >= 0 ? i : 0, targets: new Map() };
    });

    expect(hoard.tapped).toBe(true);
    expect(hoard.counters['gold']).toBe(1);
    expect(p1(ctx).hand.length).toBe(before + 1);
  });

  it('resolves even though the cost sacrificed the source (CR 608.2f)', () => {
    const ctx = pod();
    // A sacrifice-costed mana ability is the only Inc-5 card that removes its own source, so
    // spend it on a real cost and check both halves: the source is gone, the mana was made.
    const barb = spawn(ctx, 'P1', recklessBarbarian());
    const bolt = oracle({
      name: 'Test Bolt',
      typeLine: 'Instant',
      manaCost: '{R}{R}',
      power: null,
      toughness: null,
      oracleText: 'Test Bolt deals 3 damage to any target.',
    });
    conjure(ctx, 'P1', bolt, 'hand');

    pump(runPrioritySequence(ctx), (d) => {
      const i = d.options.findIndex((o) => o.description.includes('Cast Test Bolt'));
      if (i < 0) return { index: 0, targets: new Map() };
      // Target an opponent, not a permanent: the only creature on the board is the Barbarian,
      // and sacrificing it to pay would then (correctly) fizzle the spell.
      const slot = d.options[i]?.targets?.[0];
      const player = slot?.options.find((o) => o === 'P2');
      return { index: i, targets: new Map(player === undefined ? [] : [[0, player]]) };
    });

    expect(ctx.state.battlefield.some((p) => p.cardId === barb.cardId)).toBe(false);
    expect(p1(ctx).graveyard.some((c) => c.name === 'Test Barbarian')).toBe(true);
    expect(ctx.state.eventLog.some((e) => e.type === 'sacrifice')).toBe(true);
    // The spell was paid for by the sacrifice and still resolved.
    expect(ctx.state.players.find((p) => p.id === 'P2')?.life).toBe(37);
  });

  it('the gold-counter trigger and the draw ability compose over a real turn', () => {
    const ctx = pod();
    const hoard = spawn(ctx, 'P1', dragonsHoard());
    spawn(ctx, 'P1', mountain());

    // A Dragon entering adds the counter that pays for the draw.
    const whelp = conjure(ctx, 'P1', dragon(), 'hand');
    pump(moveObject(ctx, whelp, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    pump(runPrioritySequence(ctx));
    expect(hoard.counters['gold']).toBe(1);
  });
});

describe('timing', () => {
  it('offers a sorcery-timed ability only at sorcery speed', () => {
    const ctx = pod();
    const slow = oracle({
      name: 'Test Slowpoke',
      typeLine: 'Artifact',
      manaCost: '{2}',
      power: null,
      toughness: null,
      oracleText: '{T}: You gain 2 life. Activate only as a sorcery.',
    });
    spawn(ctx, 'P1', slow);

    expect(optionsFor(ctx).some((d) => d.includes('gain 2 life'))).toBe(true);

    // A non-empty stack ends the sorcery-speed window (CR 602.5d).
    ctx.state.phase = 'ending';
    ctx.state.step = 'end';
    expect(optionsFor(ctx).some((d) => d.includes('gain 2 life'))).toBe(false);
  });
});

describe('automatic mana payment preference', () => {
  it('uses lands before creature mana sources even when the creature entered first', () => {
    const ctx = pod();
    const elf = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Mana Elf',
        typeLine: 'Creature — Elf Druid',
        manaCost: '{G}',
        power: '1',
        toughness: '1',
        oracleText: '{T}: Add {G}.',
      }),
    );
    const land = spawn(ctx, 'P1', forest());

    const sources = manaSourcesFor(ctx, 'P1');
    expect(sources.map((source) => source.cardId)).toEqual([land.cardId, elf.cardId]);
    expect(planPayment(parseManaCost('{G}').cost!, [], sources)?.tapCardIds).toEqual([
      land.cardId,
    ]);
  });
});
