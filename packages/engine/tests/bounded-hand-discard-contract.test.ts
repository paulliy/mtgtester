import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { allOf, not, ofType } from '../src/cards/selector';
import { activated, manaCost, spell, targetSlots } from '../src/cards/templates';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { cloneContractContext } from './helpers/contract-harness';
import {
  HAND_DISCARD_CAPABILITIES,
  supportsBoundedHandDiscard,
} from '../../../scripts/contracts/bounded-hand-discard';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

const suite = 'independent bounded hand discard composition';

function spellDefinition(): CardDefinition {
  const printed = oracle({
    name: 'Independent bounded hand discard',
    typeLine: 'Sorcery',
    manaCost: '{B}',
    oracleText: 'Synthetic test text; rules are authored directly as IR.',
    power: null,
    toughness: null,
  });
  const definition = structuredClone(interpretCard(printed));
  const opponent = targetSlots({ player: { kind: 'player', controller: 'opponent' } });
  definition.spellAbility = spell({
    targets: opponent.targets,
    effects: [
      {
        op: 'revealHandAndDiscard',
        target: opponent.slot.player,
        filter: allOf(not(ofType('Creature')), not(ofType('Land'))),
      },
    ],
  });
  definition.modeled = true;
  definition.unmodeledReasons = [];
  return definition;
}

function setup(options: { fund?: boolean; targetHand?: 'mixed' | 'creature-land' | 'empty' } = {}) {
  const ctx = createGame(
    gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(8, forest) }))),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 3;
  const p1 = ctx.state.players.find((player) => player.id === 'P1')!;
  const p2 = ctx.state.players.find((player) => player.id === 'P2')!;
  const printed = oracle({
    name: 'Independent bounded hand discard',
    typeLine: 'Sorcery',
    manaCost: '{B}',
    oracleText: 'Synthetic test text; rules are authored directly as IR.',
    power: null,
    toughness: null,
  });
  const spell = conjure(ctx, 'P1', printed, 'hand');
  ctx.defs.set(spell.oracleId, spellDefinition());
  if (options.fund ?? true) addMana(p1, [{ symbol: 'B' }]);

  const targetCards =
    options.targetHand === 'empty'
      ? []
      : options.targetHand === 'creature-land'
        ? [
            oracle({
              name: 'Only Creature',
              typeLine: 'Creature — Soldier',
              manaCost: '{W}',
              power: '2',
              toughness: '2',
            }),
            oracle({
              name: 'Only Land',
              typeLine: 'Basic Land — Forest',
              manaCost: null,
              power: null,
              toughness: null,
            }),
          ]
        : [
            oracle({
              name: 'Excluded Creature',
              typeLine: 'Creature — Soldier',
              manaCost: '{W}',
              power: '2',
              toughness: '2',
            }),
            oracle({
              name: 'Excluded Land',
              typeLine: 'Basic Land — Forest',
              manaCost: null,
              power: null,
              toughness: null,
            }),
            oracle({
              name: 'Eligible Enchantment',
              typeLine: 'Enchantment',
              manaCost: '{1}{W}',
              power: null,
              toughness: null,
            }),
            oracle({
              name: 'Eligible Artifact',
              typeLine: 'Artifact',
              manaCost: '{1}',
              power: null,
              toughness: null,
            }),
          ];
  const hand = targetCards.map((card) => conjure(ctx, 'P2', card, 'hand'));
  return { ctx, p1, p2, spell, hand };
}

function castOption(
  ctx: ReturnType<typeof setup>['ctx'],
  player: ReturnType<typeof setup>['p1'],
  objectId: string,
) {
  return computePriorityOptions(ctx, player).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      option.type === 'castSpell' && payload.kind === 'castSpell' && payload.objectId === objectId
    );
  });
}

