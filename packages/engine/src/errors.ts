/** Typed engine errors. */

/**
 * Thrown when the engine needs behavior it cannot model (brief §6.3). The engine
 * converts this into a halted `GameResult` — a visible failure, never a wrong game.
 */
export class UnmodeledCardError extends Error {
  readonly cardName: string;
  readonly reasons: string[];
  readonly situation: string;

  constructor(cardName: string, reasons: string[], situation: string) {
    super(
      `Unmodeled card "${cardName}" (${situation}): ${reasons.join('; ')}. ` +
        'The engine halts rather than guessing (brief §6.3).',
    );
    this.name = 'UnmodeledCardError';
    this.cardName = cardName;
    this.reasons = reasons;
    this.situation = situation;
  }
}

/**
 * Thrown by `Engine.submit()` when a decision does not reference a legal option
 * (brief §7.7). State is unchanged; the caller may retry with a corrected response.
 */
export class IllegalDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalDecisionError';
  }
}

/**
 * Thrown when a game exceeds a work limit set through `EngineOptions` (ADR 0031 decision 9): too
 * many events in one `advance()`, a loop that never yields, or too many objects in one game.
 * `Engine.advance` turns it into a halted `GameResult`.
 */
export class EngineBudgetError extends Error {
  readonly budget: 'stepWork' | 'objects';
  readonly limit: number;

  constructor(budget: 'stepWork' | 'objects', limit: number) {
    super(
      budget === 'stepWork'
        ? `the engine emitted more than ${limit} events in one step`
        : `the game created more than ${limit} objects`,
    );
    this.name = 'EngineBudgetError';
    this.budget = budget;
    this.limit = limit;
  }
}

/** Misuse of the engine driver (submit without a pending decision, advance after end). */
export class EngineUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUsageError';
  }
}

/**
 * Thrown where the engine reaches a state a validated card definition cannot produce: an
 * authoring or engine bug, never a rules outcome (ADR 0034 decision 2). `site` names the code
 * that raised it. `Engine.advance` turns it into a halted `GameResult` that keeps the site, or
 * rethrows it under `GameConfig.strictInvariants` so a failing test points at the line.
 */
export class EngineInvariantError extends Error {
  readonly site: string;

  constructor(site: string, message: string) {
    super(`Engine invariant violated at ${site}: ${message}`);
    this.name = 'EngineInvariantError';
    this.site = site;
  }
}
