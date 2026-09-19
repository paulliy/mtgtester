/**
 * The two "Will" modal spells (R.6), and the primitives each needed.
 *
 * Both print the same header — "Choose one. If you control a commander as you cast this spell,
 * you may choose both instead." — which `parseModalSpellBlock` already read. What was missing
 * was inside the bullets, and a modal block fails closed if ANY bullet fails, so each card was
 * unmodeled for a reason that had nothing to do with modality:
 *
 * - **Akroma's Will** — its keyword lists are Oxford lists ("flying, vigilance, and double
 *   strike"), which left a stray "and" on the last element, and its second bullet grants
 *   *protection from each color* until end of turn. `UntilEotEffect` had `keyword?:
 *   KeywordAbility` and no protection variant, so protection grants were refused outright.
 * - **Jeska's Will** — "Add {R} for each card in target opponent's hand" is a spell effect with
 *   a computed amount, and "Exile the top three cards of your library. You may play them this
 *   turn" is a two-sentence block whose second sentence is meaningless alone.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility, permanentSource } from '../src/effects/resolve';
import type { Ability } from '../src/cards/ability';
import type { ObjectId } from '@mtg/shared';
import type { GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const akromasWill = () =>
  oracle({
    name: "Akroma's Will",
    typeLine: 'Instant',
    manaCost: '{3}{W}',
    power: null,
    toughness: null,
    oracleText:
      'Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Creatures you control gain flying, vigilance, and double strike until end of turn.\n• Creatures you control gain lifelink, indestructible, and protection from each color until end of turn.',
  });

const jeskasWill = () =>
  oracle({
    name: "Jeska's Will",
    typeLine: 'Sorcery',
    manaCost: '{2}{R}',
    power: null,
    toughness: null,
    oracleText:
      "Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Add {R} for each card in target opponent's hand.\n• Exile the top three cards of your library. You may play them this turn.",
  });

function pod(seed = 'modal-wills'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
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

describe("Akroma's Will", () => {
  it('models both bullets, Oxford lists and all', () => {
    const def = interpretCard(akromasWill());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const modes = def.spellAbility?.modes;
    expect(modes).toBeDefined();
    expect(modes!.options).toHaveLength(2);
    // "Choose one … you may choose both instead" — one normally, two with a commander out.
    expect(modes!.minChoices).toBe(1);
    expect(modes!.maxChoices).toBe(1);
    expect(modes!.maxChoicesIf).toEqual({
      condition: { kind: 'controlsYourCommander' },
      maxChoices: 2,
    });

    // Bullet 1: three keywords, the third of which is the Oxford-list element that used to be
    // read as "and double strike" and rejected.
    const first = modes!.options[0]!.effects;
    expect(first.map((e) => (e as { keyword?: string }).keyword)).toEqual([
      'flying',
      'vigilance',
      'double strike',
    ]);

    // Bullet 2: two keywords plus a protection grant, which is a DIFFERENT op — protection
    // carries an argument and cannot ride on `keyword`.
    const second = modes!.options[1]!.effects;
    expect(second.filter((e) => e.op === 'grantKeywordEachUntilEot')).toHaveLength(2);
    const protection = second.find((e) => e.op === 'grantProtectionEachUntilEot');
    expect(protection).toBeDefined();
    // CR 105.1 — five colors. Colorless is not a color.
    expect((protection as { colors: string[] }).colors).toEqual(['W', 'U', 'B', 'R', 'G']);
  });

  it('actually grants protection until end of turn', () => {
    const ctx = pod();
    const target = spawn(ctx, 'P1', bear());
    const opponentCreature = spawn(ctx, 'P2', bear());
    expect(computeCharacteristics(ctx, target).protectionFrom).toEqual([]);

    const def = interpretCard(akromasWill());
    const ability = def.spellAbility as Ability;
    const bullet = ability.modes!.options[1]!;
    pump(
      executeAbility(
        ctx,
        permanentSource(target),
        { kind: 'spell', targets: [], effects: bullet.effects },
        [],
      ),
    );

    const chars = computeCharacteristics(ctx, target);
    expect([...chars.protectionFrom].sort()).toEqual(['B', 'G', 'R', 'U', 'W']);
    expect(chars.keywords).toContain('lifelink');
    expect(chars.keywords).toContain('indestructible');

    // "Creatures YOU control" — the affected set is fixed at resolution and excludes theirs.
    expect(computeCharacteristics(ctx, opponentCreature).protectionFrom).toEqual([]);
  });

  it('does not protect a creature that entered after resolution (CR 611.2c)', () => {
    const ctx = pod();
    const early = spawn(ctx, 'P1', bear());

    const def = interpretCard(akromasWill());
    const bullet = (def.spellAbility as Ability).modes!.options[1]!;
    pump(
      executeAbility(
        ctx,
        permanentSource(early),
        { kind: 'spell', targets: [], effects: bullet.effects },
        [],
      ),
    );

    const late = spawn(ctx, 'P1', bear());
    expect(computeCharacteristics(ctx, late).protectionFrom).toEqual([]);
  });
});

describe("Jeska's Will", () => {
  it('models both bullets', () => {
    const def = interpretCard(jeskasWill());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const modes = def.spellAbility?.modes;
    expect(modes!.options).toHaveLength(2);

    // Bullet 1 is a SPELL effect with a computed amount, not a mana ability: it targets and it
    // uses the stack.
    const add = modes!.options[0]!.effects[0]!;
    expect(add.op).toBe('addMana');
    expect((add as { colors: string[] }).colors).toEqual(['R']);
    expect((add as { amount: { kind: string } }).amount.kind).toBe('cardsInTargetHand');

    // Bullet 2 is one BLOCK: "you may play them this turn" is meaningless split off from the
    // exile it refers to.
    expect(modes!.options[1]!.effects).toEqual([
      { op: 'exileTopNPlayableUntilEot', count: { kind: 'const', n: 3 } },
    ]);
  });

  it('adds one red mana per card in the targeted opponent’s hand', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', bear());
    const me = ctx.state.players[0]!;
    const them = ctx.state.players[1]!;
    for (let i = 0; i < 3; i += 1) conjure(ctx, them.id, forest(), 'hand');

    const def = interpretCard(jeskasWill());
    const ability = def.spellAbility as Ability;
    const bullet = ability.modes!.options[0]!;
    pump(
      executeAbility(
        ctx,
        permanentSource(source),
        { kind: 'spell', targets: ability.targets, effects: bullet.effects },
        [them.id as unknown as ObjectId],
      ),
    );

    // A single-color palette is not a choice — the mana is added without a decision.
    expect(me.manaEntries.map((e) => e.symbol)).toEqual(['R', 'R', 'R']);
  });
});
