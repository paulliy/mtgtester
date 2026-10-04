/**
 * What a single-player requester is allowed to learn when setup refuses to start a game.
 *
 * A spectator watches all four seats, so a spectator refusal may name every failing deck. A
 * single-player requester holds exactly one seat and the other three are opponents whose
 * decklists and private card data must never come back (brief §10.1). `setupSeats` reports every
 * failing seat together, and a `SeatProblem` carries free text in three places at once — its own
 * `message`, each `ValidationIssue.message`, and `ValidationIssue.cardName` — plus
 * `unresolvedNames` and `unmodeledCards`, which are card names outright. Filtering by seat alone
 * would still forward an opponent's card name inside the requester's own entry if the upstream
 * message ever mentioned one.
 *
 * So nothing is forwarded. The payload is *reconstructed* from an allowlist:
 *
 * - one fixed line per failing seat, saying only whether it was the requester's seat or an
 *   opponent's;
 * - for the requester's own seat only, the validation *codes* that failed, each paired with a
 *   description generated here from the code — never the upstream message, never `cardName`;
 * - no `unmodeledCards` at all, in either direction, because that field is nothing but names.
 *
 * Authorization is the caller's validated seat identity. When it is not an actual seat the
 * projection authorizes nothing rather than guessing, so an unknown or malformed identity is
 * strictly less revealing than a known one.
 */

import { VALIDATION_CODES, isPlayerSeatId } from '@mtg/shared';
import type { ErrorPayload, PlayerId, ValidationCode, ValidationIssue } from '@mtg/shared';
import type { SeatProblem } from '../match/setup';

/**
 * A description per validation code, written here rather than taken from the failing deck. The
 * code is the diagnostic; the sentence only makes it readable. An issue whose code is not in this
 * table is dropped, so a code added upstream without a description stays silent instead of
 * arriving with upstream text attached.
 */
const SAFE_VALIDATION_DESCRIPTIONS: Record<ValidationCode, string> = {
  cardCount: 'The deck does not have the required number of cards.',
  commanderLegality: 'A chosen commander is not legal as a commander.',
  partnerPairing: 'The two commanders are not a legal partner pairing.',
  singleton: 'The deck breaks the singleton rule.',
  colorIdentity: 'A card falls outside the commander color identity.',
  banned: 'The deck contains a card banned in Commander.',
  companion: 'A companion does not meet its deckbuilding condition.',
};

/** The one sentence a single-player requester gets for any setup failure with no seat detail. */
export const SETUP_REFUSED_MESSAGE =
  'The game could not be set up. Check your own deck selection and try again.';

/** Fixed per-seat lines. Neither says anything a requester did not already know. */
const OWN_SEAT_LINE = 'your seat could not be prepared for this game';
const OPPONENT_SEAT_LINE = 'an opponent seat could not be prepared for this game';

function isKnownCode(code: unknown): code is ValidationCode {
  return typeof code === 'string' && (VALIDATION_CODES as readonly string[]).includes(code);
}

/**
 * The requester's own failed validation codes, deduplicated and in `VALIDATION_CODES` order so
 * the output does not depend on the order the deck happened to fail in.
 */
function ownSeatIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const codes = new Set<ValidationCode>();
  for (const issue of issues) {
    if (isKnownCode(issue.code)) codes.add(issue.code);
  }
  return VALIDATION_CODES.filter((code) => codes.has(code)).map((code) => ({
    code,
    message: SAFE_VALIDATION_DESCRIPTIONS[code],
  }));
}

/**
 * Build the single-player `error` payload for a set of failing seats.
 *
 * `authorizedSeat` is the requester's validated seat, or anything else to authorize nothing.
 */
export function projectSetupProblems(
  problems: readonly SeatProblem[],
  authorizedSeat: unknown,
): ErrorPayload {
  const ownSeat: PlayerId | null = isPlayerSeatId(authorizedSeat) ? authorizedSeat : null;
  const lines: string[] = [];
  const deckIssues: NonNullable<ErrorPayload['deckIssues']> = [];

  for (const problem of problems) {
    // The seat label is the requester's own seat or a seat name they can already see in setup;
    // it is an identifier, not deck content.
    const own = ownSeat !== null && problem.seat === ownSeat;
    lines.push(`${problem.seat}: ${own ? OWN_SEAT_LINE : OPPONENT_SEAT_LINE}.`);
    if (!own) continue;
    const issues = ownSeatIssues(problem.issues);
    if (issues.length > 0) deckIssues.push({ seat: problem.seat, issues });
  }

  return {
    message: lines.length > 0 ? lines.join('\n') : SETUP_REFUSED_MESSAGE,
    ...(deckIssues.length > 0 && { deckIssues }),
    // `unmodeledCards` is deliberately never set here: every element of it is a card name.
  };
}

/**
 * The same allowlist applied to an `ErrorPayload` that has already crossed the wire.
 *
 * The agent client needs this because it cannot verify what the server sanitized: a refusal it
 * receives before `gameStarted` is the only frame that carries deck diagnostics, and republishing
 * it on stdout would be a second, independent disclosure. The authorized seat here is the seat the
 * client itself asked to play, taken from its own validated configuration -- never inferred from
 * the diagnostics being projected, which are precisely the untrusted input.
 *
 * `message` is replaced outright rather than filtered: the upstream text is a per-seat summary
 * and no rule distinguishes the part of it that describes the requester's own deck.
 */
export function projectSetupErrorPayload(
  payload: Readonly<ErrorPayload>,
  authorizedSeat: unknown,
): { message: string; deckIssues?: NonNullable<ErrorPayload['deckIssues']> } {
  const ownSeat: PlayerId | null = isPlayerSeatId(authorizedSeat) ? authorizedSeat : null;
  const issues: ValidationIssue[] = [];
  if (ownSeat !== null) {
    for (const entry of payload.deckIssues ?? []) {
      // The seat on an inbound entry is untrusted data, so it is matched, not coerced.
      if (!isPlayerSeatId(entry.seat) || entry.seat !== ownSeat) continue;
      if (!Array.isArray(entry.issues)) continue;
      issues.push(...entry.issues);
    }
  }
  const safe = ownSeat === null ? [] : ownSeatIssues(issues);
  return {
    message: SETUP_REFUSED_MESSAGE,
    ...(safe.length > 0 && ownSeat !== null && { deckIssues: [{ seat: ownSeat, issues: safe }] }),
  };
}
