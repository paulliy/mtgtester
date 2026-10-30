import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { changeController, moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { runCombatPhase } from '../src/combat/combat';
import { buildPlayerView } from '../src/view/view';
import type { GameContext } from '../src/state/types';
import { forcedOutcome, isForced, type PendingDecision } from '../src/decisions';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

const pins = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
  ) as {
    cards: { sha256: string; card: OracleCard }[];
  }
).cards;
const duelistPin = pins.find(({ card }) => card.name === 'Keen Duelist')!;
const szarekhPin = pins.find(({ card }) => card.name === 'Szarekh, the Silent King')!;
const restInPeace = (
  JSON.parse(
    readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
  ) as { cards: { card: OracleCard }[] }
).cards.find(({ card }) => card.name === 'Rest in Peace')!.card;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 3,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function pass(d: PendingDecision) {
  return {
    index: Math.max(
      0,
      d.options.findIndex((o) => o.type === 'pass'),
    ),
    targets: new Map<number, string>(),
  };
}
/** The triggers in this file are mandatory: none may ask "use this ability?" before its effects. */
function expectMandatory(d: PendingDecision) {
  expect(d.decisionType).not.toBe('optionalTrigger');
}
function settle(ctx: GameContext, choose?: (d: PendingDecision) => ReturnType<typeof pass>) {
  return pump(runPrioritySequence(ctx), (d) => {
    expectMandatory(d);
    return choose?.(d) ?? pass(d);
  });
}
function upkeep(ctx: GameContext, player: string) {
  ctx.state.currentTurnPlayer = player;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(player);
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  queueStepTriggers(ctx, 'upkeep');
}
function libraryCard(
  ctx: GameContext,
  player: string,
  name: string,
  cmc: number,
  typeLine: string,
) {
  return conjure(
    ctx,
    player,
    oracle({ name, typeLine, manaCost: cmc ? `{${cmc}}` : '', cmc, oracleText: '' }),
    'library',
  );
}
function chooseOpponent(d: PendingDecision, player = 'P2') {
  const target = d.options[0]?.targets?.[0];
  if (target !== undefined) return { index: 0, targets: new Map([[target.slot, player]]) };
  const index = d.options.findIndex(
    (o) => o.type === 'choosePlayer' && o.description.includes(player),
  );
  return { index: Math.max(0, index), targets: new Map<number, string>() };
}
function attack(
  ctx: GameContext,
  creatureId: string,
  choose?: (decision: PendingDecision) => ReturnType<typeof pass>,
) {
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  return pump(runCombatPhase(ctx), (d) => {
    if (d.decisionType === 'declareAttackers')
      return declareAttacks(d, (id) => (id === creatureId ? 'P2' : null));
    expectMandatory(d);
    return choose?.(d) ?? pass(d);
  });
}

