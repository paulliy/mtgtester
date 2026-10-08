import type { ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeTargetOptions, validateChosenTargets } from '../src/actions/legal';
import type { Ability, TargetSpec } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { executeAbility, isTargetStillLegal } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import { captureResolutionTargets } from '../src/targets/resolution';
import { targetCandidates, targetIsLegal } from '../src/targets/legality';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup(seed = 'target-contract') {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  const mine = conjure(ctx, 'P1', bear(), 'graveyard');
  const theirs = conjure(ctx, 'P2', bear(), 'graveyard');
  const wrongType = conjure(ctx, 'P2', forest(), 'graveyard');
  return { ctx, mine, theirs, wrongType };
}

describe('shared target legality contract', () => {
  it.each([
    ['controller', ['mine']],
    ['opponent', ['theirs']],
    ['any', ['mine', 'theirs']],
  ] as const)(
    'selects %s graveyards with an independent creature restriction',
    (scope, expected) => {
      const { ctx, mine, theirs, wrongType } = setup();
      const spec: TargetSpec = {
        kind: 'cardInGraveyard',
        graveyardOwnerScope: scope,
        filter: ofType('Creature'),
      };
      const candidates = computeTargetOptions(ctx, spec, 'P1');
      expect(new Set(candidates)).toEqual(
        new Set(expected.map((name) => (name === 'mine' ? mine.id : theirs.id))),
      );
      expect(candidates).not.toContain(wrongType.id);
      for (const id of candidates) {
        expect(targetIsLegal(ctx, spec, id, { controllerId: 'P1' })).toBe(true);
        expect(isTargetStillLegal(ctx, id, spec, 'P1')).toBe(true);
      }
    },
  );

  it('uses the referenced player at announcement and resolution, rejecting a missing dependency', () => {
    const { ctx, theirs } = setup();
    const spec: TargetSpec = { kind: 'cardInGraveyard', graveyardOwnerSlot: 0 };
    const chosen = ['P2' as ObjectId];
    expect(
      targetIsLegal(ctx, spec, theirs.id, {
        controllerId: 'P1',
        chosenTargets: chosen,
        phase: 'announcement',
      }),
    ).toBe(true);
    expect(isTargetStillLegal(ctx, theirs.id, spec, 'P1', undefined, undefined, '', chosen)).toBe(
      true,
    );
    expect(isTargetStillLegal(ctx, theirs.id, spec, 'P1')).toBe(false);
    const def = {
      ...interpretCard(oracle({ name: 'Dependent target', typeLine: 'Sorcery', manaCost: '{0}' })),
      spellAbility: {
        kind: 'spell' as const,
        targets: [{ kind: 'player' as const }, spec],
        effects: [],
      },
    };
    expect(
      validateChosenTargets(
        ctx,
        def,
        'P1',
        new Map([
          [0, 'P2' as ObjectId],
          [1, theirs.id],
        ]),
      ),
    ).toEqual([...chosen, theirs.id]);
  });

  it('does not recover a graveyard target when the physical card leaves and returns', () => {
    const { ctx, theirs } = setup();
    const spec: TargetSpec = { kind: 'cardInGraveyard', graveyardOwnerScope: 'any' };
    const oldId = theirs.id;
    const moved = pump(moveObject(ctx, theirs, { zone: 'exile' })).value!;
    const returned = pump(moveObject(ctx, moved, { zone: 'graveyard' })).value!;
    expect(returned.cardId).toBe(theirs.cardId);
    expect(returned.id).not.toBe(oldId);
    expect(isTargetStillLegal(ctx, oldId, spec, 'P1')).toBe(false);
    expect(computeTargetOptions(ctx, spec, 'P1')).toContain(returned.id);
  });

  it('does not apply targeting protections to non-target choices', () => {
    const { ctx } = setup();
    const card = oracle({
      name: 'Protected probe',
      typeLine: 'Creature',
      power: '2',
      toughness: '2',
      oracleText: 'Shroud\nProtection from red',
    });
    const permanent = spawn(ctx, 'P2', card);
    ctx.defs.set(permanent.oracleId, {
      ...interpretCard(card),
      modeled: true,
      keywords: ['shroud'],
      protectionFrom: ['R'],
      unmodeledReasons: [],
    });
    const context = { controllerId: 'P1' as const, sourceColors: ['R' as const] };
    expect(targetCandidates(ctx, 'creature', context)).not.toContain(permanent.id);
    expect(targetCandidates(ctx, 'creature', { ...context, targeting: false })).toContain(
      permanent.id,
    );
  });

  it('keeps independent ordinary target occurrences free to select the same object', () => {
    const { ctx } = setup();
    const permanent = spawn(ctx, 'P1', bear());
    const def = {
      ...interpretCard(oracle({ name: 'Two occurrences', typeLine: 'Sorcery', manaCost: '{0}' })),
      spellAbility: {
        kind: 'spell' as const,
        targets: [{ kind: 'creature' as const }, { kind: 'creature' as const }],
        effects: [],
      },
    };
    expect(
      validateChosenTargets(
        ctx,
        def,
        'P1',
        new Map([
          [0, permanent.id],
          [1, permanent.id],
        ]),
      ),
    ).toEqual([permanent.id, permanent.id]);
  });

  it('captures target legality before an earlier instruction changes its characteristic', () => {
    const { ctx } = setup();
    const permanent = spawn(ctx, 'P1', bear());
    const ability: Ability = {
      kind: 'spell',
      targets: [{ kind: 'creature' }],
      effects: [
        { op: 'grantKeywordEachUntilEot', selector: ofType('Creature'), keyword: 'shroud' },
        { op: 'putCounters', target: 0, counter: '+1/+1', count: 1 },
      ],
    };
    pump(
      executeAbility(
        ctx,
        { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
        ability,
        [permanent.id],
      ),
    );
    expect(permanent.counters['+1/+1']).toBe(1);
    expect(isTargetStillLegal(ctx, permanent.id, 'creature', 'P1')).toBe(false);
  });

  it('follows public-zone moves caused by the same effect, including both blink moves', () => {
    const { ctx } = setup();
    const original = spawn(ctx, 'P1', bear());
    pump(
      executeAbility(
        ctx,
        { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [
            { op: 'blinkTarget', target: 0 },
            { op: 'putCounters', target: 0, counter: '+1/+1', count: 2 },
          ],
        },
        [original.id],
      ),
    );
    const returned = ctx.state.battlefield.find(
      (permanent) => permanent.cardId === original.cardId,
    )!;
    expect(returned.id).not.toBe(original.id);
    expect(returned.counters['+1/+1']).toBe(2);
    expect(ctx.resolutionObjectMoves).toBeUndefined();
  });

  it('the same-effect public-zone exception also preserves an explicitly identified source', () => {
    const { ctx } = setup();
    const original = spawn(ctx, 'P1', bear());
    pump(
      executeAbility(
        ctx,
        {
          id: original.id,
          cardId: original.cardId,
          name: original.name,
          oracleId: original.oracleId,
          controllerId: 'P1',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [
            { op: 'blinkTarget', target: 0 },
            { op: 'putCounters', target: 'source', counter: '+1/+1', count: 2 },
          ],
        },
        [original.id],
      ),
    );
    const returned = ctx.state.battlefield.find(
      (permanent) => permanent.cardId === original.cardId,
    )!;
    expect(returned.id).not.toBe(original.id);
    expect(returned.counters['+1/+1']).toBe(2);
  });

  it('preserves counted target occurrences through moves caused by the effect', () => {
    const { ctx } = setup();
    const original = spawn(ctx, 'P1', bear());
    pump(
      executeAbility(
        ctx,
        { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'creature', count: { min: 1, max: 1 } }],
          effects: [
            { op: 'blinkEachChosen', targetSlot: 0, returnUnder: 'owner' },
            { op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 2 },
          ],
        },
        [],
        undefined,
        undefined,
        { 0: [original.id] },
      ),
    );
    const returned = ctx.state.battlefield.find(
      (permanent) => permanent.cardId === original.cardId,
    )!;
    expect(returned.id).not.toBe(original.id);
    expect(returned.counters['+1/+1']).toBe(2);
  });

  it('does not follow unrelated public-zone moves while a resolution choice is suspended', () => {
    const { ctx } = setup();
    const original = spawn(ctx, 'P1', bear());
    const resolution = executeAbility(
      ctx,
      { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
      {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [
          { op: 'putCounters', target: 0, counter: '+1/+1', count: 1 },
          { op: 'chooseOne', options: [{ description: 'Continue', effects: [] }] },
          { op: 'putCounters', target: 0, counter: '+1/+1', count: 2 },
        ],
      },
      [original.id],
    );
    expect(resolution.next().done).toBe(false);
    expect(original.counters['+1/+1']).toBe(1);
    const exiled = pump(moveObject(ctx, original, { zone: 'exile' })).value!;
    const returned = pump(
      moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P1' }),
    ).value!;
    expect(resolution.next({ index: 0, targets: new Map() }).done).toBe(true);
    expect(
      ctx.state.battlefield.find((permanent) => permanent.id === returned.id)?.counters['+1/+1'],
    ).toBeUndefined();
  });

  it('ends cross-zone tracking when the effect moves its target to a hidden zone', () => {
    const { ctx } = setup();
    const original = spawn(ctx, 'P1', bear());
    const resolution = executeAbility(
      ctx,
      { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
      {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [
          { op: 'returnToHand', target: 0 },
          { op: 'chooseOne', options: [{ description: 'Continue', effects: [] }] },
          { op: 'putCounters', target: 0, counter: '+1/+1', count: 2 },
        ],
      },
      [original.id],
    );
    expect(resolution.next().done).toBe(false);
    const bounced = ctx.state.players[0]!.hand.find((card) => card.cardId === original.cardId)!;
    const returned = pump(
      moveObject(ctx, bounced, { zone: 'battlefield', controllerId: 'P1' }),
    ).value!;
    expect(resolution.next({ index: 0, targets: new Map() }).done).toBe(true);
    expect(
      ctx.state.battlefield.find((permanent) => permanent.id === returned.id)?.counters['+1/+1'],
    ).toBeUndefined();
  });

  it('preserves both occurrences when builders reuse one target specification', () => {
    const { ctx } = setup();
    const first = spawn(ctx, 'P1', bear());
    const second = spawn(ctx, 'P1', bear());
    const spec: TargetSpec = { kind: 'creature' };
    pump(
      executeAbility(
        ctx,
        { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [spec, spec],
          effects: [
            { op: 'putCounters', target: 0, counter: '+1/+1', count: 1 },
            { op: 'putCounters', target: 1, counter: '+1/+1', count: 1 },
          ],
        },
        [first.id, second.id],
      ),
    );
    expect(first.counters['+1/+1']).toBe(1);
    expect(second.counters['+1/+1']).toBe(1);
  });

  it('keeps a player referent stable across repeated any-target instructions', () => {
    const { ctx } = setup();
    const player = ctx.state.players[1]!;
    const initialLife = player.life;
    pump(
      executeAbility(
        ctx,
        { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'anyTarget' }],
          effects: [
            { op: 'loseLifeTarget', target: 0, amount: { kind: 'const', n: 2 } },
            { op: 'loseLifeTarget', target: 0, amount: { kind: 'const', n: 3 } },
          ],
        },
        [player.id as ObjectId],
      ),
    );
    expect(player.life).toBe(initialLife - 5);
  });

  it('skips an illegal slot-based target while resolving the surviving target', () => {
    const { ctx } = setup();
    const source = spawn(ctx, 'P1', bear());
    const protectedTarget = spawn(
      ctx,
      'P2',
      oracle({ name: 'Shrouded probe', oracleText: 'Shroud' }),
    );
    const initialHand = ctx.state.players[0]!.hand.length;
    ctx.state.stack.push({
      id: 'probe-stack',
      sourceId: source.id,
      controllerId: 'P1',
      kind: 'spell',
      description: 'Partial probe',
      sourceOracleId: source.oracleId,
      sourceCardId: source.cardId,
      card: null,
      isCommanderCast: false,
      targets: [protectedTarget.id, 'P1' as ObjectId],
      ability: {
        kind: 'spell',
        targets: [{ kind: 'creature' }, { kind: 'player' }],
        effects: [
          { op: 'exileUntilSourceLeaves', targetSlot: 0 },
          { op: 'drawTarget', target: 1, count: { kind: 'const', n: 1 } },
        ],
      },
    });
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield).toContain(protectedTarget);
    expect(ctx.state.players[0]!.hand).toHaveLength(initialHand + 1);
  });

  it('does not copy a spell that fails its announced noncreature restriction', () => {
    const { ctx } = setup();
    const card = conjure(ctx, 'P1', bear(), 'hand');
    ctx.state.stack.push({
      id: 'creature-spell',
      sourceId: 'creature-spell',
      controllerId: 'P1',
      kind: 'spell',
      description: card.name,
      sourceOracleId: card.oracleId,
      sourceCardId: card.cardId,
      card,
      isCommanderCast: false,
      targets: [],
      ability: { kind: 'spell', targets: [], effects: [] },
    });
    pump(
      executeAbility(
        ctx,
        { cardId: 'probe', name: 'Probe', oracleId: forest().oracleId, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: [{ kind: 'noncreatureSpell' }],
          effects: [{ op: 'copyTargetSpell', target: 0 }],
        },
        ['creature-spell'],
      ),
    );
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('resolves a surviving counted target without enforcing announcement minima again', () => {
    const { ctx } = setup();
    const first = spawn(ctx, 'P1', bear());
    const second = spawn(ctx, 'P1', bear());
    const ability: Ability = {
      kind: 'spell',
      targets: [{ kind: 'creature', count: { min: 2, max: 2 } }],
      effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
    };
    ctx.state.stack.push({
      id: 'probe-stack',
      sourceId: 'probe-stack',
      controllerId: 'P1',
      kind: 'spell',
      description: 'Counted probe',
      sourceOracleId: forest().oracleId,
      sourceCardId: 'probe',
      card: null,
      isCommanderCast: false,
      targets: [],
      countTargets: { 0: [first.id, second.id] },
      ability,
    });
    pump(moveObject(ctx, first, { zone: 'graveyard' }));
    pump(resolveTopOfStack(ctx));
    expect(second.counters['+1/+1']).toBe(1);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(false);
  });

  it('fizzles when all selected targets become illegal', () => {
    const { ctx } = setup();
    const permanent = spawn(ctx, 'P1', bear());
    ctx.state.stack.push({
      id: 'probe-stack',
      sourceId: 'probe-stack',
      controllerId: 'P1',
      kind: 'spell',
      description: 'Fizzle probe',
      sourceOracleId: forest().oracleId,
      sourceCardId: 'probe',
      card: null,
      isCommanderCast: false,
      targets: [permanent.id],
      ability: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      },
    });
    pump(moveObject(ctx, permanent, { zone: 'graveyard' }));
    const handSize = ctx.state.players[0]!.hand.length;
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.players[0]!.hand).toHaveLength(handSize);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
  });
  it('locks a collective mana-value budget before a prior instruction changes a target', () => {
    const { ctx } = setup();
    const small = spawn(ctx, 'P1', bear());
    const large = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Large copy probe',
        typeLine: 'Creature',
        manaCost: '{8}',
        power: '8',
        toughness: '8',
      }),
    );
    const ability: Ability = {
      kind: 'activated',
      targets: [
        { kind: 'creature' },
        { kind: 'nonlandPermanent', count: { min: 0, max: 1 }, totalManaValueAtMost: 2 },
      ],
      effects: [
        { op: 'becomeCopyOf', ref: 0 },
        { op: 'returnToHandEachChosen', targetSlot: 1 },
      ],
    };
    pump(
      executeAbility(
        ctx,
        {
          id: small.id,
          cardId: small.cardId,
          oracleId: small.oracleId,
          name: small.name,
          controllerId: 'P1',
        },
        ability,
        [large.id],
        undefined,
        undefined,
        { 1: [small.id] },
      ),
    );
    expect(ctx.state.battlefield.some((p) => p.cardId === small.cardId)).toBe(false);
    expect(ctx.state.players[0]!.hand.some((c) => c.cardId === small.cardId)).toBe(true);
  });

  it('invalidates an over-budget counted group at resolution start, independently of reused specs', () => {
    const { ctx } = setup();
    const small = spawn(ctx, 'P1', bear());
    const large = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Over-budget probe',
        typeLine: 'Creature',
        manaCost: '{8}',
        power: '8',
        toughness: '8',
      }),
    );
    const shared: TargetSpec = {
      kind: 'nonlandPermanent',
      count: { min: 0, max: 2 },
      totalManaValueAtMost: 2,
    };
    const snapshot = captureResolutionTargets(
      ctx,
      [shared, shared],
      [],
      { 0: [small.id], 1: [small.id, large.id] },
      { controllerId: 'P1' },
    );
    expect(snapshot.slotLegality.get(0)?.get(small.id)).toBe(true);
    expect(snapshot.slotLegality.get(1)?.get(small.id)).toBe(false);
    expect(snapshot.slotLegality.get(1)?.get(large.id)).toBe(false);
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'budget-source',
          oracleId: small.oracleId,
          name: 'Budget probe',
          controllerId: 'P1',
          resolutionTargets: snapshot,
        },
        {
          kind: 'activated',
          targets: [shared, shared],
          effects: [
            { op: 'returnToHandEachChosen', targetSlot: 0 },
            { op: 'returnToHandEachChosen', targetSlot: 1 },
          ],
        },
        [],
        undefined,
        undefined,
        { 0: [small.id], 1: [small.id, large.id] },
      ),
    );
    expect(ctx.state.players[0]!.hand.some((c) => c.cardId === small.cardId)).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.cardId === large.cardId)).toBe(true);
  });
});
