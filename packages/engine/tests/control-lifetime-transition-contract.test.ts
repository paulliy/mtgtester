import { describe, expect, it } from 'vitest';
import { changeController, refreshControlEffects } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { phaseOutControlledPermanents, phaseInAtUntap } from '../src/state/phasing';
import { copies, forest, gameConfig, oracle, spawn } from './fixtures';

function setup() {
  return createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed: 'control-reversion-transition' },
    ),
  );
}

describe('control expiry transitions', () => {
  it('expires the duration when its source and controlled creature phase out together, regardless of battlefield order', () => {
    const ctx = setup();
    const source = spawn(ctx, 'P1', oracle({ name: 'First phased source' }));
    const creature = spawn(ctx, 'P2', oracle({ name: 'Later phased controlled creature' }));
    changeController(ctx, creature, 'P1', {
      kind: 'whileSourceOnBattlefield',
      sourceObjectId: source.id,
    });
    phaseOutControlledPermanents(ctx, 'P1');
    expect(ctx.state.battlefield).toHaveLength(0);
    expect(creature.controlChanges ?? []).toHaveLength(0);
    phaseInAtUntap(ctx, 'P1');
    expect(creature.controllerId).toBe('P2');
  });
  it('expiry is a real controller transition without recording a new control effect or retimestamping the permanent', () => {
    const ctx = setup();
    const creature = spawn(ctx, 'P2', oracle({ name: 'Reverting combat witness' }));
    const timestamp = creature.timestamp;
    changeController(ctx, creature, 'P1', { kind: 'untilEndOfTurn' });
    creature.summoningSick = false;
    creature.attacking = 'P3';
    creature.statuses.push('attacking');
    refreshControlEffects(ctx, creature, { expireEndOfTurn: true });
    expect(creature.controllerId).toBe('P2');
    expect(creature.summoningSick).toBe(true);
    expect(creature.attacking).toBeNull();
    expect(creature.statuses).not.toContain('attacking');
    expect(creature.controlChanges ?? []).toHaveLength(0);
    expect(creature.timestamp).toBe(timestamp);
  });

  it('does not create a source-bound duration that already ended before it could begin', () => {
    const ctx = setup();
    const creature = spawn(ctx, 'P2', oracle({ name: 'Source duration witness' }));
    creature.summoningSick = false;
    changeController(ctx, creature, 'P1', {
      kind: 'whileSourceOnBattlefield',
      sourceObjectId: 'departed-source-incarnation',
    });
    expect(creature.controllerId).toBe('P2');
    expect(creature.summoningSick).toBe(false);
    expect(creature.controlChanges ?? []).toHaveLength(0);
  });
});
