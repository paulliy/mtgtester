/**
 * Claim-time deck check for table seats (ADR 0031 decision 6): a plaintext decklist from a
 * remote player is parsed in memory with `parsePlaintextDeck`, resolved against the oracle index
 * and validated, reporting every problem. It never goes through `importDeck`, which sniffs for a
 * URL and would fetch it, and it never touches the database; the deck is stored only after the
 * host approves the claim.
 */

import type { ResolvedDeck, TableDeckProblem } from '@mtg/shared';
import { TABLE_MAX_DECKLIST_CHARS } from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { BannedList } from '../decks/banned';
import { parsePlaintextDeck } from '../decks/plaintext';
import { resolveDeck } from '../decks/resolve';
import { validateDeck } from '../decks/validate';

export type DeckCheckResult =
  { ok: true; deck: ResolvedDeck } | { ok: false; problems: TableDeckProblem[] };

/** Synchronous, pure, no I/O. The table calls it once per claim. */
export type DeckChecker = (decklist: string) => DeckCheckResult;

export const TABLE_MAX_DECKLIST_LINES = 250;

export interface DeckCheckerDeps {
  index: OracleIndex;
  banned: BannedList;
}

export function createDeckChecker(deps: DeckCheckerDeps): DeckChecker {
  return (decklist) => {
    if (decklist.length > TABLE_MAX_DECKLIST_CHARS) {
      return {
        ok: false,
        problems: [{ code: 'tooLarge', message: 'The decklist is too long.' }],
      };
    }
    if (decklist.split(/\r?\n/).length > TABLE_MAX_DECKLIST_LINES) {
      return {
        ok: false,
        problems: [
          {
            code: 'tooLarge',
            message: `The decklist has more than ${TABLE_MAX_DECKLIST_LINES} lines.`,
          },
        ],
      };
    }
    let resolution;
    try {
      resolution = resolveDeck(parsePlaintextDeck(decklist), deps.index);
    } catch {
      return {
        ok: false,
        problems: [{ code: 'parse', message: 'The decklist could not be read.' }],
      };
    }
    if (resolution.resolved === null) {
      return {
        ok: false,
        problems: resolution.unresolvedNames.map((name) => ({
          code: 'unresolved' as const,
          message: `"${name}" is not a card this server knows.`,
          cardName: name,
        })),
      };
    }
    const validation = validateDeck(resolution.resolved, deps.banned);
    if (!validation.valid) {
      return {
        ok: false,
        problems: validation.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          ...(issue.cardName === undefined ? {} : { cardName: issue.cardName }),
        })),
      };
    }
    return { ok: true, deck: resolution.resolved };
  };
}
