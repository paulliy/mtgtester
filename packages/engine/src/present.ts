/**
 * Presentation helpers (brief — player-experience overhaul, Workstream 3): the central
 * construction points for `EngineActionOption.presentation` / `PendingDecision.presentationSource`.
 *
 * These are the ergonomic way to satisfy the contract "a decision the player answers carries
 * enough to render a real card, not raw text" — a card override or flow site that builds its
 * options through these helpers gets a correct, image-bearing presentation for free, using the
 * exact same `scryfallIdOf` lookup the spectator board uses (see `state/queries.ts`), so a card
 * can never look different in a decision panel than it does on the board.
 *
 * Purely descriptive: nothing here is consulted for legality, and none of it reaches the AI
 * prompt (`ActionPresentation`/`PresentedCard` are deliberately not part of `LegalAction`).
 */

import type {
  ActionPresentation,
  ActionSubject,
  PresentedCard,
  PresentedSource,
} from '@mtg/shared';
import type { EngineActionOption } from './decisions';
import { scryfallIdOf } from './state/queries';
import type { EngineCardObject, EnginePermanent, GameContext } from './state/types';

/** Build a `PresentedCard` from any card-shaped engine object (hand/graveyard/exile card or permanent). */
export function presentedCard(
  ctx: GameContext,
  obj: EngineCardObject | EnginePermanent,
  controller?: string,
): PresentedCard {
  return {
    objectId: obj.id,
    name: obj.name,
    scryfallId: scryfallIdOf(ctx, obj.oracleId),
    typeLine: obj.typeLine,
    zone: obj.zone,
    ...(controller !== undefined ? { controller } : {}),
  };
}

/** Build a `PresentedSource` — what a whole decision is about (e.g. what triggered it). */
export function presentedSource(
  ctx: GameContext,
  obj: { cardId: string; name: string; oracleId: string },
): PresentedSource {
  return {
    cardId: obj.cardId,
    name: obj.name,
    scryfallId: scryfallIdOf(ctx, obj.oracleId),
  };
}

interface OptionBase {
  type: string;
  description: string;
  payload?: unknown;
  data?: Record<string, unknown>;
  verb: string;
  role?: ActionPresentation['role'];
}

/** An option whose subject is a card — the dominant shape (discard, scry, search, order…). */
export function cardOption(
  ctx: GameContext,
  card: EngineCardObject | EnginePermanent,
  opts: OptionBase & { controller?: string },
): EngineActionOption {
  const subject: ActionSubject = { kind: 'card', card: presentedCard(ctx, card, opts.controller) };
  return {
    type: opts.type,
    description: opts.description,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    presentation: {
      verb: opts.verb,
      subjects: [subject],
      ...(opts.role ? { role: opts.role } : {}),
    },
  };
}

/** An option whose subject is a player (an opponent choice, a divide-among-players effect). */
export function playerOption(
  playerId: string,
  label: string,
  opts: OptionBase,
): EngineActionOption {
  const subject: ActionSubject = { kind: 'player', playerId, label };
  return {
    type: opts.type,
    description: opts.description,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    presentation: {
      verb: opts.verb,
      subjects: [subject],
      ...(opts.role ? { role: opts.role } : {}),
    },
  };
}

/** An option whose subject is a bare number (an X choice, a damage-division amount). */
export function valueOption(value: number, label: string, opts: OptionBase): EngineActionOption {
  const subject: ActionSubject = { kind: 'value', label, value };
  return {
    type: opts.type,
    description: opts.description,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    presentation: {
      verb: opts.verb,
      subjects: [subject],
      ...(opts.role ? { role: opts.role } : {}),
    },
  };
}

/** An option with no card/player/value subject of its own — e.g. a mode of a modal spell. */
export function plainOption(opts: OptionBase): EngineActionOption {
  return {
    type: opts.type,
    description: opts.description,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    presentation: { verb: opts.verb, subjects: [], ...(opts.role ? { role: opts.role } : {}) },
  };
}
