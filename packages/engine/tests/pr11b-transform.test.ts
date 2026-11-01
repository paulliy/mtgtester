import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, declareAttacks, spawn } from './fixtures';
import {
  activate,
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  pinned,
  player,
  resolve,
} from './pr11-helpers';

const LANDING = pinned("Legion's Landing // Adanto, the First Fort");

/** Declare `attackers` against P2, stopping once the attack triggers are on the stack. */
function attackWith(ctx: GameContext, attackers: EnginePermanent[]): void {
  ctx.state.phase = 'combat';
  const ids = new Set(attackers.map((attacker) => attacker.id));
  const gen = runCombatPhase(ctx);
  let step = gen.next();
  while (!step.done) {
    const decision = step.value;
    if (decision.decisionType === 'declareAttackers') {
      step = gen.next(declareAttacks(decision, (id) => (ids.has(id) ? 'P2' : null)));
      continue;
    }
    // The first priority window after the declaration holds the attack triggers.
    if (ctx.state.stack.length > 0) return;
    step = gen.next({ index: 0, targets: new Map() });
  }
}

function landed(seed: string): {
  ctx: GameContext;
  landing: EnginePermanent;
  /** The decision types asked while the enter trigger resolved. */
  enterAsked: string[];
} {
  const ctx = game(seed);
  castFromHand(ctx, 'P1', LANDING, new Map(), { W: 1 });
  resolve(ctx);
  checkpoint(ctx);
  const enterAsked = resolve(ctx).map((decision) => decision.decisionType);
  const landing = battlefield(ctx, "Legion's Landing")[0]!;
  return { ctx, landing, enterAsked };
}

describe("Legion's Landing // Adanto, the First Fort", () => {
  it('landing-modeled — the front, the attack trigger and the back face model', () => {
    for (const oracleId of [LANDING.oracleId, fixtureOracleId(LANDING.name)]) {
      const def = interpretCard({ ...LANDING, oracleId } as typeof LANDING);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.backFace?.name).toBe('Adanto, the First Fort');
    }
  });

  it('landing-c01-positive — entering creates a 1/1 white Vampire with lifelink', () => {
    const { ctx, enterAsked } = landed('landing-enters');
    expect(battlefield(ctx, 'Vampire')).toHaveLength(1);
    // The enter trigger is mandatory: nobody is asked "use this ability?".
    expect(enterAsked).not.toContain('optionalTrigger');
    const [vampire] = battlefield(ctx, 'Vampire');
    const chars = computeCharacteristics(ctx, vampire!);
    expect([chars.power, chars.toughness, chars.colors, chars.keywords]).toEqual([
      1,
      1,
      ['W'],
      ['lifelink'],
    ]);
  });

  it('landing-c02-positive — attacking with three creatures transforms it into Adanto', () => {
    const { ctx, landing } = landed('landing-three');
    const attackers = [spawn(ctx, 'P1', bear()), spawn(ctx, 'P1', bear())];
    attackers.push(battlefield(ctx, 'Vampire')[0]!);
    for (const attacker of attackers) attacker.summoningSick = false;
    attackWith(ctx, attackers);
    expect(ctx.state.stack.at(-1)?.description).toContain('transform');
    // The transform trigger is mandatory too.
    expect(resolve(ctx).map((decision) => decision.decisionType)).not.toContain('optionalTrigger');
    expect(landing.transformed).toBe(true);
    expect(landing.name).toBe('Adanto, the First Fort');
    const chars = computeCharacteristics(ctx, landing);
    expect(chars.types).toEqual(['Land']);
    expect(chars.supertypes).toEqual(['Legendary']);
    expect(chars.manaAbilities.map((ability) => ability.units)).toEqual([[['W']]]);
  });

  it('landing-c02-negative — attacking with two creatures does not trigger', () => {
    const { ctx, landing } = landed('landing-two');
    const attackers = [spawn(ctx, 'P1', bear()), spawn(ctx, 'P1', bear())];
    for (const attacker of attackers) attacker.summoningSick = false;
    attackWith(ctx, attackers);
    expect(ctx.state.stack.some((entry) => entry.description.includes('transform'))).toBe(false);
    expect(landing.transformed).toBe(false);
  });

  it('landing-c02-opponent — an opponent attacking with three creatures does not trigger', () => {
    const { ctx, landing } = landed('landing-opponent');
    Object.assign(ctx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1 });
    const attackers = [0, 1, 2].map(() => spawn(ctx, 'P2', bear()));
    for (const attacker of attackers) attacker.summoningSick = false;
    ctx.state.phase = 'combat';
    const ids = new Set(attackers.map((attacker) => attacker.id));
    const gen = runCombatPhase(ctx);
    let step = gen.next();
    while (!step.done) {
      const decision = step.value;
      if (decision.decisionType === 'declareAttackers') {
        step = gen.next(declareAttacks(decision, (id) => (ids.has(id) ? 'P1' : null)));
        continue;
      }
      if (ctx.state.stack.length > 0) break;
      step = gen.next({ index: 0, targets: new Map() });
    }
    expect(ctx.state.stack.some((entry) => entry.description.includes('transform'))).toBe(false);
    expect(landing.transformed).toBe(false);
  });

  it('landing-c02-once — a doubled trigger turns the card over only once (CR 701.27f)', () => {
    const { ctx, landing } = landed('landing-doubled');
    const attackers = [0, 1, 2].map(() => spawn(ctx, 'P1', bear()));
    for (const attacker of attackers) attacker.summoningSick = false;
    attackWith(ctx, attackers);
    const trigger = ctx.state.stack.at(-1)!;
    ctx.state.stack.push({ ...trigger, id: `${trigger.id}-copy` as typeof trigger.id });
    resolve(ctx);
    resolve(ctx);
    expect(landing.transformed).toBe(true);
    expect(landing.transformations).toBe(1);
  });

  it('adanto-c03-positive — Adanto taps for {W} and makes a Vampire for {2}{W}, {T}', () => {
    const { ctx, landing } = landed('adanto-token');
    const attackers = [0, 1, 2].map(() => spawn(ctx, 'P1', bear()));
    for (const attacker of attackers) attacker.summoningSick = false;
    attackWith(ctx, attackers);
    resolve(ctx);
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    ctx.state.stack = [];
    anyMana(ctx, 'P1', 2);
    addMana(player(ctx, 'P1'), [{ symbol: 'W' }]);
    activate(ctx, 'P1', landing);
    resolve(ctx);
    expect(battlefield(ctx, 'Vampire')).toHaveLength(2);
    expect(landing.tapped).toBe(true);
  });
});