describe('PR09 reveal and mill cards', () => {
  it('pr09-duelist-own-upkeep-reveal-life-and-hand — publicly reveals both, cross-pays life, and puts cards into hands', () => {
    const ctx = pod('pr09-duelist-upkeep');
    spawn(ctx, 'P1', duelistPin.card);
    const a = libraryCard(ctx, 'P1', 'Duelist top', 3, 'Artifact');
    const b = libraryCard(ctx, 'P2', 'Opponent top', 5, 'Artifact');
    upkeep(ctx, 'P1');
    const { decisions } = settle(ctx, (d) => chooseOpponent(d));
    expect(decisions.some((d) => d.decisionType === 'chooseTargets')).toBe(true);
    expect(playerById(ctx, 'P1').life).toBe(35);
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(playerById(ctx, 'P1').hand.map((c) => c.cardId)).toContain(a.cardId);
    expect(playerById(ctx, 'P2').hand.map((c) => c.cardId)).toContain(b.cardId);
    expect(ctx.state.eventLog.filter((e) => e.type === 'revealCard')).toHaveLength(2);
    expect(
      ctx.state.eventLog
        .filter((e) => e.type === 'revealCard')
        .every((e) => e.payload['revealed'] === true),
    ).toBe(true);
    expect(ctx.state.eventLog.some((e) => e.type === 'draw')).toBe(false);
    const revealIndexes = ctx.state.eventLog
      .map((e, i) => (e.type === 'revealCard' ? i : -1))
      .filter((i) => i >= 0);
    const lossIndexes = ctx.state.eventLog
      .map((e, i) => (e.type === 'lifeLoss' ? i : -1))
      .filter((i) => i >= 0);
    expect(revealIndexes).toHaveLength(2);
    expect(lossIndexes).toHaveLength(2);
    expect(Math.max(...revealIndexes)).toBeLessThan(Math.min(...lossIndexes));
    expect(JSON.stringify(buildPlayerView(ctx, 'P3'))).toContain('Duelist top');
    expect(JSON.stringify(buildPlayerView(ctx, 'P3'))).toContain('Opponent top');
  });
  it('pr09-duelist-wrong-upkeep-does-not-trigger — only the controller upkeep queues it', () => {
    const ctx = pod('pr09-duelist-other-upkeep');
    spawn(ctx, 'P1', duelistPin.card);
    upkeep(ctx, 'P2');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
  it('pr09-duelist-target-opponents-only — excludes self and a hexproof opponent from target choices', () => {
    const ctx = pod('pr09-duelist-targets');
    spawn(ctx, 'P1', duelistPin.card);
    ctx.state.playerHexproofTurn = { P3: ctx.state.turnNumber };
    upkeep(ctx, 'P1');
    let offered: string[] = [];
    settle(ctx, (d) => {
      if (d.decisionType === 'chooseTargets') {
        offered = d.options[0]?.targets?.[0]?.options ?? [];
        return chooseOpponent(d, 'P2');
      }
      return pass(d);
    });
    expect(offered.some((s) => s.includes('P1'))).toBe(false);
    expect(offered.some((s) => s.includes('P2'))).toBe(true);
    expect(offered.some((s) => s.includes('P3'))).toBe(false);
    expect(offered.some((s) => s.includes('P4'))).toBe(true);
  });
  it('pr09-duelist-illegal-target-fizzles-all — a sole departed opponent makes both reveals and losses fail', () => {
    const ctx = pod('pr09-duelist-fizzle');
    spawn(ctx, 'P1', duelistPin.card);
    libraryCard(ctx, 'P1', 'Duelist top', 2, 'Artifact');
    libraryCard(ctx, 'P2', 'Opponent top', 4, 'Artifact');
    ctx.state.playerHexproofTurn = { P3: ctx.state.turnNumber, P4: ctx.state.turnNumber };
    upkeep(ctx, 'P1');
    const sequence = runPrioritySequence(ctx);
    let step = sequence.next();
    expect(step.done).toBe(false);
    if (step.done) throw new Error('expected Duelist target choice');
    expect(step.value.decisionType).toBe('chooseTargets');
    step = sequence.next(chooseOpponent(step.value, 'P2'));
    playerById(ctx, 'P2').hasLost = true;
    while (!step.done) {
      const decision = step.value;
      step = sequence.next(isForced(decision) ? forcedOutcome(decision) : pass(decision));
    }
    expect(ctx.state.eventLog.some((e) => e.type === 'fizzle')).toBe(true);
    expect(ctx.state.eventLog.filter((e) => e.type === 'revealCard')).toHaveLength(0);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });
  it('pr09-duelist-empty-library — an empty side reveals no card and does not cause deck-out', () => {
    const ctx = pod('pr09-duelist-empty');
    spawn(ctx, 'P1', duelistPin.card);
    libraryCard(ctx, 'P2', 'Opponent top', 4, 'Artifact');
    playerById(ctx, 'P1').library.length = 0;
    upkeep(ctx, 'P1');
    settle(ctx, (d) => chooseOpponent(d));
    expect(playerById(ctx, 'P1').life).toBe(36);
    expect(playerById(ctx, 'P1').hasLost).toBe(false);
    expect(ctx.state.eventLog.filter((e) => e.type === 'revealCard')).toHaveLength(1);
  });
  it('pr09-duelist-source-departure-keeps-controller — queued trigger resolves after Duelist leaves', () => {
    const ctx = pod('pr09-duelist-departure');
    const source = spawn(ctx, 'P1', duelistPin.card);
    const a = libraryCard(ctx, 'P1', 'Duelist top', 1, 'Artifact');
    libraryCard(ctx, 'P2', 'Opponent top', 2, 'Artifact');
    upkeep(ctx, 'P1');
    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    settle(ctx, (d) => chooseOpponent(d));
    expect(playerById(ctx, 'P1').life).toBe(38);
    expect(playerById(ctx, 'P1').hand.map((c) => c.cardId)).toContain(a.cardId);
  });
  it('pr09-duelist-controller-change-keeps-trigger-controller — control change after trigger does not redirect its life loss', () => {
    const ctx = pod('pr09-duelist-control-change');
    const source = spawn(ctx, 'P1', duelistPin.card);
    libraryCard(ctx, 'P1', 'Duelist top', 1, 'Artifact');
    libraryCard(ctx, 'P2', 'Opponent top', 3, 'Artifact');
    upkeep(ctx, 'P1');
    changeController(ctx, source, 'P3');
    settle(ctx, (d) => chooseOpponent(d));
    expect(playerById(ctx, 'P1').life).toBe(37);
    expect(playerById(ctx, 'P3').life).toBe(40);
  });
  it('pr09-szarekh-attack-mills-three-and-returns-eligible — mills through real attack and chooses a Vehicle', () => {
    const ctx = pod('pr09-szarekh-mill');
    const king = spawn(ctx, 'P1', szarekhPin.card);
    king.summoningSick = false;
    const vehicle = libraryCard(ctx, 'P1', 'Milled Vehicle', 3, 'Artifact — Vehicle');
    libraryCard(ctx, 'P1', 'Milled nonmatch', 1, 'Creature — Bear');
    libraryCard(ctx, 'P1', 'Milled artifact', 2, 'Artifact');
    attack(ctx, king.id, (d) =>
      d.options.some((o) => o.description.includes('Milled Vehicle'))
        ? {
            index: d.options.findIndex((o) => o.description.includes('Milled Vehicle')),
            targets: new Map(),
          }
        : pass(d),
    );
    expect(playerById(ctx, 'P1').hand.map((c) => c.cardId)).toContain(vehicle.cardId);
    expect(ctx.state.eventLog.filter((e) => e.type === 'mill')).toHaveLength(3);
  });
  it('pr09-szarekh-replaced-mill-public-zone — recovers the newly milled Vehicle from exile and excludes prior exile cards', () => {
    const ctx = pod('pr09-szarekh-replaced-mill');
    spawn(ctx, 'P1', restInPeace);
    const king = spawn(ctx, 'P1', szarekhPin.card);
    king.summoningSick = false;
    const old = conjure(
      ctx,
      'P1',
      oracle({ name: 'Old exiled Vehicle', typeLine: 'Artifact — Vehicle' }),
      'exile',
    );
    const vehicle = libraryCard(ctx, 'P1', 'Replaced mill Vehicle', 3, 'Artifact — Vehicle');
    const misses = [
      libraryCard(ctx, 'P1', 'Replaced mill creature', 1, 'Creature — Bear'),
      libraryCard(ctx, 'P1', 'Replaced mill artifact', 2, 'Artifact'),
    ];
    let offered = false;
    attack(ctx, king.id, (decision) => {
      expect(decision.options.some((option) => option.description.includes(old.name))).toBe(false);
      const index = decision.options.findIndex((option) =>
        option.description.includes(vehicle.name),
      );
      if (index < 0) return pass(decision);
      offered = true;
      return { index, targets: new Map() };
    });
    expect(offered).toBe(true);
    const recovered = playerById(ctx, 'P1').hand.find((card) => card.cardId === vehicle.cardId)!;
    expect(recovered).toBeDefined();
    expect(recovered.id).not.toBe(vehicle.id);
    expect(playerById(ctx, 'P1').graveyard).toHaveLength(0);
    expect(ctx.state.exile.map((card) => card.cardId)).toEqual(
      expect.arrayContaining([old.cardId, ...misses.map((card) => card.cardId)]),
    );
    expect(ctx.state.exile.some((card) => card.cardId === vehicle.cardId)).toBe(false);
    expect(ctx.state.eventLog.filter((event) => event.type === 'mill')).toHaveLength(3);
  });
  it('pr09-szarekh-replaced-mill-decline — may leave an eligible milled artifact creature in exile', () => {
    const ctx = pod('pr09-szarekh-replaced-decline');
    spawn(ctx, 'P1', restInPeace);
    const king = spawn(ctx, 'P1', szarekhPin.card);
    king.summoningSick = false;
    const eligible = libraryCard(
      ctx,
      'P1',
      'Replaced artifact creature',
      2,
      'Artifact Creature — Golem',
    );
    let declined = false;
    attack(ctx, king.id, (decision) => {
      if (!decision.options.some((option) => option.description.includes(eligible.name)))
        return pass(decision);
      const index = decision.options.findIndex((option) => option.type === 'decline');
      expect(index).toBeGreaterThanOrEqual(0);
      declined = true;
      return { index, targets: new Map() };
    });
    expect(declined).toBe(true);
    expect(playerById(ctx, 'P1').hand).toHaveLength(0);
    expect(ctx.state.exile.some((card) => card.cardId === eligible.cardId)).toBe(true);
    expect(playerById(ctx, 'P1').graveyard).toHaveLength(0);
  });
  it('pr09-szarekh-excludes-generic-artifact — generic artifact alone is not an eligible card', () => {
    const ctx = pod('pr09-szarekh-artifact');
    const king = spawn(ctx, 'P1', szarekhPin.card);
    king.summoningSick = false;
    const artifact = libraryCard(ctx, 'P1', 'Only artifact', 2, 'Artifact');
    libraryCard(ctx, 'P1', 'Other nonmatch', 1, 'Creature — Bear');
    libraryCard(ctx, 'P1', 'Other nonmatch 2', 1, 'Creature — Bear');
    const { decisions } = attack(ctx, king.id);
    expect(playerById(ctx, 'P1').hand.map((c) => c.cardId)).not.toContain(artifact.cardId);
    expect(
      decisions.some((d) => d.options.some((o) => o.description.includes('Only artifact'))),
    ).toBe(false);
  });
  it('pr09-szarekh-only-milled-cards-and-one-return — ignores existing graveyard cards and returns at most one eligible card', () => {
    const ctx = pod('pr09-szarekh-only-milled');
    const king = spawn(ctx, 'P1', szarekhPin.card);
    king.summoningSick = false;
    const old = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Old artifact creature',
        typeLine: 'Artifact Creature — Golem',
        manaCost: '{2}',
        cmc: 2,
      }),
      'graveyard',
    );
    const eligible = libraryCard(
      ctx,
      'P1',
      'Milled artifact creature',
      2,
      'Artifact Creature — Golem',
    );
    const vehicle = libraryCard(ctx, 'P1', 'Milled Vehicle', 3, 'Artifact — Vehicle');
    libraryCard(ctx, 'P1', 'Milled nonmatch', 1, 'Creature — Bear');
    attack(ctx, king.id, (d) => {
      const choice = d.options.findIndex((o) => o.description.includes('Milled artifact creature'));
      return choice >= 0 ? { index: choice, targets: new Map() } : pass(d);
    });
    expect(playerById(ctx, 'P1').hand).toHaveLength(1);
    expect([eligible.cardId, vehicle.cardId]).toContain(playerById(ctx, 'P1').hand[0]?.cardId);
    expect(playerById(ctx, 'P1').hand.map((c) => c.cardId)).not.toContain(old.cardId);
  });
  it('pr09-szarekh-no-matches-or-empty — no eligible milled card yields no choice or loss', () => {
    const ctx = pod('pr09-szarekh-empty');
    const king = spawn(ctx, 'P1', szarekhPin.card);
    king.summoningSick = false;
    const { decisions } = attack(ctx, king.id);
    expect(
      decisions.some((d) => d.options.some((o) => o.description.toLowerCase().includes('hand'))),
    ).toBe(false);
    expect(playerById(ctx, 'P1').hasLost).toBe(false);
  });
});
