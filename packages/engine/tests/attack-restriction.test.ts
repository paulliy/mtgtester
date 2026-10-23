/**
 * The `attackRestriction` rule static: "creatures matching a filter can't attack you or planeswalkers
 * you control" (Combat Calligrapher, Eriette, Rite of the Raging Storm), and its costed form,
 * "… unless their controller pays {X}, where X is the number of counters on that creature" (Nils).
 * Tested here on generic permanents so the rule is pinned independently of any one card.
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { runCombatPhase } from '../src/combat/combat';
import type { CardDefinition } from '../src/cards/definition';
import type { RuleStatic } from '../src/cards/rule-statics';
import {
  allOf,
  HAS_ANY_COUNTER,
  named,
  ofSubtype,
  ofType,
  type Selector,
} from '../src/cards/selector';
import type { PendingDecision } from '../src/decisions';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

function restrictorDef(oracleId: string, staticRule: RuleStatic): CardDefinition {
  return {
    oracleId,
    name: `Lab Restrictor ${oracleId}`,
    typeLine: 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
    subtypes: [],
    colors: [],
    colorIdentity: [],
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    ruleStatics: [staticRule],
    modeled: true,
    unmodeledReasons: [],
  };
}

const CREATURE = (name: string, subtype = 'Bear'): OracleCard =>
  oracle({ name, typeLine: `Creature — ${subtype}`, power: '2', toughness: '2' });
const WALKER = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Planeswalker — Lab', manaCost: '{3}', loyalty: '5', oracleText: '' });

function combatContext(seats = 4): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(3, forest) })),
      { seed: `attack-restriction-${seats}` },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  for (const p of ctx.state.players) conjure(ctx, p.id, forest(), 'library');
  return ctx;
}

/** `playerId` is the active player. */
function activate(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.players.findIndex((p) => p.id === playerId);
}

/** P1 controls a permanent whose rule static is `staticRule`. */
function restrictor(ctx: GameContext, id: string, staticRule: RuleStatic): EnginePermanent {
  registerCustomDef(ctx, restrictorDef(id, staticRule));
  return spawn(
    ctx,
    'P1',
    oracle({ name: `Lab Restrictor ${id}`, oracleId: id, typeLine: 'Enchantment', manaCost: null }),
  );
}

interface Offer {
  players: string[];
  planeswalkers: string[];
  taxes: Record<string, number>;
  mustAttack: boolean;
}

/**
 * The active player's attack declaration: records what each creature is offered and declares
 * `attack` (creature name to a player id or planeswalker object id). Returns what was offered and
 * which attacks were actually declared, by creature name.
 */
function declare(
  ctx: GameContext,
  attack: Record<string, string> = {},
  answer?: (decision: PendingDecision) => ReturnType<typeof pick> | null,
) {
  const offers = new Map<string, Offer>();
  pump(runCombatPhase(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      for (const subject of decision.presentationAttackDeclaration.subjects)
        offers.set(subject.name, {
          players: subject.defenders.map((d) => d.playerId),
          planeswalkers: subject.planeswalkers.map((w) => w.objectId),
          taxes: Object.fromEntries([
            ...subject.defenders.map((d) => [d.playerId, d.attackTax] as const),
            ...subject.planeswalkers.map((w) => [w.objectId, w.attackTax] as const),
          ]),
          mustAttack: subject.mustAttack,
        });
      return declareAttacks(decision, (_id, subject) => attack[subject.name] ?? null);
    }
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    return answer?.(decision) ?? pick(decision, /Pass|does not|Pay|Auto/);
  });
  const attacked = Object.fromEntries(
    ctx.state.eventLog
      .filter((event) => event.type === 'attack')
      .map((event) => [event.payload['attacker'] as string, event.payload['defender'] as string]),
  );
  return { offers, attacked };
}

const INKLING_FILTER: Selector = ofSubtype('Inkling');

