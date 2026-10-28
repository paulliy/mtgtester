/**
 * `DisclosurePolicy` (ADR 0031 decision 3): what a game's frames may carry, decided by the entry
 * point that builds the session instead of by branches scattered through it.
 *
 * Every field defaults to deny. `DENY_ALL` is the starting point, `testerPolicy` reproduces what
 * the tester's server has always sent for a mode, and `tablePolicy` is the table's. A new field
 * therefore has to be given a value in all three before it compiles, and a policy that forgets one
 * shows nothing rather than everything.
 *
 * The policy also yields an outbound message-type allowlist. `MatchSession.sendPublic` and
 * `sendToSeat` check it, so a code path that builds a full-state frame at the wrong moment is
 * stopped at the last hop: it throws under test and is dropped, with a warning, otherwise.
 */

import { assertNever, SERVER_TO_CLIENT_TYPES } from '@mtg/shared';
import type { GameMode, PlayerId, ServerToClientType } from '@mtg/shared';

/** When a frame that carries the whole game state (a spectator board, the full log) may go out. */
export type FullStateRelease = 'never' | 'afterGame' | 'always';

/**
 * Whose AI reasoning notes a viewer may read, and when.
 *
 * - `none`: nobody's.
 * - `ownSeat`: a seat's own notes only, never another seat's. A human seat writes none, so at a
 *   table this releases nothing today.
 * - `afterGame`: every seat's, once the game is over.
 * - `live`: as they are produced, subject to the viewer's own debug flag (the spectator).
 */
export type AnnotationDisclosure = 'none' | 'ownSeat' | 'afterGame' | 'live';

/**
 * Whose archetype tag a viewer may read. A bot's tag is computed from its secret generated list,
 * so it is the one that matters.
 *
 * - `none`: nobody's.
 * - `ownHumanSeat`: a human seat's own tag goes to that seat alone; a bot's is withheld from
 *   everyone. After the game, `decklistsAfterGame` releases them with the decklists.
 * - `all`: every seat's.
 */
export type ArchetypeTagDisclosure = 'none' | 'ownHumanSeat' | 'all';

export interface DisclosurePolicy {
  /** The public game label (the seed) in `gameStarted`, the game report and the player's board. */
  showSeed: boolean;
  /** `debugEvents` frames, and the debug flags that turn them (and AI reasoning) on. */
  debugEvents: boolean;
  /** AI reasoning notes, and the post-game reviews built from them. */
  annotations: AnnotationDisclosure;
  /** `apiWaiting`: token counts track a bot's hand. */
  aiCostReports: boolean;
  /** Raw error text, halt reasons and the halted card name, instead of a fixed message. */
  rawErrorText: boolean;
  archetypeTags: ArchetypeTagDisclosure;
  /** Full-state frames: `replayUnlocked`, `replayTurnState`, `stateSnapshot`. */
  fullState: FullStateRelease;
  /** Every seat's decklist (and, with `ownHumanSeat`, every archetype tag) once the game is over. */
  decklistsAfterGame: boolean;
  /**
   * A halt counts as the end of the game for the post-game unlock: the session announces the
   * result and unlocks what `fullState` and `decklistsAfterGame` allow, instead of leaving the
   * players looking at a stopped board. The fixed message is sent either way.
   */
  haltIsTerminal: boolean;
}

/** Every field at its most restrictive value. */
export const DENY_ALL: Readonly<DisclosurePolicy> = Object.freeze({
  showSeed: false,
  debugEvents: false,
  annotations: 'none',
  aiCostReports: false,
  rawErrorText: false,
  archetypeTags: 'none',
  fullState: 'never',
  decklistsAfterGame: false,
  haltIsTerminal: false,
});

/**
 * What the tester's server sends today, per mode. Single-player is the sealed case: the seed is a
 * label the player chose, debug and live reasoning are off, and the full state and every note
 * unlock when the game ends. A spectator watches the whole table, so it sees everything live.
 */
export function testerPolicy(gameMode: GameMode): Readonly<DisclosurePolicy> {
  switch (gameMode) {
    case 'spectator':
      return Object.freeze({
        ...DENY_ALL,
        showSeed: true,
        debugEvents: true,
        annotations: 'live',
        aiCostReports: true,
        rawErrorText: true,
        archetypeTags: 'all',
        fullState: 'always',
        decklistsAfterGame: true,
      });
    case 'singlePlayer':
      return Object.freeze({
        ...DENY_ALL,
        showSeed: true,
        annotations: 'afterGame',
        aiCostReports: true,
        archetypeTags: 'all',
        fullState: 'afterGame',
        decklistsAfterGame: true,
      });
    case 'table':
      // A table is never run by the tester's server; if one ever is, it gets the table's policy.
      return tablePolicy();
    default:
      return assertNever(gameMode, 'tester disclosure policy');
  }
}

/** ADR 0031 decision 3. */
export function tablePolicy(): Readonly<DisclosurePolicy> {
  return Object.freeze({
    ...DENY_ALL,
    // No debug events, raw errors, AI cost reports or seed in a live frame.
    annotations: 'ownSeat',
    archetypeTags: 'ownHumanSeat',
    // Replay and decklists unlock only after the game, a halted game included.
    fullState: 'afterGame',
    decklistsAfterGame: true,
    haltIsTerminal: true,
  });
}

/** The seed as a frame may carry it: empty when the policy hides it. */
export function seedLabel(policy: DisclosurePolicy, seed: string): string {
  return policy.showSeed ? seed : '';
}

/** Whether a decklist (or a deck source detail) may be shown to its non-owners. */
export function mayShowDecklists(policy: DisclosurePolicy, gameOver: boolean): boolean {
  return gameOver && policy.decklistsAfterGame;
}

