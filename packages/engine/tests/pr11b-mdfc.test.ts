import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, oracle, pick, pump, spawn } from './fixtures';
import {
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  offeredTargets,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr11-helpers';

const MALAKIR = pinned('Malakir Rebirth // Malakir Mire');
const VALAKUT = pinned('Valakut Awakening // Valakut Stoneforge');

const card = (name: string) =>
  oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', oracleText: 'Draw a card.' });

/** Play the land face of a spell // land modal DFC from hand through the priority menu. */
function playLandFace(ctx: ReturnType<typeof game>, cardName: string, face: string) {
  const object = conjure(ctx, 'P1', pinned(cardName), 'hand');
  const option = priorityOption(
    ctx,
    'P1',
    (payload) =>
      payload.kind === 'playLand' &&
      payload.objectId === object.id &&
      payload.alternativeCast === 'mdfc',
  );
  expect(option?.description).toBe(`Play ${face}`);
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  return battlefield(ctx, face)[0]!;
}

describe('PR11b modal DFC spell faces', () => {
  it('pr11b-mdfc-modeled — both spell // land cards model under the Oracle and fixture ids', () => {
    for (const source of [MALAKIR, VALAKUT]) {
      for (const oracleId of [source.oracleId, fixtureOracleId(source.name)]) {
        const def = interpretCard({ ...source, oracleId } as typeof source);
        expect(def.unmodeledReasons, source.name).toEqual([]);
        expect(def.modeled).toBe(true);
        expect(def.alternativeCasts?.some((alt) => alt.kind === 'mdfc' && alt.landFace)).toBe(true);
      }
    }
  });
});

describe('Malakir Rebirth // Malakir Mire', () => {
  it('malakir-c01-positive — lose 2 life; the creature returns tapped under its owner when it dies', () => {
    const ctx = game('malakir-positive');
    const foe = spawn(ctx, 'P2', bear());
    castFromHand(ctx, 'P1', MALAKIR, new Map([[0, foe.id]]), { B: 1 });
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(38);
    pump(moveObject(ctx, foe, { zone: 'graveyard' }));
    checkpoint(ctx);
    expect(ctx.state.stack.at(-1)?.kind).toBe('triggeredAbility');
    resolve(ctx);
    const back = battlefield(ctx, 'Test Bear');
    expect(back).toHaveLength(1);
    expect(back[0]!.id).not.toBe(foe.id);
    expect(back[0]!.controllerId).toBe('P2');
    expect(back[0]!.tapped).toBe(true);
    expect(player(ctx, 'P2').graveyard).toHaveLength(0);
  });

  it('malakir-c01-owner — a creature you control but do not own returns under its owner', () => {
    const ctx = game('malakir-owner');
    const stolen = spawn(ctx, 'P2', bear());
    stolen.controllerId = 'P1';
    castFromHand(ctx, 'P1', MALAKIR, new Map([[0, stolen.id]]), { B: 1 });
    resolve(ctx);
    pump(moveObject(ctx, stolen, { zone: 'graveyard' }));
    checkpoint(ctx);
    resolve(ctx);
    expect(battlefield(ctx, 'Test Bear')[0]?.controllerId).toBe('P2');
  });

  it('malakir-c01-negative — the returned object, and a death after end of turn, stay in the graveyard', () => {
    const ctx = game('malakir-negative');
    const mine = spawn(ctx, 'P1', bear());
    const other = spawn(ctx, 'P1', bear());
    castFromHand(ctx, 'P1', MALAKIR, new Map([[0, mine.id]]), { B: 1 });
    resolve(ctx);
    pump(moveObject(ctx, mine, { zone: 'graveyard' }));
    checkpoint(ctx);
    resolve(ctx);
    const returned = battlefield(ctx, 'Test Bear').find((p) => p.id !== other.id)!;
    // The new object never had the grant (CR 400.7).
    pump(moveObject(ctx, returned, { zone: 'graveyard' }));
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(player(ctx, 'P1').graveyard.map((c) => c.name)).toContain('Test Bear');

    // A second casting on another creature lapses at end of turn.
    castFromHand(ctx, 'P1', MALAKIR, new Map([[0, other.id]]), { B: 1 });
    resolve(ctx);
    endUntilEotEffects(ctx);
    pump(moveObject(ctx, other, { zone: 'graveyard' }));
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(0);
  });

  it('malakir-c01-fizzle — an illegal target on resolution means no life loss and no grant', () => {
    const ctx = game('malakir-fizzle');
    const foe = spawn(ctx, 'P2', bear());
    castFromHand(ctx, 'P1', MALAKIR, new Map([[0, foe.id]]), { B: 1 });
    pump(moveObject(ctx, foe, { zone: 'exile' }));
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(40);
  });

  it('malakir-c01-targets — only creatures are offered', () => {
    const ctx = game('malakir-targets');
    const foe = spawn(ctx, 'P2', bear());
    const relic = spawn(
      ctx,
      'P2',
      oracle({ name: 'Relic', typeLine: 'Artifact', manaCost: '{1}', oracleText: '' }),
    );
    const object = conjure(ctx, 'P1', MALAKIR, 'hand');
    anyMana(ctx, 'P1', 0);
    addMana(player(ctx, 'P1'), [{ symbol: 'B' }]);
    const options = offeredTargets(
      ctx,
      'P1',
      (p) => p.kind === 'castSpell' && p.objectId === object.id,
    );
    expect(options).toContain(foe.id);
    expect(options).not.toContain(relic.id);
  });

  it('malakir-land-face — Malakir Mire is played as a land and enters tapped', () => {
    const ctx = game('malakir-land');
    const mire = playLandFace(ctx, 'Malakir Rebirth // Malakir Mire', 'Malakir Mire');
    expect(mire.tapped).toBe(true);
    expect(player(ctx, 'P1').landsPlayedThisTurn).toBe(1);
  });
});

describe('Valakut Awakening // Valakut Stoneforge', () => {
  function withHand(seed: string, count: number) {
    const ctx = game(seed);
    for (let i = 0; i < count; i++) conjure(ctx, 'P1', card(`Hand Card ${i + 1}`), 'hand');
    return ctx;
  }

  it('valakut-c01-positive — two cards go to the bottom in the chosen order and three are drawn', () => {
    const ctx = withHand('valakut-positive', 3);
    const libraryBefore = player(ctx, 'P1').library.length;
    castFromHand(ctx, 'P1', VALAKUT, new Map(), { R: 1, C: 2 });
    const script = [
      'Put on bottom Hand Card 1',
      'Put on bottom Hand Card 2',
      'Done choosing cards',
      'Choose a new bottom order',
      'Put Hand Card 2 next on the bottom',
    ];
    pump(resolveTopOfStack(ctx), (decision) => pick(decision, script.shift()!));
    expect(script).toEqual([]);
    const p1 = player(ctx, 'P1');
    expect(p1.hand.map((c) => c.name)).not.toContain('Hand Card 1');
    expect(p1.hand.map((c) => c.name)).not.toContain('Hand Card 2');
    expect(p1.hand.map((c) => c.name)).toContain('Hand Card 3');
    expect(p1.hand).toHaveLength(1 + 3);
    expect(p1.library).toHaveLength(libraryBefore - 3 + 2);
    expect(p1.library.slice(-2).map((c) => c.name)).toEqual(['Hand Card 2', 'Hand Card 1']);
  });

  it('valakut-c01-none — putting no cards draws exactly one', () => {
    const ctx = withHand('valakut-none', 2);
    castFromHand(ctx, 'P1', VALAKUT, new Map(), { R: 1, C: 2 });
    pump(resolveTopOfStack(ctx), (decision) => pick(decision, 'Put no cards on the bottom'));
    expect(player(ctx, 'P1').hand).toHaveLength(3);
  });

  it('valakut-c01-empty-hand — with an empty hand it still draws one', () => {
    const ctx = withHand('valakut-empty', 0);
    castFromHand(ctx, 'P1', VALAKUT, new Map(), { R: 1, C: 2 });
    resolve(ctx);
    expect(player(ctx, 'P1').hand).toHaveLength(1);
  });

  it('valakut-land-face — Valakut Stoneforge is played as a land and enters tapped', () => {
    const ctx = game('valakut-land');
    const forge = playLandFace(
      ctx,
      'Valakut Awakening // Valakut Stoneforge',
      'Valakut Stoneforge',
    );
    expect(forge.tapped).toBe(true);
  });
});
