import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import {
  BOUNDED_PR08_CAPABILITIES,
  BOUNDED_PR08_SPELLS,
  matchesBoundedPr08Spell,
} from '../../../scripts/contracts/bounded-pr08-spells';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { addMana } from '../src/mana/pool';
import { playerById } from '../src/state/objects';
import { computeCharacteristics } from '../src/effects/continuous';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import type { EngineCardObject, GameContext } from '../src/state/types';
import type { PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(10, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    phase: 'precombatMain',
    step: null,
    turnNumber: 4,
  });
  return ctx;
}
function syntheticCard(ctx: GameContext, id: string): OracleCard {
  const entry = BOUNDED_PR08_SPELLS.find((x) => x.id === id)!;
  const card = oracle({
    oracleId: entry.definition.oracleId,
    name: entry.definition.name,
    typeLine: entry.definition.typeLine,
    manaCost: entry.manaCost,
    colors: [...entry.colors],
    colorIdentity: [...entry.colors],
    oracleText: '',
  });
  ctx.defs.set(card.oracleId, structuredClone(entry.definition));
  return card;
}
const mana = (id: string): ('C' | 'R' | 'W' | 'U')[] =>
  id === 'mob-rule'
    ? ['C', 'C', 'C', 'C', 'R', 'R']
    : id === 'cut-a-deal'
      ? ['C', 'C', 'W']
      : id === 'reins-of-power'
        ? ['C', 'C', 'U', 'U']
        : id === 'councils-judgment'
          ? ['C', 'W', 'W']
          : ['C', 'C', 'C', 'W'];
function settle(ctx: GameContext) {
  return pump(runPrioritySequence(ctx), (d: PendingDecision) => ({
    index: Math.max(
      0,
      d.options.findIndex((o) => o.type === 'pass'),
    ),
    targets: new Map(),
  }));
}
function optionFor(ctx: GameContext, cardId: string, mode?: number) {
  return computePriorityOptions(ctx, playerById(ctx, 'P1')).find((o) => {
    const p = o.payload as PriorityActionPayload;
    return (
      p.kind === 'castSpell' &&
      p.objectId === cardId &&
      (mode === undefined || p.mode === mode || p.modes?.[0] === mode)
    );
  });
}
function cast(ctx: GameContext, card: EngineCardObject, mode?: number, target?: string) {
  addMana(
    playerById(ctx, 'P1'),
    mana(BOUNDED_PR08_SPELLS.find((x) => x.definition.oracleId === card.oracleId)!.id).map(
      (symbol) => ({ symbol }),
    ),
  );
  const option = optionFor(ctx, card.id, mode);
  expect(option).toBeDefined();
  const targets = target === undefined ? new Map<number, string>() : new Map([[0, target]]);
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  settle(ctx);
}

