import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import {
  playerById,
  moveObject,
  createToken,
  movePermanentsToGraveyard,
} from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import type { GameContext } from '../src/state/types';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  pump,
  declareAttacks,
  declareBlocks,
  oracle,
  spawn,
} from './fixtures';
import { SURVIVOR_1_1_RED } from '../src/cards/tokens';
import { ofType } from '../src/cards/selector';
import { interpretCard } from '../src/cards/interpret';
import { constant } from '../src/cards/value';
import { manaSourcesFor } from '../src/state/queries';
import { registerCustomDef } from './fixtures';
import { dealDamageToPlayer, permanentSource } from '../src/effects/resolve';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards;
const alexiosPin = pins.find((p) => p.card.name === 'Alexios, Deimos of Kosmos')!;
const varchildPin = pins.find((p) => p.card.name === 'Varchild, Betrayer of Kjeldor')!;
const dread = (
  JSON.parse(
    readFileSync('packages/engine/tests/fixtures/marchesa-batch1-oracle.json', 'utf8'),
  ) as { cards: { card: OracleCard }[] }
).cards.find((p) => p.card.name === 'Dread Return')!.card;
const szerasPin = (
  JSON.parse(
    readFileSync('packages/engine/tests/fixtures/marchesa-batch1-oracle.json', 'utf8'),
  ) as { cards: { card: OracleCard }[] }
).cards.find((p) => p.card.name === 'Illuminor Szeras')!.card;
function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 5,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}
function settle(ctx: GameContext) {
  return pump(runPrioritySequence(ctx), (d) => ({
    index: Math.max(
      0,
      d.options.findIndex((o) => o.type === 'pass'),
    ),
    targets: new Map(),
  }));
}
function cast(ctx: GameContext, who: string, card: OracleCard, mana: ('R' | 'C')[]) {
  const hand = conjure(ctx, who, card, 'hand');
  addMana(
    playerById(ctx, who),
    mana.map((symbol) => ({ symbol })),
  );
  const option = computePriorityOptions(ctx, playerById(ctx, who)).find(
    (o) =>
      (o.payload as PriorityActionPayload).kind === 'castSpell' &&
      (o.payload as { objectId?: string }).objectId === hand.id,
  );
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, who), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  settle(ctx);
  return ctx.state.battlefield.find((p) => p.cardId === hand.cardId)!;
}
function answer(d: PendingDecision): DecisionOutcome {
  return {
    index: Math.max(
      0,
      d.options.findIndex((o) => o.type === 'pass'),
    ),
    targets: new Map(),
  };
}

