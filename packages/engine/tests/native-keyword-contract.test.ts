import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { runCombatPhase } from '../src/combat/combat';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { interpretCard } from '../src/cards/interpret';
import { PRIMITIVE_CONTRACTS } from '../../../scripts/contracts/primitive-contracts';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  keywordCreature,
  pick,
  pump,
  spawn,
} from './fixtures';

/** Independent printed-keyword probes, cast normally before a prepared later combat. */
function setup(keyword: string, blockers: string[] = []) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      {
        seed: `native-keyword-${keyword}-${blockers.join('-')}`,
      },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 2;
  ctx.state.phase = 'precombatMain';
  const player = ctx.state.players[0]!;
  player.life = 35;
  const card = conjure(ctx, 'P1', keywordCreature('Independent attacker', keyword, '{0}'), 'hand');
  const cast = computePriorityOptions(ctx, player).find(
    (option) => (option.payload as { objectId?: string }).objectId === card.id,
  );
  expect(cast).toBeDefined();
  pump(
    applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(player.hand).toHaveLength(0);
  pump(resolveTopOfStack(ctx));
  expect(ctx.state.stack).toHaveLength(0);
  const attacker = ctx.state.battlefield.find((permanent) => permanent.cardId === card.cardId)!;
  expect(attacker).toBeDefined();
  expect(attacker.summoningSick).toBe(true);
  // Prepare the source's next combat, after it has been controlled since turn start.
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  attacker.summoningSick = false;
  const defenders = blockers.map((ability, index) =>
    spawn(ctx, 'P2', keywordCreature(`Independent blocker ${index}`, ability, '{0}', '3/3')),
  );
  return { ctx, player, attacker, defenders };
}

function combat(state: ReturnType<typeof setup>) {
  const { ctx, attacker } = state;
  let rejected = 0;
  const offered: string[] = [];
  pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      return declareAttacks(decision, (id) => (id === attacker.id ? 'P2' : null));
    }
    if (decision.decisionType === 'declareBlockers') {
      const presentation = decision.presentationBlockDeclaration!;
      if (presentation.rejection) rejected++;
      offered.push(...presentation.subjects.map((subject) => subject.subjectId));
      return declareBlocks(decision, () => attacker.id);
    }
    if (decision.decisionType === 'assignCombatDamage') {
      return { index: 0, targets: new Map() };
    }
    return pick(decision, /Pass|does not/);
  });
  for (const id of ['P3', 'P4']) expect(ctx.state.players.find((p) => p.id === id)?.life).toBe(40);
  return { rejected, offered, defenderLife: ctx.state.players[1]!.life };
}

describe('independent printed keyword combat contracts', () => {
  it.each(['flying', 'menace', 'lifelink'])(
    '%s scope accepts only the bounded printed creature',
    (keyword) => {
      const contract = PRIMITIVE_CONTRACTS.find(
        (entry) => entry.capability === `Keyword.${keyword}`,
      )!;
      const definition = interpretCard(keywordCreature('Independent scope probe', keyword, '{0}'));
      expect(contract.supports(definition)).toBe(true);
      const alternatives = [
        { ...definition, keywords: [] },
        { ...definition, keywords: [...definition.keywords, 'vigilance' as const] },
        { ...definition, power: 3 },
        { ...definition, supertypes: ['Legendary'] },
        { ...definition, entersWithCounters: { flying: 1 } },
        { ...definition, spellAbility: { kind: 'spell' as const, targets: [], effects: [] } },
        { ...definition, modeled: false, unmodeledReasons: ['unsupported probe'] },
        interpretCard(keywordCreature('Independent paid probe', keyword, '{1}')),
      ];
      for (const alternative of alternatives) expect(contract.supports(alternative)).toBe(false);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.cases)).toBe(true);
      expect(
        contract.cases
          .filter((entry) => entry.file === 'packages/engine/tests/native-keyword-contract.test.ts')
          .map((entry) => entry.role),
      ).toEqual(['positive', 'negative']);
    },
  );
  it('flying excludes an ordinary ground blocker after a normal cast', () => {
    const state = setup('Flying', ['']);
    const result = combat(state);
    expect(result.offered).not.toContain(state.defenders[0]!.id);
    expect(result.defenderLife).toBe(38);
    expect(state.player.life).toBe(35);
    expect(state.ctx.state.battlefield).toContain(state.attacker);
  });
  it('flying does not exclude a reach blocker after a normal cast', () => {
    const state = setup('Flying', ['Reach']);
    const result = combat(state);
    expect(result.offered).toContain(state.defenders[0]!.id);
    expect(result.rejected).toBe(0);
    expect(result.defenderLife).toBe(40);
    expect(state.player.life).toBe(35);
    expect(state.player.graveyard.some((card) => card.cardId === state.attacker.cardId)).toBe(true);
    expect(state.ctx.state.battlefield).toContain(state.defenders[0]);
  });
  it('menace permits two ordinary blockers after a normal cast', () => {
    const state = setup('Menace', ['', '']);
    const result = combat(state);
    expect(result.offered).toEqual(state.defenders.map((defender) => defender.id));
    expect(result.rejected).toBe(0);
    expect(result.defenderLife).toBe(40);
    expect(state.player.graveyard.some((card) => card.cardId === state.attacker.cardId)).toBe(true);
    expect(state.ctx.state.battlefield).toEqual(expect.arrayContaining(state.defenders));
  });
  it('menace rejects and repairs a lone ordinary blocker after a normal cast', () => {
    const state = setup('Menace', ['']);
    const result = combat(state);
    expect(result.rejected).toBe(1);
    expect(
      state.ctx.state.eventLog.some((event) => event.type === 'blockDeclarationRepaired'),
    ).toBe(true);
    expect(result.defenderLife).toBe(38);
    expect(state.ctx.state.battlefield).toContain(state.attacker);
    expect(state.ctx.state.battlefield).toContain(state.defenders[0]);
  });
  it('lifelink gains life for its controller from unblocked combat damage after a normal cast', () => {
    const state = setup('Lifelink');
    expect(combat(state).defenderLife).toBe(38);
    expect(state.player.life).toBe(37);
    expect(state.ctx.state.battlefield).toContain(state.attacker);
  });
  it('ordinary combat damage without lifelink does not gain life after a normal cast', () => {
    const state = setup('');
    expect(combat(state).defenderLife).toBe(38);
    expect(state.player.life).toBe(35);
    expect(state.ctx.state.battlefield).toContain(state.attacker);
  });
});
