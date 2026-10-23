import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { addMana } from '../src/mana/pool';
import { spellManaValue } from '../src/state/objects';
import { spellDefinitionOf } from '../src/state/queries';
import type { EngineCardObject, GameContext } from '../src/state/types';
import { conjure, oracle, pump, spawn } from './fixtures';
import { battlefield, game, pinned, player, resolve } from './pr11-helpers';

const WEAR_TEAR = pinned('Wear // Tear');

const relic = () =>
  oracle({ name: 'Test Relic', typeLine: 'Artifact', manaCost: '{1}', oracleText: '' });
const ward = () =>
  oracle({ name: 'Test Ward', typeLine: 'Enchantment', manaCost: '{1}', oracleText: '' });

type Mana = Partial<Record<'W' | 'R' | 'C', number>>;

function give(ctx: GameContext, mana: Mana): void {
  addMana(
    player(ctx, 'P1'),
    Object.entries(mana).flatMap(([symbol, count]) =>
      Array.from({ length: count }, () => ({ symbol: symbol as 'W' })),
    ),
  );
}

/** The cast options P1 has for `card`, by description. */
function castOptions(ctx: GameContext, card: EngineCardObject) {
  return computePriorityOptions(ctx, player(ctx, 'P1')).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
}

function cast(
  ctx: GameContext,
  card: EngineCardObject,
  match: (description: string) => boolean,
  targets: ReadonlyMap<number, string>,
): void {
  const option = castOptions(ctx, card).find((entry) => match(entry.description));
  expect(option, 'cast option').toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
}

describe('Wear // Tear', () => {
  it('wear-tear-modeled — both halves and fuse model under the Oracle and fixture ids', () => {
    for (const oracleId of [WEAR_TEAR.oracleId, fixtureOracleId(WEAR_TEAR.name)]) {
      const def = interpretCard({ ...WEAR_TEAR, oracleId } as typeof WEAR_TEAR);
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.alternativeCasts?.map((alt) => [alt.kind, alt.name, alt.fused])).toEqual([
        ['split', 'Wear', undefined],
        ['split', 'Tear', undefined],
        ['split', 'Wear // Tear', true],
      ]);
    }
  });

  it('wear-tear-combined — off the stack it has both names, both colors and mana value 3 (CR 709.4)', () => {
    const def = interpretCard(WEAR_TEAR);
    expect([def.name, def.colors, spellManaValue(def, undefined)]).toEqual([
      'Wear // Tear',
      ['R', 'W'],
      3,
    ]);
  });

  it('wear-c01-positive — cast as Wear for {1}{R}, it is a red spell named Wear and destroys an artifact', () => {
    const ctx = game('wear-half');
    const artifact = spawn(ctx, 'P2', relic());
    const card = conjure(ctx, 'P1', WEAR_TEAR, 'hand');
    give(ctx, { R: 1, C: 1 });
    cast(ctx, card, (text) => text.includes('as Wear'), new Map([[0, artifact.id]]));
    const spell = ctx.state.stack.at(-1)!;
    const face = spellDefinitionOf(ctx, spell);
    expect([face.name, face.colors, spellManaValue(face, undefined)]).toEqual(['Wear', ['R'], 2]);
    resolve(ctx);
    expect(battlefield(ctx, 'Test Relic')).toHaveLength(0);
    expect(player(ctx, 'P1').graveyard.map((entry) => entry.name)).toContain('Wear // Tear');
  });

  it('tear-c02-positive — cast as Tear for {W}, it destroys an enchantment', () => {
    const ctx = game('tear-half');
    const enchantment = spawn(ctx, 'P2', ward());
    const card = conjure(ctx, 'P1', WEAR_TEAR, 'hand');
    give(ctx, { W: 1 });
    expect(castOptions(ctx, card).map((option) => option.description)).toEqual([
      expect.stringContaining('as Tear'),
    ]);
    cast(ctx, card, (text) => text.includes('as Tear'), new Map([[0, enchantment.id]]));
    expect(spellDefinitionOf(ctx, ctx.state.stack.at(-1)!).colors).toEqual(['W']);
    resolve(ctx);
    expect(battlefield(ctx, 'Test Ward')).toHaveLength(0);
  });

  it('wear-tear-no-whole — the combined card is never offered as a spell of its own', () => {
    const ctx = game('wear-tear-whole');
    spawn(ctx, 'P2', relic());
    spawn(ctx, 'P2', ward());
    const card = conjure(ctx, 'P1', WEAR_TEAR, 'hand');
    give(ctx, { R: 1, W: 1, C: 1 });
    const descriptions = castOptions(ctx, card).map((option) => option.description);
    expect(descriptions).toHaveLength(3);
    expect(descriptions.filter((text) => /as Wear|as Tear|fused/.test(text))).toHaveLength(3);
  });

  it('wear-tear-c03-fused — fused from hand for {1}{R}{W}, it destroys both, Wear first (CR 702.102d)', () => {
    const ctx = game('wear-tear-fused');
    const artifact = spawn(ctx, 'P2', relic());
    const enchantment = spawn(ctx, 'P2', ward());
    const card = conjure(ctx, 'P1', WEAR_TEAR, 'hand');
    give(ctx, { R: 1, W: 1, C: 1 });
    cast(
      ctx,
      card,
      (text) => text.includes('fused'),
      new Map([
        [0, artifact.id],
        [1, enchantment.id],
      ]),
    );
    const face = spellDefinitionOf(ctx, ctx.state.stack.at(-1)!);
    expect([face.name, face.colors, spellManaValue(face, undefined)]).toEqual([
      'Wear // Tear',
      ['R', 'W'],
      3,
    ]);
    resolve(ctx);
    expect(battlefield(ctx, 'Test Relic')).toHaveLength(0);
    expect(battlefield(ctx, 'Test Ward')).toHaveLength(0);
  });

  it('wear-tear-c03-partial — a fused spell whose artifact target is gone still destroys the enchantment', () => {
    const ctx = game('wear-tear-partial');
    const artifact = spawn(ctx, 'P2', relic());
    const enchantment = spawn(ctx, 'P2', ward());
    const card = conjure(ctx, 'P1', WEAR_TEAR, 'hand');
    give(ctx, { R: 1, W: 1, C: 1 });
    cast(
      ctx,
      card,
      (text) => text.includes('fused'),
      new Map([
        [0, artifact.id],
        [1, enchantment.id],
      ]),
    );
    ctx.state.battlefield = ctx.state.battlefield.filter((perm) => perm.id !== artifact.id);
    resolve(ctx);
    expect(battlefield(ctx, 'Test Ward')).toHaveLength(0);
  });

  it('wear-tear-c03-hand-only — cast from exile with permission, only the halves are offered', () => {
    const ctx = game('wear-tear-exile');
    spawn(ctx, 'P2', relic());
    spawn(ctx, 'P2', ward());
    const card = conjure(ctx, 'P1', WEAR_TEAR, 'exile');
    card.playableUntilEotBy = 'P1';
    give(ctx, { R: 1, W: 1, C: 1 });
    const descriptions = castOptions(ctx, card).map((option) => option.description);
    expect(descriptions.some((text) => text.includes('as Wear'))).toBe(true);
    expect(descriptions.some((text) => text.includes('as Tear'))).toBe(true);
    expect(descriptions.some((text) => text.includes('fused'))).toBe(false);
  });
});