/**
 * Whether `viewer` may read the archetype tag of `owner`'s deck.
 *
 * `ownerIsHuman` matters because a human's tag is their own business to see, while a bot's tag is
 * a classifier's reading of a list nobody at the table has seen.
 */
export function mayShowArchetypeTag(
  policy: DisclosurePolicy,
  context: { owner: PlayerId; viewer: PlayerId; ownerIsHuman: boolean; gameOver: boolean },
): boolean {
  switch (policy.archetypeTags) {
    case 'all':
      return true;
    case 'ownHumanSeat':
      return (
        (context.ownerIsHuman && context.owner === context.viewer) ||
        mayShowDecklists(policy, context.gameOver)
      );
    case 'none':
      return false;
    default:
      return assertNever(policy.archetypeTags, 'archetype tag disclosure');
  }
}

// ── The outbound allowlist ──────────────────────────────────────────────────────────────────

/** What a message type needs from the policy before it may be sent. */
type OutboundGate =
  'always' | 'debugEvents' | 'aiCostReports' | 'rawErrorText' | 'annotations' | 'fullState';

/**
 * Every wire type, classified. `satisfies Record<ServerToClientType, ...>` makes a new type fail
 * typecheck until someone decides what it needs.
 */
const OUTBOUND_GATES = {
  gameStarted: 'always',
  // The spectator board: the whole table, every hand included.
  stateSnapshot: 'fullState',
  eventBatch: 'always',
  // Carries the failed model's raw detail (`invalidResponse`) and a bot's legal menu.
  decisionPending: 'rawErrorText',
  // The payload is the policy's job: a fixed message unless `rawErrorText`.
  computeHalted: 'always',
  apiWaiting: 'aiCostReports',
  debugEvents: 'debugEvents',
  playerStateSnapshot: 'always',
  playerActionRequired: 'always',
  sessionPaused: 'always',
  replayUnlocked: 'fullState',
  gameOver: 'always',
  // Model commentary on the game, written from the reviewing seat's reasoning.
  gameReflections: 'annotations',
  diplomacyState: 'always',
  dealDraft: 'always',
  error: 'always',
} as const satisfies Record<ServerToClientType, OutboundGate>;

/**
 * Wire types that are not in `ServerToClientType` yet but are full-state by nature. Naming them
 * here means the table server's post-game replay frames are denied until the game ends from the
 * day they are added, not from the day someone remembers to classify them.
 */
const PLANNED_OUTBOUND_GATES: Readonly<Record<string, OutboundGate>> = {
  replayTurnState: 'fullState',
};

/** The full-state types, for tests and for the table server's own checks. */
export const FULL_STATE_TYPES: readonly string[] = [
  ...SERVER_TO_CLIENT_TYPES.filter((type) => OUTBOUND_GATES[type] === 'fullState'),
  ...Object.entries(PLANNED_OUTBOUND_GATES)
    .filter(([, gate]) => gate === 'fullState')
    .map(([type]) => type),
];

function gateOf(type: string): OutboundGate | undefined {
  if (Object.hasOwn(OUTBOUND_GATES, type)) return OUTBOUND_GATES[type as ServerToClientType];
  if (Object.hasOwn(PLANNED_OUTBOUND_GATES, type)) return PLANNED_OUTBOUND_GATES[type];
  return undefined;
}

/**
 * Whether a message of `type` may leave the session. `terminal` is whether the game has ended or
 * halted. An unknown type is denied.
 */
export function isOutboundAllowed(
  policy: DisclosurePolicy,
  type: string,
  context: { terminal: boolean },
): boolean {
  const gate = gateOf(type);
  if (gate === undefined) return false;
  switch (gate) {
    case 'always':
      return true;
    case 'debugEvents':
      return policy.debugEvents;
    case 'aiCostReports':
      return policy.aiCostReports;
    case 'rawErrorText':
      return policy.rawErrorText;
    case 'annotations':
      return policy.annotations === 'afterGame' || policy.annotations === 'live';
    case 'fullState':
      return (
        policy.fullState === 'always' || (policy.fullState === 'afterGame' && context.terminal)
      );
    default:
      return assertNever(gate, 'outbound gate');
  }
}

/** The allowed types, for a policy and a phase: the allowlist as data. */
export function outboundAllowlist(
  policy: DisclosurePolicy,
  context: { terminal: boolean },
): ReadonlySet<string> {
  const known = [...SERVER_TO_CLIENT_TYPES, ...Object.keys(PLANNED_OUTBOUND_GATES)];
  return new Set(known.filter((type) => isOutboundAllowed(policy, type, context)));
}

/** Whether this process is a test run. The repo has no other detector; Vitest sets `VITEST`. */
function underTest(): boolean {
  const flag = process.env['VITEST'];
  return flag !== undefined && flag !== '' && flag !== 'false';
}

/**
 * Check one outbound message. Returns whether to send it. A disallowed message throws under test,
 * where it is a bug to fix, and is dropped with a warning otherwise, where a thrown error would
 * take the game down for a frame nobody should have been sent anyway.
 */
export function checkOutbound(
  policy: DisclosurePolicy,
  type: string,
  context: { terminal: boolean },
): boolean {
  if (isOutboundAllowed(policy, type, context)) return true;
  const detail = `the disclosure policy does not allow sending '${type}' ${
    context.terminal ? 'after the game' : 'while the game is live'
  }`;
  if (underTest()) throw new Error(detail);
  console.warn(`[disclosure] ${detail}; the message was dropped`);
  return false;
}
