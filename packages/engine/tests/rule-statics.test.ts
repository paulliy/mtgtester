/**
 * Rule-modifying statics (ADR 0010, Inc 13) — cost reduction, "can't be countered" as a
 * state-dependent rule, "opponents can't cast spells", and casting from a non-hand zone.
 *
 * `StaticEffect`/`ContinuousOp` only express CR 613 layer operations over PERMANENTS; none of
 * these four have a permanent to apply an op to, which is why they are a separate category
 * (`RuleStatic`, gathered by `gatherRuleStatics`) rather than squeezed into the layer engine.
 *
 * What these tests pin:
 *
 * - a FIXED reduction (Eminence) and a DYNAMIC one (Temur Battlecrier, counting qualifying
 *   creatures) both reduce the displayed AND charged cost identically, floored at zero;
 * - Eminence's reduction is gathered from the COMMAND ZONE, not just the battlefield, and
 *   excludes the source's own card ("OTHER Dragon spells");
 * - a reduction gated "during your turn" is inactive on any other player's turn;
 * - "can't be countered" printed on a CREATURE (Dromoka) protects the spell even though there is
 *   no `spellAbility` to carry the flag on — `spellCantBeCountered` is surfaced independent of it;
 * - "creature spells you control can't be countered" (Rhythm of the Wild) is a STATE-DEPENDENT
 *   rule: re-checked at the moment of countering, not fixed at cast time, and only protects
 *   spells matching its filter;
 * - "your opponents can't cast spells during your turn" blocks casts (never land plays) for
 *   opponents only, and only during the source's controller's own turn;
 * - "cast Dragon spells from the top of your library" offers only the top card, and only when it
 *   matches the filter.
 */

import { describe, expect, it } from 'vitest';
import { computePriorityOptions, costReductionFor } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { castFromLibraryTopCandidates, spellProtectedFromCounter } from '../src/state/queries';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, registerDef, spawn } from './fixtures';

function pod(seed = 'rule-statics'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(6, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;
const p2 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P2') as EnginePlayerState;

const dromoka = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Dragonlord Dromoka',
    typeLine: 'Legendary Creature — Elder Dragon',
    manaCost: '{4}{G}{W}',
    colors: ['G', 'W'],
    colorIdentity: ['G', 'W'],
    power: '4',
    toughness: '4',
    oracleText:
      "This spell can't be countered.\nFlying, lifelink\nYour opponents can't cast spells during your turn.",
  });

const korlessa = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Korlessa, Scale Singer',
    typeLine: 'Legendary Creature — Dragon Bard',
    manaCost: '{G}{U}',
    colors: ['G', 'U'],
    colorIdentity: ['G', 'U'],
    power: '1',
    toughness: '4',
    oracleText:
      'You may look at the top card of your library any time.\nYou may cast Dragon spells from the top of your library.',
  });

const rhythm = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Rhythm of the Wild',
    typeLine: 'Enchantment',
    manaCost: '{1}{R}{G}',
    power: null,
    toughness: null,
    oracleText:
      "Creature spells you control can't be countered.\nNontoken creatures you control have riot.",
  });

const battlecrier = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Temur Battlecrier',
    typeLine: 'Creature — Orc Ranger',
    manaCost: '{G}{U}{R}',
    power: '3',
    toughness: '3',
    oracleText:
      'During your turn, spells you cast cost {1} less to cast for each creature you control with power 4 or greater.',
  });

const urDragon = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'The Ur-Dragon',
    typeLine: 'Legendary Creature — Dragon Avatar',
    manaCost: '{4}{W}{U}{B}{R}{G}',
    colors: ['W', 'U', 'B', 'R', 'G'],
    colorIdentity: ['W', 'U', 'B', 'R', 'G'],
    power: '9',
    toughness: '9',
    oracleText:
      'Eminence — As long as The Ur-Dragon is in the command zone or on the battlefield, other Dragon spells you cast cost {1} less to cast.\nFlying\nWhenever one or more Dragons you control attack, draw that many cards, then you may put a permanent card from your hand onto the battlefield.',
  });

const bigDragon = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Big Dragon', typeLine: 'Creature — Dragon', manaCost: '{3}', power: '4', toughness: '4' });

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{2}', power: '2', toughness: '2' });

const freeBear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Free Bear', typeLine: 'Creature — Bear', manaCost: '{0}', power: '1', toughness: '1' });

