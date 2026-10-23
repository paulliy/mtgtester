import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import { validateEffectExpressions } from '../src/cards/expression-validation';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { spell } from '../src/cards/templates';
import { createGame } from '../src/state/game';
import {
  changeController,
  controlledBy,
  moveObject,
  refreshControlEffects,
} from '../src/state/objects';
import { phaseOutControlledPermanents, phaseInAtUntap } from '../src/state/phasing';
import { priorityCheckpoint } from '../src/sba/sba';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup() {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed: 'control-lifetime-contract' },
    ),
  );
  const creature = spawn(ctx, 'P4', oracle({ name: 'Control history witness' }));
  return { ctx, creature };
}

describe('timestamped control lifetimes', () => {
  it('an older temporary effect expires without undoing a later permanent change', () => {
    const { ctx, creature } = setup();
    changeController(ctx, creature, 'P1', { kind: 'untilEndOfTurn' });
    changeController(ctx, creature, 'P3');
    endUntilEotEffects(ctx);
    expect(creature.controllerId).toBe('P3');
  });

  it('a newer temporary effect expires back to an older permanent effect, not to the owner', () => {
    const { ctx, creature } = setup();
    changeController(ctx, creature, 'P1');
    changeController(ctx, creature, 'P3', { kind: 'untilEndOfTurn' });
    endUntilEotEffects(ctx);
    expect(creature.controllerId).toBe('P1');
  });

  it('a same-controller permanent effect masks an older temporary effect without removing the creature from combat', () => {
    const { ctx, creature } = setup();
    changeController(ctx, creature, 'P1', { kind: 'untilEndOfTurn' });
    creature.summoningSick = false;
    creature.attacking = 'P2';
    changeController(ctx, creature, 'P1');
    expect(creature.attacking).toBe('P2');
    expect(creature.summoningSick).toBe(false);
    endUntilEotEffects(ctx);
    expect(creature.controllerId).toBe('P1');
    expect(creature.attacking).toBe('P2');
    expect(creature.summoningSick).toBe(false);
  });

  it('source departure ends only its exact duration and a blink never revives that effect', () => {
    const { ctx, creature } = setup();
    const source = spawn(ctx, 'P1', oracle({ name: 'Control duration source' }));
    changeController(ctx, creature, 'P2', { kind: 'untilEndOfTurn' });
    changeController(ctx, creature, 'P1', {
      kind: 'whileSourceOnBattlefield',
      sourceObjectId: source.id,
    });
    const graveyard = pump(moveObject(ctx, source, { zone: 'graveyard' })).value;
    expect(creature.controllerId).toBe('P2');
    expect(graveyard).not.toBeNull();
    pump(moveObject(ctx, graveyard!, { zone: 'battlefield', controllerId: 'P1' }));
    refreshControlEffects(ctx, creature);
    expect(creature.controllerId).toBe('P2');
    endUntilEotEffects(ctx);
    expect(creature.controllerId).toBe('P4');
  });

  it('changing control of the duration source does not end its battlefield duration', () => {
    const { ctx, creature } = setup();
    const source = spawn(ctx, 'P1', oracle({ name: 'Changing controller source' }));
    changeController(ctx, creature, 'P1', {
      kind: 'whileSourceOnBattlefield',
      sourceObjectId: source.id,
    });
    changeController(ctx, source, 'P2');
    refreshControlEffects(ctx, creature);
    expect(creature.controllerId).toBe('P1');
  });

  it('temporary control expires while the affected creature is phased out', () => {
    const { ctx, creature } = setup();
    changeController(ctx, creature, 'P1', { kind: 'untilEndOfTurn' });
    phaseOutControlledPermanents(ctx, 'P1');
    endUntilEotEffects(ctx);
    phaseInAtUntap(ctx, 'P1');
    expect(creature.controllerId).toBe('P4');
  });

  it('a departed recipient is removed even when their effect was hidden under a later temporary effect', () => {
    const { ctx, creature } = setup();
    changeController(ctx, creature, 'P2');
    changeController(ctx, creature, 'P3', { kind: 'untilEndOfTurn' });
    ctx.state.players.find((player) => player.id === 'P2')!.hasLost = true;
    pump(priorityCheckpoint(ctx));
    expect(creature.controllerId).toBe('P3');
    endUntilEotEffects(ctx);
    expect(creature.controllerId).toBe('P4');
  });

  it('a duration ends when its source leaves the game with its owner', () => {
    const { ctx, creature } = setup();
    const source = spawn(ctx, 'P1', oracle({ name: 'Eliminated owner source' }));
    changeController(ctx, source, 'P2');
    changeController(ctx, creature, 'P2', {
      kind: 'whileSourceOnBattlefield',
      sourceObjectId: source.id,
    });
    ctx.state.players.find((player) => player.id === 'P1')!.hasLost = true;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.id === source.id)).toBe(false);
    expect(creature.controllerId).toBe('P4');
  });

  it('falls back to the controller under which the permanent entered, even when that player is not its owner', () => {
    const { ctx, creature } = setup();
    const hand = pump(moveObject(ctx, creature, { zone: 'hand' })).value;
    const returned = pump(
      moveObject(ctx, hand!, { zone: 'battlefield', controllerId: 'P3' }),
    ).value;
    if (!returned || returned.zone !== 'battlefield' || !('controllerId' in returned))
      throw new Error('Witness did not return');
    changeController(ctx, returned, 'P1', { kind: 'untilEndOfTurn' });
    endUntilEotEffects(ctx);
    expect(returned.ownerId).toBe('P4');
    expect(returned.controllerId).toBe('P3');
  });

  it.each(['untilEndOfTurn', 'whileSourceOnBattlefield'] as const)(
    'does not revert to a departed initial controller when %s ends',
    (kind) => {
      const { ctx, creature } = setup();
      const hand = pump(moveObject(ctx, creature, { zone: 'hand' })).value;
      const returned = pump(
        moveObject(ctx, hand!, { zone: 'battlefield', controllerId: 'P2' }),
      ).value;
      if (!returned || returned.zone !== 'battlefield' || !('controllerId' in returned))
        throw new Error('Witness did not return');
      const source = spawn(ctx, 'P3', oracle({ name: 'Retained control source' }));
      changeController(
        ctx,
        returned,
        'P3',
        kind === 'untilEndOfTurn' ? { kind } : { kind, sourceObjectId: source.id },
      );
      ctx.state.players.find((player) => player.id === 'P2')!.hasLost = true;
      pump(priorityCheckpoint(ctx));
      expect(returned.controllerId).toBe('P3');
      returned.summoningSick = false;
      returned.attacking = 'P1';
      const timestamp = returned.timestamp;
      if (kind === 'untilEndOfTurn') endUntilEotEffects(ctx);
      else pump(moveObject(ctx, source, { zone: 'graveyard' }));
      pump(priorityCheckpoint(ctx));
      expect(returned.controllerId).toBe('P3');
      expect(controlledBy(returned)).toBe('P3');
      expect(ctx.state.battlefield).toContain(returned);
      expect(returned.summoningSick).toBe(false);
      expect(returned.attacking).toBe('P1');
      expect(returned.timestamp).toBe(timestamp);
      expect(returned.controlChanges ?? []).toHaveLength(0);
      changeController(ctx, returned, 'P1');
      expect(returned.controllerId).toBe('P1');
    },
  );

  it('a source-bound ability resolving after its source left produces no control effect', () => {
    const { ctx, creature } = setup();
    pump(
      executeAbility(
        ctx,
        {
          cardId: 'departed-source',
          name: 'Departed source',
          oracleId: 'departed-source',
          controllerId: 'P1',
        },
        spell({
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'gainControlTarget', target: 0, duration: 'whileSourceOnBattlefield' }],
        }),
        [creature.id],
      ),
    );
    expect(creature.controllerId).toBe('P4');
  });

  it('never substitutes a later battlefield incarnation when a source-bound effect lacks its original object identity', () => {
    const { ctx, creature } = setup();
    const source = spawn(ctx, 'P1', oracle({ name: 'Unproven source incarnation' }));
    pump(
      executeAbility(
        ctx,
        { cardId: source.cardId, name: source.name, oracleId: source.oracleId, controllerId: 'P1' },
        spell({
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'gainControlTarget', target: 0, duration: 'whileSourceOnBattlefield' }],
        }),
        [creature.id],
      ),
    );
    expect(creature.controllerId).toBe('P4');
  });

  it.each([{ duration: 'whenever' }, { untap: false }, { grantHaste: false }])(
    'rejects malformed control duration or rider data %j',
    (invalid) => {
      const issues: AuthoringIssue[] = [];
      validateEffectExpressions(
        {
          op: 'gainControl',
          selector: { kind: 'type', value: 'Creature' },
          ...invalid,
        } as unknown as Effect,
        'effect',
        issues,
      );
      expect(issues.length).toBeGreaterThan(0);
    },
  );
});