function castAtP2(state: ReturnType<typeof setup>): void {
  const option = castOption(state.ctx, state.p1, state.spell.id);
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(state.ctx, state.p1, option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, 'P2']]),
    }),
  );
  expect(state.ctx.state.stack).toHaveLength(1);
}

function expectNoMutationAfterRejectedCast(state: ReturnType<typeof setup>, targetId = 'P2'): void {
  const before = cloneContractContext(state.ctx);
  expect(() =>
    pump(
      applyPriorityAction(
        state.ctx,
        state.p1,
        { kind: 'castSpell', objectId: state.spell.id, fromCommand: false },
        { index: 0, targets: new Map([[0, targetId]]) },
      ),
    ),
  ).toThrow();
  expect(state.ctx.state).toEqual(before.state);
  expect(state.ctx.debugLog).toEqual(before.debugLog);
  expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
}

describe(suite, () => {
  it.each(HAND_DISCARD_CAPABILITIES)('%s: positive', (capability) => {
    const state = setup();
    const definition = state.ctx.defs.get(state.spell.oracleId)!;
    expect(supportsBoundedHandDiscard(definition)).toBe(true);
    expect(deriveCardCapabilities(definition)).toEqual(HAND_DISCARD_CAPABILITIES);
    expect(HAND_DISCARD_CAPABILITIES).toContain(capability);
    const lifeBefore = state.ctx.state.players.map((player) => player.life);
    castAtP2(state);

    let choiceCount = 0;
    const resolution = pump(resolveTopOfStack(state.ctx), (decision) => {
      choiceCount++;
      expect(decision.player).toBe('P1');
      expect(decision.prompt).toContain("P2's revealed hand");
      expect(decision.options.map((option) => option.description)).toEqual([
        'Discard Eligible Enchantment',
        'Discard Eligible Artifact',
      ]);
      return { index: 1, targets: new Map() };
    });

    expect(choiceCount).toBe(1);
    expect(resolution.decisions).toHaveLength(1);
    expect(
      state.ctx.state.eventLog
        .filter((event) => event.type === 'revealCard')
        .map((event) => event.payload['name']),
    ).toEqual(['Excluded Creature', 'Excluded Land', 'Eligible Enchantment', 'Eligible Artifact']);
    expect(state.p2.graveyard.map((card) => card.cardId)).toEqual([state.hand[3]!.cardId]);
    expect(state.p2.hand.map((card) => card.cardId)).toEqual(
      state.hand.slice(0, 3).map((card) => card.cardId),
    );
    expect(state.p1.graveyard.map((card) => card.cardId)).toEqual([state.spell.cardId]);
    expect(state.ctx.state.players.map((player) => player.life)).toEqual(lifeBefore);
    expect(state.ctx.state.stack).toEqual([]);
  });

  it.each(HAND_DISCARD_CAPABILITIES)('%s: negative', (capability) => {
    const state = setup({ targetHand: 'creature-land' });
    expect(HAND_DISCARD_CAPABILITIES).toContain(capability);

    if (capability === 'CardDefinition') {
      const definition = state.ctx.defs.get(state.spell.oracleId)!;
      state.ctx.defs.set(state.spell.oracleId, {
        ...definition,
        modeled: false,
        unmodeledReasons: ['independent unsupported test variant'],
      });
      const before = cloneContractContext(state.ctx);
      expect(() => castOption(state.ctx, state.p1, state.spell.id)).toThrow(/Unmodeled/);
      expectNoMutationAfterRejectedCast(state);
      expect(state.ctx.state).toEqual(before.state);
      return;
    }

    if (capability === 'CardDefinition.manaCost' || capability === 'ParsedManaCost') {
      const unfunded = setup({ fund: false, targetHand: 'creature-land' });
      expect(castOption(unfunded.ctx, unfunded.p1, unfunded.spell.id)).toBeUndefined();
      expectNoMutationAfterRejectedCast(unfunded);
      return;
    }

    if (capability === 'Ability.spell') {
      state.ctx.state.phase = 'combat';
      expect(castOption(state.ctx, state.p1, state.spell.id)).toBeUndefined();
      expectNoMutationAfterRejectedCast(state);
      return;
    }

    if (capability === 'Ability.targets' || capability === 'TargetSpec.player') {
      const option = castOption(state.ctx, state.p1, state.spell.id);
      expect(option?.targets?.[0]?.options).toEqual(['P2', 'P3', 'P4']);
      expectNoMutationAfterRejectedCast(state, 'P1');
      return;
    }

    castAtP2(state);
    const resolution = pump(resolveTopOfStack(state.ctx));
    expect(resolution.decisions).toHaveLength(0);
    expect(
      state.ctx.state.eventLog
        .filter((event) => event.type === 'revealCard')
        .map((event) => event.payload['name']),
    ).toEqual(['Only Creature', 'Only Land']);
    expect(state.p2.hand.map((card) => card.cardId)).toEqual(state.hand.map((card) => card.cardId));
    expect(state.p2.graveyard).toHaveLength(0);
    expect(state.ctx.state.stack).toEqual([]);
  });

  it('resolves an empty target hand without a choice or reveal event', () => {
    const state = setup({ targetHand: 'empty' });
    castAtP2(state);
    const resolution = pump(resolveTopOfStack(state.ctx));
    expect(resolution.decisions).toHaveLength(0);
    expect(state.ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(state.p2.hand).toHaveLength(0);
    expect(state.p2.graveyard).toHaveLength(0);
    expect(state.p1.graveyard.map((card) => card.cardId)).toEqual([state.spell.cardId]);
  });

  it('uses the target hand at resolution, including a card added after casting', () => {
    const state = setup({ targetHand: 'creature-land' });
    castAtP2(state);
    const added = conjure(
      state.ctx,
      'P2',
      oracle({
        name: 'Resolution-time Artifact',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
      'hand',
    );
    const resolution = pump(resolveTopOfStack(state.ctx));
    expect(resolution.decisions).toHaveLength(0); // The sole eligible choice is forced.
    expect(
      state.ctx.state.eventLog
        .filter((event) => event.type === 'revealCard')
        .map((event) => event.payload['name']),
    ).toEqual(['Only Creature', 'Only Land', 'Resolution-time Artifact']);
    expect(state.p2.graveyard.map((card) => card.cardId)).toEqual([added.cardId]);
    expect(state.p2.hand.map((card) => card.cardId)).toEqual(state.hand.map((card) => card.cardId));
  });

  it('rejects nearby out-of-scope definition shapes', () => {
    const base = spellDefinition();
    expect(supportsBoundedHandDiscard(base)).toBe(true);

    const wrongTarget = structuredClone(base);
    wrongTarget.spellAbility!.targets[0] = { kind: 'player' };
    expect(supportsBoundedHandDiscard(wrongTarget)).toBe(false);

    const wrongFilter = structuredClone(base);
    const effect = wrongFilter.spellAbility!.effects[0];
    if (effect?.op === 'revealHandAndDiscard' && effect.filter.kind === 'allOf')
      effect.filter.of[0] = not(ofType('Artifact'));
    expect(supportsBoundedHandDiscard(wrongFilter)).toBe(false);

    const wrongCost = structuredClone(base);
    wrongCost.manaCost = manaCost('{1}{B}');
    expect(supportsBoundedHandDiscard(wrongCost)).toBe(false);

    const extraEffect = structuredClone(base);
    extraEffect.spellAbility!.effects.push({ op: 'draw', count: { kind: 'const', n: 1 } });
    expect(supportsBoundedHandDiscard(extraEffect)).toBe(false);

    const extraAbility = structuredClone(base);
    extraAbility.activatedAbilities.push(activated({ costs: [{ kind: 'tap' }], effects: [] }));
    expect(supportsBoundedHandDiscard(extraAbility)).toBe(false);
  });
});