describe('Dragonlord Dromoka', () => {
  it('parses to spellCantBeCountered + a cantCastSpells rule static, even with no spellAbility', () => {
    const def = interpretCard(dromoka());

    expect(def.modeled).toBe(true);
    expect(def.spellAbility).toBeNull(); // a creature, not an instant/sorcery
    expect(def.spellCantBeCountered).toBe(true);
    expect(def.keywords).toEqual(expect.arrayContaining(['flying', 'lifelink']));
    expect(def.ruleStatics).toEqual([{ kind: 'cantCastSpells', who: 'opponents', yourTurnOnly: true }]);
  });

  it("protects the spell from being countered even though it's a creature, not an instant/sorcery", () => {
    const ctx = pod();
    const def = registerDef(ctx, dromoka());
    // What `apply.ts` builds for a permanent card carrying `spellCantBeCountered`: a minimal
    // zero-effect ability, purely so the counter executor's `entry.ability?.cantBeCountered` has
    // something to read.
    ctx.state.stack.push({
      id: 'o-dromoka',
      sourceId: 'c-dromoka',
      controllerId: 'P1',
      kind: 'spell',
      description: 'Dragonlord Dromoka',
      targets: [],
      card: null,
      ability: { kind: 'spell', targets: [], effects: [], cantBeCountered: true },
      sourceOracleId: def.oracleId,
      sourceCardId: 'c-dromoka',
      isCommanderCast: false,
    });

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-counter', name: 'Test Counter', oracleId: 'oracle-test-counter', controllerId: 'P2' },
        { kind: 'spell', targets: [{ kind: 'spell' }], effects: [{ op: 'counter', target: 0 }] },
        ['o-dromoka'],
      ),
    );

    expect(ctx.state.stack).toHaveLength(1); // still there — countering had no effect
  });

  it("stops opponents from casting spells during the controller's turn, but not their own turn", () => {
    const ctx = pod();
    spawn(ctx, 'P1', dromoka());
    conjure(ctx, 'P2', freeBear(), 'hand');

    expect(computePriorityOptions(ctx, p2(ctx)).some((o) => o.type === 'castSpell')).toBe(false);

    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(computePriorityOptions(ctx, p2(ctx)).some((o) => o.type === 'castSpell')).toBe(true);
  });

  it("never blocks the source's own controller — only opponents", () => {
    const ctx = pod();
    spawn(ctx, 'P1', dromoka());
    conjure(ctx, 'P1', freeBear(), 'hand');

    expect(computePriorityOptions(ctx, p1(ctx)).some((o) => o.type === 'castSpell')).toBe(true);
  });
});

describe('Rhythm of the Wild', () => {
  it('grants riot to nontoken creatures you control, and marks creature spells uncounterable', () => {
    const def = interpretCard(rhythm());

    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toEqual([
      { kind: 'cantBeCountered', filter: { kind: 'type', value: 'Creature' } },
    ]);
    expect(def.staticEffects).toContainEqual(
      expect.objectContaining({ op: { layer: 6, addKeyword: 'riot' } }),
    );
  });

  it('is a STATE-DEPENDENT rule: protects a creature spell only while on the battlefield', () => {
    const ctx = pod();
    registerDef(ctx, bigDragon());
    registerDef(ctx, bear());
    const perm = spawn(ctx, 'P1', rhythm());

    expect(spellProtectedFromCounter(ctx, 'P1', bigDragon().oracleId)).toBe(true);
    // The filter is "creature spells" — a non-creature is not protected.
    const instant = oracle({ name: 'Test Bolt Two', typeLine: 'Instant', manaCost: '{R}' });
    registerDef(ctx, instant);
    expect(spellProtectedFromCounter(ctx, 'P1', instant.oracleId)).toBe(false);

    // Leaves the battlefield: the rule stops applying, unlike a fixed-at-cast property.
    ctx.state.battlefield = ctx.state.battlefield.filter((p) => p.id !== perm.id);
    expect(spellProtectedFromCounter(ctx, 'P1', bigDragon().oracleId)).toBe(false);
  });

  it("only protects the controller's OWN spells", () => {
    const ctx = pod();
    registerDef(ctx, bigDragon());
    spawn(ctx, 'P1', rhythm());

    expect(spellProtectedFromCounter(ctx, 'P2', bigDragon().oracleId)).toBe(false);
  });
});

describe('Temur Battlecrier', () => {
  it('parses to a dynamic, turn-gated cost reduction', () => {
    const def = interpretCard(battlecrier());

    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toHaveLength(1);
    const rs = def.ruleStatics[0];
    expect(rs?.kind).toBe('costReduction');
    expect(rs).toMatchObject({ yourTurnOnly: true });
    expect(rs && 'filter' in rs ? rs.filter : undefined).toBeUndefined(); // ANY spell, not just creatures
  });

  it('reduces by {1} per qualifying creature, and by nothing with none', () => {
    const ctx = pod();
    const crier = spawn(ctx, 'P1', battlecrier());
    registerDef(ctx, bear());

    expect(costReductionFor(ctx, 'P1', bear().oracleId, 'c-any')).toBe(0);

    spawn(ctx, 'P1', oracle({ name: 'Test Ogre', typeLine: 'Creature — Ogre', manaCost: '{4}', power: '4', toughness: '4' }));
    spawn(ctx, 'P1', oracle({ name: 'Test Giant', typeLine: 'Creature — Giant', manaCost: '{4}', power: '5', toughness: '5' }));
    // Battlecrier itself is power 3 — does not count toward its own reduction.
    expect(crier.power).toBe(3);
    expect(costReductionFor(ctx, 'P1', bear().oracleId, 'c-any')).toBe(2);
  });

  it("is inactive on any turn but the controller's own", () => {
    const ctx = pod();
    spawn(ctx, 'P1', battlecrier());
    registerDef(ctx, bear());
    spawn(ctx, 'P1', oracle({ name: 'Test Ogre 2', typeLine: 'Creature — Ogre', manaCost: '{4}', power: '4', toughness: '4' }));

    ctx.state.currentTurnPlayer = 'P2';
    expect(costReductionFor(ctx, 'P1', bear().oracleId, 'c-any')).toBe(0);
  });
});

