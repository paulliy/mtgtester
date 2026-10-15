import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import { runPrioritySequence } from '../src/turn/priority';
import { computeCharacteristics } from '../src/effects/continuous';
import { evaluateCondition } from '../src/cards/condition';
import { captureObjectFacts } from '../src/cards/source-identity';
import { queueTriggersForEvent } from '../src/state/objects';
import { playPreparedScenario } from '../src/flow/game';
import {
  bear,
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  mountain,
  oracle,
  plains,
  pump,
  spawn,
  swamp,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/combat-trigger-oracle.json'), 'utf8'),
) as { cards: { card: OracleCard; sha256: string }[] };
const pinned = (name: string) => fixture.cards.find(({ card }) => card.name === name)!.card;
function isCastOf(payload: unknown, objectId: string): boolean {
  const action = payload as PriorityActionPayload | undefined;
  return action?.kind === 'castSpell' && action.objectId === objectId;
}

it('pins the complete Oracle cards used by the combat regressions', () => {
  for (const pin of fixture.cards) {
    expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
  }
});

function pod() {
  const ctx = createGame(gameConfig([0, 1, 2].map(() => ({ cards: copies(24, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('attack qualification and last-known defender regressions', () => {
  it('rejects a full-turn continuation that omits the postcombat main', () => {
    const ctx = pod();
    expect(() =>
      pump(
        playPreparedScenario(ctx, {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          continueThroughCombat: true,
          continueToEndStep: true,
          continueThroughNextTurn: true,
          hand: [],
          battlefield: [],
        }),
      ),
    ).toThrow('postcombat main');
  });
  for (const qualifies of [false, true]) {
    it(`checks emblem attack qualifications only at the event: ${qualifies}`, () => {
      const ctx = pod();
      const attacker = spawn(ctx, 'P1', bear());
      attacker.attacking = 'P2';
      ctx.state.players[1]!.life = qualifies ? 41 : 39;
      ctx.state.players[0]!.emblems.push({
        id: 'combat-qualification-emblem',
        name: 'Combat qualification emblem',
        controllerId: 'P1',
        abilities: [
          {
            kind: 'triggered',
            trigger: {
              when: 'attacks',
              subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
              defendingPlayerIsEventPlayer: true,
              eventCondition: { kind: 'attackingPlayerHasMoreLifeThanYou' },
            },
            targets: [],
            effects: [{ op: 'gainLife', amount: { kind: 'const', n: 5 } }],
          },
        ],
      });
      queueTriggersForEvent(ctx, 'attacks', [{ permanent: attacker, playerId: 'P1' }]);
      expect(ctx.state.pendingTriggers).toHaveLength(qualifies ? 1 : 0);
      if (qualifies) expect(ctx.state.pendingTriggers[0]!.scope?.eventPlayerId).toBe('P2');
      ctx.state.players[1]!.life = qualifies ? 39 : 41;
      pump(runPrioritySequence(ctx));
      expect(ctx.state.players[0]!.life).toBe(qualifies ? 45 : 40);
    });
  }
  for (const countersRemain of [true, false]) {
    it(`keeps the separate intervening-if recheck when counters remain: ${countersRemain}`, () => {
      const ctx = pod();
      const source = spawn(ctx, 'P1', bear());
      source.attacking = 'P2';
      source.counters['+1/+1'] = 1;
      ctx.state.players[1]!.life = 41;
      ctx.defs.set(source.oracleId, {
        ...ctx.defs.get(source.oracleId)!,
        triggers: [
          {
            kind: 'triggered',
            trigger: {
              when: 'attacks',
              subject: { kind: 'self' },
              eventCondition: { kind: 'attackingPlayerHasMoreLifeThanYou' },
              condition: { kind: 'sourceHasCounters', counter: '+1/+1', cmp: '>=', n: 1 },
            },
            targets: [],
            effects: [{ op: 'gainLife', amount: { kind: 'const', n: 7 } }],
          },
        ],
      });
      queueTriggersForEvent(ctx, 'attacks', [{ permanent: source, playerId: 'P1' }]);
      expect(ctx.state.pendingTriggers).toHaveLength(1);
      ctx.state.players[1]!.life = 39;
      if (!countersRemain) source.counters['+1/+1'] = 0;
      pump(runPrioritySequence(ctx));
      expect(ctx.state.players[0]!.life).toBe(countersRemain ? 47 : 40);
    });
  }
  it('uses departure information but rejects self, non-player, and eliminated defenders', () => {
    const ctx = pod();
    const source = spawn(ctx, 'P1', bear());
    const attacker = spawn(ctx, 'P2', oracle({ name: 'Defender information witness' }));
    attacker.attacking = 'P3';
    const facts = captureObjectFacts(ctx, attacker);
    const scope = {
      cardId: source.cardId,
      objectId: source.id,
      controllerId: 'P1',
      triggerObjectCardId: attacker.cardId,
      eventObjectId: attacker.id,
      triggerObjectFacts: facts,
    };
    ctx.state.battlefield = ctx.state.battlefield.filter((p) => p.id !== attacker.id);
    expect(evaluateCondition(ctx, { kind: 'triggerObjectAttackingOpponent' }, scope)).toBe(true);
    for (const defenderId of ['P1', 'missing-player', null]) {
      facts.candidate.attackingDefenderId = defenderId;
      expect(evaluateCondition(ctx, { kind: 'triggerObjectAttackingOpponent' }, scope)).toBe(false);
    }
    facts.candidate.attackingDefenderId = 'P3';
    ctx.state.players[2]!.hasLost = true;
    expect(evaluateCondition(ctx, { kind: 'triggerObjectAttackingOpponent' }, scope)).toBe(false);
  });
  for (const response of [false, true]) {
    it(`Marchesa real-card dethrone ${response ? 'still adds a counter after Bolt changes the life leader' : 'adds a counter without response'}`, () => {
      const ctx = pod();
      ctx.state.players[0]!.life = 20;
      ctx.state.players[1]!.life = 41;
      ctx.state.players[2]!.life = 40;
      const marchesa = spawn(ctx, 'P1', pinned('Marchesa, the Black Rose'));
      const bolt = conjure(ctx, 'P3', pinned('Lightning Bolt'), 'hand');
      spawn(ctx, 'P3', mountain());
      let cast = false;
      ctx.state.phase = 'combat';
      pump(runCombatPhase(ctx), (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, () => 'P2');
        if (
          response &&
          !cast &&
          decision.decisionType === 'priority' &&
          decision.player === 'P3' &&
          ctx.state.step === 'declareAttackers' &&
          ctx.state.stack.some((s) => s.description.includes('Dethrone'))
        ) {
          const index = decision.options.findIndex((o) => isCastOf(o.payload, bolt.id));
          expect(index).toBeGreaterThanOrEqual(0);
          cast = true;
          return { index, targets: new Map([[0, 'P2']]) };
        }
        return { index: 0, targets: new Map() };
      });
      expect(cast).toBe(response);
      const count = marchesa.counters['+1/+1'] ?? 0;
      expect(count).toBe(1);

      expect(ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(false);
    });
  }
  it('Marchesa-granted dethrone resolves after the life leader changes', () => {
    const ctx = pod();
    ctx.state.players[0]!.life = 20;
    ctx.state.players[1]!.life = 41;
    ctx.state.players[2]!.life = 40;
    const marchesa = spawn(ctx, 'P1', pinned('Marchesa, the Black Rose'));
    const ally = spawn(ctx, 'P1', bear());
    const bolt = conjure(ctx, 'P3', pinned('Lightning Bolt'), 'hand');
    spawn(ctx, 'P3', mountain());
    let cast = false;
    ctx.state.phase = 'combat';
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === ally.id ? 'P2' : null));
      if (
        !cast &&
        decision.decisionType === 'priority' &&
        decision.player === 'P3' &&
        ctx.state.step === 'declareAttackers' &&
        ctx.state.stack.length > 0
      ) {
        const index = decision.options.findIndex((o) => isCastOf(o.payload, bolt.id));
        expect(index).toBeGreaterThanOrEqual(0);
        cast = true;
        return { index, targets: new Map([[0, 'P2']]) };
      }
      return { index: 0, targets: new Map() };
    });
    expect(cast).toBe(true);
    expect(marchesa.counters['+1/+1'] ?? 0).toBe(0);
    expect(ally.counters['+1/+1'] ?? 0).toBe(1);
  });
  for (const response of ['none', 'damage-defender', 'kill-Namor'] as const) {
    it(`Namor bonus survives ${response} and affects the correct defender`, () => {
      const ctx = pod();
      ctx.state.players[0]!.life = 40;
      ctx.state.players[1]!.life = 41;
      const attacker = spawn(ctx, 'P1', pinned('Namor, Atlantean King'));
      const ally = spawn(ctx, 'P1', bear());
      expect(interpretCard(pinned('Namor, Atlantean King')).modeled).toBe(true);
      const bolt = conjure(ctx, 'P3', pinned('Lightning Bolt'), 'hand');
      spawn(ctx, 'P3', mountain());
      let cast = false;
      let boundPlayer: string | undefined;
      ctx.state.phase = 'combat';
      pump(runCombatPhase(ctx), (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, () => 'P2');
        const trigger = ctx.state.stack.find((s) => s.sourceCardId === attacker.cardId);
        if (trigger !== undefined) boundPlayer = trigger.triggerScope?.eventPlayerId;
        if (
          response !== 'none' &&
          !cast &&
          decision.decisionType === 'priority' &&
          decision.player === 'P3' &&
          ctx.state.step === 'declareAttackers' &&
          ctx.state.stack.some((s) => s.sourceCardId === attacker.cardId)
        ) {
          const index = decision.options.findIndex((o) => isCastOf(o.payload, bolt.id));
          expect(index).toBeGreaterThanOrEqual(0);
          cast = true;
          return { index, targets: new Map([[0, response === 'kill-Namor' ? attacker.id : 'P2']]) };
        }
        return { index: 0, targets: new Map() };
      });
      expect(cast).toBe(response !== 'none');
      expect(boundPlayer).toBe('P2');

      const damage = ctx.state.eventLog.find(
        (e) =>
          e.type === 'damage' &&
          e.payload['sourceCardId'] === ally.cardId &&
          e.payload['combat'] === true,
      )!.payload['amount'];
      expect(damage).toBe(4);
      expect(ctx.state.eventLog.some((e) => e.type === 'triggerConditionFailed')).toBe(false);
    });
  }
  for (const remove of [false, true]) {
    it(`Scriv Contract ${remove ? 'does not charge life when debtor dies attacking another opponent' : 'pumps debtor attacking another opponent'}`, () => {
      const ctx = pod();
      const debtor = spawn(ctx, 'P2', bear());
      const scriv = conjure(ctx, 'P1', pinned('Scriv, the Obligator'), 'hand');
      for (const basic of [forest, forest, plains, swamp]) spawn(ctx, 'P1', basic());
      const action = computePriorityOptions(ctx, ctx.state.players[0]!).find((o) =>
        isCastOf(o.payload, scriv.id),
      )!;
      expect(action).toBeDefined();
      pump(
        applyPriorityAction(ctx, ctx.state.players[0]!, action.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      pump(runPrioritySequence(ctx), () => ({ index: 0, targets: new Map([[0, debtor.id]]) }));
      const contract = ctx.state.battlefield.find((p) => p.name === 'Contract')!;
      expect(contract.attachedTo).toBe(debtor.id);
      ctx.state.currentTurnPlayer = 'P2';
      ctx.state.activePlayerIndex = 1;
      const before = ctx.state.players[1]!.life;
      const bolt = conjure(ctx, 'P3', pinned('Lightning Bolt'), 'hand');
      spawn(ctx, 'P3', mountain());
      let cast = false;
      ctx.state.phase = 'combat';
      pump(runCombatPhase(ctx), (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, () => 'P3');
        if (
          remove &&
          !cast &&
          decision.decisionType === 'priority' &&
          decision.player === 'P3' &&
          ctx.state.step === 'declareAttackers' &&
          ctx.state.stack.some((s) => s.sourceCardId === contract.cardId)
        ) {
          const index = decision.options.findIndex((o) => isCastOf(o.payload, bolt.id));
          expect(index).toBeGreaterThanOrEqual(0);
          cast = true;
          return { index, targets: new Map([[0, debtor.id]]) };
        }
        return { index: 0, targets: new Map() };
      });
      expect(cast).toBe(remove);
      if (!remove) {
        // The temporary boost is still present at end of combat (it expires at end of turn).
        expect(computeCharacteristics(ctx, debtor).power).toBe(4);
      } else expect(ctx.state.battlefield.some((p) => p.id === debtor.id)).toBe(false);
      const lost = before - ctx.state.players[1]!.life;
      expect(lost).toBe(0);
    });
  }
});
