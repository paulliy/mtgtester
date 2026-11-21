/**
 * CR 508.1f taps the declared attackers before 508.1g/h pay the attack costs, so an attacker
 * without vigilance cannot pay its own attack tax with a `{T}` mana ability (engine-stop bug 07,
 * fuzz seed 355: "cost for P1 became unpayable at application time"). The per-creature menu check,
 * the joint validator and the payment must agree on which mana sources the attack leaves usable.
 */
import { describe, expect, it } from 'vitest';
import { runCombatPhase } from '../src/combat/combat';
import type { CardDefinition } from '../src/cards/definition';
import type { PendingDecision } from '../src/decisions';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  copies,
  declareAttacks,
  declareNoAttacks,
  forest,
  gameConfig,
  keywordCreature,
  oracle,
  pick,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

/** "Ghostly Prison" shape: each creature attacking the controller costs {2}. */
function attackTaxDef(oracleId: string, amount: number): CardDefinition {
  return {
    oracleId,
    name: 'Test Ghostly Prison',
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
    ruleStatics: [{ kind: 'attackTax', amount }],
    modeled: true,
    unmodeledReasons: [],
  };
}

interface Board {
  ctx: GameContext;
  mana: EnginePermanent;
  bear: EnginePermanent;
  forests: EnginePermanent[];
}

/** P1 attacks. P2 taxes attackers {2} each; P3 and P4 do not. P1 has `lands` untapped Forests. */
function board(lands: number, manaKeywords = ''): Board {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed: 'attack-tax-attacker-mana' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'combat';
  registerCustomDef(ctx, attackTaxDef('test-prison-attacker-mana', 2));
  spawn(
    ctx,
    'P2',
    oracle({
      name: 'Test Ghostly Prison',
      oracleId: 'test-prison-attacker-mana',
      typeLine: 'Enchantment',
      manaCost: null,
    }),
  );
  const mana = spawn(
    ctx,
    'P1',
    keywordCreature('Test Mana Elf', `${manaKeywords}{T}: Add {G}.`, '{G}', '1/1'),
  );
  const bear = spawn(ctx, 'P1', keywordCreature('Test Bear', '', '{1}{G}', '2/2'));
  const forests = Array.from({ length: lands }, () => spawn(ctx, 'P1', forest()));
  return { ctx, mana, bear, forests };
}

type Plan = Record<string, string | null>;

/**
 * Run P1's combat with a first proposal and then (if the engine re-asks) a decline-all. Returns
 * the declaration decisions so a test can read the rejection. Strict: every decision is answered.
 */
function attack(ctx: GameContext, proposal: Plan): PendingDecision[] {
  const declarations: PendingDecision[] = [];
  pump(
    runCombatPhase(ctx),
    (d) => {
      if (d.decisionType === 'declareAttackers' && d.player === 'P1') {
        declarations.push(d);
        if (declarations.length > 1) return declareNoAttacks(d);
        return declareAttacks(d, (subjectId) => {
          const permanent = ctx.state.battlefield.find((p) => p.id === subjectId);
          return permanent === undefined ? null : (proposal[permanent.name] ?? null);
        });
      }
      return pick(d, /Pass|does not/);
    },
    { strict: true },
  );
  return declarations;
}

function expectRejected(declarations: PendingDecision[]): void {
  expect(declarations).toHaveLength(2);
  const violations = declarations[1]?.presentationAttackDeclaration?.rejection?.violations ?? [];
  expect(violations.length).toBeGreaterThan(0);
  expect(violations.every((v) => v.kind === 'attackTax')).toBe(true);
}

function attacked(ctx: GameContext): string[] {
  return ctx.state.eventLog
    .filter((e) => e.type === 'attack')
    .map((e) => String(e.payload['attacker']));
}

describe('attack tax and mana abilities of the attackers themselves (CR 508.1f)', () => {
  it('rejects the fuzz-355 shape: a free mana attacker plus one taxed attacker, one other source', () => {
    const { ctx, mana, forests } = board(1);
    const declarations = attack(ctx, { 'Test Mana Elf': 'P3', 'Test Bear': 'P2' });
    // The elf is tapped by attacking, so only the Forest can pay the {2}. Declined, nobody attacks.
    expectRejected(declarations);
    expect(attacked(ctx)).toEqual([]);
    expect(mana.tapped).toBe(false);
    expect(forests[0]?.tapped).toBe(false);
  });

  it('rejects the mana creature alone attacking the taxed player when only one other source exists', () => {
    const { ctx } = board(1);
    expectRejected(attack(ctx, { 'Test Mana Elf': 'P2' }));
    expect(attacked(ctx)).toEqual([]);
  });

  it('rejects two creatures at the taxed player when the attackers cannot pay for themselves', () => {
    // {4} owed; three Forests plus the elf would make four, but the elf is tapped by attacking.
    const { ctx } = board(3);
    expectRejected(attack(ctx, { 'Test Mana Elf': 'P2', 'Test Bear': 'P2' }));
    expect(attacked(ctx)).toEqual([]);
  });

  it('accepts and pays the same board with two usable non-attacking sources', () => {
    const { ctx, mana, forests } = board(2);
    const declarations = attack(ctx, { 'Test Mana Elf': 'P3', 'Test Bear': 'P2' });
    expect(declarations).toHaveLength(1);
    expect(attacked(ctx).sort()).toEqual(['Test Bear', 'Test Mana Elf']);
    expect(mana.tapped).toBe(true);
    expect(forests.every((f) => f.tapped)).toBe(true);
  });

  it('still lets a non-attacking mana creature help pay another creature’s tax', () => {
    // The elf stays home, so it and the Forest pay the bear's {2}.
    const { ctx, mana, forests } = board(1);
    const declarations = attack(ctx, { 'Test Bear': 'P2' });
    expect(declarations).toHaveLength(1);
    expect(attacked(ctx)).toEqual(['Test Bear']);
    expect(mana.tapped).toBe(true);
    expect(forests[0]?.tapped).toBe(true);
  });

  it('lets a vigilant mana creature tap for its own attack tax', () => {
    // Vigilance: not tapped by attacking, so it is a usable source. Elf plus Forest pay {2}.
    const { ctx, mana, forests } = board(1, 'Vigilance\n');
    const declarations = attack(ctx, { 'Test Mana Elf': 'P2' });
    expect(declarations).toHaveLength(1);
    expect(attacked(ctx)).toEqual(['Test Mana Elf']);
    expect(mana.tapped).toBe(true);
    expect(forests[0]?.tapped).toBe(true);
  });
});