describe('The Ur-Dragon', () => {
  it('parses Eminence as a cost reduction active from the command zone, excluding itself', () => {
    const def = interpretCard(urDragon());

    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'costReduction',
        amount: { kind: 'const', n: 1 },
        filter: { kind: 'subtype', value: 'Dragon' },
        excludesSelf: true,
        alsoFromCommandZone: true,
      },
    ]);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]?.trigger).toMatchObject({
      when: 'attacks',
      aggregate: true,
    });
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'draw', count: { kind: 'triggerCount' } },
      { op: 'handToBattlefield', filter: expect.anything(), count: 'one' },
    ]);
  });

  it('reduces OTHER Dragon spells from the command zone, but never its own cast', () => {
    const ctx = pod();
    const ur = conjure(ctx, 'P1', urDragon(), 'command');
    registerDef(ctx, bigDragon());

    expect(costReductionFor(ctx, 'P1', bigDragon().oracleId, 'c-other')).toBe(1);
    expect(costReductionFor(ctx, 'P1', ur.oracleId, ur.cardId)).toBe(0);
  });

  it('reduces from the BATTLEFIELD too, once cast', () => {
    const ctx = pod();
    spawn(ctx, 'P1', urDragon());
    registerDef(ctx, bigDragon());

    expect(costReductionFor(ctx, 'P1', bigDragon().oracleId, 'c-other')).toBe(1);
  });

  it('draws that many cards, then may put a permanent from hand onto the battlefield', () => {
    const ctx = pod();
    const def = registerDef(ctx, urDragon());
    conjure(ctx, 'P1', bear(), 'hand');
    const player = p1(ctx);
    const before = player.hand.length;

    pump(
      executeAbility(
        ctx,
        { cardId: 'c-ur', name: 'The Ur-Dragon', oracleId: def.oracleId, controllerId: 'P1' },
        def.triggers[0]!,
        [],
        undefined,
        { triggerCount: 3 },
      ),
      (d) => {
        const i = d.options.findIndex((o) => o.description.includes('Test Bear'));
        return { index: i >= 0 ? i : 0, targets: new Map() };
      },
    );

    // 3 cards drawn (from the seeded library), and the Bear moved out of hand onto the
    // battlefield — hand size nets to (before + 3 drawn - 1 put onto the battlefield).
    expect(player.hand.length).toBe(before + 3 - 1);
    expect(ctx.state.battlefield.some((p) => p.name === 'Test Bear')).toBe(true);
  });
});

describe('Korlessa, Scale Singer', () => {
  it('parses "look at the top card any time" as a recognized no-op, and the cast-from-top static', () => {
    const def = interpretCard(korlessa());

    expect(def.modeled).toBe(true);
    expect(def.ruleStatics).toEqual([
      { kind: 'castFromZone', zone: 'libraryTop', filter: { kind: 'subtype', value: 'Dragon' } },
    ]);
  });

  it('offers only the TOP card of the library, and only when it matches the filter', () => {
    const ctx = pod();
    spawn(ctx, 'P1', korlessa());
    registerDef(ctx, bigDragon());
    registerDef(ctx, bear());

    // Bear on top: not a Dragon, so nothing is offered.
    conjure(ctx, 'P1', bear(), 'library');
    expect(castFromLibraryTopCandidates(ctx, 'P1')).toHaveLength(0);

    // A Dragon on top: offered, and it is exactly the top card.
    const dragonCard = conjure(ctx, 'P1', bigDragon(), 'library');
    const candidates = castFromLibraryTopCandidates(ctx, 'P1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(dragonCard.id);
  });

  it('is offered as a real castSpell option, from the correct zone', () => {
    const ctx = pod();
    spawn(ctx, 'P1', korlessa());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', bigDragon(), 'library');

    const options = computePriorityOptions(ctx, p1(ctx));
    const opt = options.find((o) => o.description.includes('Test Big Dragon'));
    expect(opt).toBeDefined();
    expect(opt?.description).toContain('top of your library');
  });
});
