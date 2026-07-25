/**
 * Commander-format rules (brief §5.7, CR 903): commander tax accumulating over multiple
 * casts, and the command-zone return from graveyard/exile (CR 903.9a, an SBA choice) and
 * from hand/library (CR 903.9b, a replacement choice applied mid-move).
 */

import { describe, expect, it } from 'vitest';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { EngineCardObject, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { commanderFor, conjure, copies, forest, gameConfig, pick, pump, spawn } from './fixtures';

function commanderCtx(): { ctx: GameContext; commander: EngineCardObject } {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map((i) => ({
        commander: commanderFor('G', `General ${i + 1}`),
        cards: copies(3, forest),
      })),
      { seed: 'commander' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const p of ctx.state.players) conjure(ctx, p.id, forest(), 'library');
  const p1 = ctx.state.players.find((p) => p.id === 'P1');
  const commander = p1?.commandZone[0] as EngineCardObject;
  return { ctx, commander };
}

describe('commander rules (brief §5.7)', () => {
  it('casts from the command zone with tax {2} per previous cast', () => {
    const { ctx, commander } = commanderCtx();
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('no P1');
    // 2 forests: enough for {1}{G} (first cast) but not {3}{G} (second cast).
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());

    let castDone = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (!castDone && d.options.some((o) => o.description.includes('from the command zone'))) {
        castDone = true;
        return pick(ctx.state.stack.length === 0 ? d : d, 'General 1');
      }
      return pick(d, 'Pass');
    });
    expect(castDone).toBe(true);
    expect(p1.commanderCastCount[commander.cardId]).toBe(1);
    const onBattlefield = ctx.state.battlefield.find((p) => p.cardId === commander.cardId);
    expect(onBattlefield?.isCommander).toBe(true);

    // Send it back to the command zone and try again with the same two lands: the cast
    // now costs {1}{G} + {2} tax and must NOT be offered.
    for (const perm of ctx.state.battlefield) {
      if (perm.cardId === commander.cardId) {
        pump(moveObject(ctx, perm, { zone: 'command' }));
      } else {
        perm.tapped = false;
      }
    }
    ctx.state.phase = 'precombatMain';
    const offered: string[] = [];
    pump(runPrioritySequence(ctx), (d) => {
      offered.push(...d.options.map((o) => o.description));
      return pick(d, 'Pass');
    });
    expect(offered.some((desc) => desc.includes('command zone'))).toBe(false);

    // With two more lands it IS offered, labeled with the tax, and casting increments
    // the count again.
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    let secondCast = false;
    pump(runPrioritySequence(ctx), (d) => {
      if (!secondCast && d.options.some((o) => o.description.includes('commander tax {2}'))) {
        secondCast = true;
        return pick(d, 'commander tax {2}');
      }
      return pick(d, 'Pass');
    });
    expect(secondCast).toBe(true);
    expect(p1.commanderCastCount[commander.cardId]).toBe(2);
    // All four lands were tapped to pay {1}{G}{2-tax}.
    expect(ctx.state.battlefield.filter((p) => p.name === 'Forest' && p.tapped)).toHaveLength(4);
  });

  it('automatically returns from the graveyard to the command zone via 903.9a SBA', () => {
    const { ctx, commander } = commanderCtx();
    const perm = spawn(ctx, 'P1', commanderFor('G', 'General 1'), { isCommander: true });
    perm.cardId = commander.cardId;
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('no P1');
    p1.commandZone = []; // it's on the battlefield now

    pump(moveObject(ctx, perm, { zone: 'graveyard' }));
    expect(p1.graveyard.some((c) => c.cardId === commander.cardId)).toBe(true);

    const { decisions } = pump(priorityCheckpoint(ctx));
    // Forced single option auto-resolves without surfacing an AI decision
    expect(decisions.filter((d) => d.decisionType === 'commanderReplacement')).toHaveLength(0);
    expect(p1.graveyard.some((c) => c.cardId === commander.cardId)).toBe(false);
    expect(p1.commandZone.some((c) => c.cardId === commander.cardId)).toBe(true);
  });

  it('returns from exile via the 903.9a SBA choice', () => {
    const { ctx, commander } = commanderCtx();
    const perm = spawn(ctx, 'P1', commanderFor('G', 'General 1'), { isCommander: true });
    perm.cardId = commander.cardId;
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('no P1');
    p1.commandZone = [];

    pump(moveObject(ctx, perm, { zone: 'exile' }));
    expect(ctx.state.exile.some((c) => c.cardId === commander.cardId)).toBe(true);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.exile.some((c) => c.cardId === commander.cardId)).toBe(false);
    expect(p1.commandZone.some((c) => c.cardId === commander.cardId)).toBe(true);
  });

  it('replaces a move to HAND via 903.9b (owner chooses command zone instead)', () => {
    const { ctx, commander } = commanderCtx();
    const perm = spawn(ctx, 'P1', commanderFor('G', 'General 1'), { isCommander: true });
    perm.cardId = commander.cardId;
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('no P1');
    p1.commandZone = [];

    const { decisions } = pump(moveObject(ctx, perm, { zone: 'hand' }), (d) =>
      pick(d, 'command zone'),
    );
    expect(decisions.some((d) => d.decisionType === 'commanderReplacement')).toBe(true);
    expect(p1.hand.some((c) => c.cardId === commander.cardId)).toBe(false);
    expect(p1.commandZone.some((c) => c.cardId === commander.cardId)).toBe(true);
  });

  it('replaces a move to LIBRARY via 903.9b — or lets it through when declined', () => {
    const { ctx, commander } = commanderCtx();
    const p1 = ctx.state.players.find((p) => p.id === 'P1');
    if (p1 === undefined) throw new Error('no P1');

    // Accept the replacement.
    const perm = spawn(ctx, 'P1', commanderFor('G', 'General 1'), { isCommander: true });
    perm.cardId = commander.cardId;
    p1.commandZone = [];
    pump(moveObject(ctx, perm, { zone: 'library' }), (d) => pick(d, 'command zone'));
    expect(p1.library.some((c) => c.cardId === commander.cardId)).toBe(false);
    expect(p1.commandZone.some((c) => c.cardId === commander.cardId)).toBe(true);

    // Decline: it really goes to the library.
    const again = p1.commandZone.find((c) => c.cardId === commander.cardId) as EngineCardObject;
    pump(moveObject(ctx, again, { zone: 'library' }), (d) => pick(d, 'go to your library'));
    expect(p1.library.some((c) => c.cardId === commander.cardId)).toBe(true);
    expect(p1.commandZone.some((c) => c.cardId === commander.cardId)).toBe(false);
  });
});
