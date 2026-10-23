import { expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { moveObject } from '../src/state/objects';
import { conjure, oracle, plains, pump, spawn } from './fixtures';
import { castFromHand, game, pinned, player } from './pr11-helpers';

it.each(['morph', 'manifest'] as const)(
  'split-second-%s — turning a permanent face up remains legal while spells and nonmana abilities are blocked',
  (way) => {
    const ctx = game(`split-second-${way}`);
    const me = player(ctx, 'P2');
    const card = conjure(
      ctx,
      'P2',
      oracle({
        name: 'Face-up Beast',
        typeLine: 'Creature — Beast',
        manaCost: '{2}{G}',
        oracleText: way === 'morph' ? 'Morph {G}' : '',
        power: '4',
        toughness: '4',
      }),
      'library',
    );
    const permanent = pump(
      moveObject(ctx, card, {
        zone: 'battlefield',
        controllerId: 'P2',
        faceDown: true,
        ...(way === 'manifest' ? { manifested: true as const } : {}),
      }),
    ).value!;
    spawn(ctx, 'P2', plains());
    me.manualMana = true;
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Rod',
        typeLine: 'Artifact',
        manaCost: '{1}',
        oracleText: '{T}: Test Rod deals 1 damage to any target.',
      }),
    );
    conjure(
      ctx,
      'P2',
      oracle({
        name: 'Test Instant',
        typeLine: 'Instant',
        manaCost: '{G}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    addMana(me, [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    const kinds = () =>
      computePriorityOptions(ctx, me).map(
        (option) => (option.payload as PriorityActionPayload).kind,
      );
    expect(kinds()).toEqual(
      expect.arrayContaining(['castSpell', 'activateAbility', 'turnFaceUp', 'activateManaAbility']),
    );
    castFromHand(ctx, 'P1', pinned("Angel's Grace"), new Map(), { W: 1 });
    const stackId = ctx.state.stack.at(-1)!.id;
    expect(kinds()).not.toContain('castSpell');
    expect(kinds()).not.toContain('activateAbility');
    expect(kinds()).toContain('activateManaAbility');
    const option = computePriorityOptions(ctx, me).find(
      (entry) => (entry.payload as PriorityActionPayload).kind === 'turnFaceUp',
    );
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, me, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack.map((entry) => entry.id)).toEqual([stackId]);
    const live = ctx.state.battlefield.find((entry) => entry.id === permanent.id)!;
    expect(live.faceDown).toBe(false);
    expect(computeCharacteristics(ctx, live).power).toBe(4);
    expect(me.manaEntries.map((entry) => entry.symbol)).toEqual(way === 'morph' ? ['C', 'C'] : []);
  },
);
