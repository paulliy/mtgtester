import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { runCombatPhase } from '../src/combat/combat';
import { executeAbility } from '../src/effects/resolve';
import type { DecisionOutcome } from '../src/decisions';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { cleanupStep, runBeginningAndPrecombatMain } from '../src/turn/turn';
import {
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

/** Four players; P1 is the active player in turn 4. */
function setup(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(10, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const grizzly = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

const walker = (ctx: GameContext, controllerId: string, name: string): EnginePermanent => {
  const perm = spawn(
    ctx,
    controllerId,
    oracle({ name, typeLine: 'Planeswalker — Lab', loyalty: '5', oracleText: '' }),
  );
  perm.counters['loyalty'] = 5;
  return perm;
};

/** Make the requirement as P1's resolving ability would, with `eventPlayer` the damaged player. */
function resolveRequirement(
  ctx: GameContext,
  effect: Extract<Ability['effects'][number], { op: 'addAttackRequirement' }>,
  targets: string[] = [],
  eventPlayerId = 'P3',
): void {
  const source = spawn(ctx, 'P1', grizzly('Requirement Source'));
  pump(
    executeAbility(
      ctx,
      { cardId: source.cardId, oracleId: source.oracleId, name: source.name, controllerId: 'P1' },
      {
        kind: 'triggered',
        targets: effect.target === undefined ? [] : [{ kind: 'creature' }],
        effects: [effect],
        description: 'test',
      } as Ability,
      targets,
      undefined,
      { eventPlayerId },
    ),
  );
}

interface Offer {
  mustAttack: boolean | undefined;
  players: string[];
  planeswalkers: string[];
}

/** What `playerId` is offered for `creature` in the next declaration (nobody else attacks). */
function offerFor(ctx: GameContext, playerId: string, creature: EnginePermanent): Offer {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = Number(playerId.slice(1)) - 1;
  creature.tapped = false;
  let offer: Offer = { mustAttack: undefined, players: [], planeswalkers: [] };
  // Driven by hand: `pump` answers a declaration with one legal choice on its own, and that is
  // exactly the case (a creature required to attack one player) these tests must see.
  const generator = runCombatPhase(ctx);
  let outcome: DecisionOutcome | undefined;
  for (;;) {
    const step = outcome === undefined ? generator.next() : generator.next(outcome);
    if (step.done === true) break;
    const decision = step.value;
    if (decision.presentationAttackDeclaration !== undefined) {
      const subject = decision.presentationAttackDeclaration.subjects.find(
        (candidate) => candidate.subjectId === creature.id,
      );
      offer = {
        mustAttack: subject?.mustAttack,
        players: subject?.defenders.map((defender) => defender.playerId) ?? [],
        planeswalkers: subject?.planeswalkers.map((entry) => entry.objectId) ?? [],
      };
      outcome = declareAttacks(decision, (_subjectId, entry) =>
        entry.mustAttack
          ? (entry.defenders[0]?.playerId ?? entry.planeswalkers[0]?.objectId ?? null)
          : null,
      );
    } else if (decision.presentationBlockDeclaration !== undefined)
      outcome = declareBlocks(decision, () => null);
    else outcome = { index: 0, targets: new Map() };
  }
  return offer;
}

const KARDUR_STYLE: Extract<Ability['effects'][number], { op: 'addAttackRequirement' }> = {
  op: 'addAttackRequirement',
  selector: { kind: 'controller', who: 'opponents' },
  requirements: [{ kind: 'anyAttack' }, { kind: 'notPlayer', player: 'you' }],
  duration: 'untilYourNextTurn',
};

describe('attack requirements made by resolving spells and abilities', () => {
  it('a fixed set names its object: only the target is required, and it must attack the named player', () => {
    const ctx = setup('arq-fixed');
    const target = spawn(ctx, 'P2', grizzly('Target Bear'));
    const other = spawn(ctx, 'P2', grizzly('Other Bear'));
    resolveRequirement(
      ctx,
      {
        op: 'addAttackRequirement',
        target: 0,
        requirements: [{ kind: 'player', player: 'eventPlayer' }],
        duration: 'endOfYourNextTurn',
      },
      [target.id],
      'P3',
    );
    const offer = offerFor(ctx, 'P2', target);
    // It attacks THAT player each combat if able: only P3 obeys it, and it must attack.
    expect(offer).toMatchObject({ mustAttack: true, players: ['P3'] });
    expect(offerFor(ctx, 'P2', other).mustAttack).toBe(false);
  });

  it('a player requirement is not obeyed by a planeswalker, and not required at all when that player cannot be attacked', () => {
    const ctx = setup('arq-player');
    const target = spawn(ctx, 'P2', grizzly('Target Bear'));
    walker(ctx, 'P3', 'P3 Walker');
    resolveRequirement(
      ctx,
      {
        op: 'addAttackRequirement',
        target: 0,
        requirements: [{ kind: 'player', player: 'eventPlayer' }],
        duration: 'endOfYourNextTurn',
      },
      [target.id],
      'P3',
    );
    // P3 and its planeswalker are both attackable; only attacking P3 itself obeys the requirement.
    const offer = offerFor(ctx, 'P2', target);
    expect(offer.players).toEqual(['P3']);
    expect(offer.planeswalkers).toEqual([]);
    // P3 has left the game: it can't be attacked, so the creature is not required to attack.
    playerById(ctx, 'P3').hasLost = true;
    expect(offerFor(ctx, 'P2', target)).toMatchObject({ mustAttack: false });
  });

  it('a live set covers creatures that come under the affected players’ control later, and nobody else', () => {
    const ctx = setup('arq-live');
    const early = spawn(ctx, 'P2', grizzly('Early Bear'));
    const mine = spawn(ctx, 'P1', grizzly('My Bear'));
    resolveRequirement(ctx, KARDUR_STYLE);
    const late = spawn(ctx, 'P3', grizzly('Late Bear'));
    expect(offerFor(ctx, 'P2', early).mustAttack).toBe(true);
    expect(offerFor(ctx, 'P3', late).mustAttack).toBe(true);
    // A creature one of them steals from another opponent is covered as it changes hands.
    late.controllerId = 'P4';
    expect(offerFor(ctx, 'P4', late).mustAttack).toBe(true);
    // Your own creatures are not "creatures your opponents control".
    expect(offerFor(ctx, 'P1', mine).mustAttack).toBe(false);
  });

  it('attack each combat and a player other than you: other players only, the planeswalker of another player never obeys the second', () => {
    const ctx = setup('arq-kardur');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    const p3Walker = walker(ctx, 'P3', 'P3 Walker');
    walker(ctx, 'P1', 'P1 Walker');
    resolveRequirement(ctx, KARDUR_STYLE);
    const offer = offerFor(ctx, 'P2', bearP2);
    // Not P1 (the controller, "a player other than you"), not any planeswalker: P3 and P4.
    expect(offer.mustAttack).toBe(true);
    expect(offer.players.sort()).toEqual(['P3', 'P4']);
    expect(offer.planeswalkers).toEqual([]);
    expect(offer.planeswalkers).not.toContain(p3Walker.id);
  });

  it('with no other player to attack it must still attack you or a planeswalker (maximum possible requirements)', () => {
    const ctx = setup('arq-two-player');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    playerById(ctx, 'P3').hasLost = true;
    playerById(ctx, 'P4').hasLost = true;
    const p1Walker = walker(ctx, 'P1', 'P1 Walker');
    resolveRequirement(ctx, KARDUR_STYLE);
    const offer = offerFor(ctx, 'P2', bearP2);
    expect(offer.mustAttack).toBe(true);
    expect(offer.players.sort()).toEqual(['P1']);
    expect(offer.planeswalkers).toEqual([p1Walker.id]);
  });

  it('a restriction wins: a creature that can only attack the controller but is forbidden to has no requirement', () => {
    const ctx = setup('arq-restriction');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    playerById(ctx, 'P3').hasLost = true;
    playerById(ctx, 'P4').hasLost = true;
    bearP2.cantAttackPlayerWhileCounter = [{ playerId: 'P1', counter: 'vow' }];
    bearP2.counters['vow'] = 1;
    resolveRequirement(ctx, KARDUR_STYLE);
    expect(offerFor(ctx, 'P2', bearP2)).toMatchObject({ mustAttack: false, players: [] });
  });

  it('"until your next turn" ends as that player’s next turn begins, and not before', () => {
    const ctx = setup('arq-until');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    resolveRequirement(ctx, KARDUR_STYLE);
    expect(ctx.state.attackRequirements).toHaveLength(1);
    // P2's, P3's and P4's turns pass, requirement intact.
    for (const [index, id] of ['P2', 'P3', 'P4'].entries()) {
      ctx.state.currentTurnPlayer = id;
      ctx.state.activePlayerIndex = index + 1;
      ctx.state.turnNumber += 1;
      pump(runBeginningAndPrecombatMain(ctx));
      expect(ctx.state.attackRequirements).toHaveLength(1);
    }
    expect(offerFor(ctx, 'P2', bearP2).mustAttack).toBe(true);
    // P1's next turn begins: gone before anyone can attack under it.
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.turnNumber += 1;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(0);
    expect(offerFor(ctx, 'P2', bearP2).mustAttack).toBe(false);
  });

  it('"until the end of your next turn" lasts through that whole turn and ends in its cleanup step', () => {
    const ctx = setup('arq-end-of-turn');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    resolveRequirement(
      ctx,
      {
        op: 'addAttackRequirement',
        target: 0,
        requirements: [{ kind: 'player', player: 'eventPlayer' }],
        duration: 'endOfYourNextTurn',
      },
      [bearP2.id],
      'P3',
    );
    // Cleanup of the turn it was made in (P1's own): still there.
    pump(cleanupStep(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(1);
    // P1's next turn: active through combat, gone after cleanup.
    ctx.state.turnNumber += 4;
    pump(runBeginningAndPrecombatMain(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(1);
    expect(offerFor(ctx, 'P2', bearP2).mustAttack).toBe(true);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    pump(cleanupStep(ctx));
    expect(ctx.state.attackRequirements).toHaveLength(0);
  });

  it('what a player who has left the game made no longer applies', () => {
    const ctx = setup('arq-controller-gone');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    resolveRequirement(
      ctx,
      {
        op: 'addAttackRequirement',
        target: 0,
        requirements: [{ kind: 'anyAttack' }],
        duration: 'endOfYourNextTurn',
      },
      [bearP2.id],
    );
    expect(offerFor(ctx, 'P2', bearP2).mustAttack).toBe(true);
    playerById(ctx, 'P1').hasLost = true;
    expect(offerFor(ctx, 'P2', bearP2).mustAttack).toBe(false);
    // The state-based action that removes them from the game also drops what they made.
    expect(ctx.state.attackRequirements).toEqual([]);
  });

  it('is added to goad: both apply and the maximum counts every requirement', () => {
    const ctx = setup('arq-goad');
    const bearP2 = spawn(ctx, 'P2', grizzly('P2 Bear'));
    bearP2.goadedBy = [{ goaderId: 'P3', appliedTurn: ctx.state.turnNumber }];
    resolveRequirement(ctx, KARDUR_STYLE);
    // Not P3 (goad), not P1 (Kardur-style): only P4 obeys everything.
    expect(offerFor(ctx, 'P2', bearP2)).toMatchObject({ mustAttack: true, players: ['P4'] });
  });
});
