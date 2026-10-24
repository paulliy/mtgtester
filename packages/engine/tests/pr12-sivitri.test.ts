import { describe, expect, it } from 'vitest';
import type { AttackDeclarationSubject, OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { runCombatPhase } from '../src/combat/combat';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { counterCount } from '../src/state/counters';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import {
  bear,
  conjure,
  declareAttacks,
  declareBlocks,
  oracle,
  plains,
  pump,
  spawn,
} from './fixtures';
import {
  activateIndex,
  battlefield,
  game,
  nextTurnOf,
  pinned,
  player,
  priorityOption,
} from './pr12-helpers';

const SIVITRI = pinned('Sivitri, Dragon Master');

const dragon = (name = 'Test Drake'): OracleCard =>
  oracle({
    name,
    typeLine: 'Creature — Dragon',
    manaCost: '{3}',
    power: '3',
    toughness: '3',
  });
const ghostlyTax = (): OracleCard =>
  oracle({
    name: 'Mana Tax Test',
    typeLine: 'Enchantment',
    manaCost: '{2}',
    oracleText:
      "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.",
  });

function turnOf(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
}

/** Resolve the top of the stack, answering its decisions with `answer`. */
function resolveTop(
  ctx: GameContext,
  answer?: (decision: PendingDecision) => DecisionOutcome,
): PendingDecision[] {
  return pump(resolveTopOfStack(ctx), answer).decisions;
}

/** Declare attacks for P2's turn; record the subjects of each declaration prompt. */
function attack(
  ctx: GameContext,
  choose: (id: string, subject: AttackDeclarationSubject) => string | null,
): { declarations: AttackDeclarationSubject[][]; rejected: boolean } {
  ctx.state.phase = 'combat';
  const declarations: AttackDeclarationSubject[][] = [];
  let rejected = false;
  pump(runCombatPhase(ctx), (decision: PendingDecision): DecisionOutcome => {
    if (decision.presentationAttackDeclaration !== undefined) {
      declarations.push(decision.presentationAttackDeclaration.subjects);
      if (decision.presentationAttackDeclaration.rejection !== undefined) rejected = true;
      return declareAttacks(decision, choose);
    }
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
  return { declarations, rejected };
}

function ready(ctx: GameContext, playerId: string, card: () => OracleCard): EnginePermanent {
  const creature = spawn(ctx, playerId, card());
  creature.summoningSick = false;
  return creature;
}

describe('Sivitri, Dragon Master', () => {
  it('sivitri-c01-activate — the +1 is a sorcery-speed loyalty ability through the priority menu', () => {
    const ctx = game('pr12-sivitri-activate');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    expect(counterCount(sivitri.counters, 'loyalty')).toBe(4);
    activateIndex(ctx, 'P1', sivitri, 0);
    expect(counterCount(sivitri.counters, 'loyalty')).toBe(5);
    expect(ctx.state.stack).toHaveLength(1);
    // Loyalty abilities are once per turn and only with an empty stack.
    expect(
      priorityOption(
        ctx,
        'P1',
        (payload) => payload.kind === 'activateAbility' && payload.objectId === sivitri.id,
      ),
    ).toBeUndefined();
  });

  it('sivitri-c01-positive — each creature attacking you or your planeswalkers costs its controller 2 life', () => {
    const ctx = game('pr12-sivitri-tax');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    expect(ctx.state.attackLifeTaxes).toHaveLength(1);
    // The effect outlasts its source.
    turnOf(ctx, 'P2');
    const first = ready(ctx, 'P2', bear);
    const second = ready(ctx, 'P2', bear);
    const { declarations } = attack(ctx, (id) =>
      id === first.id ? 'P1' : id === second.id ? sivitri.id : null,
    );
    const subject = declarations[0]!.find((entry) => entry.subjectId === first.id)!;
    expect(subject.defenders.find((entry) => entry.playerId === 'P1')?.attackLifeTax).toBe(2);
    expect(
      subject.defenders.find((entry) => entry.playerId === 'P3')?.attackLifeTax,
    ).toBeUndefined();
    expect(
      subject.planeswalkers.find((entry) => entry.objectId === sivitri.id)?.attackLifeTax,
    ).toBe(2);
    expect(player(ctx, 'P2').life).toBe(40 - 4);
    // Both attacks happened: P1 and Sivitri each took 2 combat damage.
    expect(player(ctx, 'P1').life).toBe(38);
    expect(counterCount(sivitri.counters, 'loyalty')).toBe(3);
  });

  it('sivitri-c01-negative — attacks on other players stay free', () => {
    const ctx = game('pr12-sivitri-free');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    turnOf(ctx, 'P2');
    const attacker = ready(ctx, 'P2', bear);
    attack(ctx, (id) => (id === attacker.id ? 'P3' : null));
    expect(player(ctx, 'P2').life).toBe(40);
    expect(player(ctx, 'P3').life).toBe(38);
  });

  it('sivitri-c01-unaffordable — a player who cannot pay the life cannot attack you', () => {
    const ctx = game('pr12-sivitri-broke');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    turnOf(ctx, 'P2');
    player(ctx, 'P2').life = 1;
    const attacker = ready(ctx, 'P2', bear);
    const { declarations } = attack(ctx, () => null);
    const subject = declarations[0]!.find((entry) => entry.subjectId === attacker.id)!;
    expect(subject.defenders.map((entry) => entry.playerId)).not.toContain('P1');
    expect(subject.planeswalkers.map((entry) => entry.objectId)).not.toContain(sivitri.id);
    expect(subject.defenders.map((entry) => entry.playerId)).toContain('P3');
  });

  it('sivitri-c01-joint — the life for every attacker is checked together', () => {
    const ctx = game('pr12-sivitri-joint');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    turnOf(ctx, 'P2');
    player(ctx, 'P2').life = 3;
    const first = ready(ctx, 'P2', bear);
    const second = ready(ctx, 'P2', bear);
    const { rejected } = attack(ctx, (id) => (id === first.id || id === second.id ? 'P1' : null));
    expect(rejected).toBe(true);
    // The engine's repair stands one attacker down; the other pays 2 of the 3 life and hits.
    expect(player(ctx, 'P2').life).toBe(1);
    expect(player(ctx, 'P1').life).toBe(38);
  });

  it('sivitri-c01-locked — a player whose life total cannot change cannot pay it', () => {
    const ctx = game('pr12-sivitri-locked');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    turnOf(ctx, 'P2');
    // Teferi's Protection's life lock (coverage PR11), set on P2's own previous turn.
    ctx.state.playerProtectionUntilNextTurn = { P2: ctx.state.turnNumber };
    const attacker = ready(ctx, 'P2', bear);
    const { declarations } = attack(ctx, () => null);
    const subject = declarations[0]!.find((entry) => entry.subjectId === attacker.id)!;
    expect(subject.defenders.map((entry) => entry.playerId)).not.toContain('P1');
  });

  it('sivitri-c01-stacks-with-mana-tax — a mana tax on the same player is paid as well', () => {
    const ctx = game('pr12-sivitri-mana');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    spawn(ctx, 'P1', ghostlyTax());
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    turnOf(ctx, 'P2');
    spawn(ctx, 'P2', plains());
    spawn(ctx, 'P2', plains());
    const attacker = ready(ctx, 'P2', bear);
    attack(ctx, (id) => (id === attacker.id ? 'P1' : null));
    expect(player(ctx, 'P1').life).toBe(38);
    expect(player(ctx, 'P2').life).toBe(38);
    expect(
      battlefield(ctx, 'Plains').filter((land) => land.tapped && land.controllerId === 'P2'),
    ).toHaveLength(2);
  });

  it('sivitri-c01-expires — the tax ends as its controller’s next turn begins', () => {
    const ctx = game('pr12-sivitri-expiry');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    activateIndex(ctx, 'P1', sivitri, 0);
    resolveTop(ctx);
    nextTurnOf(ctx, 'P2');
    expect(ctx.state.attackLifeTaxes).toHaveLength(1);
    nextTurnOf(ctx, 'P1');
    expect(ctx.state.attackLifeTaxes).toHaveLength(0);
  });

  it('sivitri-c02 — −3 searches for a Dragon card, reveals it, puts it into hand and shuffles', () => {
    const ctx = game('pr12-sivitri-tutor');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    const me = player(ctx, 'P1');
    const wanted = conjure(ctx, 'P1', dragon('Hidden Drake'), 'library');
    conjure(ctx, 'P1', bear(), 'library');
    const offered: string[] = [];
    const before = ctx.state.eventLog.length;
    activateIndex(ctx, 'P1', sivitri, 1);
    expect(counterCount(sivitri.counters, 'loyalty')).toBe(1);
    resolveTop(ctx, (decision) => {
      offered.push(...decision.options.map((option) => option.description));
      const index = decision.options.findIndex((option) => option.description.includes('Hidden'));
      return { index: Math.max(index, 0), targets: new Map() };
    });
    expect(offered.some((text) => text.includes('Test Bear'))).toBe(false);
    expect(me.hand.map((card) => card.cardId)).toContain(wanted.cardId);
    const events = ctx.state.eventLog.slice(before);
    expect(events.find((event) => event.type === 'searchFound')?.payload['revealed']).toBe(true);
    expect(events.map((event) => event.type)).toContain('shuffle');
  });

  it('sivitri-c02-shared-grammar — Maelstrom of the Spirit Dragon’s identical search also reveals and shuffles', () => {
    const maelstrom = oracle({
      name: 'Maelstrom of the Spirit Dragon',
      typeLine: 'Land',
      oracleText:
        '{4}, {T}, Sacrifice this land: Search your library for a Dragon card, reveal it, put it into your hand, then shuffle.',
    });
    const def = interpretCard(maelstrom);
    expect(def.activatedAbilities[0]?.ability.effects).toEqual([
      {
        op: 'searchLibrary',
        filter: { kind: 'subtype', value: 'Dragon' },
        destinations: [{ zone: 'hand' }],
        reveal: true,
      },
      { op: 'shuffle' },
    ]);
  });

  it('sivitri-c03 — −7 destroys every non-Dragon creature and spares Dragons', () => {
    const ctx = game('pr12-sivitri-ultimate');
    const sivitri = spawn(ctx, 'P1', SIVITRI);
    sivitri.counters['loyalty'] = 7;
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P3', dragon());
    activateIndex(ctx, 'P1', sivitri, 2);
    resolveTop(ctx);
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(0);
    expect(battlefield(ctx, 'Test Drake')).toHaveLength(1);
  });
});
