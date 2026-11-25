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
import { drainPool } from '../mana/pool';
import { checkpointBoard, priorityCheckpoint } from '../sba/sba';
import { resolveTopOfStack } from '../stack/stack';
import { playersInApnapOrder } from '../state/queries';
import { playerById } from '../state/objects';
import type { EnginePlayerState, GameContext } from '../state/types';

/**
 * CR 732.4: a loop of optional actions by one player is repeated a number of times the player
 * chooses, then they must stop. The engine cannot see a loop, so it backstops a decider that
 * keeps taking the same action from the same menu: after this many identical choices in a row
 * within one priority sequence, that option is withheld from the identical menu.
 */
export const OPTIONAL_LOOP_ITERATIONS = 10;

interface RepeatRecord {
  player: PlayerId;
  /** The full (pre-filter) menu the player last acted from and the option they took. */
  options: readonly EngineActionOption[];
  chosen: EngineActionOption;
  /** Consecutive identical (menu, option) actions ending with that one. */
  count: number;
  /** The player's finite resources when they took it (see `resourcesOf`). */
  resources: readonly number[];
}

/**
 * What a repeated action could use up: life, energy, cards in hand and library, permanents, and
 * untapped permanents. An action that lowers any of them cannot repeat forever, so it is a finite
 * choice the player may keep making ("Pay 1 life: +1/+1" until they stop), not a loop CR 732.4
 * asks them to number. A repeat that lowers none of them (an untap loop paid from the creatures it
 * untaps, a free life gain) can go on forever, and only that is counted toward the limit.
 */
function resourcesOf(ctx: GameContext, player: EnginePlayerState): number[] {
  let permanents = 0;
  let untapped = 0;
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== player.id) continue;
    permanents += 1;
    if (!perm.tapped) untapped += 1;
  }
  return [
    player.life,
    player.energy ?? 0,
    player.hand.length,
    player.library.length,
    permanents,
    untapped,
  ];
}

function optionSignature(option: EngineActionOption): string {
  let payload = '';
  try {
    payload = JSON.stringify([option.payload, option.data]) ?? '';
  } catch {
    payload = '';
  }
  return `${option.description}\u0000${payload}`;
}

function menuSignature(options: readonly EngineActionOption[]): string {
  return options.map(optionSignature).join('\u0001');
}

function isPassPayload(payload: PriorityActionPayload): boolean {
  return (
    payload.kind === 'pass' ||
    payload.kind === 'passAndYieldTurn' ||
    payload.kind === 'yieldToAbility'
  );
}

function shouldAutoPassPriority(ctx: GameContext, player: EnginePlayerState): boolean {
  if (player.yieldUntilEndOfTurn === true) {
    return true;
  }
  if (ctx.state.stack.length > 0) {
    const top = ctx.state.stack[ctx.state.stack.length - 1];
    if (
      top !== undefined &&
      top.kind === 'triggeredAbility' &&
      player.yieldedAbilities?.includes(top.sourceOracleId) === true
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Empty every player's mana pool (end of each step and phase, CR 500.4).
 *
 * Mana marked `persistent` survives — "until end of turn, you don't lose this mana as steps and
 * phases end" (Klauth). `includePersistent` is set by the cleanup step, where end of TURN drops
 * it along with everything else.
 */
export function emptyManaPools(ctx: GameContext, includePersistent = false): void {
  for (const p of ctx.state.players) {
    drainPool(p, includePersistent);
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
  let lastAction = null as RepeatRecord | null; // last non-pass priority action in this sequence
  // The read scope of the board as the last checkpoint left it, while nothing has changed it
  // since: the next checkpoint's SBA scan and the next menu reuse its layer digests rather than
  // take them again. Cleared by anything that changes the state or yields to the outside.
  let board: object | undefined;

  for (;;) {
    // Checkpoint before anyone receives priority (CR 117.5). Anything happening (SBAs,
    // triggers hitting the stack) voids accumulated passes.
    const acted = yield* priorityCheckpoint(ctx, board);
    board = checkpointBoard(ctx);
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

    if (shouldAutoPassPriority(ctx, player)) {
      debug(ctx, 'priority', `${player.id} auto-passes priority (yield active)`);
      passesInARow += 1;
      if (passesInARow >= players.length) {
        if (s.stack.length === 0) {
          s.priorityPlayerIndex = null;
          return;
        }
        board = undefined;
        yield* resolveTopOfStack(ctx);
        passesInARow = 0;
        holder = null;
      } else {
        const idx = players.findIndex((p) => p.id === holder);
        holder = (players[(idx + 1) % players.length] as (typeof players)[number]).id;
      }
      continue;
    }

    let options = computePriorityOptions(ctx, player, board);
    // The menu is offered next, and the answer may come after any outside change (a concession).
    board = undefined;
    // Signature work only when this player's own non-pass action came last (no cost otherwise).
    const fullMenu = options;
    let sameMenu = false;
    if (lastAction !== null && lastAction.player === player.id) {
      const before = lastAction.resources;
      sameMenu =
        menuSignature(options) === menuSignature(lastAction.options) &&
        !resourcesOf(ctx, player).some((value, i) => value < (before[i] ?? value));
      if (sameMenu && lastAction.count >= OPTIONAL_LOOP_ITERATIONS) {
        const blocked = optionSignature(lastAction.chosen);
        const kept = options.filter(
          (o) =>
            isPassPayload(o.payload as PriorityActionPayload) || optionSignature(o) !== blocked,
        );
        if (kept.length < options.length) {
          debug(
            ctx,
            'priority',
            `${player.id} repeated the same action ${lastAction.count} times from an identical menu; withholding it (CR 732.4)`,
          );
          options = kept;
        }
      }
    }
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

    if (isPassPayload(payload)) {
      if (payload.kind === 'passAndYieldTurn') {
        player.yieldUntilEndOfTurn = true;
        debug(ctx, 'priority', `${player.id} passes priority and yields until end of turn`);
      } else if (payload.kind === 'yieldToAbility') {
        if (!player.yieldedAbilities) player.yieldedAbilities = [];
        if (!player.yieldedAbilities.includes(payload.sourceOracleId)) {
          player.yieldedAbilities.push(payload.sourceOracleId);
        }
        debug(
          ctx,
          'priority',
          `${player.id} passes priority and yields to ability ${payload.sourceOracleId}`,
        );
      } else {
        debug(ctx, 'priority', `${player.id} passes priority`);
      }
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
      const previous: RepeatRecord | null = lastAction;
      const repeat =
        sameMenu &&
        previous !== null &&
        optionSignature(previous.chosen) === optionSignature(chosen);
      lastAction = {
        player: player.id,
        options: fullMenu,
        chosen,
        count: repeat && previous !== null ? previous.count + 1 : 1,
        resources: resourcesOf(ctx, player),
      };
      yield* applyPriorityAction(ctx, player, payload, outcome);
      passesInARow = 0;
      // CR 117.3c: the actor retains priority; holder unchanged.
    }
  }
}
