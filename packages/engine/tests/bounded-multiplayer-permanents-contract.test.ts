import { describe, expect, it } from 'vitest';
import {
  boundedMultiplayerPermanent,
  MULTIPLAYER_PERMANENT_KINDS,
  supportsBoundedMultiplayerPermanent,
  type MultiplayerPermanentKind,
} from '../../../scripts/contracts/bounded-multiplayer-permanents';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { runCombatPhase } from '../src/combat/combat';
import type { PendingDecision, DecisionOutcome } from '../src/decisions';
import { dealDamageToPlayer } from '../src/effects/resolve';
import { phaseOutControlledPermanents } from '../src/state/phasing';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { createToken, moveObject, playerById } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import { canBeSacrificed } from '../src/state/queries';
import { runPrioritySequence } from '../src/turn/priority';
import { SURVIVOR_1_1_RED } from '../src/cards/tokens';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

function setup(kind: MultiplayerPermanentKind, funded = true) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: `independent-${kind}` },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  const definition = boundedMultiplayerPermanent(kind);
  const card = conjure(
    ctx,
    'P1',
    oracle({
      oracleId: definition.oracleId,
      name: definition.name,
      typeLine: definition.typeLine,
      manaCost: kind === 'channel-land' ? null : '{R}',
    }),
    'hand',
  );
  registerCustomDef(ctx, definition);
  if (funded && definition.manaCost) {
    const cost = definition.manaCost;
    addMana(playerById(ctx, 'P1'), [
      ...Object.entries(cost.colored).flatMap(([symbol, n]) =>
        Array.from({ length: n }, () => ({ symbol: symbol as 'W' | 'U' | 'B' | 'R' | 'G' })),
      ),
      ...Array.from({ length: cost.generic }, () => ({ symbol: 'C' as const })),
    ]);
  }
  const options = () =>
    computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        (payload.kind === 'castSpell' || payload.kind === 'playLand') &&
        payload.objectId === card.id
      );
    });
  const cast = () => {
    const option = options()[0]!;
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(runPrioritySequence(ctx));
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId)!;
    expect(permanent).toBeDefined();
    return permanent;
  };
  return { ctx, definition, card, options, cast };
}
function pass(decision: PendingDecision): DecisionOutcome {
  return {
    index: Math.max(
      0,
      decision.options.findIndex((option) => option.type === 'pass'),
    ),
    targets: new Map(),
  };
}
function resolveModes(
  ctx: ReturnType<typeof setup>['ctx'],
  wanted: string[],
  destinations: Record<number, string>,
) {
  const seen: string[] = [];
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.prompt.toLowerCase().includes('choose modes')) {
      const index = decision.options.findIndex(
        (option) =>
          option.description.split('; ').length === wanted.length &&
          wanted.every((label) => option.description.includes(label)),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    }
    if (decision.decisionType === 'chooseTargets') {
      const slot = decision.options[0]!.targets![0]!;
      expect(slot.options).toContain(destinations[slot.slot]);
      expect(slot.options.some((option) => seen.includes(option))).toBe(false);
      seen.push(destinations[slot.slot]!);
      return { index: 0, targets: new Map([[slot.slot, destinations[slot.slot]!]]) };
    }
    return pass(decision);
  });
}

function contractIt(title: string, run: () => void) {
  const kind = title.split(':')[0] as MultiplayerPermanentKind;
  for (const capability of deriveCardCapabilities(boundedMultiplayerPermanent(kind)))
    it(`${capability} / ${title}`, run);
}

