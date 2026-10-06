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
});
