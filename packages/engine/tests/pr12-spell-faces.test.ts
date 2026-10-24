import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { hasKeyword } from '../src/state/queries';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EngineCardObject, GameContext } from '../src/state/types';
import { bear, conjure, forest, island, oracle, pump, spawn } from './fixtures';
import {
  activateIndex,
  alias,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr12-helpers';

const BLOOMVINE = pinned('Bloomvine Regent // Claim Territory');
const MARANG = pinned('Marang River Regent // Coil and Catch');
const MANUAL = pinned('Monster Manual // Zoological Study');

const snowForest = (): OracleCard =>
  oracle({
    name: 'Snow-Covered Forest',
    typeLine: 'Basic Snow Land — Forest',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
const dualForest = (): OracleCard =>
  oracle({
    name: 'Nonbasic Grove',
    typeLine: 'Land — Forest Island',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
const whelp = (): OracleCard =>
  oracle({
    name: 'Test Whelp',
    typeLine: 'Creature — Dragon',
    manaCost: '{1}',
    power: '2',
    toughness: '2',
  });
const rock = (): OracleCard =>
  oracle({ name: 'Test Rock', typeLine: 'Artifact', manaCost: '{2}', oracleText: '' });

type Mana = Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>>;

function addPool(ctx: GameContext, playerId: string, mana: Mana): void {
  addMana(
    player(ctx, playerId),
    Object.entries(mana).flatMap(([symbol, count]) =>
      Array.from({ length: count }, () => ({ symbol: symbol as 'G' })),
    ),
  );
}

/** Cast `object` via its Omen or Adventure face through the priority menu. */
function castFace(
  ctx: GameContext,
  playerId: string,
  object: EngineCardObject,
  kind: 'omen' | 'adventure',
  mana: Mana,
): void {
  addPool(ctx, playerId, mana);
  const option = priorityOption(
    ctx,
    playerId,
    (payload) =>
      payload.kind === 'castSpell' &&
      payload.objectId === object.id &&
      payload.alternativeCast === kind,
  );
  expect(option, `cast ${object.name} via ${kind}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

function resolveWith(
  ctx: GameContext,
  answer: (decision: PendingDecision) => DecisionOutcome,
): PendingDecision[] {
  return pump(resolveTopOfStack(ctx), answer).decisions;
}

const byDescription =
  (...patterns: RegExp[]) =>
  (decision: PendingDecision): DecisionOutcome => {
    for (const pattern of patterns) {
      const index = decision.options.findIndex((option) => pattern.test(option.description));
      if (index >= 0) return { index, targets: new Map() };
    }
    return { index: 0, targets: new Map() };
  };

describe('PR12 spell faces — interpretation', () => {
  it('pr12-spell-faces-modeled — each card carries its executable spell face for both identities', () => {
    for (const card of [BLOOMVINE, MARANG, MANUAL]) {
      for (const identity of [card, alias(card)]) {
        const def = interpretCard(identity);
        expect(def.modeled, identity.oracleId).toBe(true);
        const face = def.alternativeCasts?.find(
          (alt) => alt.kind === 'omen' || alt.kind === 'adventure',
        );
        expect(face?.name).toBe(card.backFace!.name);
      }
    }
  });
});

describe('Bloomvine Regent // Claim Territory', () => {
  it('bloomvine-c01-c02 — flying; it or another Dragon entering under your control gains you 3 life', () => {
    const ctx = game('pr12-bloomvine-life');
    castFromHand(ctx, 'P1', BLOOMVINE, new Map(), { G: 2, C: 3 });
    resolve(ctx);
    const permanent = battlefield(ctx, 'Bloomvine Regent // Claim Territory')[0]!;
    expect(hasKeyword(ctx, permanent, 'flying')).toBe(true);
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(43);
    castFromHand(ctx, 'P1', whelp(), new Map(), { C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(46);
  });

  it('bloomvine-c02-negative — an opponent’s Dragon or your non-Dragon does not gain you life', () => {
    const ctx = game('pr12-bloomvine-quiet');
    spawn(ctx, 'P1', BLOOMVINE);
    castFromHand(ctx, 'P1', bear(), new Map(), { G: 2 });
    resolve(ctx);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    spawn(ctx, 'P2', whelp());
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(player(ctx, 'P1').life).toBe(40);
  });

  it('claim-c01-positive — the Omen finds two basic Forests: one enters tapped, one goes to hand, both revealed, then both shuffles', () => {
    const ctx = game('pr12-claim-two');
    const me = player(ctx, 'P1');
    const first = conjure(ctx, 'P1', forest(), 'library');
    const second = conjure(ctx, 'P1', snowForest(), 'library');
    conjure(ctx, 'P1', dualForest(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    const card = conjure(ctx, 'P1', BLOOMVINE, 'hand');
    const before = ctx.state.eventLog.length;
    castFace(ctx, 'P1', card, 'omen', { G: 1, C: 2 });
    expect(ctx.state.stack.at(-1)?.description).toContain('Claim Territory');
    const offered: string[][] = [];
    resolveWith(ctx, (decision) => {
      offered.push(decision.options.map((option) => option.description));
      return byDescription(/Put Forest onto/, /Put Snow-Covered Forest into/)(decision);
    });
    // Only basic Forests: not the nonbasic Forest, not the Island.
    expect([...offered[0]!].sort()).toEqual([
      'Find nothing',
      'Put Forest onto the battlefield tapped',
      'Put Snow-Covered Forest onto the battlefield tapped',
    ]);
    expect(offered[1]).toEqual(['Put Snow-Covered Forest into your hand', 'Find nothing']);
    const land = battlefield(ctx, 'Forest').find((perm) => perm.cardId === first.cardId);
    expect(land?.tapped).toBe(true);
    expect(me.hand.map((c) => c.cardId)).toContain(second.cardId);
    // Shuffled into its owner's library as the Omen resolves.
    expect(me.library.map((c) => c.cardId)).toContain(card.cardId);
    const events = ctx.state.eventLog.slice(before);
    expect(
      events.filter((event) => event.type === 'searchFound').map((e) => e.payload['revealed']),
    ).toEqual([true, true]);
    expect(events.filter((event) => event.type === 'shuffle').length).toBeGreaterThanOrEqual(1);
  });

  it('claim-c01-up-to — finding only one or none is allowed', () => {
    const ctx = game('pr12-claim-one');
    const me = player(ctx, 'P1');
    conjure(ctx, 'P1', forest(), 'library');
    const card = conjure(ctx, 'P1', BLOOMVINE, 'hand');
    const lands = battlefield(ctx, 'Forest').length;
    castFace(ctx, 'P1', card, 'omen', { G: 1, C: 2 });
    resolveWith(ctx, byDescription(/Find nothing/));
    expect(battlefield(ctx, 'Forest')).toHaveLength(lands);
    expect(me.library.map((c) => c.cardId)).toContain(card.cardId);
  });

  it('claim-c01-negative — it is a sorcery: no cast via Omen while the stack is not empty', () => {
    const ctx = game('pr12-claim-timing');
    const card = conjure(ctx, 'P1', BLOOMVINE, 'hand');
    castFromHand(ctx, 'P1', bear(), new Map(), { G: 2 });
    addPool(ctx, 'P1', { G: 1, C: 2 });
    expect(
      priorityOption(
        ctx,
        'P1',
        (payload) => payload.kind === 'castSpell' && payload.objectId === card.id,
      ),
    ).toBeUndefined();
  });
});

describe('Marang River Regent // Coil and Catch', () => {
  it('marang-c01-c02 — flying; entering returns up to two other nonland permanents to their owners’ hands', () => {
    const ctx = game('pr12-marang-enter');
    const theirs = spawn(ctx, 'P2', bear());
    const borrowed = spawn(ctx, 'P2', rock());
    borrowed.ownerId = 'P3';
    const kept = spawn(
      ctx,
      'P4',
      oracle({ name: 'Kept Bear', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    castFromHand(ctx, 'P1', MARANG, new Map(), { U: 2, C: 4 });
    resolve(ctx);
    const regent = battlefield(ctx, 'Marang River Regent // Coil and Catch')[0]!;
    expect(hasKeyword(ctx, regent, 'flying')).toBe(true);
    const seen: string[][] = [];
    pump(priorityCheckpoint(ctx), (decision) => {
      seen.push(decision.options.map((option) => option.description));
      return byDescription(/^Target Test Bear$/, /^Target Test Rock$/)(decision);
    });
    expect(seen[0]).toContain('Target Kept Bear');
    expect(seen[0]).toContain('Choose no more targets');
    // "Other": the Regent itself is never offered; lands are not either.
    expect(seen.flat().some((text) => text.includes('Marang'))).toBe(false);
    expect(seen.flat().some((text) => text.includes('Plains'))).toBe(false);
    resolve(ctx);
    expect(player(ctx, 'P2').hand.map((card) => card.cardId)).toContain(theirs.cardId);
    // An owner's hand, not its controller's.
    expect(player(ctx, 'P3').hand.map((card) => card.cardId)).toContain(borrowed.cardId);
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(0);
    expect(battlefield(ctx, 'Kept Bear').map((perm) => perm.id)).toEqual([kept.id]);
    expect(battlefield(ctx, 'Marang River Regent // Coil and Catch')).toHaveLength(1);
  });

  it('coil-c01-positive — the Omen instant draws three, then discards a card, then the card is shuffled into its owner’s library', () => {
    const ctx = game('pr12-coil');
    const me = player(ctx, 'P1');
    const card = conjure(ctx, 'P1', MARANG, 'hand');
    const keep = conjure(ctx, 'P1', bear(), 'hand');
    const hand = me.hand.length;
    const library = me.library.length;
    // Instant speed: castable on an opponent's turn with a spell on the stack.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Gain Test',
        typeLine: 'Sorcery',
        manaCost: '{1}',
        oracleText: 'You gain 1 life.',
      }),
      new Map(),
      { C: 1 },
    );
    castFace(ctx, 'P1', card, 'omen', { U: 1, C: 3 });
    expect(ctx.state.stack.at(-1)?.description).toContain('Coil and Catch');
    const prompts: string[] = [];
    resolveWith(ctx, (decision) => {
      prompts.push(decision.prompt);
      return byDescription(/Discard Test Bear/)(decision);
    });
    expect(me.hand.length).toBe(hand - 1 + 3 - 1);
    expect(me.hand.map((c) => c.cardId)).not.toContain(keep.cardId);
    expect(me.graveyard.map((c) => c.cardId)).toContain(keep.cardId);
    expect(me.library.length).toBe(library - 3 + 1);
    expect(me.library.map((c) => c.cardId)).toContain(card.cardId);
    expect(me.graveyard.map((c) => c.cardId)).not.toContain(card.cardId);
  });
});

describe('Monster Manual // Zoological Study', () => {
  it('manual-c01-positive — {1}{G}, {T}: you may put a creature card from your hand onto the battlefield', () => {
    const ctx = game('pr12-manual-cheat');
    const manual = spawn(ctx, 'P1', MANUAL);
    const creature = conjure(ctx, 'P1', whelp(), 'hand');
    conjure(ctx, 'P1', rock(), 'hand');
    addPool(ctx, 'P1', { G: 1, C: 1 });
    const offered: string[] = [];
    activateIndex(ctx, 'P1', manual, 0);
    expect(manual.tapped).toBe(true);
    resolveWith(ctx, (decision) => {
      offered.push(...decision.options.map((option) => option.description));
      return byDescription(/Test Whelp/)(decision);
    });
    expect(offered.some((text) => text.includes('Test Rock'))).toBe(false);
    expect(battlefield(ctx, 'Test Whelp').map((perm) => perm.cardId)).toEqual([creature.cardId]);
  });

  it('manual-c01-optional — putting nothing is allowed, and it needs {1}{G} and an untapped Manual', () => {
    const ctx = game('pr12-manual-decline');
    const manual = spawn(ctx, 'P1', MANUAL);
    conjure(ctx, 'P1', whelp(), 'hand');
    expect(
      priorityOption(
        ctx,
        'P1',
        (payload) => payload.kind === 'activateAbility' && payload.objectId === manual.id,
      ),
    ).toBeUndefined();
    addPool(ctx, 'P1', { G: 1, C: 1 });
    activateIndex(ctx, 'P1', manual, 0);
    const decisions = resolveWith(ctx, (decision) => {
      const decline = decision.options.findIndex((option) => option.type === 'decline');
      return { index: Math.max(decline, 0), targets: new Map() };
    });
    expect(decisions.some((d) => d.options.some((option) => option.type === 'decline'))).toBe(true);
    expect(battlefield(ctx, 'Test Whelp')).toHaveLength(0);
  });

  it('zoological-c01-positive — mills five, returns a creature card milled this way, and goes on an Adventure', () => {
    const ctx = game('pr12-zoo');
    const me = player(ctx, 'P1');
    const lower = conjure(ctx, 'P1', bear(), 'library');
    const top = [conjure(ctx, 'P1', whelp(), 'library')];
    // conjure puts each card on top: the five milled are the last five conjured.
    for (let i = 0; i < 4; i++) top.push(conjure(ctx, 'P1', rock(), 'library'));
    void lower;
    const card = conjure(ctx, 'P1', MANUAL, 'hand');
    castFace(ctx, 'P1', card, 'adventure', { G: 1, C: 2 });
    const offered: string[][] = [];
    resolveWith(ctx, (decision) => {
      offered.push(decision.options.map((option) => option.description));
      return { index: 0, targets: new Map() };
    });
    expect(me.graveyard.filter((c) => c.name === 'Test Rock')).toHaveLength(4);
    expect(me.hand.map((c) => c.cardId)).toContain(top[0]!.cardId);
    // Mandatory: no decline among the choices; a lone creature card is simply returned.
    expect(offered.flat().some((text) => /Take none|decline/i.test(text))).toBe(false);
    const exiled = ctx.state.exile.find((c) => c.cardId === card.cardId);
    expect(exiled?.onAdventure).toBe(true);
    // "You may cast the artifact later from exile."
    addPool(ctx, 'P1', { G: 1, C: 3 });
    const fromExile = priorityOption(
      ctx,
      'P1',
      (payload) => payload.kind === 'castSpell' && payload.objectId === exiled!.id,
    );
    expect(fromExile).toBeDefined();
    expect(
      priorityOption(
        ctx,
        'P1',
        (payload) =>
          payload.kind === 'castSpell' &&
          payload.objectId === exiled!.id &&
          payload.alternativeCast === 'adventure',
      ),
    ).toBeUndefined();
  });

  it('zoological-c01-negative — with no creature card among the milled cards, nothing returns', () => {
    const ctx = game('pr12-zoo-none');
    const me = player(ctx, 'P1');
    conjure(ctx, 'P1', bear(), 'library');
    for (let i = 0; i < 5; i++) conjure(ctx, 'P1', rock(), 'library');
    const card = conjure(ctx, 'P1', MANUAL, 'hand');
    const hand = me.hand.length;
    castFace(ctx, 'P1', card, 'adventure', { G: 1, C: 2 });
    resolveWith(ctx, () => ({ index: 0, targets: new Map() }));
    expect(me.hand.length).toBe(hand - 1);
    expect(me.hand.some((c) => c.name === 'Test Bear')).toBe(false);
    expect(me.graveyard.filter((c) => c.name === 'Test Rock')).toHaveLength(5);
  });

  it('zoological-c01-choice — several creature cards milled: exactly one is chosen', () => {
    const ctx = game('pr12-zoo-choice');
    const me = player(ctx, 'P1');
    const a = conjure(ctx, 'P1', whelp(), 'library');
    const b = conjure(ctx, 'P1', bear(), 'library');
    for (let i = 0; i < 3; i++) conjure(ctx, 'P1', rock(), 'library');
    const card = conjure(ctx, 'P1', MANUAL, 'hand');
    castFace(ctx, 'P1', card, 'adventure', { G: 1, C: 2 });
    const offered: string[][] = [];
    resolveWith(ctx, (decision) => {
      offered.push(decision.options.map((option) => option.description));
      return byDescription(/Test Bear/)(decision);
    });
    expect(offered).toEqual([['Return Test Bear', 'Return Test Whelp']]);
    expect(me.hand.map((c) => c.cardId)).toContain(b.cardId);
    expect(me.graveyard.map((c) => c.cardId)).toContain(a.cardId);
  });
});