describe('independent bounded multiplayer permanent compositions', () => {
  contractIt('channel-land: positive', () => {
    const { ctx, card, definition, cast } = setup('channel-land');
    expect(supportsBoundedMultiplayerPermanent(definition)).toBe(true);
    const land = cast();
    expect(land.tapped).toBe(false);
    const green = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent green witness',
        typeLine: 'Sorcery',
        manaCost: '{G}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (option) =>
        (option.payload as PriorityActionPayload).kind === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === green.id,
    )!;
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(runPrioritySequence(ctx));
    expect(land.tapped).toBe(true);
    expect(playerById(ctx, 'P1').life).toBe(41);
    const second = conjure(
      ctx,
      'P1',
      oracle({
        oracleId: card.oracleId,
        name: definition.name,
        typeLine: 'Legendary Land',
        manaCost: null,
      }),
      'hand',
    );
    spawn(
      ctx,
      'P1',
      oracle({ name: 'Independent legendary discount', typeLine: 'Legendary Creature — Bear' }),
    );
    const target = spawn(
      ctx,
      'P2',
      oracle({ name: 'Independent channel target', typeLine: 'Artifact' }),
    );
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    const channel = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
      const p = option.payload as PriorityActionPayload;
      return p.kind === 'activateAbility' && p.objectId === second.id;
    })!;
    expect(channel).toBeDefined();
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), channel.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, target.id]]),
      }),
    );
    pump(runPrioritySequence(ctx));
    expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === second.cardId)).toBe(
      true,
    );
    expect(playerById(ctx, 'P2').graveyard.some((entry) => entry.cardId === target.cardId)).toBe(
      true,
    );
    expect(
      ctx.state.battlefield.some(
        (entry) => entry.controllerId === 'P2' && entry.name === 'Forest' && !entry.tapped,
      ),
    ).toBe(true);
  });
  contractIt('distinct-combat: positive', () => {
    for (const selected of [
      ['make token', 'draw lose'],
      ['draw lose', 'counters'],
    ]) {
      const { ctx, cast } = setup('distinct-combat');
      const source = cast();
      const other = spawn(ctx, 'P3', oracle({ name: 'Independent counter recipient' }));
      ctx.state.phase = 'combat';
      ctx.state.step = 'beginCombat';
      queueStepTriggers(ctx, 'beginningOfCombat');
      resolveModes(ctx, selected, { 0: 'P1', 1: 'P2', 2: 'P3' });
      expect(playerById(ctx, 'P2').life).toBe(39);
      expect(playerById(ctx, 'P2').hand).toHaveLength(1);
      if (selected.includes('make token'))
        expect(
          ctx.state.battlefield.some(
            (entry) => entry.controllerId === 'P1' && entry.name === 'Inkling',
          ),
        ).toBe(true);
      else expect(other.counters['+1/+1']).toBe(1);
      expect(computeCharacteristics(ctx, source).keywords).toEqual(['flying', 'double strike']);
    }
    const { ctx, cast } = setup('distinct-combat');
    const source = cast();
    source.summoningSick = false;
    const ground = spawn(
      ctx,
      'P2',
      oracle({ name: 'Independent ground blocker', power: '8', toughness: '8' }),
    );
    pump(runCombatPhase(ctx), (decision) =>
      decision.decisionType === 'declareAttackers'
        ? declareAttacks(decision, (id) => (id === source.id ? 'P2' : null))
        : decision.decisionType === 'declareBlockers'
          ? (() => {
              expect(
                decision.presentationBlockDeclaration!.subjects.map((subject) => subject.subjectId),
              ).not.toContain(ground.id);
              return declareBlocks(decision, () => null);
            })()
          : pass(decision),
    );
    expect(playerById(ctx, 'P2').life).toBe(36);
  });
  contractIt('distinct-death: positive', () => {
    const { ctx, cast } = setup('distinct-death');
    const source = cast();
    const victim = spawn(ctx, 'P2', oracle({ name: 'Independent sacrifice recipient' }));
    for (let n = 0; n < 2; n++) conjure(ctx, 'P3', forest(), 'hand');
    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    resolveModes(ctx, ['sacrifice', 'discard', 'lose'], { 0: 'P2', 1: 'P3', 2: 'P4' });
    expect(ctx.state.battlefield).not.toContain(victim);
    expect(playerById(ctx, 'P3').hand).toHaveLength(0);
    expect(playerById(ctx, 'P4').life).toBe(35);
  });
  contractIt('upkeep-rotation: positive', () => {
    const { ctx, cast } = setup('upkeep-rotation');
    const source = cast();
    source.tapped = true;
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx));
    expect(source.controllerId).toBe('P2');
    expect(source.tapped).toBe(false);
    expect(source.counters['+1/+1']).toBe(1);
    expect(computeCharacteristics(ctx, source).keywords).toContain('haste');
    expect(canBeSacrificed(ctx, source)).toBe(false);
    pump(moveObject(ctx, source, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(ctx.state.battlefield).toContain(source);
    const blocker = spawn(
      ctx,
      'P3',
      oracle({ name: 'Independent trample blocker', power: '1', toughness: '1' }),
    );
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id, subject) => {
          if (id !== source.id) return null;
          expect(subject.mustAttack).toBe(true);
          expect(subject.defenders.map((player) => player.playerId)).not.toContain('P1');
          return 'P3';
        });
      if (decision.decisionType === 'declareBlockers')
        return declareBlocks(decision, (id) => (id === blocker.id ? source.id : null));
      if (decision.decisionType === 'assignCombatDamage')
        return { index: 0, targets: new Map(), combatDamageSplit: { [blocker.id]: 1, P3: 4 } };
      return pass(decision);
    });
    expect(playerById(ctx, 'P3').life).toBe(36);
  });
  contractIt('survivor-rules: positive', () => {
    const { ctx, cast } = setup('survivor-rules');
    const source = cast();
    source.summoningSick = false;
    const original = createToken(ctx, SURVIVOR_1_1_RED, 'P2');
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === source.id ? 'P2' : null));
      if (decision.decisionType === 'declareBlockers') {
        expect(
          decision.presentationBlockDeclaration!.subjects.map((subject) => subject.subjectId),
        ).not.toContain(original.id);
        return declareBlocks(decision, () => null);
      }
      return pass(decision);
    });
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(
      ctx.state.battlefield.filter((entry) => entry.isToken && entry.name === 'Survivor'),
    ).toHaveLength(4);
    pump(moveObject(ctx, source, { zone: 'hand' }));
    pump(runPrioritySequence(ctx));
    expect(
      ctx.state.battlefield
        .filter((entry) => entry.isToken && entry.name === 'Survivor')
        .every((entry) => entry.controllerId === 'P1'),
    ).toBe(true);
  });
  for (const kind of MULTIPLAYER_PERMANENT_KINDS) {
    contractIt(`${kind}: negative`, () => {
      const { ctx, definition, card, options, cast } = setup(kind, false);
      const extended = structuredClone(definition);
      extended.ruleStatics.push({ kind: 'cantBeCountered' });
      expect(supportsBoundedMultiplayerPermanent(extended)).toBe(false);
      const before = cloneContractContext(ctx);
      if (kind !== 'channel-land') {
        expect(options()).toEqual([]);
        expect(ctx.state).toEqual(before.state);
        const funded = setup(kind, true);
        const source = funded.cast();
        if (kind === 'distinct-combat') {
          funded.ctx.state.phase = 'combat';
          funded.ctx.state.step = 'beginCombat';
          queueStepTriggers(funded.ctx, 'beginningOfCombat');
          pump(runPrioritySequence(funded.ctx), (decision) => {
            if (decision.prompt.toLowerCase().includes('choose modes')) {
              expect(decision.options[0]!.description).toBe('Choose no modes');
              return { index: 0, targets: new Map() };
            }
            return pass(decision);
          });
          expect(funded.ctx.state.battlefield).toHaveLength(1);
          expect(playerById(funded.ctx, 'P2').hand).toHaveLength(0);
          funded.ctx.state.currentTurnPlayer = 'P2';
          funded.ctx.state.activePlayerIndex = 1;
          queueStepTriggers(funded.ctx, 'beginningOfCombat');
          expect(funded.ctx.state.pendingTriggers).toHaveLength(0);
        } else if (kind === 'distinct-death') {
          pump(moveObject(funded.ctx, source, { zone: 'hand' }));
          expect(funded.ctx.state.pendingTriggers).toHaveLength(0);
          const death = setup(kind, true);
          const watcher = death.cast();
          death.ctx.state.playerHexproofTurn = { P3: 4, P4: 4 };
          pump(moveObject(death.ctx, watcher, { zone: 'graveyard' }));
          pump(runPrioritySequence(death.ctx), (decision) => {
            if (decision.prompt.toLowerCase().includes('choose modes')) {
              expect(decision.options).toHaveLength(3);
              expect(decision.options.every((option) => !option.description.includes(';'))).toBe(
                true,
              );
              return {
                index: decision.options.findIndex((option) => option.description === 'lose'),
                targets: new Map(),
              };
            }
            return pass(decision);
          });
          expect(playerById(death.ctx, 'P2').life).toBe(35);
        } else if (kind === 'upkeep-rotation') {
          funded.ctx.state.currentTurnPlayer = 'P2';
          funded.ctx.state.activePlayerIndex = 1;
          queueStepTriggers(funded.ctx, 'upkeep');
          const exiled = pump(moveObject(funded.ctx, source, { zone: 'exile' })).value!;
          const returned = pump(moveObject(funded.ctx, exiled, { zone: 'battlefield' })).value!;
          pump(runPrioritySequence(funded.ctx));
          expect('controllerId' in returned && returned.controllerId).toBe('P1');
          expect('counters' in returned && returned.counters['+1/+1']).toBeUndefined();
        } else {
          pump(
            dealDamageToPlayer(
              funded.ctx,
              {
                id: source.id,
                cardId: source.cardId,
                oracleId: source.oracleId,
                name: source.name,
                controllerId: 'P1',
              },
              playerById(funded.ctx, 'P2'),
              2,
              { combat: false, sourceIsCommander: false, sourceHasLifelink: false },
            ),
          );
          pump(runPrioritySequence(funded.ctx));
          expect(funded.ctx.state.battlefield).toHaveLength(1);
          const survivor = createToken(funded.ctx, SURVIVOR_1_1_RED, 'P2');
          survivor.summoningSick = false;
          phaseOutControlledPermanents(funded.ctx, 'P1');
          funded.ctx.state.currentTurnPlayer = 'P2';
          funded.ctx.state.activePlayerIndex = 1;
          pump(runCombatPhase(funded.ctx), (decision) =>
            decision.decisionType === 'declareAttackers'
              ? declareAttacks(decision, (_id, subject) => {
                  expect(subject.defenders.map((player) => player.playerId)).toContain('P1');
                  return 'P1';
                })
              : pass(decision),
          );
          expect(playerById(funded.ctx, 'P1').life).toBe(39);
        }
        return;
      }
      // Lands need no mana to play, but their channel activation does and the colored pip stays.
      spawn(
        ctx,
        'P2',
        oracle({ name: 'Independent illegal basic target', typeLine: 'Basic Land — Forest' }),
      );
      addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
      expect(
        computePriorityOptions(ctx, playerById(ctx, 'P1')).some((option) => {
          const p = option.payload as PriorityActionPayload;
          return p.kind === 'activateAbility' && p.objectId === card.id;
        }),
      ).toBe(false);
      const land = cast();
      expect(land.tapped).toBe(false);
    });
  }
});
