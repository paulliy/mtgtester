/**
 * The priority sequence (CR 117, brief §5.4) — where most rules bugs live, per the brief.
 *
 * - Before ANY player receives priority: the SBA/trigger checkpoint (CR 117.5).
 * - The active player receives priority first, then each other player in turn order
 *   (APNAP). A player who casts/activates/plays retains priority (CR 117.3c).
 * - An object resolves only after ALL players pass in succession; after a resolution the
 *   active player receives priority again (CR 117.3b).
 * - The sequence (and the step) ends when all players pass on an empty stack.
 * - A player whose only option is "pass" is auto-passed with no decision surfaced
 *   (brief §5.4/§7.4) — handled by the engine pump via `isForced`.
 */

import type { PlayerId } from '@mtg/shared';
import type { EngineActionOption, GameGen } from '../decisions';
import { debug } from '../log/log';
import { TurnAbortedSignal } from '../signals';
import { applyPriorityAction } from '../actions/apply';
import { computePriorityOptions } from '../actions/legal';
import type { PriorityActionPayload } from '../actions/legal';
import { priorityCheckpoint } from '../sba/sba';
import { resolveTopOfStack } from '../stack/stack';
import { playersInApnapOrder } from '../state/queries';
import { playerById } from '../state/objects';
import type { GameContext } from '../state/types';

/** Empty every player's mana pool (end of each step and phase, CR 500.4). */
export function emptyManaPools(ctx: GameContext): void {
  for (const p of ctx.state.players) {
    p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  }
}

function activePlayerHasLeft(ctx: GameContext): boolean {
  const ap = ctx.state.players.find((p) => p.id === ctx.state.currentTurnPlayer);
  return ap === undefined || ap.hasLost;
}

/**
 * Run one full priority sequence for the current step/phase: give priority around the
 * table until all players pass in succession on an empty stack. Resolves the stack as
 * passes complete. Throws `GameOverSignal` (via the checkpoint) or `TurnAbortedSignal`
 * (active player left, stack empty — Phase 2 simplification of CR 800.4j).
 */
export function* runPrioritySequence(ctx: GameContext): GameGen<void> {
  const s = ctx.state;

  let holder: PlayerId | null = null; // null → (re)start from the active player
  let passesInARow = 0;

  for (;;) {
    // Checkpoint before anyone receives priority (CR 117.5). Anything happening (SBAs,
    // triggers hitting the stack) voids accumulated passes.
    const acted = yield* priorityCheckpoint(ctx);
    if (acted) passesInARow = 0;

    if (activePlayerHasLeft(ctx)) {
      if (s.stack.length === 0) throw new TurnAbortedSignal();
      // CR 800.4j: with the AP gone, the next player in turn order takes their place in
      // the priority order while the stack finishes resolving.
    }

    const players = playersInApnapOrder(ctx);
    if (players.length === 0) throw new Error('engine bug: priority with no players');
    if (holder === null || !players.some((p) => p.id === holder)) {
      holder = (players[0] as (typeof players)[number]).id;
    }
    const player = playerById(ctx, holder);
    s.priorityPlayerIndex = s.turnOrder.indexOf(holder);

    const options = computePriorityOptions(ctx, player);
    debug(
      ctx,
      'legalActions',
      `${player.id}: ${options.length} option(s) at ${s.phase}${s.step !== null ? `/${s.step}` : ''}`,
      { options: options.map((o) => o.description) },
    );

    const outcome = yield {
      decisionType: 'priority',
      player: player.id,
      prompt: `You have priority (${s.phase}${s.step !== null ? `, ${s.step}` : ''}). Choose an action.`,
      options,
    };
    const chosen = options[outcome.index] as EngineActionOption;
    const payload = chosen.payload as PriorityActionPayload;

    if (payload.kind === 'pass') {
      debug(ctx, 'priority', `${player.id} passes priority`);
      passesInARow += 1;
      if (passesInARow >= players.length) {
        if (s.stack.length === 0) {
          s.priorityPlayerIndex = null;
          return; // step/phase ends (CR 117.4)
        }
        yield* resolveTopOfStack(ctx);
        passesInARow = 0;
        holder = null; // active player receives priority after a resolution (CR 117.3b)
      } else {
        const idx = players.findIndex((p) => p.id === holder);
        holder = (players[(idx + 1) % players.length] as (typeof players)[number]).id;
      }
    } else {
      yield* applyPriorityAction(ctx, player, payload, outcome);
      passesInARow = 0;
      // CR 117.3c: the actor retains priority; holder unchanged.
    }
  }
}