describe('PR08 Alexios and Varchild', () => {
  it('pr08-alexios-varchild-01 — pinned definitions and real casts', () => {
    expect(alexiosPin.sha256).toBe(
      'e32a494aba692a9dd95ad02e77a8f9a27744e1a0ed3bb7896c03f7691ca5c171',
    );
    const actx = pod('alexios-cast');
    const a = cast(actx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    expect(computeCharacteristics(actx, a).keywords).toContain('trample');
    const v = cast(pod('varchild-cast'), 'P1', varchildPin.card, ['C', 'C', 'R']);
    expect(v.name).toBe('Varchild, Betrayer of Kjeldor');
  });

  it('pr08-alexios-varchild-02 — upkeep rotates control, untaps, and adds active player counter', () => {
    const ctx = pod('alexios-upkeep');
    const alexios = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    alexios.tapped = true;
    let permanentRecords = alexios.controlChanges?.length ?? 0;
    for (const [index, who] of ['P1', 'P2', 'P3'].entries()) {
      ctx.state.currentTurnPlayer = who;
      ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(who);
      ctx.state.step = 'upkeep';
      queueStepTriggers(ctx, 'upkeep');
      settle(ctx);
      expect(alexios.controllerId).toBe(who);
      expect(alexios.tapped).toBe(false);
      expect(alexios.counters['+1/+1']).toBe(index + 1);
      expect(alexios.controlChanges?.at(-1)?.duration.kind).toBe('permanent');
      expect(alexios.controlChanges?.length).toBe(permanentRecords + 1);
      permanentRecords++;
      expect(computeCharacteristics(ctx, alexios).keywords).toContain('haste');
    }
  });

  it('pr08-alexios-varchild-03 — Alexios resists single sacrifice', () => {
    const ctx = pod('alexios-sacrifice');
    const a = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    pump(moveObject(ctx, a, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(ctx.state.battlefield).toContain(a);
    expect(ctx.state.eventLog.some((e) => e.type === 'sacrifice')).toBe(false);
  });

  it('pr08-alexios-varchild-04 — Alexios is filtered from batch sacrifice', () => {
    const ctx = pod('alexios-batch');
    const a = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    const victim = spawn(
      ctx,
      'P1',
      oracle({ name: 'Batch Victim', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    pump(movePermanentsToGraveyard(ctx, [a, victim], 'sacrifice'));
    expect(ctx.state.battlefield).toContain(a);
    expect(ctx.state.battlefield).not.toContain(victim);
  });

  it('pr08-alexios-varchild-05 — Alexios is excluded from sacrifice costs', () => {
    const ctx = pod('alexios-cost');
    const a = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    const spell = conjure(ctx, 'P1', dread, 'graveyard');
    const target = conjure(
      ctx,
      'P1',
      oracle({ name: 'Cost Target', typeLine: 'Creature — Bear' }),
      'graveyard',
    );
    spawn(ctx, 'P1', oracle({ name: 'Cost Fodder A', typeLine: 'Creature — Bear' }));
    spawn(ctx, 'P1', oracle({ name: 'Cost Fodder B', typeLine: 'Creature — Bear' }));
    const offered = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (o) =>
          (o.payload as PriorityActionPayload).kind === 'castSpell' &&
          (o.payload as { objectId?: string }).objectId === spell.id,
      );
    expect(offered()).toBe(false);
    spawn(ctx, 'P1', oracle({ name: 'Cost Fodder C', typeLine: 'Creature — Bear' }));
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (o) =>
        (o.payload as PriorityActionPayload).kind === 'castSpell' &&
        (o.payload as { objectId?: string }).objectId === spell.id,
    )!;
    const prompts: string[] = [];
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, target.id]]),
      }),
      (d) => {
        prompts.push(d.options.map((o) => o.description).join('|'));
        return {
          index: Math.max(
            0,
            d.options.findIndex((o) => o.type === 'pass'),
          ),
          targets: new Map(),
        };
      },
    );
    expect(prompts.join('\n')).not.toContain(a.id);
    expect(ctx.state.battlefield).toContain(a);
  });

  it('pr08-alexios-varchild-16 — Alexios cannot pay activated costs or appear as mana-payment sacrifice', () => {
    const ctx = pod('alexios-activated-cost');
    const a = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    const artifact = oracle({
      name: 'Sacrifice Activator',
      oracleId: 'test-alexios-sacrifice-activator',
      typeLine: 'Artifact',
    });
    const def = interpretCard(artifact);
    def.activatedAbilities = [
      {
        costs: [
          {
            kind: 'sacrificeOther',
            selector: {
              kind: 'allOf',
              of: [ofType('Creature'), { kind: 'controller', who: 'you' }],
            },
          },
        ],
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'gainLife', amount: constant(1) }],
        },
        timing: 'any',
      },
    ];
    registerCustomDef(ctx, def);
    const source = spawn(ctx, 'P1', artifact);
    const available = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some((o) => {
        const p = o.payload as { kind?: string; objectId?: string };
        return p.kind === 'activateAbility' && p.objectId === source.id;
      });
    expect(available()).toBe(false);
    const fodder = spawn(
      ctx,
      'P1',
      oracle({ name: 'Activator Fodder', typeLine: 'Creature — Bear' }),
    );
    expect(available()).toBe(true);
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((o) => {
      const p = o.payload as { kind?: string; objectId?: string };
      return p.kind === 'activateAbility' && p.objectId === source.id;
    })!;
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.battlefield).toContain(a);
    expect(ctx.state.battlefield).not.toContain(fodder);
    const manaSource = spawn(ctx, 'P1', szerasPin);
    const candidates = manaSourcesFor(ctx, 'P1').filter((s) => s.cardId === manaSource.cardId);
    expect(candidates.flatMap((s) => s.sacrifices ?? []).flat()).not.toContain(a.cardId);
  });

  it('pr08-alexios-varchild-06 — queued upkeep trigger does not affect blinked incarnation', () => {
    const ctx = pod('alexios-blink');
    const old = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    const moved = pump(moveObject(ctx, old, { zone: 'graveyard' })).value;
    if (moved === null || moved.zone !== 'graveyard')
      throw new Error('Alexios did not reach the graveyard');
    const entered = pump(moveObject(ctx, moved, { zone: 'battlefield', controllerId: 'P1' })).value;
    if (entered === null || entered.zone !== 'battlefield' || !('counters' in entered))
      throw new Error('Alexios did not return as a permanent');
    const fresh = entered;
    expect(fresh.id).not.toBe(old.id);
    settle(ctx);
    expect(fresh.controllerId).toBe('P1');
    expect(fresh.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('pr08-alexios-varchild-07 — owner player is illegal but owner planeswalker is legal', () => {
    const ctx = pod('alexios-defender');
    const a = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    const walker = spawn(
      ctx,
      'P1',
      oracle({ name: 'Owner Walker', typeLine: 'Planeswalker — Test', loyalty: '5' }),
    );
    a.summoningSick = false;
    a.controllerId = 'P2';
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'combat';
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const subject = d.presentationAttackDeclaration!.subjects.find(
          (s) => s.subjectId === a.id,
        )!;
        expect(subject.mustAttack).toBe(true);
        expect(subject.defenders.map((x) => x.playerId)).not.toContain('P1');
        expect(subject.planeswalkers.length).toBeGreaterThan(0);
        return declareAttacks(d, (id) => (id === a.id ? subject.planeswalkers[0]!.objectId : null));
      }
      return answer(d);
    });
    expect(walker.counters['loyalty']).toBeLessThan(5);
  });

  it('pr08-alexios-varchild-08 — opponent Survivor cannot block but own Survivor can', () => {
    const ctx = pod('varchild-block');
    cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    const hostile = createToken(ctx, SURVIVOR_1_1_RED, 'P2');
    const friendly = createToken(ctx, SURVIVOR_1_1_RED, 'P1');
    const attacker = spawn(
      ctx,
      'P3',
      oracle({ name: 'Bear Witness', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P3',
      activePlayerIndex: 2,
      phase: 'combat',
      step: null,
    });
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers')
        return declareAttacks(d, (id) => (id === attacker.id ? 'P1' : null));
      if (d.decisionType === 'declareBlockers') {
        const s = d.presentationBlockDeclaration!.subjects.find((x) => x.subjectId === hostile.id);
        expect(s).toBeUndefined();
        expect(
          d.presentationBlockDeclaration!.subjects.some((x) => x.subjectId === friendly.id),
        ).toBe(true);
        return declareBlocks(d, (id) => (id === friendly.id ? attacker.id : null));
      }
      return answer(d);
    });
    expect(friendly.blocking).toBeTruthy();
  });

  it('pr08-alexios-varchild-09 — Survivors cannot attack controller or their planeswalker', () => {
    const ctx = pod('varchild-attack');
    cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    const walker = spawn(
      ctx,
      'P1',
      oracle({ name: 'Varchild Defender', typeLine: 'Planeswalker — Test', loyalty: '5' }),
    );
    const hostile = createToken(ctx, SURVIVOR_1_1_RED, 'P2');
    hostile.summoningSick = false;
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P2',
      activePlayerIndex: 1,
      phase: 'combat',
      step: null,
    });
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const subject = d.presentationAttackDeclaration!.subjects.find(
          (s) => s.subjectId === hostile.id,
        )!;
        expect(subject.defenders.map((x) => x.playerId)).not.toContain('P1');
        expect(subject.planeswalkers.map((x) => x.objectId)).not.toContain(walker.id);
        return declareAttacks(d, (id) => (id === hostile.id ? 'P3' : null));
      }
      return answer(d);
    });
  });

  it('pr08-alexios-varchild-10 — Survivor attack restriction ends when source leaves', () => {
    const ctx = pod('varchild-gone');
    const v = cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    const hostile = createToken(ctx, SURVIVOR_1_1_RED, 'P2');
    hostile.summoningSick = false;
    pump(moveObject(ctx, v, { zone: 'graveyard' }));
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P2',
      activePlayerIndex: 1,
      phase: 'combat',
      step: null,
    });
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const subject = d.presentationAttackDeclaration!.subjects.find(
          (s) => s.subjectId === hostile.id,
        )!;
        expect(subject.defenders.map((x) => x.playerId)).toContain('P1');
        return declareAttacks(d, (id) => (id === hostile.id ? 'P1' : null));
      }
      return answer(d);
    });
  });

  it('pr08-alexios-varchild-11 — leave trigger captures all Survivors', () => {
    const ctx = pod('varchild-ltb');
    const v = cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    const existing = createToken(ctx, SURVIVOR_1_1_RED, 'P2');
    pump(moveObject(ctx, v, { zone: 'graveyard' }));
    const response = createToken(ctx, SURVIVOR_1_1_RED, 'P3');
    settle(ctx);
    expect(existing.controllerId).toBe('P1');
    expect(response.controllerId).toBe('P1');
  });

  it('pr08-alexios-varchild-13 — losing abilities removes Alexios sacrifice restriction', () => {
    const ctx = pod('alexios-loses-abilities');
    const a = cast(ctx, 'P1', alexiosPin.card, ['C', 'C', 'C', 'R']);
    const suppressor = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ability Suppressor', typeLine: 'Enchantment' }),
    );
    const def = ctx.defs.get(suppressor.oracleId)!;
    ctx.defs.set(suppressor.oracleId, {
      ...def,
      staticEffects: [{ affects: ofType('Creature'), op: { layer: 6, loseAllAbilities: true } }],
    });
    expect(computeCharacteristics(ctx, a).keywords).not.toContain('trample');
    pump(moveObject(ctx, a, { zone: 'graveyard', reason: 'sacrifice' }));
    expect(ctx.state.battlefield).not.toContain(a);
  });

  it('pr08-alexios-varchild-14 — losing abilities removes Varchild Survivor attack restriction', () => {
    const ctx = pod('varchild-loses-abilities');
    const v = cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    const suppressor = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ability Suppressor', typeLine: 'Enchantment' }),
    );
    const def = ctx.defs.get(suppressor.oracleId)!;
    ctx.defs.set(suppressor.oracleId, {
      ...def,
      staticEffects: [{ affects: ofType('Creature'), op: { layer: 6, loseAllAbilities: true } }],
    });
    const hostile = createToken(ctx, SURVIVOR_1_1_RED, 'P2');
    hostile.summoningSick = false;
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P2',
      activePlayerIndex: 1,
      phase: 'combat',
      step: null,
    });
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers') {
        const subject = d.presentationAttackDeclaration!.subjects.find(
          (s) => s.subjectId === hostile.id,
        )!;
        expect(subject.defenders.map((x) => x.playerId)).toContain('P1');
        return declareAttacks(d, (id) => (id === hostile.id ? 'P1' : null));
      }
      return answer(d);
    });
    expect(ctx.state.battlefield).toContain(v);
  });

  it('pr08-alexios-varchild-12 — combat damage creates Survivors for damaged player', () => {
    const ctx = pod('varchild-damage');
    const v = cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    v.summoningSick = false;
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'combat';
    ctx.state.step = null;
    const { decisions } = pump(runCombatPhase(ctx), (d) =>
      d.decisionType === 'declareAttackers'
        ? declareAttacks(d, (id) => (id === v.id ? 'P2' : null))
        : answer(d),
    );
    void decisions;
    settle(ctx);
    const survivors = ctx.state.battlefield.filter(
      (p) => p.isToken && computeCharacteristics(ctx, p).subtypes.includes('Survivor'),
    );
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((p) => p.controllerId === 'P2' && p.ownerId === 'P2')).toBe(true);
    expect(playerById(ctx, 'P2').life).toBeLessThan(40);
  });

  it('pr08-alexios-varchild-15 — prevented combat damage creates no Survivors', () => {
    const ctx = pod('varchild-no-damage');
    const v = cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    v.summoningSick = false;
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Large Blocker', typeLine: 'Creature — Giant', power: '5', toughness: '5' }),
    );
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P1',
      activePlayerIndex: 0,
      phase: 'combat',
      step: null,
    });
    pump(runCombatPhase(ctx), (d) => {
      if (d.decisionType === 'declareAttackers')
        return declareAttacks(d, (id) => (id === v.id ? 'P2' : null));
      if (d.decisionType === 'declareBlockers') return declareBlocks(d, () => v.id);
      return answer(d);
    });
    settle(ctx);
    expect(
      ctx.state.battlefield.some(
        (p) => p.isToken && computeCharacteristics(ctx, p).subtypes.includes('Survivor'),
      ),
    ).toBe(false);
  });

  it('pr08-alexios-varchild-17 — noncombat damage to a player creates no Survivors', () => {
    const ctx = pod('varchild-noncombat');
    const v = cast(ctx, 'P1', varchildPin.card, ['C', 'C', 'R']);
    pump(
      dealDamageToPlayer(ctx, permanentSource(v), playerById(ctx, 'P2'), 2, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
        sourceHasInfect: false,
      }),
    );
    settle(ctx);
    expect(
      ctx.state.battlefield.some(
        (p) => p.isToken && computeCharacteristics(ctx, p).subtypes.includes('Survivor'),
      ),
    ).toBe(false);
    expect(playerById(ctx, 'P2').life).toBe(38);
  });
});