describe('attackRestriction (unconditional)', () => {
  const rule = (filter: Selector): RuleStatic => ({
    kind: 'attackRestriction',
    filter,
    includePlaneswalkers: true,
  });

  it("matching creatures can't attack the static's controller or their planeswalkers, but can attack anyone else", () => {
    const ctx = combatContext();
    activate(ctx, 'P2');
    restrictor(ctx, 'r-inkling', rule(INKLING_FILTER));
    const mine = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const other = spawn(ctx, 'P3', WALKER('P3 Walker'));
    spawn(ctx, 'P2', CREATURE('P2 Inkling', 'Inkling'));
    spawn(ctx, 'P2', CREATURE('P2 Bear'));
    const { offers } = declare(ctx);
    expect(offers.get('P2 Inkling')!.players.sort()).toEqual(['P3', 'P4']);
    expect(offers.get('P2 Inkling')!.planeswalkers).toEqual([other.id]);
    // A creature that does not match is unaffected.
    expect(offers.get('P2 Bear')!.players.sort()).toEqual(['P1', 'P3', 'P4']);
    expect(offers.get('P2 Bear')!.planeswalkers.sort()).toEqual([mine.id, other.id].sort());
  });

  it("only attacks on the static's controller are covered: its controller's own creatures and another player's attacks elsewhere are unaffected", () => {
    const ctx = combatContext();
    restrictor(ctx, 'r-inkling-own', rule(INKLING_FILTER));
    spawn(ctx, 'P1', CREATURE('P1 Inkling', 'Inkling'));
    const { offers } = declare(ctx);
    expect(offers.get('P1 Inkling')!.players.sort()).toEqual(['P2', 'P3', 'P4']);
    // Another player's restrictor does not reach P1's attack on P3.
    const second = combatContext();
    activate(second, 'P2');
    registerCustomDef(second, restrictorDef('r-inkling-p3', rule(INKLING_FILTER)));
    spawn(
      second,
      'P3',
      oracle({
        name: 'Lab Restrictor r-inkling-p3',
        oracleId: 'r-inkling-p3',
        typeLine: 'Enchantment',
        manaCost: null,
      }),
    );
    spawn(second, 'P2', CREATURE('P2 Inkling', 'Inkling'));
    expect(declare(second).offers.get('P2 Inkling')!.players.sort()).toEqual(['P1', 'P4']);
  });

  it('is read against the creature as it would attack: a name filter matches exactly that name', () => {
    const ctx = combatContext();
    activate(ctx, 'P2');
    restrictor(ctx, 'r-named', rule(named('P2 Rager')));
    spawn(ctx, 'P2', CREATURE('P2 Rager'));
    spawn(ctx, 'P2', CREATURE('P2 Ragerlike'));
    const { offers } = declare(ctx);
    expect(offers.get('P2 Rager')!.players).not.toContain('P1');
    expect(offers.get('P2 Ragerlike')!.players).toContain('P1');
  });

  it('is a restriction, so it beats an attack requirement (CR 508.1c): a goaded creature that can only attack the restrictor is not forced and has no legal attack', () => {
    const ctx = combatContext(2);
    ctx.state.turnOrder = ['P1', 'P2'];
    activate(ctx, 'P2');
    restrictor(ctx, 'r-goad', rule(INKLING_FILTER));
    const inkling = spawn(ctx, 'P2', CREATURE('P2 Inkling', 'Inkling'));
    inkling.goadedBy = [{ goaderId: 'P1', appliedTurn: ctx.state.turnNumber - 1 }];
    const { offers, attacked } = declare(ctx);
    // The goad would send it at P1 (the only opponent) but P1 is off limits; and with the
    // restriction gone it would be goaded away from P1 entirely, so nothing is required.
    expect(offers.get('P2 Inkling')?.players ?? []).toEqual([]);
    expect(offers.get('P2 Inkling')?.mustAttack ?? false).toBe(false);
    expect(attacked).toEqual({});
  });

  it('keeps a requirement mandatory against the players it does not cover', () => {
    const ctx = combatContext();
    activate(ctx, 'P2');
    restrictor(ctx, 'r-goad-others', rule(INKLING_FILTER));
    const inkling = spawn(ctx, 'P2', CREATURE('P2 Inkling', 'Inkling'));
    // Goaded by P3: it must attack a player other than P3, and cannot attack P1, so that leaves
    // only P4: a forced declaration the engine makes itself (it is never surfaced).
    inkling.goadedBy = [{ goaderId: 'P3', appliedTurn: ctx.state.turnNumber - 1 }];
    const { offers, attacked } = declare(ctx);
    expect(offers.has('P2 Inkling')).toBe(false);
    expect(attacked).toEqual({ 'P2 Inkling': 'P4' });
  });

  it("ends with the static's source: once it leaves the battlefield the creature can attack its controller again", () => {
    const ctx = combatContext();
    activate(ctx, 'P2');
    const source = restrictor(ctx, 'r-leaves', rule(INKLING_FILTER));
    spawn(ctx, 'P2', CREATURE('P2 Inkling', 'Inkling'));
    expect(declare(ctx).offers.get('P2 Inkling')!.players).not.toContain('P1');
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== source.id);
    ctx.state.phase = 'combat';
    expect(declare(ctx).offers.get('P2 Inkling')!.players).toContain('P1');
  });

  it('applies to creatures that arrive later, since it is a static of the source', () => {
    const ctx = combatContext();
    activate(ctx, 'P2');
    restrictor(ctx, 'r-later', rule(INKLING_FILTER));
    const late = spawn(ctx, 'P2', CREATURE('P2 Late Inkling', 'Inkling'), { summoningSick: false });
    expect(declare(ctx).offers.get(late.name)!.players).not.toContain('P1');
  });
});

