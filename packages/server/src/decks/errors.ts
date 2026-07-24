import type { DeckSourceType } from '@mtg/shared';

/** A source-specific import error with a message safe to surface to the user (§8.2 — be precise). */
export class DeckImportError extends Error {
  constructor(
    message: string,
    readonly sourceType: DeckSourceType,
  ) {
    super(message);
    this.name = 'DeckImportError';
  }
}
