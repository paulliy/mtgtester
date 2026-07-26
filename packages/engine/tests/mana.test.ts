import { describe, expect, it } from 'vitest';
import { TAP_COST } from '../src/cards/definition';
import type { ManaEntry } from '../src/cards/ability';
import { canPay, parseManaCost, planPayment, withX } from '../src/mana/cost';
import type { ManaSource, ProducedMana } from '../src/mana/cost';

type Sym = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const src = (cardId: string, ...syms: Sym[]): ManaSource => ({
  cardId,
  units: syms.map((s) => [s]),
  costs: TAP_COST,
});

/** A floating pool, one entry per symbol listed. The pool is a LIST of mana since Inc 12. */
const pool = (...syms: Sym[]): ManaEntry[] => syms.map((symbol) => ({ symbol }));

/** `produced` as a symbol multiset, so tests read as "what entered the pool". */
const producedSymbols = (produced: ProducedMana[]): Sym[] =>
  produced.map((p) => p.symbol).sort() as Sym[];

describe('mana cost parsing', () => {
  it('parses generic + colored + colorless', () => {
    const { cost } = parseManaCost('{3}{G}{G}{C}');
    expect(cost).toEqual({
      generic: 3,
      colored: { W: 0, U: 0, B: 0, R: 0, G: 2 },
      colorless: 1,
    });
  });

  it('parses null/empty as zero cost', () => {
    expect(parseManaCost(null).cost?.generic).toBe(0);
    expect(parseManaCost('').cost?.generic).toBe(0);
  });

  it('reports hybrid, Phyrexian, and snow symbols as unsupported', () => {
    for (const costStr of ['{W/U}', '{2/W}', '{G/P}', '{S}']) {
      const result = parseManaCost(costStr);
      expect(result.cost).toBeNull();
      expect(result.unsupportedSymbols.length).toBeGreaterThan(0);
    }
  });

  it('counts {X} rather than rejecting it — the caster announces its value (CR 601.2b)', () => {
    const { cost, unsupportedSymbols } = parseManaCost('{X}{R}');

    expect(unsupportedSymbols).toEqual([]);
    expect(cost).toMatchObject({ x: 1, colored: { R: 1 }, generic: 0 });
    // {X} is not payable on its own; announcing X folds it into generic.
    expect(withX(cost!, 3)).toMatchObject({ generic: 3, colored: { R: 1 } });
    expect(withX(cost!, 3).x).toBeUndefined();
  });
});

describe('payment solver', () => {
  it('pays colored pips from matching sources only', () => {
    const cost = parseManaCost('{G}{G}').cost!;
    expect(canPay(cost, pool(), [src('a', 'G'), src('b', 'G')])).toBe(true);
    expect(canPay(cost, pool(), [src('a', 'G'), src('b', 'R')])).toBe(false);
  });

  it('pays generic from any mana, {C} only from colorless', () => {
    const generic2 = parseManaCost('{2}').cost!;
    expect(canPay(generic2, pool(), [src('a', 'W'), src('b', 'C')])).toBe(true);
    const colorlessPip = parseManaCost('{C}').cost!;
    expect(canPay(colorlessPip, pool(), [src('a', 'W')])).toBe(false);
    expect(canPay(colorlessPip, pool(), [src('a', 'C')])).toBe(true);
  });

  it('never reports a false "cannot pay" when colors are tight', () => {
    // {1}{G}: the G source must go to the pip; generic from the other.
    const cost = parseManaCost('{1}{G}').cost!;
    expect(canPay(cost, pool(), [src('a', 'G'), src('b', 'W')])).toBe(true);
    // Only one source: cannot cover both.
    expect(canPay(cost, pool(), [src('a', 'G')])).toBe(false);
  });

  it('uses floating pool mana before tapping', () => {
    const cost = parseManaCost('{G}').cost!;
    const plan = planPayment(cost, pool('G'), [src('a', 'G')]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toEqual([]);
    expect(plan!.fromPool.G).toBe(1);
  });

  it('handles multi-unit sources (Sol Ring pattern)', () => {
    const cost = parseManaCost('{2}').cost!;
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(cost, pool(), [solRing]);
    expect(plan?.tapCardIds).toEqual(['sol']);
  });

  it('is deterministic in source selection order', () => {
    const cost = parseManaCost('{G}').cost!;
    const plan = planPayment(cost, pool(), [src('first', 'G'), src('second', 'G')]);
    expect(plan?.tapCardIds).toEqual(['first']);
  });

  it('taps a permanent only once when it offers alternative mana abilities', () => {
    // Haven of the Spirit Dragon's shape: two abilities on ONE permanent, emitted as two
    // sources sharing a cardId. Tapping both would make one land produce two mana.
    const plainC: ManaSource = { cardId: 'haven', units: [['C']], costs: TAP_COST };
    const anyColor: ManaSource = {
      cardId: 'haven',
      units: [['W', 'U', 'B', 'R', 'G']],
      costs: TAP_COST,
    };
    expect(canPay(parseManaCost('{1}').cost!, pool(), [plainC, anyColor])).toBe(true);
    // {2} needs two mana, and this is one land: not payable.
    expect(canPay(parseManaCost('{2}').cost!, pool(), [plainC, anyColor])).toBe(false);

    const plan = planPayment(parseManaCost('{U}').cost!, pool(), [plainC, anyColor]);
    // The {C} alternative cannot pay a {U} pip; the solver backtracks to the any-color one.
    expect(plan?.tapCardIds).toEqual(['haven']);
    expect(producedSymbols(plan!.produced)).toEqual(['U']);
  });
});

describe('payment plan produced mana', () => {
  it('single-symbol sources: produced equals their total output (Sol Ring → {C}{C})', () => {
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}').cost!, pool(), [solRing]);
    // Both {C} enter the pool: one pays the {1}, one floats as surplus.
    expect(producedSymbols(plan!.produced)).toEqual(['C', 'C']);
  });

  it('attributes each produced mana to the source that made it', () => {
    // Attribution is what lets a restriction or spend trigger ride onto the right mana.
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}').cost!, pool(), [solRing]);
    expect(plan!.produced).toEqual([
      { cardId: 'sol', symbol: 'C' },
      { cardId: 'sol', symbol: 'C' },
    ]);
  });

  it('multi-color source: produced is the SPECIFIC symbol the cost needs, not the first', () => {
    // A {W}-or-{U} land paying {U} must produce U — the old code always added the first
    // symbol (W) and would have mispaid.
    const dual: ManaSource = { cardId: 'dual', units: [['W', 'U']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{U}').cost!, pool(), [dual]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toEqual(['dual']);
    expect(producedSymbols(plan!.produced)).toEqual(['U']);
  });

  it('multi-color source: covers a colored pip and a generic pip from the right choices', () => {
    // {W/U} dual + {G} land paying {1}{U}: dual → U (the pip), Forest → generic.
    const dual: ManaSource = { cardId: 'dual', units: [['W', 'U']], costs: TAP_COST };
    const forest: ManaSource = { cardId: 'forest', units: [['G']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}{U}').cost!, pool(), [dual, forest]);
    expect(plan).not.toBeNull();
    expect(producedSymbols(plan!.produced)).toEqual(['G', 'U']);
  });
});