describe('attackRestriction with a cost (per counter on the creature)', () => {
  const rule: RuleStatic = {
    kind: 'attackRestriction',
    filter: allOf(ofType('Creature'), HAS_ANY_COUNTER),
    includePlaneswalkers: true,
    cost: { perCounterOnCreature: true },
  };

  /** P2's creature carries `counters`, and P2 has `lands` untapped Forests. */
  function board(counters: Record<string, number>, lands: number, name = 'P2 Bear') {
    const ctx = combatContext();
    activate(ctx, 'P2');
    restrictor(ctx, 'r-cost', rule);
    const walker = spawn(ctx, 'P1', WALKER('P1 Walker'));
    const creature = spawn(ctx, 'P2', CREATURE(name));
    creature.counters = { ...counters };
    const forests = Array.from({ length: lands }, () => spawn(ctx, 'P2', forest()));
    return { ctx, walker, creature, forests };
  }

  it("a creature with counters can attack the controller by paying one generic mana per counter of any kind, shown as that creature's own tax", () => {
    const { ctx, creature, forests } = board({ '+1/+1': 2, shield: 1 }, 3);
    const { offers, attacked } = declare(ctx, { 'P2 Bear': 'P1' });
    expect(offers.get('P2 Bear')!.players).toContain('P1');
    expect(offers.get('P2 Bear')!.taxes['P1']).toBe(3);
    expect(offers.get('P2 Bear')!.taxes['P3']).toBe(0);
    expect(attacked['P2 Bear']).toBe('P1');
    expect(forests.every((land) => land.tapped)).toBe(true);
    expect(creature.attacking).toBeNull(); // combat is over
  });

  it('is not offered the attack when the controller cannot pay, and is never forced to pay', () => {
    const { ctx } = board({ '+1/+1': 2 }, 1);
    const { offers } = declare(ctx);
    expect(offers.get('P2 Bear')!.players).not.toContain('P1');
    expect(offers.get('P2 Bear')!.players.sort()).toEqual(['P3', 'P4']);
  });

  it('a creature with no counters, or attacking someone else, pays nothing', () => {
    const { ctx, forests } = board({}, 2);
    const { offers, attacked } = declare(ctx, { 'P2 Bear': 'P1' });
    expect(offers.get('P2 Bear')!.taxes['P1']).toBe(0);
    expect(attacked['P2 Bear']).toBe('P1');
    expect(forests.some((land) => land.tapped)).toBe(false);
    const second = board({ '+1/+1': 4 }, 0);
    const result = declare(second.ctx, { 'P2 Bear': 'P3' });
    expect(result.attacked['P2 Bear']).toBe('P3');
  });

  it("covers the controller's planeswalkers too", () => {
    const { ctx, walker, forests } = board({ '+1/+1': 1 }, 1);
    const { offers, attacked } = declare(ctx, { 'P2 Bear': walker.id });
    expect(offers.get('P2 Bear')!.taxes[walker.id]).toBe(1);
    expect(attacked['P2 Bear']).toBe('P1');
    expect(forests[0]!.tapped).toBe(true);
  });

  it('sums the costs of every creature attacking the controller: they are paid together, and an unaffordable total is not a legal declaration', () => {
    const first = board({ '+1/+1': 1 }, 3);
    const second = spawn(first.ctx, 'P2', CREATURE('P2 Second'));
    second.counters = { '+1/+1': 2 };
    const paid = declare(first.ctx, { 'P2 Bear': 'P1', 'P2 Second': 'P1' });
    expect(paid.attacked).toEqual({ 'P2 Bear': 'P1', 'P2 Second': 'P1' });
    expect(first.forests.every((land) => land.tapped)).toBe(true);

    // One short of 3: each creature can afford its own cost alone, but not both together, so the
    // engine repairs the declaration by standing one down rather than letting an unpayable
    // attack through.
    const short = board({ '+1/+1': 1 }, 2);
    const also = spawn(short.ctx, 'P2', CREATURE('P2 Second'));
    also.counters = { '+1/+1': 2 };
    const result = declare(short.ctx, { 'P2 Bear': 'P1', 'P2 Second': 'P1' });
    expect(Object.keys(result.attacked)).toHaveLength(1);
    expect(short.forests.filter((land) => land.tapped)).toHaveLength(
      result.attacked['P2 Second'] === 'P1' ? 2 : 1,
    );
  });
});

describe('attackRestriction authoring contract', () => {
  const valid: RuleStatic = {
    kind: 'attackRestriction',
    filter: ofSubtype('Inkling'),
    includePlaneswalkers: true,
  };

  it('accepts the unconditional and the per-counter-cost shapes', () => {
    expect(validateCardDefinition(restrictorDef('v1', valid))).toEqual([]);
    expect(
      validateCardDefinition(
        restrictorDef('v2', { ...valid, cost: { perCounterOnCreature: true } }),
      ),
    ).toEqual([]);
  });

  it('rejects a restriction that does not cover planeswalkers, a bad cost, and a malformed filter', () => {
    const bad = (rule: unknown) =>
      validateCardDefinition(restrictorDef('v3', rule as RuleStatic)).map((issue) => issue.path);
    expect(bad({ ...valid, includePlaneswalkers: false })).toContain(
      'definition.ruleStatics[0].includePlaneswalkers',
    );
    expect(bad({ ...valid, cost: { perCounterOnCreature: false } })).toContain(
      'definition.ruleStatics[0].cost',
    );
    expect(bad({ ...valid, filter: { kind: 'name', value: 3 } }).length).toBeGreaterThan(0);
  });
});