describe('bounded PR08 spell normal casts', () => {
  it('mob-rule — funded synthetic spell resolves through a real cast', () => {
    const ctx = pod('bounded-mob-rule');
    const card = syntheticCard(ctx, 'mob-rule');
    const large = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Large synthetic witness',
        typeLine: 'Creature — Bear',
        power: '4',
        toughness: '5',
      }),
    );
    large.tapped = true;
    const small = spawn(
      ctx,
      'P3',
      oracle({
        name: 'Small synthetic witness',
        typeLine: 'Creature — Bear',
        power: '2',
        toughness: '5',
      }),
    );
    addMana(
      playerById(ctx, 'P1'),
      mana('mob-rule').map((symbol) => ({ symbol })),
    );
    const hand = conjure(ctx, 'P1', card, 'hand');
    const option = optionFor(ctx, hand.id, 0);
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    expect(large.controllerId).toBe('P1');
    expect(large.tapped).toBe(false);
    expect(computeCharacteristics(ctx, large).keywords).toContain('haste');
    expect(small.controllerId).toBe('P3');
  });
  it('cut-a-deal — funded synthetic spell resolves through a real cast', () => {
    const ctx = pod('bounded-cut-a-deal');
    const card = syntheticCard(ctx, 'cut-a-deal');
    const hand = conjure(ctx, 'P1', card, 'hand');
    cast(ctx, hand);
    expect(playerById(ctx, 'P1').hand).toHaveLength(3);
    for (const id of ['P2', 'P3', 'P4']) expect(playerById(ctx, id).hand).toHaveLength(1);
    expect(playerById(ctx, 'P1').graveyard.some((o) => o.cardId === hand.cardId)).toBe(true);
  });
  it('reins-of-power — funded synthetic spell resolves through a real cast', () => {
    const ctx = pod('bounded-reins');
    const card = syntheticCard(ctx, 'reins-of-power');
    const own = spawn(
      ctx,
      'P1',
      oracle({ name: 'Own creature', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    const other = spawn(
      ctx,
      'P2',
      oracle({ name: 'Other creature', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    const bystander = spawn(
      ctx,
      'P3',
      oracle({
        name: 'Bystander creature',
        typeLine: 'Creature — Bear',
        power: '2',
        toughness: '2',
      }),
    );
    const hand = conjure(ctx, 'P1', card, 'hand');
    cast(ctx, hand, undefined, 'P2');
    expect(own.controllerId).toBe('P2');
    expect(other.controllerId).toBe('P1');
    expect(bystander.controllerId).toBe('P3');
  });
  it('councils-judgment — funded synthetic spell resolves through a real cast', () => {
    const ctx = pod('bounded-council');
    const card = syntheticCard(ctx, 'councils-judgment');
    const artifact = spawn(ctx, 'P2', oracle({ name: 'Ballot artifact', typeLine: 'Artifact' }));
    const creature = spawn(
      ctx,
      'P3',
      oracle({ name: 'Ballot creature', typeLine: 'Creature — Bear' }),
    );
    const hand = conjure(ctx, 'P1', card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      mana('councils-judgment').map((symbol) => ({ symbol })),
    );
    const opt = optionFor(ctx, hand.id);
    expect(opt).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), opt!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    expect(ctx.state.battlefield).not.toContain(artifact);
    expect(ctx.state.battlefield).toContain(creature);
    expect(ctx.state.exile.some((o) => o.cardId === artifact.cardId)).toBe(true);
  });
  it('benevolent-offering — funded synthetic spell resolves through a real cast', () => {
    const ctx = pod('bounded-offering');
    const card = syntheticCard(ctx, 'benevolent-offering');
    spawn(ctx, 'P1', oracle({ name: 'Caster body', typeLine: 'Creature — Bear' }));
    spawn(ctx, 'P2', oracle({ name: 'Chosen body', typeLine: 'Creature — Bear' }));
    const hand = conjure(ctx, 'P1', card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      mana('benevolent-offering').map((symbol) => ({ symbol })),
    );
    const opt = optionFor(ctx, hand.id);
    expect(opt).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), opt!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    const spirits = ctx.state.battlefield.filter((p) => p.isToken);
    expect(spirits).toHaveLength(6);
    expect(spirits.filter((p) => p.ownerId === 'P1')).toHaveLength(3);
    expect(spirits.filter((p) => p.ownerId === 'P2')).toHaveLength(3);
    expect(playerById(ctx, 'P1').life).toBe(48);
    expect(playerById(ctx, 'P2').life).toBe(48);
  });
  it.each(BOUNDED_PR08_SPELLS.map((x) => x.id))(
    '%s — unfunded normal cast is absent and state is unchanged',
    (id) => {
      const ctx = pod(`bounded-unfunded-${id}`);
      const card = syntheticCard(ctx, id);
      const hand = conjure(ctx, 'P1', card, 'hand');
      const before = structuredClone(ctx.state);
      expect(optionFor(ctx, hand.id)).toBeUndefined();
      expect(ctx.state).toEqual(before);
    },
  );
});

describe('bounded PR08 exact composition support', () => {
  for (const capability of BOUNDED_PR08_CAPABILITIES) {
    it(`${capability}: positive exact bounded definition`, () => {
      const candidates = BOUNDED_PR08_SPELLS.filter((entry) =>
        deriveCardCapabilities(entry.definition).includes(capability),
      );
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((entry) => matchesBoundedPr08Spell(entry.definition))).toBe(true);
    });
    it(`${capability}: negative extra executable instruction is out of scope`, () => {
      const entry = BOUNDED_PR08_SPELLS.find((candidate) =>
        deriveCardCapabilities(candidate.definition).includes(capability),
      )!;
      const changed = structuredClone(entry.definition);
      if (changed.spellAbility!.modes)
        changed.spellAbility!.modes.options[0]!.effects.push({
          op: 'gainLife',
          amount: { kind: 'const', n: 1 },
        });
      else changed.spellAbility!.effects.push({ op: 'gainLife', amount: { kind: 'const', n: 1 } });
      expect(matchesBoundedPr08Spell(changed)).toBe(false);
    });
  }
  it('nested token names are executable definition fields and remain exact', () => {
    const changed = structuredClone(
      BOUNDED_PR08_SPELLS.find((entry) => entry.id === 'benevolent-offering')!.definition,
    );
    const effect = changed.spellAbility!.effects[0]!;
    if (effect.op !== 'shareTokensWithChosenOpponent')
      throw new Error('expected shared token effect');
    effect.spec = { ...effect.spec, name: 'Renamed token' };
    expect(matchesBoundedPr08Spell(changed)).toBe(false);
  });
});

describe('bounded PR08 capability-specific normal cast evidence', () => {
  for (const entry of BOUNDED_PR08_SPELLS) {
    const capabilities = deriveCardCapabilities(entry.definition);
    for (const capability of capabilities) {
      it(`${capability} / ${entry.id}: funded synthetic spell resolves through a real cast`, () => {
        const ctx = pod(`registered-funded-${capability}-${entry.id}`);
        const card = syntheticCard(ctx, entry.id);
        const hand = conjure(ctx, 'P1', card, 'hand');
        addMana(
          playerById(ctx, 'P1'),
          mana(entry.id).map((symbol) => ({ symbol })),
        );
        const chosen = entry.id === 'mob-rule' ? 0 : undefined;
        const option = optionFor(ctx, hand.id, chosen);
        expect(option).toBeDefined();
        const targets =
          entry.id === 'reins-of-power' ? new Map([[0, 'P2']]) : new Map<number, string>();
        pump(
          applyPriorityAction(
            ctx,
            playerById(ctx, 'P1'),
            option!.payload as PriorityActionPayload,
            { index: 0, targets },
          ),
        );
        settle(ctx);
        expect(
          playerById(ctx, 'P1').graveyard.some((object) => object.cardId === hand.cardId),
        ).toBe(true);
      });
      it(`${capability} / ${entry.id}: unfunded normal cast is absent`, () => {
        const ctx = pod(`registered-unfunded-${capability}-${entry.id}`);
        const card = syntheticCard(ctx, entry.id);
        const hand = conjure(ctx, 'P1', card, 'hand');
        expect(optionFor(ctx, hand.id, entry.id === 'mob-rule' ? 0 : undefined)).toBeUndefined();
        expect(playerById(ctx, 'P1').hand).toContain(hand);
      });
    }
  }
});
